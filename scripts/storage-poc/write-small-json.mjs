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

requireAcknowledgement(ACKNOWLEDGEMENTS.writeSmallJson);

const fixtureUrl = new URL('./fixtures/small-json.json', import.meta.url);
const parsed = JSON.parse(fs.readFileSync(fixtureUrl, 'utf8'));
const value = JSON.stringify(parsed);
const source = Buffer.from(value, 'utf8');
const keys = await resolvePocKeys();
const result = await writeMergedValue({
  vdxfid: keys.smallJson.vdxfid,
  encodedHex: utf8ToHex(value),
});

console.log(
  JSON.stringify(
    {
      operation: 'write-small-json',
      identity: POC_IDENTITY,
      vdxf: keys.smallJson,
      logicalBytes: source.length,
      encodedHexCharacters: source.length * 2,
      sourceSha256: sha256Hex(source),
      ...result,
    },
    null,
    2,
  ),
);
