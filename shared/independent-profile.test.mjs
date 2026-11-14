import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { jubjub } from '@noble/curves/jubjub';
import { blake2b } from '@noble/hashes/blake2b';

import { buildResultSet, createInclusionProof } from '../server/result-set.mjs';
import { buildCompactPlayerResultRecord } from '../server/verus/player-result.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { createChainReader, VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { ROUND_KEYS } from './independent-round.mjs';
import { verifyProfileIndependently } from './independent-profile.mjs';
import { playerResultKeyId } from './player-result.mjs';
import { RESULT_ALGORITHM } from './result-set.mjs';
import { CROSS_CHAIN_DATA_REF_KEY_HEX, DATA_DESCRIPTOR_KEY, DATA_DESCRIPTOR_KEY_HEX } from './verus-decrypt.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const OTHER = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
const ROUND = 'number-target:1.0.0:2026-11-13';
const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const hexOf = (b) => Buffer.from(b).toString('hex');
const txid = (n) => n.toString(16).padStart(64, '0');

// ---- versleutelen zoals Verus Mobile (omgekeerde van shared/verus-decrypt.mjs) -------------
const N = jubjub.CURVE.n;
const random = () => (BigInt(`0x${crypto.randomBytes(40).toString('hex')}`) % (N - 1n)) + 1n;
const le32 = (x) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const concat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const cs = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
const vdxf = (keyHex, data) => concat(Buffer.from(keyHex, 'hex'), [1], cs(data.length), data);
const descriptor = ({ flags, objectdata, salt, epk }) => concat([1, flags], cs(objectdata.length), objectdata,
  ...(salt ? [cs(salt.length), salt] : []), ...(epk ? [cs(epk.length), epk] : []));
function keys() { const ivk = random(); const gd = jubjub.ExtendedPoint.BASE.multiply(random()); return { ivk, gd, pkd: gd.multiply(ivk) }; }
function seal(plain, { gd, pkd }) {
  const esk = random();
  const epk = gd.multiply(esk).toRawBytes();
  const shared = pkd.multiply(8n).multiply(esk).toRawBytes();
  const key = blake2b(concat(shared, epk), { dkLen: 32, personalization: Buffer.from('Zcash_SaplingKDF') });
  return { epk, sealed: chacha20poly1305(key, new Uint8Array(12)).encrypt(plain) };
}
/** Waarde in de contentmultimap + bewijs-hex, zoals Mobile een record publiceert. */
function mobileRecord(recordJson) {
  const k = keys();
  const ccdr = concat([0, 1, 1], Buffer.alloc(32), [0, 0, 0, 0], [0, 0]);
  const reference = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 0, objectdata: vdxf(CROSS_CHAIN_DATA_REF_KEY_HEX, ccdr) })), k);
  const inner = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 2, objectdata: Buffer.from(recordJson), salt: crypto.randomBytes(32) })), k);
  const evidenceDescriptor = vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 5, objectdata: inner.sealed, epk: inner.epk }));
  return {
    value: { [DATA_DESCRIPTOR_KEY]: { version: 1, flags: 13, objectdata: hexOf(reference.sealed), epk: hexOf(reference.epk), ivk: hexOf(le32(k.ivk)) } },
    evidenceHex: hexOf(concat([1, 1, 1], Buffer.from(DATA_DESCRIPTOR_KEY_HEX, 'hex'), cs(evidenceDescriptor.length), evidenceDescriptor)),
  };
}

// ---- een Number Target-ronde met resultaten, zoals de server ze maakt ---------------------
const definition = {
  schemaVersion: 2, roundId: ROUND, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', date: '2026-11-13',
  opensAt: '2026-11-13T00:00:00.000Z', closesAt: '2026-11-14T00:00:00.000Z',
  puzzle: { numbers: [100, 25, 3, 7, 7, 1], target: 728, solution: '(100+3)*7+7' }, salt: 'ab'.repeat(32),
};
const resultRecord = (player, solved) => ({
  schemaVersion: 3, roundId: ROUND, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', playerIAddress: player,
  status: solved ? 'solved' : 'unsolved', actions: [{ sequence: 1, value: solved ? '(100+3)*7+7' : '100*7' }],
  score: { solved, actionsUsed: 1 }, playerSignature: null,
});

