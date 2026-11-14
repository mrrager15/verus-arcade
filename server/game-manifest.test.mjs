import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { GameManifestService } from './game-manifest-service.mjs';
import {
  TESTNET_SYSTEM_ID,
  attachDeveloperSignature,
  buildGameManifest,
  manifestKeyName,
  manifestMessage,
  manifestSignatureHash,
  readSignedManifest,
  rulesSha256,
} from './game-manifest.mjs';
import { gameRules } from '../shared/games/index.mjs';
import { VerusRequestError } from './verus/requests.mjs';

const DEV = 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g';
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const RULES_TEXT = fs.readFileSync('shared/games/number-target/1.0.0/rules.mjs', 'utf8');

test('manifest: regels-hash is gelijk met CRLF en LF', () => {
  const lf = RULES_TEXT.replace(/\r\n/g, '\n');
  assert.equal(rulesSha256(lf), rulesSha256(lf.replace(/\n/g, '\r\n')));
  assert.notEqual(rulesSha256(lf), rulesSha256(`${lf}// gewijzigd\n`));
  assert.equal(manifestKeyName('number-target'), 'Arcade::game.number-target.manifest.v1');
});

test('manifest: bouwen, bericht en handtekening horen bij precies dit manifest', () => {
  const manifest = buildGameManifest({ rules: gameRules('number-target', '1.0.0'), rulesText: RULES_TEXT, developer: DEV });
  assert.deepEqual(Object.keys(manifest), ['schema', 'version', 'slug', 'name', 'gameVersion', 'contract', 'maxActions', 'rulesPath', 'rulesSha256', 'developer']);
  assert.equal(manifest.rulesPath, 'shared/games/number-target/1.0.0/rules.mjs');
  const lines = manifestMessage(manifest).split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Verus Arcade game manifest v1');
  assert.equal(lines[1], 'game:number-target@1.0.0');
  assert.match(lines[3], /^manifest:sha256:[0-9a-f]{64}$/);
  const sd = { version: 1, systemid: TESTNET_SYSTEM_ID, hashtype: 5, signaturehash: manifestSignatureHash(manifest), identityid: DEV, signaturetype: 1, signature: 'AQ==' };
  const signed = attachDeveloperSignature(manifest, { signaturedata: sd, signatureheight: 100 });
  assert.equal(readSignedManifest(signed).message, manifestMessage(manifest));
  // Andere ondertekenaar, ander manifest of ander netwerk wordt geweigerd.
  assert.throws(() => attachDeveloperSignature(manifest, { signaturedata: { ...sd, identityid: ARCADE }, signatureheight: 100 }), /different identity/);
  assert.throws(() => readSignedManifest({ ...signed, maxActions: 6 }), /does not cover/);
  assert.throws(() => readSignedManifest({ ...signed, rulesSha256: '00'.repeat(32) }), /does not cover/);
  assert.throws(() => attachDeveloperSignature(manifest, { signaturedata: { ...sd, systemid: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yX' }, signatureheight: 100 }), /Unsupported/);
  assert.throws(() => buildGameManifest({ rules: gameRules('number-target', '1.0.0'), rulesText: RULES_TEXT, developer: 'Arcade@' }), /i-address/);
});

/** Nep-wallet-laag: "tekent" door de hash te bewaren; verifieert door te vergelijken. */
function fakeVerus() {
  const signedHashes = new Set();
  return {
    serviceId: ARCADE,
    async signMmrRoot(hash) {
      signedHashes.add(`${ARCADE}:${hash}`);
      return { signaturedata: { version: 1, systemid: TESTNET_SYSTEM_ID, hashtype: 5, signaturehash: hash, identityid: ARCADE, signaturetype: 1, signature: 'c2ln' }, signatureheight: 1000 };
    },
    async createSignRequest({ message, requestIdHex }) {
      return { requestHex: Buffer.from(message).toString('hex'), walletUri: `verus://${requestIdHex}`, height: 900 };
    },
    async verifySignResponse({ body, message, expectedSigner }) {
      if (body.toString() !== 'goedgekeurd') throw new VerusRequestError('INVALID_SIGNATURE', 'Invalid wallet response signature.');
      const hash = crypto.createHash('sha256').update(message).digest('hex');
      signedHashes.add(`${expectedSigner}:${hash}`);
      return { identityId: expectedSigner, nativeSignature: 'bW9iaWxl', signingHeight: 950, name: 'mrrager' };
    },
    async verifyHashSignature({ signaturedata, signatureheight }) {
      if (!signedHashes.has(`${signaturedata.identityid}:${signaturedata.signaturehash}`)) throw new Error('Invalid signature.');
      return { valid: true, identityId: signaturedata.identityid, signatureHeight: signatureheight };
    },
  };
}

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const service = new GameManifestService({ repository, verusRequests: fakeVerus(), origin: 'http://192.168.0.240:8100', createRequestIdHex: () => 'ab'.repeat(20) });
  return { database, repository, service };
}

test('manifest-service: Arcade@ tekent zelf (Word Grid)', async () => {
  const { database, service } = setup();
  const row = await service.signAsService({ slug: 'word-grid', version: '1.0.0' });
  assert.equal(row.status, 'signed');
  assert.equal(row.signed.developer, ARCADE);
  const check = await service.verifySigned(row.signed);
  assert.equal(check.rulesMatch, true);
  // Een gewijzigd regelbestand past niet meer bij het manifest.
  await assert.rejects(service.verifySigned(row.signed, { rulesText: 'export const meta = {};' }), /does not match/);
  database.close();
});

test('manifest-service: externe ontwikkelaar tekent via de wallet (Number Target)', async () => {
  const { database, repository, service } = setup();
  const pending = await service.createDeveloperRequest({ slug: 'number-target', version: '1.0.0', developer: DEV });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.walletUri, `verus://${'ab'.repeat(20)}`);
  assert.equal(service.callbackUrl('ab'.repeat(20)), `http://192.168.0.240:8100/api/v1/manifest-jobs/${'ab'.repeat(20)}/response`);
  await assert.rejects(service.acceptResponse({ requestIdHex: 'ab'.repeat(20), body: Buffer.from('vervalst') }), (error) => error.httpStatus === 422);
  await assert.rejects(service.acceptResponse({ requestIdHex: 'cd'.repeat(20), body: Buffer.from('goedgekeurd') }), (error) => error.code === 'MANIFEST_REQUEST_NOT_FOUND');
  const accepted = await service.acceptResponse({ requestIdHex: 'ab'.repeat(20), body: Buffer.from('goedgekeurd') });
  assert.deepEqual([accepted.replayed, accepted.status], [false, 'signed']);
  assert.equal(accepted.manifest.developer, DEV);
  assert.equal(accepted.manifest.developerSignature.signatureheight, 950);
  const again = await service.acceptResponse({ requestIdHex: 'ab'.repeat(20), body: Buffer.from('goedgekeurd') });
  assert.equal(again.replayed, true);
  // Een getekend manifest wordt nooit stil vervangen.
  await assert.rejects(service.createDeveloperRequest({ slug: 'number-target', version: '1.0.0', developer: DEV }), (error) => error.code === 'GAME_MANIFEST_SIGNED');
  assert.equal(repository.listGameManifests().length, 1);
  database.close();
});
