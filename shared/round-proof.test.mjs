import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from './canonical-json.mjs';
import { canonicalJson as serverCanonicalJson } from '../server/canonical-json.mjs';
import { verifyRoundReveal as serverVerifyRoundReveal } from '../server/round-proof.mjs';
import { roundKeyFromSalt } from './round-key.mjs';
import {
  RESULT_ALGORITHM, validateCommitment, validateResultDescriptor, verifyRoundReveal, verifyRoundRevealSync,
} from './round-proof.mjs';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/round-reveal-vectors.json', import.meta.url), 'utf8'));
const sha256Hex = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const real = vectors.cases.filter((c) => c.name.startsWith('echt: '));

test('rondebewijs: gedeelde code geeft exact de uitkomst van de oude serverversie (31 vectoren)', async () => {
  assert.equal(vectors.cases.length, 31);
  for (const c of vectors.cases) {
    const input = { commitment: c.commitment, reveal: c.reveal };
    const sync = verifyRoundRevealSync(structuredClone(input), sha256Hex);
    const async = await verifyRoundReveal(structuredClone(input), async (text) => sha256Hex(text));
    assert.equal(sync.valid, c.expectedServer, `${c.name} (sync)`);
    assert.deepEqual(async, sync, `${c.name} (async = sync)`);
    assert.equal(serverVerifyRoundReveal(structuredClone(input)), c.expectedServer, `${c.name} (server-schil)`);
    // Dezelfde hash als de oude browserversie toonde (waar die er een berekende).
    if (typeof c.expectedBrowser === 'boolean') assert.equal(sync.recomputedSha256, c.recomputedSha256, `${c.name} (hash)`);
    assert.equal(sync.reason === null, sync.valid, `${c.name}: reden alleen bij ongeldig`);
  }
});

test('rondebewijs: de negen echte rondes van Arcade@ (8–13 nov, beide games) zijn geldig', () => {
  assert.deepEqual(real.map((c) => c.commitment.roundId), [
    'number-target:1.0.0:2026-11-11', 'number-target:1.0.0:2026-11-12', 'number-target:1.0.0:2026-11-13',
    'word-grid:1.0.0:2026-11-08', 'word-grid:1.0.0:2026-11-09', 'word-grid:1.0.0:2026-11-10',
    'word-grid:1.0.0:2026-11-11', 'word-grid:1.0.0:2026-11-12', 'word-grid:1.0.0:2026-11-13',
  ]);
  for (const c of real) {
    assert.equal(c.expectedServer, true);
    validateCommitment(c.commitment);
  }
});

test('rondebewijs: de vier gevallen waarin de oude browserversie soepeler was, zijn nu ongeldig', () => {
  const differ = vectors.cases.filter((c) => c.expectedServer !== c.expectedBrowser).map((c) => c.name);
  assert.deepEqual(differ, [
    'v1: commitment-schema 2', 'v1: reveal zonder definitie', 'v1 vorm: chainId als getal (hash klopt)', 'v1 vorm: lege chainId (hash klopt)',
  ]);
  const byName = Object.fromEntries(vectors.cases.map((c) => [c.name, c]));
  assert.equal(verifyRoundRevealSync(byName['v1: commitment-schema 2'], sha256Hex).reason, 'commitment');
  assert.deepEqual(verifyRoundRevealSync(byName['v1: reveal zonder definitie'], sha256Hex), { valid: false, recomputedSha256: null, reason: 'reveal' });
  assert.equal(verifyRoundRevealSync(byName['v1 vorm: lege chainId (hash klopt)'], sha256Hex).reason, 'definition');
  assert.equal(verifyRoundRevealSync(byName['v1: ander antwoord'], sha256Hex).reason, 'hash');
  assert.equal(verifyRoundRevealSync(byName['v1: commitment voor een andere ronde'], sha256Hex).reason, 'metadata');
});

test('rondebewijs: commitment- en result-descriptor-vorm', () => {
  const commitment = real[0].commitment;
  // Sinds fase 5 bestaat schema 2, maar alleen mét het versleuteladres (zie de test hieronder).
  assert.throws(() => validateCommitment({ ...commitment, schemaVersion: 2 }), /schema version 2/);
  assert.throws(() => validateCommitment({ ...commitment, schemaVersion: 3 }), /schema version 1/);
  assert.throws(() => validateCommitment({ ...commitment, extra: 1 }), /schema version 1/);
  assert.throws(() => validateCommitment({ ...commitment, hiddenDefinitionSha256: 'ab' }), /schema version 1/);
  assert.throws(() => validateCommitment({ ...commitment, closesAt: commitment.opensAt }), /timestamps/);

  const descriptor = {
    schemaVersion: 1, algorithm: RESULT_ALGORITHM, roundId: commitment.roundId, chainId: commitment.chainId,
    gameId: commitment.gameId, gameVersion: commitment.gameVersion, leafCount: 1, rootSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
  };
  validateResultDescriptor(descriptor, commitment);
  validateResultDescriptor({ ...descriptor, leafCount: 0 });
  assert.throws(() => validateResultDescriptor({ ...descriptor, roundId: 'word-grid:1.0.0:2026-01-01' }, commitment), /another round/);
  assert.throws(() => validateResultDescriptor({ ...descriptor, algorithm: 'md5' }), /schema version 1/);
  assert.throws(() => validateResultDescriptor({ ...descriptor, leafCount: -1 }), /schema version 1/);
  assert.throws(() => validateResultDescriptor({ ...descriptor, leafCount: 1.5 }), /schema version 1/);
  assert.throws(() => validateResultDescriptor({ ...descriptor, extra: true }), /schema version 1/);
});

