/**
 * Fase 4: records lezen die Verus Mobile versleuteld in een VerusID zet, zonder
 * daemon (de publieke RPC blokkeert `decryptdata`). Gedeeld: browser, server en
 * losse verifier; alleen @noble.
 *
 * Twee lagen, allebei te openen met de viewing key (ivk) die in de verwijzing staat:
 *  1. In de contentmultimap van de speler: een DataDescriptor met flags 13
 *     (versleuteld + epk + ivk). Ontsleuteld: een DataDescriptor met een
 *     `CrossChainDataRef` (welke tx, welke output, welk object).
 *  2. In die tx: `notaryevidence` → `EvidenceData` (versie twee keer, type 1,
 *     vdxfd, data) → DataDescriptor met flags 5 (versleuteld + eigen epk).
 *     Ontsleuteld: de gezouten DataDescriptor met het record zelf.
 *
 * Per laag (daemon v1.2.18: `CVDXFEncryptor::Decrypt`, `KDF_Sapling`):
 *   geheim = [ivk]([8]·epk) op Jubjub · sleutel = BLAKE2b-256(geheim ‖ epk, "Zcash_SaplingKDF")
 *   klare tekst = ChaCha20-Poly1305-IETF(sleutel, nonce 0, geen AAD)
 * De Poly1305-tag maakt het zelfcontrolerend: een verkeerde sleutel of verschoven
 * bytes geven een fout, nooit half juiste data. Nagekeken tegen `decryptdata` op
 * 9 van 9 echte records (fase 4 stap 5) en in de tests op `fixtures/mobile-records.json`.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { jubjub } from '@noble/curves/jubjub';
import { blake2b } from '@noble/hashes/blake2b';

/** VDXF-keys als hash160 (hex): `vrsc::data.type.object.datadescriptor` en `…crosschaindataref`. */
export const DATA_DESCRIPTOR_KEY_HEX = '08a2ebb2c55f83a8e2a426a53320ed4d42124f4d';
export const CROSS_CHAIN_DATA_REF_KEY_HEX = 'd6ae5ac0571b22d161261b87c748f6e0aee0334d';
/** Zo noemt de daemon de DataDescriptor-key in JSON. */
export const DATA_DESCRIPTOR_KEY = 'i4GC1YGEVD21afWudGoFJVdnfjJ5XWnCQv';

export const FLAG_ENCRYPTED = 1;
export const FLAG_SALT = 2;
export const FLAG_EPK = 4;
export const FLAG_IVK = 8;
export const FLAG_SSK = 0x10;
export const FLAG_LABEL = 0x20;
export const FLAG_MIME = 0x40;
export const FLAG_VDXF_KEY = 0x80;

const KDF_PERSONALIZATION = new TextEncoder().encode('Zcash_SaplingKDF');
const ZERO_NONCE = new Uint8Array(12);
const MAX_RECORD_BYTES = 64 * 1024;

export class DecryptError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DecryptError';
    this.code = 'DECRYPT_FAILED';
  }
}

/** @param {string} message @returns {never} */
const fail = (message) => { throw new DecryptError(message); };

/** @param {string} hex */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) fail('Invalid hex');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** @param {Uint8Array} bytes */
export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {Uint8Array} bytes */
function littleEndian(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/**
 * Lezer voor Verus-serialisatie: compactsize (varslice), Bitcoin-VARINT, vaste stukken.
 * @param {Uint8Array} bytes
 */
function byteReader(bytes) {
  let offset = 0;
  const need = (/** @type {number} */ n) => { if (offset + n > bytes.length) fail('Data ends too early'); };
  return {
    get offset() { return offset; },
    get done() { return offset === bytes.length; },
    u8() { need(1); return bytes[offset++]; },
    u32() { need(4); const v = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24); offset += 4; return v >>> 0; },
    /** @param {number} n */
    take(n) { need(n); const out = bytes.slice(offset, offset + n); offset += n; return out; },
    compactSize() {
      const first = this.u8();
      if (first < 0xfd) return first;
      if (first === 0xfd) { need(2); const v = bytes[offset] | (bytes[offset + 1] << 8); offset += 2; return v; }
      if (first === 0xfe) return this.u32();
      return fail('Length too large');
    },
    varSlice() { return this.take(this.compactSize()); },
    /** Bitcoin-core VARINT (MSB-voortzetting, +1 per vervolgbyte). */
    varInt() {
      let n = 0;
      for (let i = 0; i < 5; i++) {
        const b = this.u8();
        n = n * 128 + (b & 0x7f);
        if ((b & 0x80) === 0) return n;
        n += 1;
      }
      return fail('VARINT too long');
    },
  };
}

