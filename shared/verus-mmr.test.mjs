import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import {
  bytesToHex, decodeMmrHashes, encodeMmrHashes, hexToBytes, mmrRoot, saltedLeafHash, verifyMmrDisclosure,
} from './verus-mmr.mjs';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/signdata-mmr-2026-11-09.json', import.meta.url), 'utf8'));
const sha256 = (bytes) => new Uint8Array(crypto.createHash('sha256').update(bytes).digest());
const sha256Pair = (l, r) => sha256(Buffer.concat([l, r]));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('verus-mmr: bladeren en wortel = uitvoer van de daemon (signdata 9 nov)', () => {
  const d = fixture.mmrdescriptor;
  const leaves = d.datadescriptors.map((dd) => saltedLeafHash(hexToBytes(dd.objectdata), hexToBytes(dd.salt), sha256));
  assert.deepEqual(decodeMmrHashes(d.mmrhashes.objectdata).map(bytesToHex), leaves.map(bytesToHex));
  assert.equal(bytesToHex(mmrRoot(leaves, sha256Pair)), d.mmrroot.objectdata);
  assert.equal(encodeMmrHashes(leaves), d.mmrhashes.objectdata);
  assert.equal(d.mmrroot.objectdata, fixture.signaturedata.signaturehash);
});

test('verus-mmr: volledige en gedeeltelijke openbaarmaking', () => {
  const full = verifyMmrDisclosure(fixture.mmrdescriptor, { sha256 });
  assert.equal(full.root, fixture.mmrdescriptor.mmrroot.objectdata);
  assert.deepEqual(full.disclosed.map((x) => [x.index, Buffer.from(x.data).toString()]), [[0, 'streak:1'], [1, 'rating:1500'], [2, 'rounds:1']]);
  const partial = clone(fixture.mmrdescriptor);
  partial.datadescriptors = [partial.datadescriptors[1]];
  const one = verifyMmrDisclosure(partial, { sha256 });
  assert.deepEqual(one.disclosed.map((x) => [x.index, Buffer.from(x.data).toString()]), [[1, 'rating:1500']]);
  assert.equal(one.leafCount, 3);
  const none = clone(fixture.mmrdescriptor);
  delete none.datadescriptors;
  assert.deepEqual(verifyMmrDisclosure(none, { sha256 }).disclosed, []);
});

test('verus-mmr: knoeien faalt', () => {
  const variants = {
    'andere waarde': (d) => { d.datadescriptors[0].objectdata = bytesToHex(Buffer.from('streak:9')); },
    'ander zout': (d) => { d.datadescriptors[0].salt = '00' + d.datadescriptors[0].salt.slice(2); },
    'geen zout': (d) => { delete d.datadescriptors[0].salt; d.datadescriptors[0].flags = 0; },
    'blad vervangen': (d) => { const l = decodeMmrHashes(d.mmrhashes.objectdata); l[2] = new Uint8Array(32).fill(7); d.mmrhashes.objectdata = encodeMmrHashes(l); },
    'blad weggelaten': (d) => { d.mmrhashes.objectdata = encodeMmrHashes(decodeMmrHashes(d.mmrhashes.objectdata).slice(0, 2)); },
    'andere wortel': (d) => { d.mmrroot.objectdata = 'ff' + d.mmrroot.objectdata.slice(2); },
    'blake2b-mmr': (d) => { d.mmrhashtype = 3; },
    'versleuteld': (d) => { d.mmrhashes.flags = 1; },
    'verkeerde key': (d) => { d.mmrhashes.objectdata = '00' + d.mmrhashes.objectdata.slice(2); },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const d = clone(fixture.mmrdescriptor);
    mutate(d);
    assert.throws(() => verifyMmrDisclosure(d, { sha256 }), Error, name);
  }
});

test('verus-mmr: zelfde wortel als de MMR van verus-typescript-primitives (blake2b, 1–40 bladeren)', () => {
  const { MerkleMountainRange, MerkleMountainView, MMRNode } = require('verus-typescript-primitives/dist/pbaas/MMR.js');
  const blake2b = require('blake2b');
  const verusHash = (bytes) => blake2b(32, null, null, Buffer.from('VerusDefaultHash')).update(bytes).digest(Buffer.alloc(32));
  const pair = (l, r) => new Uint8Array(verusHash(Buffer.concat([l, r])));
  for (let n = 1; n <= 40; n++) {
    const leaves = Array.from({ length: n }, () => new Uint8Array(crypto.randomBytes(32)));
    const sdk = new MerkleMountainRange();
    for (const leaf of leaves) sdk.add(new MMRNode(Buffer.from(leaf)));
    assert.equal(bytesToHex(mmrRoot(leaves, pair)), new MerkleMountainView(sdk).getRoot().toString('hex'), `n=${n}`);
  }
});

test('verus-mmr: handtekening van Arcade@ op de wortel verifieert offline (SDK, versie 2)', () => {
  const P = require('verus-typescript-primitives');
  const { IdentitySignature, networks } = require('@bitgo/utxo-lib');
  const verify = (signaturedata) => {
    const sd = P.SignatureData.fromJson(signaturedata);
    const digest = sd.getIdentityHash({ version: 2, hash_type: 5, height: fixture.signatureheight });
    const sig = new IdentitySignature(networks.verus);
    sig.fromBuffer(sd.signatureAsVch, 0, sd.systemID, sd.identityID);
    return sig.verifyHashOffline(digest, fixture.signerPrimaryAddress);
  };
  assert.deepEqual(verify(fixture.signaturedata), [true]);
  assert.deepEqual(verify({ ...fixture.signaturedata, signaturehash: '00' + fixture.signaturedata.signaturehash.slice(2) }), [false]);
});
