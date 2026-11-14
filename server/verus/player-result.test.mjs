import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../canonical-json.mjs';
import { RESULT_ALGORITHM, buildResultSet, createInclusionProof } from '../result-set.mjs';
import {
  PLAYER_RESULT_MAX_BYTES,
  buildCompactPlayerResultRecord,
  buildPlayerResultRecord,
  expandCompactPlayerResult,
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

/** Gemeten op 11 nov 2026 (echte verzoeken: 1004 bytes → 1897 tekens, 480 → 1210): ±581 + 4/3 per byte. */
const estimateDeeplink = (bytes) => 581 + Math.ceil((bytes * 4) / 3);
const MOBILE_MAX = 2045;

function bigProof(players, words = ['slate', 'crane', 'brick', 'flame', 'spray', 'adieu']) {
  const records = [resultRecord(PLAYER, words)];
  for (let i = 1; i < players; i += 1) records.push(resultRecord(`i${String(i).padStart(6, '0')}${'B'.repeat(27)}`, ['crane']));
  const set = buildResultSet(records);
  return createInclusionProof(set, set.entries.findIndex((e) => e.record.playerIAddress === PLAYER));
}

test('v2 compact: bouwen, uitpakken en lezen geeft hetzelfde als v1', () => {
  const proof = proofFor(5);
  const compact = buildCompactPlayerResultRecord({ round: ROUND, proof });
  assert.deepEqual(Object.keys(compact).sort(), ['count', 'guesses', 'index', 'proof', 'round', 'schema', 'sig', 'sigHeight', 'status', 'version']);
  assert.equal(compact.guesses, 'crane,plane');
  const expanded = expandCompactPlayerResult(compact, { player: PLAYER });
  assert.equal(canonicalJson(expanded.record), canonicalJson(proof.record));
  assert.equal(expanded.resultRoot, proof.rootSha256);
  const serialized = serializePlayerResultRecord(compact, { player: PLAYER });
  const parsed = parsePlayerResultRecord(serialized.json, { player: PLAYER });
  const v1 = buildPlayerResultRecord({ round: ROUND, proof, resultRootTxid: TXID });
  for (const key of ['round', 'chain', 'game', 'gameVersion', 'player', 'status', 'guesses', 'resultRoot']) assert.equal(parsed[key], v1[key], key);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.resultRootTxid, null);
  // v1 blijft gewoon leesbaar
  assert.deepEqual(parsePlayerResultRecord(serializePlayerResultRecord(v1).json), v1);
});

test('v2 compact: zonder handtekening, en wat geweigerd wordt', () => {
  const unsigned = { ...resultRecord(PLAYER, ['crane']), playerSignature: null };
  const set = buildResultSet([unsigned, resultRecord(ARCADE, ['crane'])]);
  const proof = createInclusionProof(set, set.entries.findIndex((e) => e.record.playerIAddress === PLAYER));
  const compact = buildCompactPlayerResultRecord({ round: ROUND, proof });
  assert.equal(compact.sig, null);
  assert.equal('sigHeight' in compact, false);
  assert.equal(expandCompactPlayerResult(compact, { player: PLAYER }).resultRoot, proof.rootSha256);

  const good = buildCompactPlayerResultRecord({ round: ROUND, proof: proofFor(5) });
  assert.throws(() => parsePlayerResultRecord(JSON.stringify(good)), /needs the identity/);
  for (const [name, broken] of Object.entries({
    'extra veld': { ...good, extra: 1 },
    'sigHeight zonder sig': { ...good, sig: null },
    'ongeldige gok': { ...good, guesses: 'crane,PLANE' },
    'te veel gokken': { ...good, guesses: 'aaaaa,bbbbb,ccccc,ddddd,eeeee,fffff,ggggg' },
    'kapotte base64': { ...good, proof: good.proof.slice(1) },
    'index buiten bereik': { ...good, index: 99 },
    'verkeerde versie': { ...good, version: 3 },
  })) {
    assert.throws(() => expandCompactPlayerResult(broken, { player: PLAYER }), name);
  }
  // een andere gok of andere speler geeft een andere wortel: past niet meer bij de gepubliceerde result-root
  assert.notEqual(expandCompactPlayerResult({ ...good, guesses: 'crane,crane' }, { player: PLAYER }).resultRoot, proofFor(5).rootSha256);
  assert.notEqual(expandCompactPlayerResult(good, { player: ARCADE }).resultRoot, proofFor(5).rootSha256);
  assert.throws(() => buildCompactPlayerResultRecord({ round: ROUND, proof: { ...proofFor(2), rootSha256: 'ff'.repeat(32) } }), /does not verify/);
});

