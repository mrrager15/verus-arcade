import fs from 'node:fs';

import { POC_IDENTITY } from './config.mjs';
import {
  hexToUtf8,
  readPocIdentity,
  resolvePocKeys,
  sha256Hex,
} from './storage.mjs';

const fixtureUrl = new URL('./fixtures/small-json.json', import.meta.url);
const fileFixtureUrl = new URL('./fixtures/small-text.txt', import.meta.url);
const expectedSmallJson = JSON.stringify(
  JSON.parse(fs.readFileSync(fixtureUrl, 'utf8')),
);
const expectedSmallFile = fs.readFileSync(fileFixtureUrl, 'utf8');
const expectedSentinel = JSON.stringify({
  schemaVersion: 1,
  type: 'verus-arcade-storage-poc',
  fixture: 'preservation-sentinel',
  network: 'vrsctest',
  message: 'This value must survive every later PoC identity update.',
});

const keys = await resolvePocKeys();
const { info, identity } = await readPocIdentity();
const content = identity.contentmultimap ?? {};

function verify(name, expected) {
  const vdxfid = keys[name].vdxfid;
  const values = content[vdxfid] ?? [];
  if (values.length !== 1 || typeof values[0] !== 'string') {
    return {
      present: false,
      vdxfid,
      valueCount: values.length,
      expectedSha256: sha256Hex(expected),
    };
  }
  const decoded = hexToUtf8(values[0]);
  return {
    present: true,
    vdxfid,
    valueCount: values.length,
    logicalBytes: Buffer.byteLength(decoded, 'utf8'),
    expectedSha256: sha256Hex(expected),
    retrievedSha256: sha256Hex(decoded),
    byteIdentical: Buffer.from(decoded).equals(Buffer.from(expected)),
  };
}

console.log(
  JSON.stringify(
    {
      operation: 'verify-poc-values',
      identity: POC_IDENTITY,
      blockHeight: info.blocks,
      contentKeyCount: Object.keys(content).length,
      sentinel: verify('preservationSentinel', expectedSentinel),
      smallJson: verify('smallJson', expectedSmallJson),
      smallFile: verify('smallFile', expectedSmallFile),
    },
    null,
    2,
  ),
);
