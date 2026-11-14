import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from './canonical-json.mjs';
import { canonicalJson as serverCanonicalJson } from '../server/canonical-json.mjs';
import { verifyRoundReveal as serverVerifyRoundReveal } from '../server/round-proof.mjs';
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
  assert.throws(() => validateCommitment({ ...commitment, schemaVersion: 2 }), /schema version 1/);
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

test('canonieke JSON: één versie, server verwijst ernaar', () => {
  assert.equal(serverCanonicalJson, canonicalJson);
  assert.equal(canonicalJson({ b: [1, { d: null, c: 'é' }], a: true }), '{"a":true,"b":[1,{"c":"é","d":null}]}');
  assert.throws(() => canonicalJson({ a: undefined }), /unsupported/);
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
});
