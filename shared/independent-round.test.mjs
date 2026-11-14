import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { createChainReader, VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { ARCADE_OPERATOR_ID, parseRoundId, ROUND_KEYS, VERDICT, verifyRoundIndependently } from './independent-round.mjs';
import { RESULT_ALGORITHM } from './round-proof.mjs';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/round-reveal-vectors.json', import.meta.url), 'utf8'));
const ROUND = 'word-grid:1.0.0:2026-11-13';
const real = vectors.cases.find((c) => c.name === `echt: ${ROUND}`);
const other = vectors.cases.find((c) => c.name === 'echt: word-grid:1.0.0:2026-11-12');
const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const hex = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('hex');
const txid = (n) => n.toString(16).padStart(64, '0');

// Chain van één blok per minuut; blok 1 310 000 = 8 nov 2026 00:00 UTC.
const H8 = 1_310_000;
const T8 = Date.parse('2026-11-08T00:00:00Z') / 1000;
const time = (h) => T8 + (h - H8) * 60;
const heightOn = (iso) => H8 + Math.round((Date.parse(iso) / 1000 - T8) / 60);

const results = {
  schemaVersion: 1, algorithm: RESULT_ALGORITHM, roundId: ROUND, chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0',
  leafCount: 1, rootSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
};

/**
 * Updates van Arcade@ zoals de operator ze doet: elke update neemt de andere keys mee.
 * `steps`: [{ height, txid, key, value }] in volgorde.
 */
function operatorHistory(steps) {
  const current = {};
  return steps.map((step) => {
    current[step.key] = [hex(step.value)];
    return { height: step.height, txid: step.txid, cmm: structuredClone(current) };
  });
}

function normalSteps({ reveal = real.reveal, commitment = real.commitment, resultsHeight = heightOn('2026-11-14T00:40:00Z') } = {}) {
  return [
    { height: heightOn('2026-11-11T00:40:00Z'), txid: txid(1), key: ROUND_KEYS.commitment, value: other.commitment },
    { height: heightOn('2026-11-12T00:40:00Z'), txid: real.reveal.commitmentTxid, key: ROUND_KEYS.commitment, value: commitment },
    { height: heightOn('2026-11-13T00:40:00Z'), txid: txid(3), key: ROUND_KEYS.results, value: { ...results, roundId: other.commitment.roundId } },
    { height: heightOn('2026-11-13T00:41:00Z'), txid: txid(4), key: ROUND_KEYS.reveal, value: other.reveal },
    { height: resultsHeight, txid: txid(5), key: ROUND_KEYS.results, value: results },
    ...(reveal ? [{ height: resultsHeight + 3, txid: txid(6), key: ROUND_KEYS.reveal, value: reveal }] : []),
  ];
}

function fakeChain({ steps = normalSteps(), tip = heightOn('2026-11-14T22:00:00Z'), info = {}, overrides = {} } = {}) {
  const history = operatorHistory(steps);
  const heights = new Map(history.map((e) => [e.txid, e.height]));
  const calls = [];
  const methods = {
    getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: tip, VRSCversion: '1.2.18', ...info }),
    getblock: ([h]) => ({ height: Number(h), time: time(Number(h)) }),
    getidentityhistory: ([id, from, to]) => ({
      history: history.filter((e) => e.height >= from && e.height <= to)
        .map((e) => ({ height: e.height, blockhash: 'x', output: { txid: e.txid, voutnum: 0 }, identity: { identityaddress: id, contentmultimap: e.cmm } })),
    }),
    getrawtransaction: ([t]) => {
      if (!heights.has(t)) throw Object.assign(new Error('No information available about transaction'), { rpcCode: -5 });
      return { txid: t, confirmations: tip - heights.get(t) + 1, height: heights.get(t) };
    },
    ...overrides,
  };
  const fetch = async (url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    calls.push(method);
    try {
      return new Response(JSON.stringify({ id, result: await methods[method](params), error: null }));
    } catch (error) {
      return new Response(JSON.stringify({ id, result: null, error: { code: error.rpcCode ?? -1, message: error.message } }), { status: 500 });
    }
  };
  return { reader: createChainReader({ fetch }), calls };
}

const verify = (chain, extra = {}) => verifyRoundIndependently({ roundId: ROUND, reader: chain.reader, sha256Hex, ...extra });

