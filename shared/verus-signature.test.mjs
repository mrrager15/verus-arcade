import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import {
  decodeBase58Check, identitySignatureDigest, parseIdentitySignature, SignatureCheckError, verifyIdentitySignature,
} from './verus-signature.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const utxo = require('@bitgo/utxo-lib');
const { VerusIdInterface } = require('verusid-ts-client');

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/arcade-signatures.json', import.meta.url), 'utf8'));
const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:1'); // geen RPC nodig: identiteit wordt meegegeven
const clone = (v) => structuredClone(v);
const sdkDigest = (sd, height, version = 2) => P.SignatureData.fromJson({ ...sd, signature: '' }).getIdentityHash({ version, hash_type: 5, height });

test('handtekening: vier echte handtekeningen van Arcade@ kloppen, zoals de SDK zegt', async () => {
  assert.equal(vectors.cases.length, 4);
  for (const c of vectors.cases) {
    assert.equal(c.sdkValid, true);
    const digest = identitySignatureDigest({ version: 2, systemId: c.signaturedata.systemid, height: c.signatureheight, identityId: c.signaturedata.identityid, signatureHash: c.signaturedata.signaturehash });
    assert.equal(Buffer.from(digest).toString('hex'), c.digestHex, 'digest = SDK-digest');
    const result = verifyIdentitySignature({ signaturedata: c.signaturedata, signatureheight: c.signatureheight, identityAtHeight: c.identityAtHeight });
    assert.deepEqual(result, { valid: true, reason: null, signer: ARCADE, height: c.signatureheight, signers: 1, required: 1 });
  }
});

