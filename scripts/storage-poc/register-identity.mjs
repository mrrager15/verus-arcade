import {
  ACKNOWLEDGEMENTS,
  POC_IDENTITY,
  POC_NETWORK,
  assertSafeIdentity,
  assertVrsctest,
  requireAcknowledgement,
} from './config.mjs';
import { rpc } from './rpc.mjs';

requireAcknowledgement(ACKNOWLEDGEMENTS.createIdentity);
assertSafeIdentity(POC_IDENTITY);

const encoded = process.env.STORAGE_POC_RESERVATION_BASE64;
const primaryAddress = process.env.STORAGE_POC_PRIMARY_ADDRESS;
if (!encoded || !primaryAddress) {
  throw new Error(
    'STORAGE_POC_RESERVATION_BASE64 and STORAGE_POC_PRIMARY_ADDRESS are required',
  );
}

const info = await rpc('getinfo');
assertVrsctest(info);

const reservation = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
const confirmations = await rpc('getrawtransaction', [reservation.txid, 1]);
if ((confirmations.confirmations ?? 0) < 1) {
  throw new Error(`Name commitment ${reservation.txid} is not confirmed`);
}

const txid = await rpc('registeridentity', [
  {
    ...reservation,
    identity: {
      name: POC_IDENTITY.replace(/@$/, ''),
      primaryaddresses: [primaryAddress],
      minimumsignatures: 1,
    },
  },
]);

console.log(
  JSON.stringify(
    {
      operation: 'registeridentity',
      network: POC_NETWORK,
      identity: POC_IDENTITY,
      txid,
    },
    null,
    2,
  ),
);
