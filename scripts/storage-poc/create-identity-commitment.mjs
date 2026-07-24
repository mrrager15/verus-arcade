import {
  ACKNOWLEDGEMENTS,
  POC_IDENTITY,
  POC_LEAF_NAME,
  POC_NETWORK,
  POC_REFERRAL,
  assertSafeIdentity,
  assertVrsctest,
  requireAcknowledgement,
} from './config.mjs';
import { rpc } from './rpc.mjs';

requireAcknowledgement(ACKNOWLEDGEMENTS.createIdentity);
assertSafeIdentity(POC_IDENTITY);

const info = await rpc('getinfo');
assertVrsctest(info);

try {
  await rpc('getidentity', [POC_IDENTITY]);
  throw new Error(`Refusing registration: ${POC_IDENTITY} already exists`);
} catch (error) {
  if (!error.message.includes('Identity not found')) throw error;
}

const controlAddress = await rpc('getnewaddress');
const reservation = await rpc('registernamecommitment', [
  POC_LEAF_NAME,
  controlAddress,
  POC_REFERRAL,
]);

console.log(
  JSON.stringify(
    {
      operation: 'registernamecommitment',
      network: POC_NETWORK,
      identity: POC_IDENTITY,
      referral: POC_REFERRAL,
      controlAddress,
      reservation,
      next: 'Wait for confirmation, then use the reservation to register the identity.',
    },
    null,
    2,
  ),
);