test('handtekening: vervalsingen worden geweigerd', () => {
  const c = vectors.cases[0];
  const check = (changes = {}) => verifyIdentitySignature({ signaturedata: clone(c.signaturedata), signatureheight: c.signatureheight, identityAtHeight: clone(c.identityAtHeight), ...changes });
  const otherRoot = { ...c.signaturedata, signaturehash: (c.signaturedata.signaturehash[0] === 'a' ? 'b' : 'a') + c.signaturedata.signaturehash.slice(1) };
  assert.deepEqual([check({ signaturedata: otherRoot }).valid, check({ signaturedata: otherRoot }).reason], [false, 'Signature is not from a key of this identity']);
  assert.equal(check({ signatureheight: c.signatureheight + 1 }).reason, 'Signature height mismatch');
  const revoked = clone(c.identityAtHeight); revoked.identity.flags |= 0x8000;
  assert.match(check({ identityAtHeight: revoked }).reason, /not active/);
  const inactive = clone(c.identityAtHeight); inactive.status = 'revoked';
  assert.equal(check({ identityAtHeight: inactive }).valid, false);
  const otherKey = clone(c.identityAtHeight); otherKey.identity.primaryaddresses = [utxo.ECPair.makeRandom({ network: utxo.networks.verus }).getAddress()];
  assert.equal(check({ identityAtHeight: otherKey }).valid, false);
  const twoNeeded = clone(c.identityAtHeight); twoNeeded.identity.minimumsignatures = 2;
  assert.equal(check({ identityAtHeight: twoNeeded }).reason, 'Not enough signatures');
  // één bit in s omgedraaid
  const bytes = Buffer.from(c.signaturedata.signature, 'base64'); bytes[bytes.length - 1] ^= 1;
  assert.equal(check({ signaturedata: { ...c.signaturedata, signature: bytes.toString('base64') } }).valid, false);
  // vormfouten gooien
  assert.throws(() => check({ signaturedata: { ...c.signaturedata, systemid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV' } }), (e) => e.code === 'UNSUPPORTED_NETWORK');
  const otherIdentity = clone(c.identityAtHeight); otherIdentity.identity.identityaddress = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
  assert.throws(() => check({ identityAtHeight: otherIdentity }), SignatureCheckError);
  const newer = clone(c.identityAtHeight); newer.blockheight = c.signatureheight + 10;
  assert.throws(() => check({ identityAtHeight: newer }), /newer/);
  assert.throws(() => check({ signaturedata: { ...c.signaturedata, signature: Buffer.concat([Buffer.from(c.signaturedata.signature, 'base64'), Buffer.from([0])]).toString('base64') } }), /Trailing/);
  assert.throws(() => check({ signaturedata: { ...c.signaturedata, hashtype: 1 } }), /Unsupported/);
});

test('handtekening: nieuwe handtekeningen van de SDK (gecomprimeerd, ongecomprimeerd, twee ondertekenaars, versie 1)', async () => {
  const height = 1_318_000;
  const root = 'ab'.repeat(32);
  const sd = { version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: root, identityid: ARCADE, signaturetype: 1 };
  const identityWith = (addresses, minimumsignatures = 1) => ({
    status: 'active', blockheight: height - 5,
    identity: { identityaddress: ARCADE, systemid: VRSCTEST_CHAIN_ID, version: 3, flags: 0, primaryaddresses: addresses, minimumsignatures },
  });
  for (const compressed of [true, false]) {
    const key = utxo.ECPair.makeRandom({ network: utxo.networks.verus, compressed });
    const identity = identityWith([key.getAddress()]);
    const signature = await sdk.signHash(ARCADE, sdkDigest(sd, height), key.toWIF(), identity, height, VRSCTEST_CHAIN_ID);
    assert.equal(await sdk.verifyHash(ARCADE, signature, sdkDigest(sd, height), identity, VRSCTEST_CHAIN_ID), true);
    const ours = verifyIdentitySignature({ signaturedata: { ...sd, signature }, signatureheight: height, identityAtHeight: identity });
    assert.equal(ours.valid, true, `gecomprimeerd: ${compressed}`);
  }

  // Twee ondertekenaars (2 van 3), rechtstreeks met utxo-lib, en versie 1 van de digest.
  const keys = [0, 1, 2].map(() => utxo.ECPair.makeRandom({ network: utxo.networks.verus }));
  for (const version of [1, 2]) {
    const sig = new utxo.IdentitySignature(utxo.networks.verus, version, 5, height, null, VRSCTEST_CHAIN_ID, ARCADE);
    const digest = sdkDigest(sd, height, version);
    sig.signHashOffline(digest, keys[0]);
    sig.signHashOffline(digest, keys[2]);
    // utxo-lib `toBuffer` rekent bij meer dan één handtekening te weinig ruimte (de lengtebytes
    // ontbreken); daarom de bytes zelf schrijven zoals `fromBuffer` ze leest.
    const height4 = Buffer.alloc(4); height4.writeUInt32LE(height);
    const signature = Buffer.concat([
      Buffer.from(version === 2 ? [2, 5] : [1]), height4, Buffer.from([sig.signatures.length]),
      ...sig.signatures.flatMap((s) => [Buffer.from([s.length]), s]),
    ]).toString('base64');
    const parsed = parseIdentitySignature(signature);
    assert.deepEqual([parsed.version, parsed.height, parsed.signatures.length], [version, height, 2]);
    const twoOfThree = identityWith(keys.map((k) => k.getAddress()), 2);
    assert.equal(await sdk.verifyHash(ARCADE, signature, digest, twoOfThree, VRSCTEST_CHAIN_ID), true);
    assert.equal(verifyIdentitySignature({ signaturedata: { ...sd, signature }, signatureheight: height, identityAtHeight: twoOfThree }).valid, true, `2 van 3, versie ${version}`);
    const threeOfThree = identityWith(keys.map((k) => k.getAddress()), 3);
    assert.equal(await sdk.verifyHash(ARCADE, signature, digest, threeOfThree, VRSCTEST_CHAIN_ID), false);
    assert.equal(verifyIdentitySignature({ signaturedata: { ...sd, signature }, signatureheight: height, identityAtHeight: threeOfThree }).valid, false);
  }
});

test('base58check: adressen en checksum', () => {
  assert.deepEqual([...decodeBase58Check(ARCADE).hash].length, 20);
  assert.equal(decodeBase58Check(ARCADE).version, 102);
  assert.equal(decodeBase58Check('R9txC8e9jmbCdyuSAgRofxqA9nN2qnUHHp').version, 60);
  assert.equal(Buffer.from(decodeBase58Check(ARCADE).hash).toString('hex'), Buffer.from(utxo.address.fromBase58Check(ARCADE).hash).toString('hex'));
  assert.throws(() => decodeBase58Check('i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLq'), /checksum/);
  assert.throws(() => decodeBase58Check('i4hk0'), /Invalid address/);
});
