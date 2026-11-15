/**
 * Fase 5 stap 6: een hele ronde naspelen (`independent-replay.mjs`) en bundels in
 * het profiel (`independent-profile.mjs`, `bundle-discovery.mjs`), op een
 * nagebootste chain met een operator en twee spelers.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { buildResultSet, createInclusionProof } from '../server/result-set.mjs';
import { buildCompactPlayerResultRecord } from '../server/verus/player-result.mjs';
import { actionBundleKeyId, serializeActionBundle } from './action-bundle.mjs';
import { createBundleRoundFinder } from './bundle-discovery.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { verifyProfileIndependently } from './independent-profile.mjs';
import { REPLAY_VERDICT, verifyRoundReplayIndependently } from './independent-replay.mjs';
import { ARCADE_OPERATOR_ID as ARCADE, ROUND_KEYS, TEST_OPERATOR_ID, isTestRound, operatorForRound } from './independent-round.mjs';
import { playerResultKeyId } from './player-result.mjs';
import { RESULT_ALGORITHM, resultSetRoot } from './result-set.mjs';
import { roundKeyFromSalt } from './round-key.mjs';
import { signReceipt, testKey } from './testing/bundle-receipt.mjs';
import { fakeChain, fakeTxid, hexJson } from './testing/fake-chain.mjs';
import { mobileRecord, sealedRecord } from './testing/mobile-record.mjs';

const P1 = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const P2 = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';
const DAILY = 'number-target:1.0.0:2026-11-13';
const TEST_ROUND = 'number-target:1.0.0:2026-11-13T0930';
const SALT = 'ab'.repeat(32);
const ADDRESS = roundKeyFromSalt(SALT).address;
const SOLVE = '(100+3)*7+7';
const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const arcadeKey = testKey();

// Hoogtes: één blok per minuut; H hoort bij de opening van de ronde.
const H = 1_317_000;

const record = (roundId, player, actions) => {
  const solved = actions.at(-1) === SOLVE;
  return {
    schemaVersion: 3, roundId, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', playerIAddress: player,
    status: solved ? 'solved' : 'abandoned', actions: actions.map((value, i) => ({ sequence: i + 1, value })),
    score: { solved, actionsUsed: actions.length }, playerSignature: null,
  };
};

async function bundle({ roundId, player, actions, key = arcadeKey, height }) {
  const signed = await signReceipt({ round: roundId, player, actions, key, height });
  return serializeActionBundle({ round: roundId, player, actions, ...signed });
}

/**
 * Een ronde met twee spelers. P1 loste op in één zet, P2 in twee.
 * `sealedBy`: wie een bundel verzegelde (en met welke zetten); `stored`: wie zijn resultaat in zijn ID zette.
 */
