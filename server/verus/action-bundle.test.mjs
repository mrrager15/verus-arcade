import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { actionBundleKeyId, parseActionBundle, receiptHash, verifyBundleReceipt } from '../../shared/action-bundle.mjs';
import { VRSCTEST_CHAIN_ID } from '../../shared/chain-reader.mjs';
import { addressMatchesSalt } from '../../shared/round-key.mjs';
import { testIdentity, testKey } from '../../shared/testing/bundle-receipt.mjs';
import { recordActions } from '../attempt-actions.mjs';
import { ActionBundleError, actionBundleContentKey, buildSignedActionBundle, bundleActionValues, roundEncryptionAddress } from './action-bundle.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const { VerusIdInterface } = require('verusid-ts-client');

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const ROUND = 'number-target:1.0.0:2026-11-13';
const HEIGHT = 1_319_000;
const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:1');
const key = testKey();

/** Tekent een hash zoals `VerusRequests.signMmrRoot` dat doet (zelfde vorm, testsleutel). */
async function signHash(hashHex, { identityId = ARCADE } = {}) {
  const signaturedata = { version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: hashHex, identityid: identityId, signaturetype: 1 };
  const digest = P.SignatureData.fromJson({ ...signaturedata, signature: '' }).getIdentityHash({ version: 2, hash_type: 5, height: HEIGHT });
  const signature = await sdk.signHash(identityId, digest, key.toWIF(), testIdentity(identityId, key, HEIGHT), HEIGHT, VRSCTEST_CHAIN_ID);
  return { signaturedata: { ...signaturedata, signature }, signatureheight: HEIGHT };
}

test('bundel maken: key in de namespace van Arcade@, via naam en fqn gelijk', () => {
  const k = actionBundleContentKey({ roundId: ROUND, serviceId: ARCADE, serviceFqn: 'Arcade.VRSCTEST@' });
  assert.deepEqual(k, {
    name: `arcade.player.bundle.${ROUND}`, fqn: `Arcade.VRSCTEST.::arcade.player.bundle.${ROUND}`,
    keyId: actionBundleKeyId({ roundId: ROUND, serviceId: ARCADE }),
  });
  assert.throws(() => actionBundleContentKey({ roundId: 'geen ronde', serviceId: ARCADE, serviceFqn: 'Arcade.VRSCTEST@' }), ActionBundleError);
});

test('bundel maken: zetten uit de vorm van het resultaatrecord (beide schema’s)', () => {
  const entries = [{ sequence: 1, action: { type: 'action', payload: { value: '75+100' } } }, { sequence: 2, action: { type: 'action', payload: { value: '2*(75+100)' } } }];
  assert.deepEqual(bundleActionValues(recordActions(entries, { schemaVersion: 2 })), ['75+100', '2*(75+100)']);
  const guesses = [{ sequence: 1, action: { type: 'guess', payload: { word: 'crane' } } }, { sequence: 2, action: { type: 'guess', payload: { word: 'chain' } } }];
  assert.deepEqual(bundleActionValues(recordActions(guesses, { schemaVersion: 1 })), ['crane', 'chain']);
  assert.throws(() => bundleActionValues([{ sequence: 2, value: 'x' }]), /index 0/);
  assert.throws(() => bundleActionValues([{ sequence: 1 }]), /index 0/);
  assert.throws(() => bundleActionValues(null), /array/);
});

test('bundel maken: het versleuteladres van een ronde volgt uit de salt van de definitie', () => {
  const salt = 'a1e0aeda38d7280137d9b3cee05672155ea4ecc5de9c9980e849fa78a5b3a595';
  const address = roundEncryptionAddress({ salt });
  assert.equal(addressMatchesSalt(address, salt), true);
  assert.throws(() => roundEncryptionAddress({}), /salt/i);
});

test('bundel maken: met ontvangstbewijs, en de onafhankelijke controle aanvaardt het', async () => {
  const actions = ['75+100', '2*(75+100)'];
  const built = await buildSignedActionBundle({ roundId: ROUND, playerId: PLAYER, actions, serviceId: ARCADE, signHash });
  assert.equal(built.ackHeight, HEIGHT);
  assert.equal(built.receiptHash, receiptHash({ round: ROUND, player: PLAYER, actions }));
  assert.match(built.sha256, /^[0-9a-f]{64}$/);
  const bundle = parseActionBundle(built.json);
  assert.deepEqual([bundle.round, bundle.player, bundle.actions, bundle.ackHeight], [ROUND, PLAYER, actions, HEIGHT]);
  assert.deepEqual(verifyBundleReceipt({ bundle, serviceId: ARCADE, identityAtHeight: testIdentity(ARCADE, key, HEIGHT) }), { valid: true, reason: null });
  // Een andere sleutel op die hoogte: het bewijs is niets waard.
  assert.equal(verifyBundleReceipt({ bundle, serviceId: ARCADE, identityAtHeight: testIdentity(ARCADE, testKey(), HEIGHT) }).valid, false);

  // De ondertekenaar moet precies deze hash als de service-ID tekenen.
  await assert.rejects(buildSignedActionBundle({ roundId: ROUND, playerId: PLAYER, actions, serviceId: ARCADE, signHash: () => signHash('ab'.repeat(32)) }), /another hash/);
  await assert.rejects(buildSignedActionBundle({ roundId: ROUND, playerId: PLAYER, actions, serviceId: ARCADE, signHash: (h) => signHash(h, { identityId: PLAYER }) }), /another identity/);
  // Ongeldige invoer komt niet tot bij het tekenen.
  let signed = 0;
  const counting = (h) => { signed += 1; return signHash(h); };
  await assert.rejects(buildSignedActionBundle({ roundId: ROUND, playerId: 'speler@', actions, serviceId: ARCADE, signHash: counting }), ActionBundleError);
  await assert.rejects(buildSignedActionBundle({ roundId: ROUND, playerId: PLAYER, actions: [], serviceId: ARCADE, signHash: counting }), ActionBundleError);
  assert.equal(signed, 0);
});
