import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

import { addressMatchesSalt, parseSaplingAddress, RoundKeyError, roundKeyFromSalt, SAPLING_ADDRESS_PATTERN, saplingAddress } from './round-key.mjs';
import { mobileRecord, sealedRecord, transactionWithEvidence } from './testing/mobile-record.mjs';
import { bytesToHex, DecryptError, hexToBytes, openEvidence, openReference, readMobileRecord } from './verus-decrypt.mjs';

const P = createRequire(import.meta.url)('verus-typescript-primitives');
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/round-key-bundle.json', import.meta.url), 'utf8'));
const isDecryptError = (pattern) => (e) => e instanceof DecryptError && pattern.test(e.message);
const TXID = 'ab'.repeat(32);

test('ronde-sleutel: vaste vectoren (de afleiding mag nooit stil veranderen)', () => {
  const vectors = [
    ['00'.repeat(32), 'zs120ujf424959xls0usdcz47xmu2gtf5n8a2r7rge30q6ydftlwvrxspf904ptj74u6kqxwugam6h', '54d82c100e7be4f783adde10fe87279678477997ceb1a01c8f886a17f4790e04'],
    ['ff'.repeat(32), 'zs15t5hghfgga0dyhe07fe4jxeh6pllejgyff0x2lj8443v2pmddqlysmg70227wwklshya2vr9uku', 'be1f4b4986ae476e72feeba3e49f3f4e529e91ae7336d93e9e4e089e65f7fc03'],
    [fixture.salt, fixture.address, fixture.ivk],
  ];
  for (const [salt, address, ivk] of vectors) {
    const key = roundKeyFromSalt(salt);
    assert.equal(key.address, address);
    assert.equal(key.ivkHex, ivk);
    assert.equal(key.ivk[31] & 0xf8, 0, 'ivk is 251 bits');
    assert.match(key.address, SAPLING_ADDRESS_PATTERN);
    assert.equal(addressMatchesSalt(address, salt), true);
  }
  assert.equal(addressMatchesSalt(vectors[0][1], vectors[1][0]), false);
  assert.equal(addressMatchesSalt('zs1nope', vectors[0][0]), false);
  for (const bad of [undefined, '', 'ab', 'AB'.repeat(32), 'zz'.repeat(32), '00'.repeat(33)]) {
    assert.throws(() => roundKeyFromSalt(bad), RoundKeyError);
  }
});

test('ronde-sleutel: adres is hetzelfde Sapling-adres als de SDK maakt en leest', () => {
  for (let i = 0; i < 40; i++) {
    const key = roundKeyFromSalt(crypto.randomBytes(32).toString('hex'));
    assert.equal(new P.SaplingPaymentAddress({ d: Buffer.from(key.diversifier), pkD: Buffer.from(key.pkd) }).toAddressString(), key.address);
    const sdk = P.SaplingPaymentAddress.fromAddressString(key.address);
    const own = parseSaplingAddress(key.address);
    assert.deepEqual([bytesToHex(own.diversifier), bytesToHex(own.pkd)], [sdk.d.toString('hex'), sdk.pkD.toString('hex')]);
    assert.equal(saplingAddress(own.diversifier, own.pkd), key.address);
  }
  const { address } = roundKeyFromSalt('11'.repeat(32));
  const swapped = address.slice(0, 20) + (address[20] === 'q' ? 'p' : 'q') + address.slice(21);
  assert.throws(() => parseSaplingAddress(swapped), /checksum/);
  assert.throws(() => parseSaplingAddress(address.toUpperCase()), /Not a Sapling address/);
  assert.throws(() => parseSaplingAddress(address.slice(0, -1)), /Not a Sapling address/);
  assert.throws(() => saplingAddress(new Uint8Array(10), new Uint8Array(32)), RoundKeyError);
});

test('ronde-sleutel: wat een echte daemon naar het adres versleutelde, opent met de ivk uit de salt', async () => {
  const key = roundKeyFromSalt(fixture.salt);
  const reference = fixture.value['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
  assert.equal(reference.flags, 5, 'versleuteld + epk, geen viewing key in de ID');
  assert.equal('ivk' in reference, false);
  // Zonder sleutel is er niets te lezen; met de verkeerde ook niet.
  assert.throws(() => openReference(fixture.value), isDecryptError(/viewing key/));
  assert.throws(() => openReference(fixture.value, { ivk: roundKeyFromSalt('22'.repeat(32)).ivk }), isDecryptError(/Decryption failed/));
  const opened = openReference(fixture.value, { ivk: key.ivk });
  assert.deepEqual([opened.ivkPublished, opened.ref.sameTransaction, opened.ref.vout, opened.ref.objectNum], [false, true, fixture.vout, fixture.objectNum]);
  const record = openEvidence(fixture.evidenceHex, key.ivk);
  assert.deepEqual({ objectdata: bytesToHex(record.bytes), salt: bytesToHex(record.salt) }, fixture.expected);
  assert.equal(new TextDecoder().decode(record.bytes), fixture.message);

  const getTransaction = async () => transactionWithEvidence(TXID, fixture.evidenceHex);
  const read = await readMobileRecord({ value: fixture.value, updateTxid: TXID, ivk: key.ivk, getTransaction });
  assert.equal(new TextDecoder().decode(read.bytes), fixture.message);
  assert.equal(read.ivkPublished, false);
  await assert.rejects(readMobileRecord({ value: fixture.value, updateTxid: TXID, getTransaction }), isDecryptError(/viewing key/));
});

test('ronde-sleutel: heen en terug voor willekeurige salts; een gepubliceerde sleutel gaat voor', async () => {
  for (let i = 0; i < 5; i++) {
    const key = roundKeyFromSalt(crypto.randomBytes(32).toString('hex'));
    const other = roundKeyFromSalt(crypto.randomBytes(32).toString('hex'));
    const text = JSON.stringify({ schema: 'arcade-action-bundle', n: i });
    const { value, evidenceHex } = sealedRecord(text, key.address);
    const getTransaction = async () => transactionWithEvidence(TXID, evidenceHex);
    const read = await readMobileRecord({ value, updateTxid: TXID, ivk: key.ivk, getTransaction });
    assert.equal(new TextDecoder().decode(read.bytes), text);
    await assert.rejects(readMobileRecord({ value, updateTxid: TXID, ivk: other.ivk, getTransaction }), isDecryptError(/Decryption failed/));
  }
  // Een fase-2-record (viewing key in de verwijzing) blijft leesbaar, ook als iemand een andere sleutel meegeeft.
  const open = mobileRecord('{"publiek":true}');
  const read = await readMobileRecord({ value: open.value, updateTxid: TXID, ivk: hexToBytes(fixture.ivk), getTransaction: async () => transactionWithEvidence(TXID, open.evidenceHex) });
  assert.deepEqual([new TextDecoder().decode(read.bytes), read.ivkPublished], ['{"publiek":true}', true]);
});
