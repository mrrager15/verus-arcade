/**
 * Alleen voor tests: een ontvangstbewijs tekenen zoals Arcade@ dat doet (de SDK
 * tekent de hash, zoals `signMmrRoot` op de server), met een willekeurige
 * testsleutel als primair adres van de service-ID.
 */
import { createRequire } from 'node:module';

import { receiptHash } from '../action-bundle.mjs';
import { VRSCTEST_CHAIN_ID } from '../chain-reader.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const utxo = require('@bitgo/utxo-lib');
const { VerusIdInterface } = require('verusid-ts-client');

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:1');

/** Een verse testsleutel (geen echte sleutel van wie dan ook). */
export const testKey = () => utxo.ECPair.makeRandom({ network: utxo.networks.verus });

/** De service-ID zoals `getidentity <id> <hoogte>` haar geeft, met `key` als enig primair adres. */
export const testIdentity = (identityId, key, height) => ({
  status: 'active', blockheight: height - 3,
  identity: { identityaddress: identityId, systemid: VRSCTEST_CHAIN_ID, version: 3, flags: 0, primaryaddresses: [key.getAddress()], minimumsignatures: 1 },
});

/**
 * @param {{ round: string, player: string, actions: string[], key: any, height: number, serviceId?: string }} input
 * @returns {Promise<{ ack: string, ackHeight: number }>}
 */
export async function signReceipt({ round, player, actions, key, height, serviceId = ARCADE }) {
  const sd = { version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: receiptHash({ round, player, actions }), identityid: serviceId, signaturetype: 1 };
  const digest = P.SignatureData.fromJson({ ...sd, signature: '' }).getIdentityHash({ version: 2, hash_type: 5, height });
  const ack = await sdk.signHash(serviceId, digest, key.toWIF(), testIdentity(serviceId, key, height), height, VRSCTEST_CHAIN_ID);
  return { ack, ackHeight: height };
}