/**
 * Een DataDescriptor uit bytes (daemon/SDK-volgorde).
 * @param {Uint8Array} bytes
 */
export function parseDataDescriptor(bytes) {
  const r = byteReader(bytes);
  /** @type {{ version: number, flags: number, vdxfKey?: Uint8Array, objectdata: Uint8Array, label?: string, mimeType?: string, salt?: Uint8Array, epk?: Uint8Array, ivk?: Uint8Array, ssk?: Uint8Array }} */
  const d = { version: r.varInt(), flags: r.varInt(), objectdata: new Uint8Array(0) };
  if (d.flags & FLAG_VDXF_KEY) d.vdxfKey = r.take(20);
  d.objectdata = r.varSlice();
  if (d.flags & FLAG_LABEL) d.label = new TextDecoder().decode(r.varSlice());
  if (d.flags & FLAG_MIME) d.mimeType = new TextDecoder().decode(r.varSlice());
  if (d.flags & FLAG_SALT) d.salt = r.varSlice();
  if (d.flags & FLAG_EPK) d.epk = r.varSlice();
  if (d.flags & FLAG_IVK) d.ivk = r.varSlice();
  if (d.flags & FLAG_SSK) d.ssk = r.varSlice();
  if (!r.done) fail('DataDescriptor has trailing bytes');
  return d;
}

/**
 * VDXF-verpakking: key (20) ‖ versie (VARINT) ‖ varslice(data).
 * @param {Uint8Array} bytes
 */
export function unwrapVdxf(bytes) {
  const r = byteReader(bytes);
  const key = bytesToHex(r.take(20));
  const version = r.varInt();
  const data = r.varSlice();
  if (!r.done) fail('VDXF object has trailing bytes');
  return { key, version, data };
}

/**
 * `CrossChainDataRef` met een `PBaaSEvidenceRef` (type 0): waar het bewijs staat.
 * `txid` in de gewone (omgekeerde) hex-weergave; alleen nullen = "dezelfde tx als de verwijzing".
 * @param {Uint8Array} bytes
 */
export function parseCrossChainDataRef(bytes) {
  const r = byteReader(bytes);
  const type = r.u8();
  if (type !== 0) fail(`Unsupported data reference type ${type}`);
  const version = r.varInt();
  const flags = r.varInt();
  const txid = bytesToHex(r.take(32).reverse());
  const vout = r.u32();
  const objectNum = r.varInt();
  const subObject = r.varInt();
  const systemId = flags & 2 ? bytesToHex(r.take(20)) : null;
  const dataHash = flags & 4 ? bytesToHex(r.take(32)) : null;
  if (!r.done) fail('Data reference has trailing bytes');
  return { version, flags, txid, sameTransaction: /^0+$/.test(txid), vout, objectNum, subObject, systemId, dataHash };
}

/**
 * `EvidenceData` uit een `notaryevidence`-object: versie (twee keer), type, vdxfd, data.
 * @param {Uint8Array} bytes
 */
export function parseEvidenceData(bytes) {
  const r = byteReader(bytes);
  r.varInt();
  const version = r.varInt(); // de SDK leest de versie bewust twee keer
  const type = r.varInt();
  if (type !== 1) fail(`Unsupported evidence type ${type} (multipart data is not supported yet)`);
  const vdxfd = bytesToHex(r.take(20));
  const data = r.varSlice();
  if (!r.done) fail('Evidence has trailing bytes');
  return { version, type, vdxfd, data };
}

/**
 * Symmetrische sleutel uit epk en ivk (Sapling: ka_agree + KDF_Sapling).
 * @param {Uint8Array} epk @param {Uint8Array} ivk
 */
export function symmetricKey(epk, ivk) {
  if (epk.length !== 32 || ivk.length !== 32) fail('epk and ivk must be 32 bytes');
  let shared;
  try {
    const scalar = littleEndian(ivk);
    if (scalar === 0n || scalar >= jubjub.CURVE.n) fail('Invalid viewing key');
    shared = jubjub.ExtendedPoint.fromHex(epk).multiply(8n).multiply(scalar).toRawBytes();
  } catch (error) {
    if (error instanceof DecryptError) throw error;
    return fail('Invalid encryption key point');
  }
  const block = new Uint8Array(64);
  block.set(shared, 0);
  block.set(epk, 32);
  return blake2b(block, { dkLen: 32, personalization: KDF_PERSONALIZATION });
}

/**
 * ChaCha20-Poly1305 openen (nonce 0, geen AAD); gooit als de tag niet klopt.
 * @param {Uint8Array} key @param {Uint8Array} sealed
 */
