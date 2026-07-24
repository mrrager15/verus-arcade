import {
  ACKNOWLEDGEMENTS,
  POC_IDENTITY,
  assertVrsctest,
  requireAcknowledgement,
} from './config.mjs';
import { rpc } from './rpc.mjs';
import { sha256Hex } from './storage.mjs';

requireAcknowledgement(ACKNOWLEDGEMENTS.testEncryption);

const info = await rpc('getinfo');
assertVrsctest(info);

const message = 'Verus Arcade encrypted storage PoC vector v1';
const existingRecipients = await rpc('z_listaddresses');
const recipient =
  existingRecipients[0] ?? (await rpc('z_getnewaddress', ['sapling']));
const signed = await rpc('signdata', [
  {
    address: POC_IDENTITY,
    message,
    encrypttoaddress: recipient,
  },
]);

const descriptors = Object.entries({
  datadescriptor: signed.datadescriptor,
  mmrdescriptor_encrypted: signed.mmrdescriptor_encrypted,
  signaturedata_encrypted: signed.signaturedata_encrypted,
}).filter(([, value]) => value && typeof value === 'object');
if (descriptors.length === 0) {
  throw new Error(
    `signdata did not return a datadescriptor (keys: ${Object.keys(signed).join(', ')})`,
  );
}

const messageHex = Buffer.from(message, 'utf8').toString('hex');
const attempts = [];
for (const [field, descriptor] of descriptors) {
  try {
    const decrypted = await rpc('decryptdata', [{ datadescriptor: descriptor }]);
    const serializedResult = JSON.stringify(decrypted);
    attempts.push({
      field,
      descriptorKeys: Object.keys(descriptor),
      decryptedType: Array.isArray(decrypted) ? 'array' : typeof decrypted,
      decryptedResultKeys:
        decrypted && typeof decrypted === 'object' ? Object.keys(decrypted) : [],
      plaintextPresent: serializedResult.includes(message),
      plaintextHexPresent: serializedResult.toLowerCase().includes(messageHex),
    });
  } catch (error) {
    attempts.push({
      field,
      descriptorKeys: Object.keys(descriptor),
      error: error.message,
    });
  }
}

console.log(
  JSON.stringify(
    {
      operation: 'test-encryption-round-trip',
      network: 'vrsctest',
      identity: POC_IDENTITY,
      recipientType: 'sapling',
      recipientAddressPrefix: recipient.slice(0, 4),
      messageBytes: Buffer.byteLength(message, 'utf8'),
      messageSha256: sha256Hex(message),
      signedResultKeys: Object.keys(signed),
      attempts,
    },
    null,
    2,
  ),
);
