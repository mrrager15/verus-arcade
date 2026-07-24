import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from './canonical-json.mjs';

test('canonical JSON sorts object keys recursively without changing array order', () => {
  assert.equal(
    canonicalJson({ z: 1, a: { y: 2, b: 3 }, list: [3, 2, 1] }),
    '{"a":{"b":3,"y":2},"list":[3,2,1],"z":1}',
  );
});

test('canonical JSON is independent of insertion order', () => {
  assert.equal(
    canonicalJson({ answer: 'crane', schemaVersion: 1 }),
    canonicalJson({ schemaVersion: 1, answer: 'crane' }),
  );
});

test('canonical JSON rejects non-finite and unsupported values', () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), /non-finite/);
  assert.throws(() => canonicalJson({ value: undefined }), /unsupported/);
});
