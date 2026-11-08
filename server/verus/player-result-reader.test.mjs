import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { decodeContentValue, locatePublishedRecord } from './player-result-reader.mjs';
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

test('locatePublishedRecord vindt het record en koppelt het aan de eerste geschiedenis-entry', () => {
  const hex = univalueHex(RECORD);
  const content = { identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}'), hex] } } };
  const history = [
    { height: 1500, output: { txid: TXID }, identity: { contentmultimap: { [KEY]: [hex] } } },
    { height: 1400, output: { txid: 'cd'.repeat(32) }, identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}')] } } },
  ];
  const located = locatePublishedRecord({ content, history, keyId: KEY, recordSha256: SHA });
  assert.deepEqual(located, { found: true, valueCount: 2, txid: TXID, height: 1500, kinds: ['univalue-descriptor', 'univalue-descriptor'] });
});

test('locatePublishedRecord: niet gevonden, zonder geschiedenis, en grenzen', () => {
  const content = { identity: { contentmultimap: { [KEY]: [univalueHex('{"ander":1}')] } } };
  assert.equal(locatePublishedRecord({ content, history: [], keyId: KEY, recordSha256: SHA }).found, false);
  assert.equal(locatePublishedRecord({ content: { identity: { contentmultimap: {} } }, history: [], keyId: KEY, recordSha256: SHA }).valueCount, 0);
  const foundNoHistory = locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: [univalueHex(RECORD)] } } }, history: null, keyId: KEY, recordSha256: SHA });
  assert.equal(foundNoHistory.found, true);
  assert.equal(foundNoHistory.txid, null);
  assert.throws(() => locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: Array(33).fill('00') } } }, history: [], keyId: KEY, recordSha256: SHA }), /too many records/);
  assert.throws(() => locatePublishedRecord({ content: { identity: { contentmultimap: { [KEY]: [univalueHex(RECORD)] } } }, history: Array(1025).fill({}), keyId: KEY, recordSha256: SHA }), /history too long/);
});
