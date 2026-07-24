import assert from 'node:assert/strict';
import test from 'node:test';

import {
  POC_IDENTITY,
  assertSafeIdentity,
  assertVrsctest,
  requireAcknowledgement,
} from './config.mjs';
import {
  hexToUtf8,
  identityStateFingerprint,
  sha256Hex,
  utf8ToHex,
} from './storage.mjs';

test('UTF-8 values round-trip through hex without byte changes', () => {
  const source = 'Verus Arcade \u2014 VRSCTEST \u{1F579}\uFE0F';
  assert.equal(hexToUtf8(utf8ToHex(source)), source);
});

test('SHA-256 helper matches a stable vector', () => {
  assert.equal(
    sha256Hex('Verus Arcade'),
    'dd66bf3353f4a538a01f5d5e6f8b8801d6555a628e06db4eb5779c067beea9d4',
  );
});

test('testnet guard accepts only an explicit testnet response', () => {
  assert.doesNotThrow(() => assertVrsctest({ testnet: true }));
  assert.throws(() => assertVrsctest({ testnet: false }), /testnet=true/);
  assert.throws(() => assertVrsctest({}), /testnet=true/);
});

test('identity guard accepts only the dedicated PoC identity', () => {
  assert.doesNotThrow(() => assertSafeIdentity(POC_IDENTITY));
  assert.throws(() => assertSafeIdentity('Arcade@'), /non-PoC identity|Arcade@/);
  assert.throws(() => assertSafeIdentity('another-test@'), /non-PoC identity/);
});

test('write acknowledgement must match exactly', () => {
  const original = process.env.STORAGE_POC_ACK;
  try {
    process.env.STORAGE_POC_ACK = 'WRONG_ACK';
    assert.throws(
      () => requireAcknowledgement('EXPECTED_ACK'),
      /Refusing write/,
    );
    process.env.STORAGE_POC_ACK = 'EXPECTED_ACK';
    assert.doesNotThrow(() => requireAcknowledgement('EXPECTED_ACK'));
  } finally {
    if (original === undefined) delete process.env.STORAGE_POC_ACK;
    else process.env.STORAGE_POC_ACK = original;
  }
});

test('hex decoding rejects no bytes for deterministic UTF-8 fixtures', () => {
  for (const size of [1, 1024, 4096, 16384]) {
    const unit = 'VERUS-ARCADE-STORAGE-POC-BOUNDARY-V1\n';
    const source = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
    assert.equal(Buffer.byteLength(source, 'utf8'), size);
    assert.equal(Buffer.byteLength(hexToUtf8(utf8ToHex(source)), 'utf8'), size);
  }
});

test('identity fingerprint changes with its transaction anchor or content', () => {
  const baseline = {
    txid: 'a'.repeat(64),
    vout: 0,
    identity: {
      identityaddress: 'i-test',
      contentmultimap: { 'i-key': ['00'] },
    },
  };
  assert.equal(identityStateFingerprint(baseline), identityStateFingerprint(baseline));
  assert.notEqual(
    identityStateFingerprint(baseline),
    identityStateFingerprint({ ...baseline, txid: 'b'.repeat(64) }),
  );
  assert.notEqual(
    identityStateFingerprint(baseline),
    identityStateFingerprint({
      ...baseline,
      identity: {
        ...baseline.identity,
        contentmultimap: { 'i-key': ['01'] },
      },
    }),
  );
});
