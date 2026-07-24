import {
  POC_IDENTITY,
  VDXF_URIS,
  assertVrsctest,
} from './config.mjs';
import { rpc, summarizeIdentity } from './rpc.mjs';

const info = await rpc('getinfo');
assertVrsctest(info);

let identity = null;
try {
  identity = await rpc('getidentity', [POC_IDENTITY]);
} catch (error) {
  if (error.code !== -5 && !error.message.includes('Identity not found')) throw error;
}

const vdxfKeys = {};
for (const [label, uri] of Object.entries(VDXF_URIS)) {
  const result = await rpc('getvdxfid', [uri]);
  vdxfKeys[label] = {
    uri,
    vdxfid: result.vdxfid,
    qualifiedname: result.qualifiedname,
  };
}

console.log(
  JSON.stringify(
    {
      network: {
        testnet: info.testnet,
        version: info.version,
        protocolversion: info.protocolversion,
        blocks: info.blocks,
        longestchain: info.longestchain,
      },
      identity: identity ? summarizeIdentity(identity) : { name: POC_IDENTITY, exists: false },
      vdxfKeys,
    },
    null,
    2,
  ),
);