export function openSealed(key, sealed) {
  if (sealed.length <= 16) fail('Ciphertext too short');
  try {
    return chacha20poly1305(key, ZERO_NONCE).decrypt(sealed);
  } catch {
    return fail('Decryption failed (wrong key or damaged data)');
  }
}

/**
 * Een versleutelde DataDescriptor openen en de binnenste DataDescriptor teruggeven.
 * @param {{ objectdata: Uint8Array, epk?: Uint8Array }} descriptor
 * @param {Uint8Array} ivk
 */
function unwrapEncrypted(descriptor, ivk) {
  if (!descriptor.epk) fail('Encrypted data without epk');
  const inner = unwrapVdxf(openSealed(symmetricKey(descriptor.epk, ivk), descriptor.objectdata));
  if (inner.key !== DATA_DESCRIPTOR_KEY_HEX) fail('Decrypted data is not a data descriptor');
  return parseDataDescriptor(inner.data);
}

/**
 * Laag 1: een waarde uit de contentmultimap (JSON van de daemon) openen tot de verwijzing.
 * @param {any} value  `{ <DataDescriptorKey>: { version, flags, objectdata, epk, ivk } }` of de descriptor zelf
 */
export function openReference(value) {
  const json = value && typeof value === 'object' && DATA_DESCRIPTOR_KEY in value ? value[DATA_DESCRIPTOR_KEY] : value;
  const flags = Number(json?.flags);
  if (!(flags & FLAG_ENCRYPTED) || !(flags & FLAG_EPK) || !(flags & FLAG_IVK)) fail('Not an encrypted reference with a viewing key');
  if (typeof json.objectdata !== 'string' || typeof json.epk !== 'string' || typeof json.ivk !== 'string') fail('Incomplete reference');
  const ivk = hexToBytes(json.ivk);
  const inner = unwrapEncrypted({ objectdata: hexToBytes(json.objectdata), epk: hexToBytes(json.epk) }, ivk);
  const wrapped = unwrapVdxf(inner.objectdata);
  if (wrapped.key !== CROSS_CHAIN_DATA_REF_KEY_HEX) fail('Reference does not point to chain data');
  return { ivk, ref: parseCrossChainDataRef(wrapped.data) };
}

/**
 * Laag 2: het bewijs (hex van één `notaryevidence`-object) openen tot het record.
 * @param {string} evidenceHex @param {Uint8Array} ivk
 * @returns {{ bytes: Uint8Array, salt: Uint8Array | null, flags: number }}
 */
export function openEvidence(evidenceHex, ivk) {
  const evidence = parseEvidenceData(hexToBytes(evidenceHex));
  const wrapped = unwrapVdxf(evidence.data);
  if (wrapped.key !== DATA_DESCRIPTOR_KEY_HEX) fail('Evidence is not a data descriptor (MMR descriptors are not supported yet)');
  let descriptor = parseDataDescriptor(wrapped.data);
  if (descriptor.flags & FLAG_ENCRYPTED) descriptor = unwrapEncrypted(descriptor, ivk);
  if (descriptor.flags & FLAG_ENCRYPTED) fail('Nested encryption is not supported');
  if (descriptor.objectdata.length > MAX_RECORD_BYTES) fail('Record too large');
  return { bytes: descriptor.objectdata, salt: descriptor.salt ?? null, flags: descriptor.flags };
}

/**
 * Een record van Verus Mobile lezen zoals `decryptdata` met `retrieve: true` dat doet.
 * @param {{
 *   value: any,
 *   updateTxid: string,
 *   getTransaction: (txid: string) => Promise<any>,
 * }} input  `value`: de waarde uit de contentmultimap; `updateTxid`: de tx waarin ze verscheen
 *           (uit `getidentityhistory`); `getTransaction`: `getrawtransaction <txid> 1`.
 */
export async function readMobileRecord({ value, updateTxid, getTransaction }) {
  if (typeof updateTxid !== 'string' || !/^[0-9a-f]{64}$/.test(updateTxid)) fail('Invalid update transaction');
  const { ivk, ref } = openReference(value);
  const txid = ref.sameTransaction ? updateTxid : ref.txid;
  const tx = await getTransaction(txid);
  const chainObject = tx?.vout?.[ref.vout]?.scriptPubKey?.notaryevidence?.evidence?.chainobjects?.[ref.objectNum];
  const hex = chainObject?.value?.hex;
  if (typeof hex !== 'string') fail('Referenced evidence not found in the transaction');
  return { ...openEvidence(hex, ivk), txid, vout: ref.vout, objectNum: ref.objectNum };
}