test('rondebewijs: commitment-schema 2 (fase 5) met het versleuteladres uit de salt', async () => {
  // Elke echte ronde opnieuw, nu met schema 2: het adres dat bij haar eigen salt hoort.
  for (const c of real) {
    const salt = c.reveal.hiddenDefinition.salt;
    const { address } = roundKeyFromSalt(salt);
    const commitment = { ...c.commitment, schemaVersion: 2, roundEncryptionAddress: address };
    validateCommitment(commitment);
    const input = { commitment, reveal: c.reveal };
    const sync = verifyRoundRevealSync(structuredClone(input), sha256Hex);
    // De definitie en dus de hash veranderen niet: alleen de commitment kreeg een veld erbij.
    assert.deepEqual(sync, { valid: true, recomputedSha256: c.commitment.hiddenDefinitionSha256, reason: null }, c.name);
    assert.deepEqual(await verifyRoundReveal(structuredClone(input), async (text) => sha256Hex(text)), sync, c.name);
    assert.equal(serverVerifyRoundReveal(structuredClone(input)), true, c.name);
  }

  const c = real[0];
  const right = roundKeyFromSalt(c.reveal.hiddenDefinition.salt).address;
  const other = roundKeyFromSalt('ab'.repeat(32)).address;
  const v2 = { ...c.commitment, schemaVersion: 2, roundEncryptionAddress: right };
  const check = (commitment, reveal = c.reveal) => verifyRoundRevealSync({ commitment, reveal }, sha256Hex);

  // Een geldig adres dat NIET uit de salt volgt: de operator kan de bundels niet laten lezen.
  validateCommitment({ ...v2, roundEncryptionAddress: other });
  assert.deepEqual(check({ ...v2, roundEncryptionAddress: other }), { valid: false, recomputedSha256: c.commitment.hiddenDefinitionSha256, reason: 'encryption-address' });
  assert.equal(serverVerifyRoundReveal({ commitment: { ...v2, roundEncryptionAddress: other }, reveal: c.reveal }), false);
  // De hash gaat voor: een andere definitie is 'hash', wat het adres ook is.
  const tampered = { ...c.reveal, hiddenDefinition: { ...c.reveal.hiddenDefinition, salt: 'cd'.repeat(32) } };
  assert.equal(check(v2, tampered).reason, 'hash');
  assert.equal(check({ ...v2, roundEncryptionAddress: roundKeyFromSalt('cd'.repeat(32)).address }, tampered).reason, 'hash');

  // Vorm: schema 2 zonder adres, met een kapot adres, of schema 1 mét adres.
  const badChecksum = right.slice(0, -1) + (right.endsWith('q') ? 'p' : 'q');
  for (const bad of [undefined, '', 42, 'zs1abc', badChecksum, right.toUpperCase()]) {
    const commitment = { ...v2, roundEncryptionAddress: bad };
    if (bad === undefined) delete commitment.roundEncryptionAddress;
    assert.throws(() => validateCommitment(commitment), /schema version 2/, String(bad));
    assert.equal(check(commitment).reason, 'commitment', String(bad));
  }
  assert.throws(() => validateCommitment({ ...v2, extra: 1 }), /schema version 2/);
  assert.throws(() => validateCommitment({ ...c.commitment, roundEncryptionAddress: right }), /schema version 1/, 'schema 1 kent het veld niet');
  // Schema 1 blijft precies wat het was: geen adres, geen adrescontrole.
  assert.deepEqual(check(c.commitment), { valid: true, recomputedSha256: c.commitment.hiddenDefinitionSha256, reason: null });
});

test('canonieke JSON: één versie, server verwijst ernaar', () => {
  assert.equal(serverCanonicalJson, canonicalJson);
  assert.equal(canonicalJson({ b: [1, { d: null, c: 'é' }], a: true }), '{"a":true,"b":[1,{"c":"é","d":null}]}');
  assert.throws(() => canonicalJson({ a: undefined }), /unsupported/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
});
