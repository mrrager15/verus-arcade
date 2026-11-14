/**
 * Alleen voor tests: een record versleutelen zoals Verus Mobile het in een
 * VerusID zet (de omgekeerde weg van shared/verus-decrypt.mjs). Geeft de waarde
 * voor de contentmultimap en de bewijs-hex voor `notaryevidence` in de update-tx.
 * Dat de ontsleuteling ook met échte Mobile-records werkt, bewijzen de tests op
 * shared/fixtures/mobile-records.json.
 */
import crypto from 'node:crypto';

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { jubjub } from '@noble/curves/jubjub';
import { blake2b } from '@noble/hashes/blake2b';

import { jubjub_groupHash } from '@noble/curves/misc';

import { parseSaplingAddress } from '../round-key.mjs';
import { CROSS_CHAIN_DATA_REF_KEY_HEX, DATA_DESCRIPTOR_KEY, DATA_DESCRIPTOR_KEY_HEX } from '../verus-decrypt.mjs';

const N = jubjub.CURVE.n;
const random = () => (BigInt(`0x${crypto.randomBytes(40).toString('hex')}`) % (N - 1n)) + 1n;
const le32 = (x) => { const b = new Uint8Array(32); for (let i = 0; i < 32; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const concat = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const cs = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
const vdxf = (keyHex, data) => concat(Buffer.from(keyHex, 'hex'), [1], cs(data.length), data);
const descriptor = ({ flags, objectdata, salt, epk }) => concat([1, flags], cs(objectdata.length), objectdata,
  ...(salt ? [cs(salt.length), salt] : []), ...(epk ? [cs(epk.length), epk] : []));

function keys() {
  const ivk = random();
  const gd = jubjub.ExtendedPoint.BASE.multiply(random());
  return { ivk, gd, pkd: gd.multiply(ivk) };
}

function seal(plain, { gd, pkd }) {
  const esk = random();
  const epk = gd.multiply(esk).toRawBytes();
  const shared = pkd.multiply(8n).multiply(esk).toRawBytes();
  const key = blake2b(concat(shared, epk), { dkLen: 32, personalization: Buffer.from('Zcash_SaplingKDF') });
  return { epk, sealed: chacha20poly1305(key, new Uint8Array(12)).encrypt(plain) };
}

/**
 * @param {string} recordText  de bytes van het record (JSON)
 * @returns {{ value: object, evidenceHex: string }}
 */
export function mobileRecord(recordText) {
  const k = keys();
  const ccdr = concat([0, 1, 1], Buffer.alloc(32), [0, 0, 0, 0], [0, 0]);
  const reference = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 0, objectdata: vdxf(CROSS_CHAIN_DATA_REF_KEY_HEX, ccdr) })), k);
  const inner = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 2, objectdata: Buffer.from(recordText), salt: crypto.randomBytes(32) })), k);
  const evidenceDescriptor = vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 5, objectdata: inner.sealed, epk: inner.epk }));
  return {
    value: { [DATA_DESCRIPTOR_KEY]: { version: 1, flags: 13, objectdata: Buffer.from(reference.sealed).toString('hex'), epk: Buffer.from(reference.epk).toString('hex'), ivk: Buffer.from(le32(k.ivk)).toString('hex') } },
    evidenceHex: concat([1, 1, 1], Buffer.from(DATA_DESCRIPTOR_KEY_HEX, 'hex'), cs(evidenceDescriptor.length), evidenceDescriptor).toString('hex'),
  };
}

/**
 * Fase 5: hetzelfde, maar versleuteld naar een Sapling-adres (`encrypttoaddress`),
 * zoals de daemon het dan doet: verwijzing met flags 5, ZONDER viewing key.
 * @param {string} recordText @param {string} address  een zs-adres (shared/round-key.mjs)
 * @returns {{ value: object, evidenceHex: string }}
 */
export function sealedRecord(recordText, address) {
  const { diversifier, pkd } = parseSaplingAddress(address);
  const k = { gd: jubjub_groupHash(diversifier, Buffer.from('Zcash_gd')), pkd: jubjub.ExtendedPoint.fromHex(pkd) };
  const ccdr = concat([0, 1, 1], Buffer.alloc(32), [0, 0, 0, 0], [0, 0]);
  const reference = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 0, objectdata: vdxf(CROSS_CHAIN_DATA_REF_KEY_HEX, ccdr) })), k);
  const inner = seal(vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 2, objectdata: Buffer.from(recordText), salt: crypto.randomBytes(32) })), k);
  const evidenceDescriptor = vdxf(DATA_DESCRIPTOR_KEY_HEX, descriptor({ flags: 5, objectdata: inner.sealed, epk: inner.epk }));
  return {
    value: { [DATA_DESCRIPTOR_KEY]: { version: 1, flags: 5, objectdata: Buffer.from(reference.sealed).toString('hex'), epk: Buffer.from(reference.epk).toString('hex') } },
    evidenceHex: concat([1, 1, 1], Buffer.from(DATA_DESCRIPTOR_KEY_HEX, 'hex'), cs(evidenceDescriptor.length), evidenceDescriptor).toString('hex'),
  };
}

/** De tx zoals `getrawtransaction <txid> 1` hem geeft, met het bewijs in vout 0, object 0. */
export function transactionWithEvidence(txid, evidenceHex, extra = {}) {
  return { txid, ...extra, vout: [{ scriptPubKey: { notaryevidence: { evidence: { version: 1, chainobjects: [{ value: { version: 1, hex: evidenceHex } }] } } } }] };
}