test('v2 compact past in een Verus Mobile-deeplink tot 20.000 spelers; v1 al niet meer bij 3', () => {
  const sizes = {};
  for (const players of [1, 2, 3, 1000, 20_000]) {
    const proof = bigProof(players);
    const v2 = serializePlayerResultRecord(buildCompactPlayerResultRecord({ round: ROUND, proof }), { player: PLAYER }).bytes;
    const v1 = Buffer.byteLength(canonicalJson(buildPlayerResultRecord({ round: ROUND, proof, resultRootTxid: TXID })));
    sizes[players] = { v1, v2, deeplinkV1: estimateDeeplink(v1), deeplinkV2: estimateDeeplink(v2) };
    assert.ok(estimateDeeplink(v2) <= MOBILE_MAX, `v2 bij ${players} spelers: ${v2} bytes → ±${estimateDeeplink(v2)} tekens`);
  }
  assert.ok(sizes[3].deeplinkV1 > MOBILE_MAX, `v1 bij 3 spelers zou ${sizes[3].deeplinkV1} tekens zijn`);
  console.log('# deeplink-schatting (bytes → tekens):', JSON.stringify(sizes));
});

// ---- Fase 8: resultaatschema 3 en compact v3 (elke game) --------------------

const NT_ROUND = Object.freeze({ id: 'number-target:1.0.0:2026-11-13', round_id: 'number-target:1.0.0:2026-11-13', chain_id: 'vrsctest', game_id: 'number-target', game_version: '1.0.0' });

function v3Record(player, actions, status, signature = null) {
  return {
    schemaVersion: 3, roundId: NT_ROUND.round_id, chainId: 'vrsctest', gameId: 'number-target', gameVersion: '1.0.0',
    playerIAddress: player, status,
    actions: actions.map((value, i) => ({ sequence: i + 1, value })),
    score: { solved: status === 'solved', actionsUsed: actions.length },
    playerSignature: signature,
  };
}

test('fase 8: compact v3 bouwt het bewezen schema-3-record byte-exact opnieuw op', () => {
  const others = ['iBdu6ywTH7xBKyDybK8XjQwBjjPDp5hGyu', 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq', 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV'];
  const records = [
    v3Record(PLAYER, ['100*7', '(100+3)*7+7'], 'solved', { height: 1500, signature: SIGNATURE }),
    ...others.map((p, i) => v3Record(p, ['25'.slice(0, 1 + (i % 2)) || '25'], 'unsolved')),
  ];
  const set = buildResultSet(records);
  const index = set.entries.find((e) => e.record.playerIAddress === PLAYER).leafIndex;
  const proof = createInclusionProof(set, index);
  const compact = buildCompactPlayerResultRecord({ round: NT_ROUND, proof });
  assert.equal(compact.version, 3);
  assert.equal(compact.actions, '100*7,(100+3)*7+7');
  assert.ok(!('guesses' in compact));
  const expanded = expandCompactPlayerResult(compact, { player: PLAYER });
  assert.equal(canonicalJson(expanded.record), canonicalJson(records[0]));
  assert.equal(expanded.resultRoot, set.rootSha256);
  const parsed = parsePlayerResultRecord(serializePlayerResultRecord(compact, { player: PLAYER }).json, { player: PLAYER });
  assert.equal(parsed.version, 3);
  assert.equal(parsed.actionsUsed, 2);
  assert.equal(parsed.status, 'solved');
  // Een zet die niet canoniek is of niet bij de game hoort, wordt geweigerd.
  assert.throws(() => expandCompactPlayerResult({ ...compact, actions: '100 * 7' }, { player: PLAYER }), /Invalid actions/);
  assert.throws(() => expandCompactPlayerResult({ ...compact, actions: 'crane' }, { player: PLAYER }), /Invalid actions/);
  assert.throws(() => expandCompactPlayerResult({ ...compact, actions: '1,1,1,1,1,1' }, { player: PLAYER }), /Too many actions/);
  assert.throws(() => expandCompactPlayerResult({ ...compact, round: 'chess:1.0.0:2026-11-13' }, { player: PLAYER }), /not registered/);
  // Een v3-record met `guesses` (v2-vorm) past niet.
  const { actions, ...rest } = compact;
  assert.throws(() => expandCompactPlayerResult({ ...rest, guesses: actions }, { player: PLAYER }), /schema v3/);
});

test('fase 8: resultaatschema 3 controleert zetten met de regels van de game', () => {
  assert.doesNotThrow(() => buildResultSet([v3Record(PLAYER, ['100*7'], 'unsolved')]));
  assert.throws(() => buildResultSet([v3Record(PLAYER, ['100 * 7'], 'unsolved')]), /not canonical/);
  assert.throws(() => buildResultSet([v3Record(PLAYER, ['crane'], 'unsolved')]), /not valid for number-target/);
  assert.throws(() => buildResultSet([{ ...v3Record(PLAYER, ['100'], 'solved'), score: { solved: true, actionsUsed: 2 } }]), /score/);
  assert.throws(() => buildResultSet([{ ...v3Record(PLAYER, ['100'], 'unsolved'), roundId: 'word-grid:1.0.0:2026-11-13' }]), /round or player/);
  assert.throws(() => buildResultSet([v3Record(PLAYER, ['1', '2', '3', '7', '25', '100'], 'unsolved')]), /actions/);
});
