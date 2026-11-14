import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  bytesToHex, DecryptError, hexToBytes, openEvidence, openReference, parseCrossChainDataRef, parseDataDescriptor, readMobileRecord, unwrapVdxf,
} from './verus-decrypt.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/mobile-records.json', import.meta.url), 'utf8'));
const flip = (hex, at) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);
const isDecryptError = (pattern) => (e) => e instanceof DecryptError && pattern.test(e.message);

/** Een tx zoals `getrawtransaction <txid> 1` hem geeft, met het bewijs op de juiste plaats. */
function transactionWith(c) {
  const vout = Array.from({ length: c.vout + 2 }, () => ({ scriptPubKey: {} }));
  const chainobjects = Array.from({ length: c.objectNum + 1 }, () => ({ value: { hex: '00' } }));
  chainobjects[c.objectNum] = { vdxftype: 'i6ZGLNfqu4cQ3h98VHimETwnWtizMwCJw6', value: { version: 1, hex: c.evidenceHex } };
  vout[c.vout] = { scriptPubKey: { notaryevidence: { evidence: { version: 1, chainobjects } } } };
  return { txid: c.updateTxid, vout };
}

test('ontsleutelen: twee echte Mobile-records, gelijk aan decryptdata (retrieve)', async () => {
  assert.equal(fixture.cases.length, 2);
  for (const c of fixture.cases) {
    const { ivk, ref } = openReference(c.value);
    assert.deepEqual([ref.sameTransaction, ref.vout, ref.objectNum], [true, c.vout, c.objectNum], c.name);
    const opened = openEvidence(c.evidenceHex, ivk);
    assert.deepEqual({ flags: opened.flags, objectdata: bytesToHex(opened.bytes), salt: bytesToHex(opened.salt) }, c.expected, c.name);
    assert.match(new TextDecoder().decode(opened.bytes), /"schema":"arcade-attestation"/);

    const asked = [];
    const record = await readMobileRecord({ value: c.value, updateTxid: c.updateTxid, getTransaction: async (txid) => { asked.push(txid); return transactionWith(c); } });
    assert.deepEqual(asked, [c.updateTxid], 'txid 0 in de verwijzing = de update-tx zelf');
    assert.equal(bytesToHex(record.bytes), c.expected.objectdata);
  }
});

test('ontsleutelen: elke beschadiging of verkeerde sleutel geeft een fout, nooit halve data', async () => {
  const [a, b] = fixture.cases;
  const { ivk } = openReference(a.value);
  const otherIvk = openReference(b.value).ivk;
  // één bit in de versleutelde tekst van het bewijs (ergens in het midden)
  assert.throws(() => openEvidence(flip(a.evidenceHex, Math.floor(a.evidenceHex.length / 2)), ivk), isDecryptError(/Decryption failed/));
  assert.throws(() => openEvidence(a.evidenceHex, otherIvk), isDecryptError(/Decryption failed/));
  const ref = a.value['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'];
  assert.throws(() => openReference({ ...ref, objectdata: flip(ref.objectdata, 10) }), isDecryptError(/Decryption failed/));
  assert.throws(() => openReference({ ...ref, ivk: b.value['i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv'].ivk }), isDecryptError(/Decryption failed/));
  assert.throws(() => openReference({ ...ref, flags: 2 }), isDecryptError(/Not an encrypted reference/));
  assert.throws(() => openReference({ ...ref, epk: 'ff'.repeat(32) }), DecryptError);
  // bewijs niet op de verwezen plaats
  await assert.rejects(readMobileRecord({ value: a.value, updateTxid: a.updateTxid, getTransaction: async () => ({ vout: [] }) }), isDecryptError(/not found/));
  await assert.rejects(readMobileRecord({ value: a.value, updateTxid: 'xyz', getTransaction: async () => ({}) }), isDecryptError(/Invalid update/));
  // multipart-bewijs (type 2) wordt (nog) niet ondersteund: duidelijke fout
  const multipart = '010102' + a.evidenceHex.slice(6);
  assert.throws(() => openEvidence(multipart, ivk), isDecryptError(/multipart/));
});

test('ontsleutelen: Verus-serialisatie (VARINT, compactsize, verwijzing)', () => {
  // VARINT 128 = 80 00; compactsize 300 = fd 2c 01
  const descriptor = parseDataDescriptor(hexToBytes(`8000` + '02' + 'fd2c01' + '00'.repeat(300) + '02' + 'abcd'));
  assert.deepEqual([descriptor.version, descriptor.flags, descriptor.objectdata.length, bytesToHex(descriptor.salt)], [128, 2, 300, 'abcd']);
  assert.throws(() => parseDataDescriptor(hexToBytes('0100' + '01' + 'aa' + 'ff')), /trailing/);
  const ref = parseCrossChainDataRef(hexToBytes('00' + '01' + '01' + '11'.repeat(31) + '22' + '05000000' + '02' + '00'));
  assert.deepEqual([ref.txid.slice(0, 2), ref.sameTransaction, ref.vout, ref.objectNum, ref.subObject], ['22', false, 5, 2, 0]);
  assert.throws(() => parseCrossChainDataRef(hexToBytes('01')), /type 1/);
  assert.equal(unwrapVdxf(hexToBytes('11'.repeat(20) + '01' + '02' + 'beef')).data.length, 2);
});
