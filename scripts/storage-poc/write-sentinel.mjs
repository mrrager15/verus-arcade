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

requireAcknowledgement(ACKNOWLEDGEMENTS.writeSentinel);

const value = JSON.stringify({
  schemaVersion: 1,
  type: 'verus-arcade-storage-poc',
  fixture: 'preservation-sentinel',
  network: 'vrsctest',
  message: 'This value must survive every later PoC identity update.',
});
const source = Buffer.from(value, 'utf8');
const keys = await resolvePocKeys();
const result = await writeMergedValue({
  vdxfid: keys.preservationSentinel.vdxfid,
  encodedHex: utf8ToHex(value),
});

console.log(
  JSON.stringify(
    {
      operation: 'write-preservation-sentinel',
      identity: POC_IDENTITY,
      vdxf: keys.preservationSentinel,
      logicalBytes: source.length,
      encodedHexCharacters: source.length * 2,
      sourceSha256: sha256Hex(source),
      ...result,
    },
    null,
    2,
  ),
);
