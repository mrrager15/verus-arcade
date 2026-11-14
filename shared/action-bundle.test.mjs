import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  ACTION_BUNDLE_MAX_BYTES, ActionBundleError, actionBundleHash, actionBundleKeyId, actionBundleKeyName, bundleMatchesRecord,
  parseActionBundle, receiptHash, receiptMessage, replayActionBundle, serializeActionBundle, verifyBundleReceipt,
} from './action-bundle.mjs';
import { VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { signReceipt, testIdentity, testKey } from './testing/bundle-receipt.mjs';

const P = createRequire(import.meta.url)('verus-typescript-primitives');
const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/round-reveal-vectors.json', import.meta.url), 'utf8'));
const definition = (round) => vectors.cases.find((c) => c.name === `echt: ${round}`).reveal.hiddenDefinition;

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const OTHER_PLAYER = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const NT_ROUND = 'number-target:1.0.0:2026-11-13';
const WG_ROUND = 'word-grid:1.0.0:2026-11-13';
const HEIGHT = 1_318_000;
const key = testKey();
const body = { round: NT_ROUND, player: PLAYER, actions: ['75+100', '2*(75+100)'] };

test('actie-bundel: key in de namespace van Arcade@, gelijk aan de SDK', () => {
  assert.equal(actionBundleKeyName(NT_ROUND), `arcade.player.bundle.${NT_ROUND}`);
  for (const round of [NT_ROUND, WG_ROUND, 'word-grid:1.0.0:2026-11-11T1524']) {
    assert.equal(actionBundleKeyId({ roundId: round, serviceId: ARCADE }), P.getDataKey(`arcade.player.bundle.${round}`, ARCADE, VRSCTEST_CHAIN_ID).id);
  }
  assert.throws(() => actionBundleKeyName('geen ronde'), ActionBundleError);
  assert.throws(() => actionBundleKeyId({ roundId: NT_ROUND, serviceId: 'Arcade@' }), ActionBundleError);
});

test('actie-bundel: maken en lezen, canoniek en streng', async () => {
  const signed = await signReceipt({ ...body, key, height: HEIGHT });
  const text = serializeActionBundle({ ...body, ...signed });
  assert.equal(text, `{"ack":"${signed.ack}","ackHeight":${HEIGHT},"actions":["75+100","2*(75+100)"],"player":"${PLAYER}","round":"${NT_ROUND}","schema":"arcade-action-bundle","version":1}`);
  assert.ok(text.length < 300, `${text.length} bytes`);
  const parsed = parseActionBundle(text);
  assert.deepEqual(parsed, { ...body, ...signed, gameId: 'number-target', gameVersion: '1.0.0' });
  assert.deepEqual(parseActionBundle(new TextEncoder().encode(text)), parsed);

  const object = JSON.parse(text);
  const bad = (change, pattern) => assert.throws(() => parseActionBundle(typeof change === 'string' ? change : JSON.stringify({ ...object, ...change })), (e) => e instanceof ActionBundleError && pattern.test(e.message), JSON.stringify(change).slice(0, 60));
  bad(` ${text}`, /canonical/);
  bad(JSON.stringify({ ...object, extra: 1 }), /Unexpected bundle fields/);
  bad({ version: 2 }, /version 1/);
  bad({ schema: 'arcade-player-result' }, /Not an Arcade action bundle/);
  bad({ round: 'number-target:2026-11-13' }, /round/);
  bad({ player: 'speler@' }, /player/);
  bad({ actions: [] }, /between 1 and 32/);
  bad({ actions: Array(33).fill('1+1') }, /between 1 and 32/);
  bad({ actions: ['1+1', 5] }, /Invalid action/);
  bad({ actions: ['a"b'] }, /Invalid action/);
  bad({ actions: ['x'.repeat(121)] }, /Invalid action/);
  bad({ ack: 'AAAA' }, /receipt signature/);
  bad({ ackHeight: 0 }, /receipt height/);
  bad('[]', /not an object/);
  bad('{', /not JSON/);
  bad('x'.repeat(ACTION_BUNDLE_MAX_BYTES + 1), /too large/);
  assert.throws(() => parseActionBundle(Uint8Array.of(0xff, 0xfe)), /UTF-8/);
});

test('actie-bundel: slechtste geval past ruim in een deeplink', async () => {
  // Number Target: 5 zetten van 60 tekens (de grenzen van de regels).
  const actions = Array.from({ length: 5 }, (_, i) => `${i + 1}+`.padEnd(60, '1'));
  const signed = await signReceipt({ round: NT_ROUND, player: PLAYER, actions, key, height: HEIGHT });
  const bytes = new TextEncoder().encode(serializeActionBundle({ round: NT_ROUND, player: PLAYER, actions, ...signed })).length;
  assert.ok(bytes <= 640, `${bytes} bytes`); // deeplink ≈ 490 + 1,4 × bytes + adres ≈ 1450 < 2045
});

test('actie-bundel: ontvangstbewijs van Arcade@ over precies deze bundel', async () => {
  const hash = actionBundleHash(body);
  assert.equal(receiptMessage({ round: NT_ROUND, player: PLAYER, bundleSha256: hash }), `Verus Arcade receipt v1\nround:${NT_ROUND}\nplayer:${PLAYER}\nbundle:sha256:${hash}`);
  assert.equal(receiptHash(body), crypto.createHash('sha256').update(receiptMessage({ round: NT_ROUND, player: PLAYER, bundleSha256: hash })).digest('hex'));
  assert.notEqual(receiptHash(body), receiptHash({ ...body, actions: [...body.actions, '1+1'] }));
  assert.notEqual(receiptHash(body), receiptHash({ ...body, player: OTHER_PLAYER }));
  assert.notEqual(receiptHash(body), receiptHash({ ...body, round: 'number-target:1.0.0:2026-11-14' }));

  const signed = await signReceipt({ ...body, key, height: HEIGHT });
  const bundle = parseActionBundle(serializeActionBundle({ ...body, ...signed }));
  const identityAtHeight = testIdentity(ARCADE, key, HEIGHT);
  assert.deepEqual(verifyBundleReceipt({ bundle, serviceId: ARCADE, identityAtHeight }), { valid: true, reason: null });

  // Iets aan de bundel veranderen na het tekenen: het ontvangstbewijs past niet meer.
  for (const change of [{ actions: ['75+100'] }, { actions: [...body.actions, '8*2'] }, { player: OTHER_PLAYER }, { round: 'number-target:1.0.0:2026-11-14' }]) {
    assert.equal(verifyBundleReceipt({ bundle: { ...bundle, ...change }, serviceId: ARCADE, identityAtHeight }).valid, false, JSON.stringify(change));
  }
  // Getekend door een andere sleutel dan die van Arcade@ op die hoogte.
  const forged = await signReceipt({ ...body, key: testKey(), height: HEIGHT });
  assert.equal(verifyBundleReceipt({ bundle: { ...bundle, ...forged }, serviceId: ARCADE, identityAtHeight }).valid, false);
  // Een andere hoogte dan in de handtekening.
  assert.match(verifyBundleReceipt({ bundle: { ...bundle, ackHeight: HEIGHT + 1 }, serviceId: ARCADE, identityAtHeight }).reason, /height/i);
  // Onbruikbare identiteit: fout wordt een reden, geen crash.
  assert.equal(verifyBundleReceipt({ bundle, serviceId: ARCADE, identityAtHeight: { identity: { identityaddress: PLAYER } } }).valid, false);
});

test('actie-bundel: naspelen met de regels tegen de onthulde puzzel (beide games)', () => {
  const nt = definition(NT_ROUND).puzzle;
  assert.deepEqual(replayActionBundle({ gameId: 'number-target', gameVersion: '1.0.0', actions: ['75+100', '2*(75+100)'] }, nt), { ok: true, status: 'solved', actionsUsed: 2, finished: true });
  assert.deepEqual(replayActionBundle({ gameId: 'number-target', gameVersion: '1.0.0', actions: ['75+100'] }, nt), { ok: true, status: 'unsolved', actionsUsed: 1, finished: false });
  // Een zet ná de oplossing kan niet: de regels weigeren hem.
  assert.equal(replayActionBundle({ gameId: 'number-target', gameVersion: '1.0.0', actions: ['2*(75+100)', '8*2'] }, nt).ok, false);
  assert.equal(replayActionBundle({ gameId: 'number-target', gameVersion: '1.0.0', actions: ['75+('] }, nt).ok, false);

  const wg = { answer: definition(WG_ROUND).answer };
  assert.deepEqual(replayActionBundle({ gameId: 'word-grid', gameVersion: '1.0.0', actions: ['crane', 'chain'] }, wg), { ok: true, status: 'solved', actionsUsed: 2, finished: true });
  assert.equal(replayActionBundle({ gameId: 'word-grid', gameVersion: '1.0.0', actions: ['crane', 'sloth', 'plumb', 'vexed', 'might', 'fjord'] }, wg).status, 'unsolved');
  assert.match(replayActionBundle({ gameId: 'onbekend', gameVersion: '1.0.0', actions: ['x'] }, wg).reason, /./);
});

test('actie-bundel: vergelijken met het officiële resultaatrecord', () => {
  const v3 = { schemaVersion: 3, roundId: NT_ROUND, playerIAddress: PLAYER, status: 'solved', actions: [{ sequence: 1, value: '75+100' }, { sequence: 2, value: '2*(75+100)' }] };
  assert.equal(bundleMatchesRecord(body, v3), true);
  assert.equal(bundleMatchesRecord({ ...body, actions: ['2*(75+100)'] }, v3), false);
  assert.equal(bundleMatchesRecord({ ...body, actions: [...body.actions].reverse() }, v3), false);
  assert.equal(bundleMatchesRecord({ ...body, player: OTHER_PLAYER }, v3), false);
  assert.equal(bundleMatchesRecord({ ...body, round: WG_ROUND }, v3), false);
  const v2 = { schemaVersion: 2, roundId: WG_ROUND, playerIAddress: PLAYER, status: 'solved', guesses: [{ sequence: 1, word: 'crane' }, { sequence: 2, word: 'chain' }] };
  assert.equal(bundleMatchesRecord({ round: WG_ROUND, player: PLAYER, actions: ['crane', 'chain'] }, v2), true);
  assert.equal(bundleMatchesRecord({ round: WG_ROUND, player: PLAYER, actions: ['crane'] }, v2), false);
  assert.equal(bundleMatchesRecord(body, {}), false);
});
