import fs from 'node:fs';

import {
  ACKNOWLEDGEMENTS,
  POC_IDENTITY,
  requireAcknowledgement,
} from './config.mjs';
import {
  resolvePocKeys,
  sha256Hex,
  utf8ToHex,
  writeMergedValue,
} from './storage.mjs';

requireAcknowledgement(ACKNOWLEDGEMENTS.writeSmallFile);

const fixtureUrl = new URL('./fixtures/small-text.txt', import.meta.url);
const payload = fs.readFileSync(fixtureUrl, 'utf8');
const encodedHex = utf8ToHex(payload);
const keys = await resolvePocKeys();
const write = await writeMergedValue({
  vdxfid: keys.smallFile.vdxfid,
  encodedHex,
});

console.log(
  JSON.stringify(
    {
      operation: 'write-small-file',
      network: 'vrsctest',
      identity: POC_IDENTITY,
      vdxfUri: keys.smallFile.uri,
      vdxfid: keys.smallFile.vdxfid,
      logicalBytes: Buffer.byteLength(payload, 'utf8'),
      encodedHexCharacters: encodedHex.length,
      sourceSha256: sha256Hex(payload),
      ...write,
    },
    null,
    2,
  ),
);