test('onafhankelijke ronde: alles op de chain en kloppend → verified', async () => {
  const chain = fakeChain();
  const r = await verify(chain);
  assert.equal(r.verdict, VERDICT.VERIFIED, r.problems.join('; '));
  assert.equal(r.operatorId, ARCADE_OPERATOR_ID);
  assert.deepEqual(Object.values(r.parts).map((p) => p.status), ['confirmed', 'confirmed', 'confirmed']);
  assert.equal(r.parts.commitment.txid, real.reveal.commitmentTxid);
  assert.equal(r.parts.reveal.recomputedSha256, real.commitment.hiddenDefinitionSha256);
  assert.ok(r.parts.results.confirmations > 0);
  assert.deepEqual(r.timing, { commitmentBeforeOpen: true, resultsAfterClose: true, revealAfterResults: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.source.tip, heightOn('2026-11-14T22:00:00Z'));
  assert.ok(r.source.calls <= 20, `${r.source.calls} aanroepen`);
  assert.equal(chain.calls.filter((m) => m === 'getidentityhistory').length, 1, 'één history-aanroep volstaat');
});

test('onafhankelijke ronde: nog geen reveal → incomplete (geen fout)', async () => {
  const r = await verify(fakeChain({ steps: normalSteps({ reveal: null }) }));
  assert.equal(r.verdict, VERDICT.INCOMPLETE);
  assert.deepEqual(Object.values(r.parts).map((p) => p.status), ['confirmed', 'confirmed', 'missing']);
  assert.equal(r.timing.revealAfterResults, null);
});

test('onafhankelijke ronde: resultaten dagen te laat → gevonden in een later venster', async () => {
  const late = heightOn('2026-11-21T10:00:00Z');
  const chain = fakeChain({ steps: normalSteps({ resultsHeight: late }), tip: heightOn('2026-11-28T00:00:00Z') });
  const r = await verify(chain);
  assert.equal(r.verdict, VERDICT.VERIFIED, r.problems.join('; '));
  assert.equal(r.parts.results.height, late);
  assert.equal(chain.calls.filter((m) => m === 'getidentityhistory').length, 2);
});

test('onafhankelijke ronde: vervalste reveal → invalid', async () => {
  const forged = structuredClone(real.reveal);
  forged.hiddenDefinition.answer = forged.hiddenDefinition.answer === 'crane' ? 'slate' : 'crane';
  const r = await verify(fakeChain({ steps: normalSteps({ reveal: forged }) }));
  assert.equal(r.verdict, VERDICT.INVALID);
  assert.equal(r.parts.reveal.status, 'invalid');
  assert.match(r.parts.reveal.problem, /does not match the commitment \(hash\)/);
});

test('onafhankelijke ronde: reveal wijst naar een andere commitment-transactie → invalid', async () => {
  const r = await verify(fakeChain({ steps: normalSteps({ reveal: { ...real.reveal, commitmentTxid: txid(77) } }) }));
  assert.equal(r.verdict, VERDICT.INVALID);
  assert.match(r.parts.reveal.problem, /another commitment transaction/);
});

test('onafhankelijke ronde: twee verschillende commitments voor één ronde → invalid', async () => {
  const steps = normalSteps();
  steps.splice(2, 0, { height: heightOn('2026-11-12T03:00:00Z'), txid: txid(8), key: ROUND_KEYS.commitment, value: { ...real.commitment, hiddenDefinitionSha256: 'c'.repeat(64) } });
  const r = await verify(fakeChain({ steps }));
  assert.equal(r.verdict, VERDICT.INVALID);
  assert.match(r.parts.commitment.problem, /2 different values/);
});

test('onafhankelijke ronde: onbekende ronde → not-found', async () => {
  const r = await verifyRoundIndependently({ roundId: 'word-grid:1.0.0:2026-11-10', reader: fakeChain().reader, sha256Hex });
  assert.equal(r.verdict, VERDICT.NOT_FOUND);
});

test('onafhankelijke ronde: RPC weg, grens of onbekende tx → unavailable, nooit invalid', async () => {
  const down = createChainReader({ fetch: async () => { throw new TypeError('fetch failed'); } });
  const r1 = await verifyRoundIndependently({ roundId: ROUND, reader: down, sha256Hex });
  assert.equal(r1.verdict, VERDICT.UNAVAILABLE);
  assert.deepEqual(Object.values(r1.parts).map((p) => p.status), ['unavailable', 'unavailable', 'unavailable']);

  const big = fakeChain({ overrides: { getidentityhistory: () => ({ history: Array(1025).fill({}) }) } });
  assert.equal((await verify(big)).verdict, VERDICT.UNAVAILABLE);

  const forgetful = fakeChain({ overrides: { getrawtransaction: () => { throw Object.assign(new Error('No information'), { rpcCode: -5 }); } } });
  const r3 = await verify(forgetful);
  assert.equal(r3.verdict, VERDICT.UNAVAILABLE);
  assert.match(r3.parts.commitment.problem, /unknown to this RPC/);
});

test('onafhankelijke ronde: geen VRSCTEST → wrong-chain', async () => {
  const r = await verify(fakeChain({ info: { name: 'VRSC', chainid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', testnet: false } }));
  assert.equal(r.verdict, VERDICT.WRONG_CHAIN);
});

test('ronde-ID ontleden: Daily en testronde', () => {
  assert.deepEqual(parseRoundId('number-target:1.0.0:2026-11-13'), { gameId: 'number-target', gameVersion: '1.0.0', date: '2026-11-13', approxOpensMs: Date.parse('2026-11-13T00:00:00Z') });
  assert.equal(parseRoundId('word-grid:1.0.0:2026-11-11T1524').approxOpensMs, Date.parse('2026-11-11T15:24:00Z'));
  for (const bad of ['', 'word-grid:2026-11-13', 'Word-Grid:1.0.0:2026-11-13', 'word-grid:1.0.0:2026-13-45', 'word-grid:1.0.0:2026-11-13T99']) {
    assert.throws(() => parseRoundId(bad), (e) => e.code === 'INVALID_INPUT', bad);
  }
});