async function world({
  roundId = DAILY, schema = 2, revealed = true,
  sealedBy = { [P1]: {} }, stored = [], extra = {}, bundleHeight = H + 700,
} = {}) {
  const operatorId = operatorForRound(roundId);
  const opensMs = isTestRound(roundId) ? Date.parse('2026-11-13T09:30:00Z') : Date.parse('2026-11-13T00:00:00Z');
  const closesMs = opensMs + (isTestRound(roundId) ? 30 * 60_000 : 86_400_000);
  // Een testronde opent 570 minuten na middernacht; de hoogtes schuiven mee zodat alles binnen de ronde valt.
  const base = H + Math.round((opensMs - Date.parse('2026-11-13T00:00:00Z')) / 60_000);
  const definition = {
    schemaVersion: 2, roundId, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', date: '2026-11-13',
    opensAt: new Date(opensMs).toISOString(), closesAt: new Date(closesMs).toISOString(),
    puzzle: { numbers: [100, 25, 3, 7, 7, 1], target: 728, solution: SOLVE }, salt: SALT,
  };
  const records = [record(roundId, P1, [SOLVE]), record(roundId, P2, ['100*7', SOLVE])];
  const set = buildResultSet(records);
  const commitment = {
    schemaVersion: schema, roundId, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', date: '2026-11-13',
    opensAt: definition.opensAt, closesAt: definition.closesAt, hiddenDefinitionSha256: await sha256Hex(canonicalJson(definition)),
    ...(schema === 2 ? { roundEncryptionAddress: ADDRESS } : {}),
  };
  const results = { schemaVersion: 1, algorithm: RESULT_ALGORITHM, roundId, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', leafCount: set.leafCount, rootSha256: set.rootSha256, bundleSha256: set.bundleSha256 };
  const reveal = { schemaVersion: 1, hiddenDefinition: definition, commitmentTxid: fakeTxid(11) };
  const closeHeight = base + Math.round((closesMs - opensMs) / 60_000);
  const heights = { commitment: base - 60, results: closeHeight + 20, reveal: closeHeight + 22 };
  const operator = [{ height: heights.commitment, txid: fakeTxid(11), cmm: { [ROUND_KEYS.commitment]: [hexJson(commitment)] } }];
  if (revealed) {
    operator.push(
      { height: heights.results, txid: fakeTxid(12), cmm: { [ROUND_KEYS.commitment]: [hexJson(commitment)], [ROUND_KEYS.results]: [hexJson(results)] } },
      { height: heights.reveal, txid: fakeTxid(13), cmm: { [ROUND_KEYS.commitment]: [hexJson(commitment)], [ROUND_KEYS.results]: [hexJson(results)], [ROUND_KEYS.reveal]: [hexJson(reveal)] } },
    );
  }

  const bundleAt = isTestRound(roundId) ? base + 10 : bundleHeight;
  const players = {};
  for (const player of [P1, P2]) {
    const updates = [];
    const seal = sealedBy[player];
    if (seal) {
      const own = records.find((r) => r.playerIAddress === player).actions.map((a) => a.value);
      const text = await bundle({ roundId, player, actions: seal.actions ?? own, key: seal.key ?? arcadeKey, height: bundleAt - 5 });
      updates.push({ height: bundleAt, keyId: actionBundleKeyId({ roundId, serviceId: ARCADE }), record: sealedRecord(text, seal.address ?? ADDRESS) });
    }
    if (stored.includes(player)) {
      const index = set.entries.findIndex((e) => e.record.playerIAddress === player);
      const compact = buildCompactPlayerResultRecord({ round: { round_id: roundId, chain_id: 'vrsctest', game_id: 'number-target', game_version: '1.0.0' }, proof: createInclusionProof(set, index) });
      updates.push({ height: heights.reveal + 50, keyId: playerResultKeyId({ roundId, serviceId: ARCADE }), record: mobileRecord(canonicalJson(compact)) });
    }
    for (const e of extra[player] ?? []) updates.push(e);
    players[player] = { updates };
  }
  const chain = fakeChain({ anchor: { height: H, timeMs: Date.parse('2026-11-13T00:00:00Z') }, tip: H + 4000, operators: { [operatorId]: operator }, players, signerKey: arcadeKey });
  return { ...chain, roundId, records, set, heights, bundleAt };
}

const replay = (w, extra = {}) => verifyRoundReplayIndependently({ roundId: w.roundId, records: w.records, reader: w.reader, sha256Hex, ...extra });
const profile = (w, player = P1) => verifyProfileIndependently({ playerId: player, reader: w.reader, sha256Hex });

// ---- de wortel van een lijst ---------------------------------------------------------------

test('resultSetRoot: zelfde wortel als de server voor 0 tot 9 spelers, in elke volgorde', () => {
  const ids = [P1, P2, ARCADE, TEST_OPERATOR_ID, ROUND_KEYS.commitment, ROUND_KEYS.reveal, 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', 'iQJpqiici9EnqPZ41diFx1DYJNUbS7kofq', 'iH73f4rhci4Q7bF5yoB72HsKtUMWyNxdi7'];
  for (let n = 0; n <= ids.length; n++) {
    const list = [...new Set(ids)].slice(0, n).map((id, i) => record(DAILY, id, i % 2 ? ['100*7', SOLVE] : [SOLVE]));
    const server = buildResultSet(list);
    const shared = resultSetRoot([...list].reverse());
    assert.deepEqual([shared.rootSha256, shared.leafCount], [server.rootSha256, server.leafCount], `${n} spelers`);
    assert.deepEqual(shared.records.map((r) => r.playerIAddress), server.bundle.map((r) => r.playerIAddress));
  }
  assert.throws(() => resultSetRoot([record(DAILY, P1, [SOLVE]), record(DAILY, P1, [SOLVE])]), /Duplicate/);
  assert.throws(() => resultSetRoot([{ ...record(DAILY, P1, [SOLVE]), status: 'won' }]));
  assert.throws(() => resultSetRoot('lijst'), /array/);
});

// ---- de ronde bij een bundel-key --------------------------------------------------------------

test('ronde bij een bundel-key: Daily en testronde via het tijdstip van het blok', () => {
  const finder = createBundleRoundFinder({ serviceId: ARCADE });
  const key = (roundId) => actionBundleKeyId({ roundId, serviceId: ARCADE });
  const at = (iso) => Date.parse(iso);
  assert.equal(finder.find({ keyId: key(DAILY), blockTimeMs: at('2026-11-13T11:40:00Z') }), DAILY);
  // Vlak voor de reveal, de dag erna, of (na een storing) twee dagen later: nog altijd dezelfde ronde.
  assert.equal(finder.find({ keyId: key(DAILY), blockTimeMs: at('2026-11-14T00:30:00Z') }), DAILY);
  assert.equal(finder.find({ keyId: key(DAILY), blockTimeMs: at('2026-11-15T08:00:00Z') }), DAILY);
  assert.equal(finder.find({ keyId: key('word-grid:1.0.0:2026-11-13'), blockTimeMs: at('2026-11-13T23:59:00Z') }), 'word-grid:1.0.0:2026-11-13');
  assert.equal(finder.find({ keyId: key(TEST_ROUND), blockTimeMs: at('2026-11-13T09:41:00Z') }), TEST_ROUND);
  assert.equal(finder.find({ keyId: key('word-grid:1.0.0:2026-11-12T2355'), blockTimeMs: at('2026-11-13T00:04:00Z') }), 'word-grid:1.0.0:2026-11-12T2355');
  // Te ver weg, een andere namespace of een willekeurige key: geen ronde.
  assert.equal(finder.find({ keyId: key(DAILY), blockTimeMs: at('2026-11-20T00:00:00Z') }), null);
  assert.equal(finder.find({ keyId: actionBundleKeyId({ roundId: DAILY, serviceId: TEST_OPERATOR_ID }), blockTimeMs: at('2026-11-13T11:40:00Z') }), null);
  assert.equal(finder.find({ keyId: ROUND_KEYS.commitment, blockTimeMs: at('2026-11-13T11:40:00Z') }), null);
  assert.equal(finder.find({ keyId: key(DAILY), blockTimeMs: Number.NaN }), null);
});

// ---- een ronde naspelen ---------------------------------------------------------------------

test('ronde naspelen: lijst = wortel op de chain, elk resultaat volgt uit de zetten, bundel klopt → verified', async () => {
  const w = await world();
  const r = await replay(w);
  assert.equal(r.verdict, REPLAY_VERDICT.VERIFIED, r.problems.join('; '));
  assert.deepEqual([r.set.status, r.set.computedRoot, r.set.count, r.sealing, r.operatorId], ['ok', w.set.rootSha256, 2, true, ARCADE]);
  assert.deepEqual(r.puzzle.target, 728);
  const [a, b] = r.players;
  assert.deepEqual([a.playerId, a.status, a.actions, a.replay, a.signed], [P1, 'solved', [SOLVE], 'ok', false]);
  assert.deepEqual(
    [a.bundle.verdict, a.bundle.sealedBeforeReveal, a.bundle.receipt, a.bundle.matchesResult, a.bundle.height, a.bundle.revealHeight],
    ['verified', true, 'valid', 'ok', w.bundleAt, w.heights.reveal],
  );
  // P2 verzegelde niets: geen fout, gewoon geen bundel.
  assert.deepEqual([b.playerId, b.actions, b.replay, b.bundle.verdict], [P2, ['100*7', SOLVE], 'ok', 'not-found']);
});

test('ronde naspelen: een lijst die niet de officiële is → invalid, en er wordt niets uit getoond', async () => {
  const w = await world();
  for (const [name, records] of [
    ['een resultaat veranderd', [record(DAILY, P1, [SOLVE]), record(DAILY, P2, [SOLVE])]],
    ['een speler weggelaten', [record(DAILY, P1, [SOLVE])]],
    ['een speler toegevoegd', [...w.records, record(DAILY, ARCADE, [SOLVE])]],
    ['geen geldige records', [{ player: P1 }]],
  ]) {
    const r = await replay(w, { records });
    assert.deepEqual([r.verdict, r.set.status, r.players.length], [REPLAY_VERDICT.INVALID, 'mismatch', 0], name);
  }
  const none = await replay(w, { records: null });
  assert.deepEqual([none.verdict, none.set.status], [REPLAY_VERDICT.UNAVAILABLE, 'not-given']);
});

test('ronde naspelen: bundel met andere zetten dan het officiële resultaat → invalid', async () => {
  // Arcade@ gaf een ontvangstbewijs voor twee zetten, maar het officiële resultaat van P1 toont er één.
  const w = await world({ sealedBy: { [P1]: { actions: ['100*7', SOLVE] } } });
  const r = await replay(w);
  assert.equal(r.verdict, REPLAY_VERDICT.INVALID);
  assert.deepEqual([r.players[0].replay, r.players[0].bundle.verdict, r.players[0].bundle.receipt, r.players[0].bundle.matchesResult], ['ok', 'invalid', 'valid', 'mismatch']);
});

test('ronde naspelen: nog niet onthuld, zonder versleuteladres, begrensd aantal bundels, testronde', async () => {
  const open = await replay(await world({ revealed: false }));
  assert.deepEqual([open.verdict, open.players.length, open.set.status], [REPLAY_VERDICT.INCOMPLETE, 0, 'unknown']);

  const old = await replay(await world({ schema: 1, sealedBy: {} }));
  assert.deepEqual([old.verdict, old.sealing, old.players.map((p) => p.bundle)], [REPLAY_VERDICT.VERIFIED, false, [null, null]]);

  const capped = await replay(await world(), { maxBundles: 1 });
  assert.deepEqual([capped.verdict, capped.players.map((p) => p.bundleSkipped)], [REPLAY_VERDICT.VERIFIED, [false, true]]);

  // Een testronde staat op de test-operator; bundel en keys blijven in de namespace van Arcade@.
  const t = await world({ roundId: TEST_ROUND });
  const r = await replay(t);
  assert.deepEqual([r.verdict, r.operatorId, r.players[0].bundle.verdict], [REPLAY_VERDICT.VERIFIED, TEST_OPERATOR_ID, 'verified'], r.problems.join('; '));
});

// ---- bundels in het profiel -----------------------------------------------------------------

test('profiel: resultaat én verzegelde bundel van dezelfde ronde → verified, bundel vergeleken met het bewezen resultaat', async () => {
  const r = await profile(await world({ stored: [P1] }));
  assert.equal(r.verdict, 'verified', r.problems.join('; '));
  assert.deepEqual([r.results.length, r.sealedOnly.length, r.ignored], [1, 0, 0]);
  const [x] = r.results;
  assert.deepEqual([x.round, x.root, x.replay, x.bundle.verdict, x.bundle.matchesResult, x.bundle.sealedBeforeReveal], [DAILY, 'ok', 'ok', 'verified', 'ok', true]);
});

test('profiel: alleen een bundel (geen resultaat in de ID) → de ronde volgt uit de key', async () => {
  const r = await profile(await world());
  assert.equal(r.verdict, 'verified', r.problems.join('; '));
  assert.equal(r.results.length, 0);
  const [s] = r.sealedOnly;
  assert.deepEqual([s.round, s.testRound, s.roundVerdict, s.check.verdict, s.check.matchesResult, s.check.actions], [DAILY, false, 'verified', 'verified', 'not-checked', [SOLVE]]);
  // Wie niets verzegelde en niets opsloeg, heeft een leeg profiel.
  assert.equal((await profile(await world(), P2)).verdict, 'empty');
});

test('profiel: verzegelde waarde die geen bundel van een ronde is → genegeerd; vals ontvangstbewijs → invalid; te laat → niet fout', async () => {
  const stray = { height: H + 300, keyId: ROUND_KEYS.reveal, record: sealedRecord('{"iets":"anders"}', ADDRESS) };
  const ignored = await profile(await world({ extra: { [P1]: [stray] } }));
  assert.deepEqual([ignored.verdict, ignored.ignored, ignored.sealedOnly.length], ['verified', 1, 1]);

  const forged = await profile(await world({ sealedBy: { [P1]: { key: testKey() } } }));
  assert.deepEqual([forged.verdict, forged.sealedOnly[0].check.verdict, forged.sealedOnly[0].check.receipt], ['invalid', 'invalid', 'invalid']);

  const late = await profile(await world({ bundleHeight: H + 1500 }));
  assert.deepEqual([late.verdict, late.sealedOnly[0].check.verdict, late.sealedOnly[0].check.sealedBeforeReveal], ['verified', 'late', false]);

  // Verzegeld naar een ander adres dan dat van de ronde: de ronde-sleutel opent het niet.
  const other = await profile(await world({ sealedBy: { [P1]: { address: roundKeyFromSalt('cd'.repeat(32)).address } } }));
  assert.deepEqual([other.verdict, other.sealedOnly[0].check.verdict], ['partial', 'unreadable']);
});

test('profiel: bundel van een ronde die nog niet onthuld is → pending; testronde → nagekeken, telt niet mee', async () => {
  const open = await profile(await world({ revealed: false }));
  assert.deepEqual([open.verdict, open.sealedOnly[0].check.verdict, open.sealedOnly[0].check.actions], ['partial', 'pending', null]);

  const t = await profile(await world({ roundId: TEST_ROUND, stored: [P1] }));
  assert.equal(t.verdict, 'partial', t.problems.join('; '));
  const [x] = t.results;
  assert.deepEqual([x.round, x.testRound, x.root, x.replay, x.roundVerdict, x.bundle.verdict, x.bundle.matchesResult], [TEST_ROUND, true, 'ok', 'ok', 'verified', 'verified', 'ok']);
});
