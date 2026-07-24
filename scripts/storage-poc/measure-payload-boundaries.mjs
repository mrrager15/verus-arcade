import {
  ACKNOWLEDGEMENTS,
  POC_IDENTITY,
  assertSafeIdentity,
  assertVrsctest,
  requireAcknowledgement,
} from './config.mjs';
import { rpc } from './rpc.mjs';
import { readPocIdentity, resolvePocKeys, sha256Hex, utf8ToHex } from './storage.mjs';

requireAcknowledgement(ACKNOWLEDGEMENTS.measurePayloadBoundaries);
assertSafeIdentity(POC_IDENTITY);

const requestedSizes = (process.env.STORAGE_POC_PAYLOAD_SIZES ?? '1024,4096,16384')
  .split(',')
  .map((value) => Number(value.trim()));

if (
  requestedSizes.length === 0 ||
  requestedSizes.some(
    (size) => !Number.isSafeInteger(size) || size < 1 || size > 65536,
  )
) {
  throw new Error('Payload sizes must be comma-separated integers from 1 through 65536');
}

const { info, identity } = await readPocIdentity();
assertVrsctest(info);
const keys = await resolvePocKeys();
const baseline = structuredClone(identity.contentmultimap ?? {});
const measurements = [];

function deterministicPayload(size) {
  const unit = 'VERUS-ARCADE-STORAGE-POC-BOUNDARY-V1\n';
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

for (const logicalBytes of requestedSizes) {
  const payload = deterministicPayload(logicalBytes);
  const contentmultimap = structuredClone(baseline);
  contentmultimap[keys.smallFile.vdxfid] = [utf8ToHex(payload)];

  const startedAt = performance.now();
  try {
    const rawTransaction = await rpc('updateidentity', [
      { name: POC_IDENTITY, contentmultimap },
      true,
    ]);
    if (typeof rawTransaction !== 'string' || !/^[0-9a-f]+$/i.test(rawTransaction)) {
      throw new Error('updateidentity returntx did not return transaction hex');
    }
    const decoded = await rpc('decoderawtransaction', [rawTransaction]);
    measurements.push({
      logicalBytes,
      encodedHexCharacters: logicalBytes * 2,
      payloadSha256: sha256Hex(payload),
      serializedTransactionBytes: rawTransaction.length / 2,
      transactionId: decoded.txid,
      constructionMilliseconds: Math.round((performance.now() - startedAt) * 100) / 100,
      broadcast: false,
    });
  } catch (error) {
    measurements.push({
      logicalBytes,
      error: error.message,
      constructionMilliseconds: Math.round((performance.now() - startedAt) * 100) / 100,
      broadcast: false,
    });
    break;
  }
}

console.log(
  JSON.stringify(
    {
      operation: 'measure-payload-boundaries',
      network: 'vrsctest',
      identity: POC_IDENTITY,
      blockHeight: info.blocks,
      baselineContentKeys: Object.keys(baseline).length,
      measurements,
    },
    null,
    2,
  ),
);
