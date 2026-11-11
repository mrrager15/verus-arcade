import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { decodeContentValue, firstAppearance, locatePublishedRecord, resolveContentValue } from './player-result-reader.mjs';
import { P } from './requests.mjs';

const KEY = 'iGoJPhRt5PGEzTSMVfnYGPShQ4yzgvS389';
const RECORD = '{"schema":"arcade-player-result","version":1}';
const SHA = createHash('sha256').update(RECORD).digest('hex');
const TXID = 'ab'.repeat(32);

function univalueHex(text) {
  const descriptor = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(0), objectdata: Buffer.from(text, 'utf8') });
  return new P.VdxfUniValue({ values: [{ [P.DataDescriptorKey.vdxfid]: descriptor }] }).toBuffer().toString('hex');
}

test('decodeContentValue herkent univalue-descriptor, kale descriptor en ruwe tekst', () => {
  assert.equal(decodeContentValue(univalueHex(RECORD)).kind, 'univalue-descriptor');
  assert.equal(decodeContentValue(univalueHex(RECORD)).bytes.toString('utf8'), RECORD);
  const bare = new P.DataDescriptor({ version: new P.BigNumber(1), flags: new P.BigNumber(0), objectdata: Buffer.from(RECORD) }).toBuffer().toString('hex');
  assert.equal(decodeContentValue(bare).kind, 'descriptor');
  const raw = Buffer.from(RECORD).toString('hex');
  assert.equal(decodeContentValue(raw).kind, 'raw');
  assert.equal(decodeContentValue('zz'), null);
  assert.equal(decodeContentValue(''), null);
});

test('locatePublishedRecord vindt het record en koppelt het aan de eerste geschiedenis-entry', async () => {
  const hex = univalueHex(RECORD);
  const content = { identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}'), hex] } } };
  const history = [
    { height: 1500, output: { txid: TXID }, identity: { contentmultimap: { [KEY]: [hex] } } },
    { height: 1400, output: { txid: 'cd'.repeat(32) }, identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}')] } } },
  ];
  const located = await locatePublishedRecord({ content, history, keyId: KEY, recordSha256: SHA });
  assert.deepEqual(located, { found: true, valueCount: 2, txid: TXID, height: 1500, kinds: ['hex-univalue-descriptor', 'hex-univalue-descriptor'] });
});

test('locatePublishedRecord: niet gevonden, zonder geschiedenis, en grenzen', async () => {
  const content = { identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}')] } } };
  assert.equal((await locatePublishedRecord({ content, history: [], keyId: KEY, recordSha256: SHA })).found, false);
  assert.equal((await locatePublishedRecord({ content: { identity: { contentmultimap: {} } }, history: [], keyId: KEY, recordSha256: SHA })).valueCount, 0);
  const foundNoHistory = await locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: [univalueHex(RECORD)] } } }, history: null, keyId: KEY, recordSha256: SHA });
  assert.equal(foundNoHistory.found, true);
  assert.equal(foundNoHistory.txid, null);
  await assert.rejects(locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: Array(33).fill('00') } } }, history: [], keyId: KEY, recordSha256: SHA }), /too many records/);
  await assert.rejects(locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: [univalueHex(RECORD)] } } }, history: Array(1025).fill({}), keyId: KEY, recordSha256: SHA }), /history too long/);
});

// Zoals live gezien op 9 nov (Verus Mobile, signdata met createmmr): versleutelde verwijzing met ivk.
const ENCRYPTED_VALUE = Object.freeze({
  [P.DataDescriptorKey.vdxfid]: { version: 1, flags: 13, objectdata: '46e5e13e', epk: '8a'.repeat(32), ivk: '0d'.repeat(32) },
});
const decryptReturning = (text, seen = []) => async (descriptor, txid) => {
  seen.push({ descriptor, txid });
  return [{ version: 1, flags: 2, objectdata: Buffer.from(text, 'utf8').toString('hex'), salt: '58'.repeat(32) }];
};

test('resolveContentValue: versleutelde verwijzing via decryptdata, met de juiste txid', async () => {
  const seen = [];
  const resolved = await resolveContentValue(ENCRYPTED_VALUE, { txid: TXID, decrypt: decryptReturning(RECORD, seen) });
  assert.equal(resolved.kind, 'encrypted-ref');
  assert.equal(resolved.bytes.toString('utf8'), RECORD);
  assert.equal(seen[0].txid, TXID);
  assert.equal(seen[0].descriptor.flags, 13);
  // Zonder txid of zonder decrypt-functie: niet leesbaar, geen fout.
  assert.equal(await resolveContentValue(ENCRYPTED_VALUE, { decrypt: decryptReturning(RECORD) }), null);
  assert.equal(await resolveContentValue(ENCRYPTED_VALUE, { txid: TXID }), null);
  // Onversleutelde descriptor in JSON-vorm.
  const plain = { [P.DataDescriptorKey.vdxfid]: { version: 1, flags: 0, objectdata: Buffer.from(RECORD).toString('hex') } };
  assert.equal((await resolveContentValue(plain)).kind, 'descriptor-json');
  assert.equal(await resolveContentValue({ iSomethingElse: {} }), null);
});

test('locatePublishedRecord met versleutelde verwijzing: txid uit de geschiedenis, anders het ontvangstbewijs', async () => {
  const content = { identity: { contentmultimap: { [KEY]: [ENCRYPTED_VALUE] } } };
  const history = [{ height: 1311250, output: { txid: TXID }, identity: { contentmultimap: { [KEY]: [{ ...ENCRYPTED_VALUE }] } } }];
  assert.deepEqual(firstAppearance({ history, keyId: KEY, value: ENCRYPTED_VALUE }), { txid: TXID, height: 1311250 });
  const located = await locatePublishedRecord({ content, history, keyId: KEY, recordSha256: SHA, decrypt: decryptReturning(RECORD) });
  assert.deepEqual(located, { found: true, valueCount: 1, txid: TXID, height: 1311250, kinds: ['encrypted-ref'] });
  const seen = [];
  const viaReceipt = await locatePublishedRecord({ content, history: [], keyId: KEY, recordSha256: SHA, fallbackTxid: 'cd'.repeat(32), decrypt: decryptReturning(RECORD, seen) });
  assert.equal(viaReceipt.found, true);
  assert.equal(seen[0].txid, 'cd'.repeat(32));
  const other = await locatePublishedRecord({ content, history, keyId: KEY, recordSha256: SHA, decrypt: decryptReturning('{"ander":1}') });
  assert.equal(other.found, false);
  assert.deepEqual(other.kinds, ['encrypted-ref']);
});
