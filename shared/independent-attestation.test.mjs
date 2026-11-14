import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { buildAttestation, buildDisclosurePayload, compactSealedRecord, encodeDisclosureLink } from '../server/attestation.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { createChainReader, VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { verifyAttestationLinkIndependently } from './independent-attestation.mjs';
import { attestationKeyName } from './player-result.mjs';
import { mobileRecord, transactionWithEvidence } from './testing/mobile-record.mjs';
import { vdxfDataKey } from './vdxf-key.mjs';

const require = createRequire(import.meta.url);
const P = require('verus-typescript-primitives');
const utxo = require('@bitgo/utxo-lib');
const { VerusIdInterface } = require('verusid-ts-client');

const ARCADE = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
const PLAYER = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const ROUND = 'number-target:1.0.0:2026-11-11';
const HEIGHT = 1_314_881;
const TIP = 1_318_800;
const sdk = new VerusIdInterface('VRSCTEST', 'http://127.0.0.1:1');
const arcadeKey = utxo.ECPair.makeRandom({ network: utxo.networks.verus });

const identityRecord = (address, height = HEIGHT) => ({
  status: 'active', blockheight: height - 3,
  identity: { identityaddress: ARCADE, systemid: VRSCTEST_CHAIN_ID, version: 3, flags: 0, primaryaddresses: [address], minimumsignatures: 1 },
});

/** Een deellink zoals de server hem maakt, getekend met `arcadeKey` (de SDK tekent, zoals Arcade@). */
async function makeLink(fields = ['streak']) {
  const attestation = buildAttestation({ player: PLAYER, roundId: ROUND, stats: { streak: 1, rounds: 1, solved: 1 }, salts: Array(6).fill('11'.repeat(32)) });
  const sd = { version: 1, systemid: VRSCTEST_CHAIN_ID, hashtype: 5, signaturehash: attestation.root, identityid: ARCADE, signaturetype: 1 };
  const digest = P.SignatureData.fromJson({ ...sd, signature: '' }).getIdentityHash({ version: 2, hash_type: 5, height: HEIGHT });
  const signature = await sdk.signHash(ARCADE, digest, arcadeKey.toWIF(), identityRecord(arcadeKey.getAddress()), HEIGHT, VRSCTEST_CHAIN_ID);
  const record = compactSealedRecord({ roundId: ROUND, descriptor: attestation.descriptor, signaturedata: { ...sd, signature }, signatureHeight: HEIGHT });
  return { link: encodeDisclosureLink(buildDisclosurePayload({ record, descriptor: attestation.descriptor, fields })), root: attestation.root, record };
}

const UPDATE_TX = 'cd'.repeat(32);
const ATTESTATION_KEY = vdxfDataKey(attestationKeyName(ROUND), ARCADE);

/** Nep-RPC; `published`: een versleuteld record (testing/mobile-record) in de ID van de speler. */
function fakeReader({ primary = arcadeKey.getAddress(), info = {}, down = false, published = null } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    if (down) throw new TypeError('fetch failed');
    const { method, params, id } = JSON.parse(init.body);
    calls.push([method, params]);
    const cmm = published ? { [ATTESTATION_KEY]: [published.value] } : {};
    const methods = {
      getinfo: () => ({ name: 'VRSCTEST', chainid: VRSCTEST_CHAIN_ID, testnet: true, blocks: TIP, VRSCversion: '1.2.18', ...info }),
      getidentity: () => identityRecord(primary, params[1]),
      getidentitycontent: () => ({ identity: { identityaddress: params[0], contentmultimap: cmm } }),
      getidentityhistory: () => ({ history: [{ height: TIP - 100, blockhash: 'x', output: { txid: UPDATE_TX, voutnum: 0 }, identity: { identityaddress: params[0], contentmultimap: cmm } }] }),
      getrawtransaction: () => (published ? transactionWithEvidence(UPDATE_TX, published.evidenceHex, { confirmations: 100, height: TIP - 100 }) : null),
    };
    const result = methods[method]?.() ?? null;
    return new Response(JSON.stringify({ id, result, error: result === null ? { code: -32601, message: 'Method not found' } : null }));
  };
  return { reader: createChainReader({ fetch }), calls };
}

