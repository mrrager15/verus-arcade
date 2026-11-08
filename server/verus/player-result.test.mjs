import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../canonical-json.mjs';
import { RESULT_ALGORITHM, buildResultSet, createInclusionProof } from '../result-set.mjs';
import {
  PLAYER_RESULT_MAX_BYTES,
  buildPlayerResultRecord,
  parsePlayerResultRecord,
  playerResultContentKey,
  playerResultKeyName,
  serializePlayerResultRecord,
  serviceNamespace,
  validatePlayerResultRecord,
} from './player-result.mjs';

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'iQZGcAzSXaeciUhoh3ZbkmcgJHmdy3seBK';
const ROUND = Object.freeze({ id: 'word-grid:1.0.0:2026-11-08', round_id: 'word-grid:1.0.0:2026-11-08', chain_id: 'vrsctest', game_id: 'word-grid', game_version: '1.0.0' });
const TXID = 'ab'.repeat(32);
const SIGNATURE = Buffer.alloc(73, 7).toString('base64');

function resultRecord(player, words) {
  return {
    schemaVersion: 2,
    roundId: ROUND.round_id,
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    playerIAddress: player,
    status: 'solved',
    guesses: words.map((word, i) => ({ sequence: i + 1, word })),
    score: { solved: true, guessesUsed: words.length },
    playerSignature: { height: 1310481, signature: SIGNATURE },
  };
}

function proofFor(players = 3) {
  const records = [resultRecord(PLAYER, ['crane', 'plane'])];
  for (let i = 1; i < players; i += 1) records.push(resultRecord(`i${String(i).padStart(3, '0')}${'A'.repeat(30)}`, ['crane']));
  const set = buildResultSet(records);
  return createInclusionProof(set, set.entries.findIndex((e) => e.record.playerIAddress === PLAYER));
}

test('key-naam en namespace', () => {
  assert.equal(playerResultKeyName(ROUND.round_id), 'arcade.player.result.word-grid:1.0.0:2026-11-08');
  assert.throws(() => playerResultKeyName('ronde met spaties'), /VDXF/);
  assert.equal(serviceNamespace('Arcade.VRSCTEST@'), 'Arcade.VRSCTEST.');
  assert.equal(serviceNamespace('Arcade.VRSCTEST.@'), 'Arcade.VRSCTEST.');
  assert.throws(() => serviceNamespace('Arcade@'), /VRSCTEST/, 'kale naam zou mainnet impliceren');
  assert.throws(() => serviceNamespace('Arcade.VRSCTEST'), /end with @/);
});

test('korte naam en fqn geven dezelfde key; verkeerde namespace wordt geweigerd', () => {
  const key = playerResultContentKey({ roundId: ROUND.round_id, serviceId: ARCADE, serviceFqn: 'Arcade.VRSCTEST@' });
  assert.equal(key.fqn, 'Arcade.VRSCTEST.::arcade.player.result.word-grid:1.0.0:2026-11-08');
  assert.match(key.keyId, /^i[1-9A-HJ-NP-Za-km-z]{20,40}$/);
  // Dezelfde ronde, dezelfde service → altijd dezelfde key (deterministisch).
  assert.equal(playerResultContentKey({ roundId: ROUND.round_id, serviceId: ARCADE, serviceFqn: 'Arcade.VRSCTEST@' }).keyId, key.keyId);
  // Andere ronde → andere key.
  assert.notEqual(playerResultContentKey({ roundId: 'word-grid:1.0.0:2026-11-09', serviceId: ARCADE, serviceFqn: 'Arcade.VRSCTEST@' }).keyId, key.keyId);
  assert.throws(() => playerResultContentKey({ roundId: ROUND.round_id, serviceId: 'RDj4ePxriVANbxdyBapJUjf23LkBYsVxa7', serviceFqn: 'Arcade.VRSCTEST@' }), /i-address/);
});

test('record bouwen uit een echt inclusiebewijs, serialiseren en terugparsen', () => {
  const proof = proofFor(5);
  const record = buildPlayerResultRecord({ round: ROUND, proof, resultRootTxid: TXID });
  assert.equal(record.schema, 'arcade-player-result');
  assert.equal(record.player, PLAYER);
  assert.equal(record.guesses, 2);
  assert.equal(record.resultRoot, proof.rootSha256);
  assert.equal(record.proof.siblings.length, 3);
  assert.doesNotThrow(() => validatePlayerResultRecord(record));
  const serialized = serializePlayerResultRecord(record);
  assert.equal(serialized.json, canonicalJson(record));
  assert.equal(serialized.sha256, createHash('sha256').update(serialized.json, 'utf8').digest('hex'));
  assert.ok(serialized.bytes < PLAYER_RESULT_MAX_BYTES, `record van ${serialized.bytes} bytes`);
  const parsed = parsePlayerResultRecord(Buffer.from(serialized.json, 'utf8'));
  assert.deepEqual(parsed, record);
});

test('zonder bevestigde result-root, met kapot bewijs of verkeerde ronde: geweigerd', () => {
  const proof = proofFor(2);
  assert.throws(() => buildPlayerResultRecord({ round: ROUND, proof, resultRootTxid: null }), /not confirmed/);
  assert.throws(() => buildPlayerResultRecord({ round: ROUND, proof: { ...proof, rootSha256: 'ff'.repeat(32) }, resultRootTxid: TXID }), /does not verify/);
  assert.throws(() => buildPlayerResultRecord({ round: { ...ROUND, round_id: 'word-grid:1.0.0:2026-11-09' }, proof, resultRootTxid: TXID }), /different round/);
});

test('teruggelezen record: samenvatting moet bij het bewezen record horen', () => {
  const record = buildPlayerResultRecord({ round: ROUND, proof: proofFor(2), resultRootTxid: TXID });
  const tampered = { ...record, guesses: 1 };
  assert.throws(() => validatePlayerResultRecord(tampered), /does not match the proven/);
  const otherPlayer = { ...record, player: ARCADE };
  assert.throws(() => validatePlayerResultRecord(otherPlayer), /does not match the proven/);
  assert.throws(() => parsePlayerResultRecord('{niet json'), /not JSON/);
  assert.throws(() => parsePlayerResultRecord(JSON.stringify({ ...record, extra: 1 })), /schema v1/);
});

test('record groter dan 2048 bytes wordt geweigerd', () => {
  // Een geldig bewijs met 24 broers (leafCount 2^24) wordt ~2.4 kB: te groot voor één leaf.
  const inner = resultRecord(PLAYER, ['crane', 'plane', 'slate', 'crate', 'trace', 'grace']);
  const hash = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };
  let current = hash(Buffer.from([0]), Buffer.from(canonicalJson(inner), 'utf8'));
  const siblings = [];
  for (let i = 0; i < 24; i += 1) {
    const sibling = Buffer.alloc(32, i + 1);
    siblings.push({ position: 'right', sha256: sibling.toString('hex') });
    current = hash(Buffer.from([1]), current, sibling);
  }
  const proof = { algorithm: RESULT_ALGORITHM, record: inner, leafIndex: 0, leafCount: 2 ** 24, siblings, rootSha256: current.toString('hex') };
  const record = buildPlayerResultRecord({ round: ROUND, proof, resultRootTxid: TXID });
  assert.throws(() => serializePlayerResultRecord(record), /RECORD_TOO_LARGE|limit/);
  assert.throws(() => parsePlayerResultRecord(canonicalJson(record)), /size limit/);
});