async function scenario({ rootOverride = null, recordKey = null, down = false, forgeStatus = false } = {}) {
  const set = buildResultSet([resultRecord(PLAYER, true), resultRecord(OTHER, false)]);
  const index = set.entries.findIndex((e) => e.record.playerIAddress === PLAYER);
  const compact = buildCompactPlayerResultRecord({ round: { round_id: ROUND, chain_id: 'vrsctest', game_id: 'number-target', game_version: '1.0.0' }, proof: createInclusionProof(set, index) });
  if (forgeStatus) compact.status = 'unsolved'; // andere uitkomst dan de zetten: wortel én replay kloppen dan niet
  const published = mobileRecord(canonicalJson(compact));
  const commitment = { schemaVersion: 1, roundId: ROUND, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', date: '2026-11-13', opensAt: definition.opensAt, closesAt: definition.closesAt, hiddenDefinitionSha256: await sha256Hex(canonicalJson(definition)) };
  const results = { schemaVersion: 1, algorithm: RESULT_ALGORITHM, roundId: ROUND, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0', leafCount: set.leafCount, rootSha256: rootOverride ?? set.rootSha256, bundleSha256: set.bundleSha256 };
  const reveal = { schemaVersion: 1, hiddenDefinition: definition, commitmentTxid: txid(11) };

  const H = 1_317_000;
  const T = Date.parse('2026-11-13T00:00:00Z') / 1000;
  const time = (h) => T + (h - H) * 60;
  const tip = H + 3000;
  const hex = (v) => Buffer.from(JSON.stringify(v)).toString('hex');
  const operator = [
    { height: H - 600, txid: txid(11), cmm: { [ROUND_KEYS.commitment]: [hex(commitment)] } },
    { height: H + 1500, txid: txid(12), cmm: { [ROUND_KEYS.commitment]: [hex(commitment)], [ROUND_KEYS.results]: [hex(results)] } },
    { height: H + 1502, txid: txid(13), cmm: { [ROUND_KEYS.commitment]: [hex(commitment)], [ROUND_KEYS.results]: [hex(results)], [ROUND_KEYS.reveal]: [hex(reveal)] } },
  ];
  const key = recordKey ?? playerResultKeyId({ roundId: ROUND, serviceId: ARCADE });
  const playerHistory = [{ height: H + 1600, txid: txid(21), cmm: { [key]: [published.value] } }];
  const heights = new Map([...operator, ...playerHistory].map((e) => [e.txid, e.height]));
  const methods = {
    getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: tip, VRSCversion: '1.2.18' }),
    getblock: ([h]) => ({ height: Number(h), time: time(Number(h)) }),
    getidentitycontent: ([id]) => ({ fullyqualifiedname: 'speler.VRSCTEST@', identity: { identityaddress: id, contentmultimap: { [key]: [published.value] } } }),
    getidentityhistory: ([id, from, to]) => ({
      history: (id === ARCADE ? operator : playerHistory).filter((e) => e.height >= from && e.height <= to)
        .map((e) => ({ height: e.height, blockhash: 'x', output: { txid: e.txid, voutnum: 0 }, identity: { identityaddress: id, contentmultimap: e.cmm } })),
    }),
    getrawtransaction: ([t]) => {
      if (!heights.has(t)) throw Object.assign(new Error('No information'), { rpcCode: -5 });
      const tx = { txid: t, confirmations: tip - heights.get(t) + 1, height: heights.get(t) };
      if (t === txid(21)) tx.vout = [{ scriptPubKey: { notaryevidence: { evidence: { version: 1, chainobjects: [{ value: { version: 1, hex: published.evidenceHex } }] } } } }];
      return tx;
    },
  };
  const fetch = async (url, init) => {
    if (down) throw new TypeError('fetch failed');
    const { method, params, id } = JSON.parse(init.body);
    try {
      return new Response(JSON.stringify({ id, result: await methods[method](params), error: null }));
    } catch (error) {
      return new Response(JSON.stringify({ id, result: null, error: { code: error.rpcCode ?? -1, message: error.message } }), { status: 500 });
    }
  };
  return verifyProfileIndependently({ playerId: PLAYER, reader: createChainReader({ fetch, limits: { timeMs: 30_000 } }), sha256Hex });
}

test('onafhankelijk profiel: versleuteld record, wortel van Arcade@ en naspelen → verified', async () => {
  const r = await scenario();
  assert.equal(r.verdict, 'verified', r.problems.join('; '));
  assert.equal(r.name, 'speler.VRSCTEST@');
  assert.equal(r.results.length, 1);
  const [x] = r.results;
  assert.deepEqual([x.round, x.recordVersion, x.status, x.root, x.replay, x.roundVerdict, x.testRound], [ROUND, 3, 'solved', 'ok', 'ok', 'verified', false]);
  assert.equal(x.txid, txid(21));
  assert.deepEqual([r.ignored, r.unreadable], [0, 0]);
});

test('onafhankelijk profiel: officiële wortel anders → mismatch, niet verborgen', async () => {
  const r = await scenario({ rootOverride: 'f'.repeat(64) });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.results[0].root, 'mismatch');
});

test('onafhankelijk profiel: record met een andere uitkomst → wortel klopt niet', async () => {
  const r = await scenario({ forgeStatus: true });
  assert.equal(r.verdict, 'invalid');
  assert.equal(r.results[0].root, 'mismatch');
});

test('onafhankelijk profiel: record onder een vreemde key wordt genegeerd', async () => {
  const r = await scenario({ recordKey: 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7' });
  assert.equal(r.verdict, 'empty');
  assert.equal(r.ignored, 1);
});

test('onafhankelijk profiel: RPC weg → unavailable, ongeldig adres → fout', async () => {
  assert.equal((await scenario({ down: true })).verdict, 'unavailable');
  await assert.rejects(verifyProfileIndependently({ playerId: 'speler@', reader: createChainReader({ fetch: async () => { throw new Error('x'); } }), sha256Hex }), (e) => e.code === 'INVALID_INPUT');
});