test('deellink onafhankelijk: velden, wortel en handtekening van Arcade@ → verified', async () => {
  const { link, root } = await makeLink(['streak', 'solved']);
  const { reader, calls } = fakeReader();
  const r = await verifyAttestationLinkIndependently({ link, reader });
  assert.equal(r.verdict, 'verified', r.problem);
  assert.deepEqual([r.player, r.round, r.fields, r.root], [PLAYER, ROUND, { streak: '1', solved: '1' }, root]);
  assert.deepEqual(r.signature, { status: 'valid', reason: null, primaryAddresses: [arcadeKey.getAddress()] });
  assert.equal(r.signatureHeight, HEIGHT);
  assert.deepEqual(calls.slice(0, 2), [['getinfo', []], ['getidentity', [ARCADE, HEIGHT]]], 'voor het oordeel alleen de publieke sleutels van Arcade@ op tekenhoogte');
  assert.equal(r.source.tip, TIP);
  assert.deepEqual(r.inPlayerIdentity, { status: 'absent', txid: null, height: null }, 'niets gepubliceerd in de ID van de speler');
});

test('deellink onafhankelijk: precies dit verzegelde record staat (versleuteld) in de ID van de speler → found', async () => {
  const { link, record } = await makeLink();
  const r = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ published: mobileRecord(canonicalJson(record)) }).reader });
  assert.equal(r.verdict, 'verified');
  assert.deepEqual(r.inPlayerIdentity, { status: 'found', txid: UPDATE_TX, height: TIP - 100 });
  // een ander record onder dezelfde key telt niet
  const other = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ published: mobileRecord(canonicalJson({ ...record, height: 1 })) }).reader });
  assert.equal(other.inPlayerIdentity.status, 'absent');
});

test('deellink onafhankelijk: een ander getoond getal of een vreemde link → invalid, zonder chain', async () => {
  const { link } = await makeLink();
  const payload = JSON.parse(Buffer.from(link, 'base64url').toString('utf8'));
  payload.fields.find((f) => f[0] === 'streak')[1] = '100';
  const forged = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const { reader, calls } = fakeReader();
  const r = await verifyAttestationLinkIndependently({ link: forged, reader });
  assert.equal(r.verdict, 'invalid');
  assert.match(r.problem, /^link: /);
  assert.equal(calls.length, 0, 'een kapotte link raakt de chain niet');
  assert.equal((await verifyAttestationLinkIndependently({ link: 'niet-geldig!', reader })).verdict, 'invalid');
});

test('deellink onafhankelijk: handtekening van een andere sleutel → invalid', async () => {
  const { link } = await makeLink();
  const other = utxo.ECPair.makeRandom({ network: utxo.networks.verus }).getAddress();
  const r = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ primary: other }).reader });
  assert.equal(r.verdict, 'invalid');
  assert.deepEqual([r.signature.status, r.signature.reason], ['invalid', 'Signature is not from a key of this identity']);
});

test('deellink onafhankelijk: RPC weg, te lage tip of andere chain → geen oordeel over de handtekening', async () => {
  const { link } = await makeLink();
  const down = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ down: true }).reader });
  assert.equal(down.verdict, 'unavailable');
  assert.equal(down.player, PLAYER, 'de link zelf is wel gelezen');
  assert.equal(down.signature.status, 'unavailable');
  const behind = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ info: { blocks: HEIGHT - 1 } }).reader });
  assert.equal(behind.verdict, 'unavailable');
  assert.match(behind.problem, /above the chain tip/);
  const mainnet = await verifyAttestationLinkIndependently({ link, reader: fakeReader({ info: { name: 'VRSC', chainid: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV', testnet: false } }).reader });
  assert.equal(mainnet.verdict, 'wrong-chain');
});
