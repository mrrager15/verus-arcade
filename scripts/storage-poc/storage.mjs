import crypto from 'node:crypto';

import {
  POC_IDENTITY,
  VDXF_URIS,
  assertSafeIdentity,
  assertVrsctest,
} from './config.mjs';
import { rpc } from './rpc.mjs';

export function utf8ToHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

export function hexToUtf8(value) {
  return Buffer.from(value, 'hex').toString('utf8');
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function resolvePocKeys() {
  const resolved = {};
  for (const [name, uri] of Object.entries(VDXF_URIS)) {
    const result = await rpc('getvdxfid', [uri]);
    resolved[name] = { uri, vdxfid: result.vdxfid };
  }
  return resolved;
}

export async function readPocIdentity() {
  assertSafeIdentity(POC_IDENTITY);
  const info = await rpc('getinfo');
  assertVrsctest(info);
  const result = await rpc('getidentity', [POC_IDENTITY]);
  if (result.status !== 'active') {
    throw new Error(`PoC identity is not active: ${result.status}`);
  }
  return { info, result, identity: result.identity };
}

export async function writeMergedValue({ vdxfid, encodedHex }) {
  const { info, identity } = await readPocIdentity();
  const before = structuredClone(identity.contentmultimap ?? {});
  const merged = structuredClone(before);
  merged[vdxfid] = [encodedHex];

  const txid = await rpc('updateidentity', [
    {
      name: POC_IDENTITY,
      contentmultimap: merged,
    },
  ]);

  return {
    txid,
    preWriteHeight: info.blocks,
    beforeKeyCount: Object.keys(before).length,
    beforeValueCount: Object.values(before).reduce(
      (total, values) => total + (Array.isArray(values) ? values.length : 0),
      0,
    ),
    submittedKeyCount: Object.keys(merged).length,
    submittedValueCount: Object.values(merged).reduce(
      (total, values) => total + (Array.isArray(values) ? values.length : 0),
      0,
    ),
  };
}
