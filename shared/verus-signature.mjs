/**
 * Fase 4: een VerusID-handtekening controleren zonder daemon en zonder de grote
 * SDK, zodat de browser het zelf kan. Doet hetzelfde als `verusid-ts-client`
 * `verifyHash` (bitgo utxo-lib `IdentitySignature.verifyHashOffline`) en
 * `verus-typescript-primitives` `SignatureData.getIdentityHash`; nagekeken tegen
 * echte handtekeningen van Arcade@ (`fixtures/arcade-signatures.json`) en in de
 * tests tegen de SDK zelf.
 *
 *   digest (versie 2) = sha256( hash160(systeem) ‖ hoogte (uint32 LE) ‖ hash160(identiteit)
 *                               ‖ varslice("Verus signed data:\n") ‖ ondertekende hash )
 *   digest (versie 1) = sha256( varslice(prefix) ‖ hash160(systeem) ‖ hoogte ‖ hash160(identiteit) ‖ hash )
 *
 * Handtekening (base64) = versie ‖ [hashtype bij v2] ‖ hoogte (uint32 LE) ‖ aantal ‖ per
 * handtekening varslice(65 bytes compact: kop 27+recid(+4 gecomprimeerd), r, s).
 * Geldig = op tekenhoogte actief en niet ingetrokken, en minstens `minimumsignatures`
 * verschillende primaire adressen waarvan de sleutel uit een handtekening terugkomt.
 *
 * Alleen hashtype 5 (sha256), zoals Arcade en Verus Mobile gebruiken.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';

import { VRSCTEST_CHAIN_ID } from './chain-reader.mjs';

export const HASH_SHA256 = 5;
export const I_ADDRESS_VERSION = 102;
export const R_ADDRESS_VERSION = 60;
const FLAG_REVOKED = 0x8000;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PREFIX_TEXT = 'Verus signed data:\n';

export class SignatureCheckError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'SignatureCheckError';
    this.code = code;
  }
}

/** @param {string} message */
const invalid = (message) => new SignatureCheckError('INVALID_SIGNATURE', message);

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** @param {string} hex */
function hexBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw invalid('Invalid hex');
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** @param {string} text */
function base64Bytes(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw invalid('Invalid base64');
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Base58Check ontleden (versie + 20 bytes), met controle van de checksum.
 * @param {string} address
 * @returns {{ version: number, hash: Uint8Array }}
 */
export function decodeBase58Check(address) {
  if (typeof address !== 'string' || address.length === 0 || address.length > 64) throw invalid('Invalid address');
  let value = 0n;
  for (const char of address) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw invalid('Invalid address');
    value = value * 58n + BigInt(digit);
  }
  /** @type {number[]} */
  const bytes = [];
  while (value > 0n) { bytes.unshift(Number(value % 256n)); value /= 256n; }
  for (const char of address) { if (char !== '1') break; bytes.unshift(0); }
  const raw = Uint8Array.from(bytes);
  if (raw.length !== 25) throw invalid('Invalid address length');
  const payload = raw.subarray(0, 21);
  if (!equalBytes(sha256(sha256(payload)).subarray(0, 4), raw.subarray(21))) throw invalid('Invalid address checksum');
  return { version: payload[0], hash: payload.slice(1) };
}

/** @param {string} address @param {number} version */
function addressHash(address, version) {
  const decoded = decodeBase58Check(address);
  if (decoded.version !== version) throw invalid('Unexpected address type');
  return decoded.hash;
}

const PREFIX = concat([Uint8Array.of(PREFIX_TEXT.length), new TextEncoder().encode(PREFIX_TEXT)]);

/** @param {number} value */
function uint32le(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

/**
 * De hash die een VerusID tekent voor `signdata` (hashtype sha256).
 * @param {{ version: number, systemId: string, height: number, identityId: string, signatureHash: string }} input
 */
export function identitySignatureDigest({ version, systemId, height, identityId, signatureHash }) {
  if (!Number.isSafeInteger(height) || height < 0 || height > 0xffff_ffff) throw invalid('Invalid height');
  const system = addressHash(systemId, I_ADDRESS_VERSION);
  const identity = addressHash(identityId, I_ADDRESS_VERSION);
  const hash = hexBytes(signatureHash);
  if (hash.length !== 32) throw invalid('Invalid signature hash');
  if (version === 1) return sha256(concat([PREFIX, system, uint32le(height), identity, hash]));
  if (version === 2) return sha256(concat([system, uint32le(height), identity, PREFIX, hash]));
  throw invalid('Unsupported signature version');
}

/**
 * De bytes van een VerusID-handtekening ontleden.
 * @param {string} base64
 * @returns {{ version: number, hashType: number, height: number, signatures: Uint8Array[] }}
 */
export function parseIdentitySignature(base64) {
  const bytes = base64Bytes(base64);
  let offset = 0;
  const need = (/** @type {number} */ n) => { if (offset + n > bytes.length) throw invalid('Signature too short'); };
  need(1);
  const version = bytes[offset++];
  let hashType = HASH_SHA256;
  if (version === 2) { need(1); hashType = bytes[offset++]; }
  if ((version !== 1 && version !== 2) || hashType !== HASH_SHA256) throw invalid('Unsupported signature version or hash type');
  need(5);
  const height = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
  offset += 4;
  const count = bytes[offset++];
  /** @type {Uint8Array[]} */
  const signatures = [];
  for (let i = 0; i < count; i++) {
    need(1);
    let length = bytes[offset++];
    if (length === 0xfd) { need(2); length = bytes[offset] | (bytes[offset + 1] << 8); offset += 2; }
    else if (length > 0xfd) throw invalid('Signature too long');
    need(length);
    signatures.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== bytes.length) throw invalid('Trailing bytes in signature');
  if (signatures.length === 0) throw invalid('No signatures');
  return { version, hashType, height, signatures };
}

/**
 * hash160 van de sleutel die deze compacte handtekening over `digest` zette, of null.
 * @param {Uint8Array} digest
 * @param {Uint8Array} compact  65 bytes: kop, r, s
 */
function recoverSigner(digest, compact) {
  if (compact.length !== 65) return null;
  const header = compact[0] - 27;
  if (header < 0 || header > 7) return null;
  try {
    const signature = secp256k1.Signature.fromCompact(compact.subarray(1)).addRecoveryBit(header & 3);
    const publicKey = signature.recoverPublicKey(digest).toRawBytes(header >= 4);
    if (!secp256k1.verify(compact.subarray(1), digest, publicKey, { lowS: false })) return null;
    return ripemd160(sha256(publicKey));
  } catch {
    return null;
  }
}

/**
 * Een handtekening in `signdata`-vorm controleren tegen de identiteit op tekenhoogte
 * (zoals `getidentity <id> <hoogte>` die geeft). Gooit bij een vormfout; geeft
 * `valid: false` met een reden als de handtekening niet klopt.
 * @param {{
 *   signaturedata: { version?: number, systemid: string, hashtype: number, signaturehash: string, identityid: string, signaturetype: number, signature: string },
 *   signatureheight: number,
 *   identityAtHeight: any,
 * }} input
 * @returns {{ valid: boolean, reason: string | null, signer: string, height: number, signers: number, required: number }}
 */
export function verifyIdentitySignature({ signaturedata: sd, signatureheight, identityAtHeight }) {
  if (Number(sd?.hashtype) !== HASH_SHA256 || Number(sd?.signaturetype) !== 1) throw invalid('Unsupported signature type');
  if (sd.systemid !== VRSCTEST_CHAIN_ID) throw new SignatureCheckError('UNSUPPORTED_NETWORK', 'Only VRSCTEST signatures are supported');
  addressHash(sd.identityid, I_ADDRESS_VERSION);
  const parsed = parseIdentitySignature(sd.signature);
  const result = { valid: false, reason: /** @type {string | null} */ (null), signer: sd.identityid, height: parsed.height, signers: 0, required: 0 };
  if (parsed.height !== Number(signatureheight)) return { ...result, reason: 'Signature height mismatch' };

  const identity = identityAtHeight?.identity;
  if (identity?.identityaddress !== sd.identityid || identity?.systemid !== VRSCTEST_CHAIN_ID) throw invalid('Identity state belongs to another identity');
  if (Number.isSafeInteger(identityAtHeight.blockheight) && identityAtHeight.blockheight > parsed.height) throw invalid('Identity state is newer than the signature');
  const required = Number(identity.minimumsignatures);
  if (!Array.isArray(identity.primaryaddresses) || !Number.isSafeInteger(required) || required < 1) throw invalid('Identity has no usable primary addresses');
  result.required = required;
  if (identityAtHeight.status !== 'active' || (Number(identity.flags) & FLAG_REVOKED) !== 0) {
    return { ...result, reason: 'The signing identity was not active at signing height' };
  }

  const digest = identitySignatureDigest({
    version: parsed.version, systemId: sd.systemid, height: parsed.height, identityId: sd.identityid, signatureHash: sd.signaturehash,
  });
  const recovered = parsed.signatures.map((compact) => recoverSigner(digest, compact)).filter((h) => h !== null);
  const signedBy = new Set();
  for (const address of identity.primaryaddresses) {
    let hash;
    try { hash = addressHash(address, R_ADDRESS_VERSION); } catch { continue; }
    if (recovered.some((h) => equalBytes(/** @type {Uint8Array} */ (h), hash))) signedBy.add(address);
  }
  result.signers = signedBy.size;
  if (signedBy.size >= required) return { ...result, valid: true };
  return { ...result, reason: signedBy.size === 0 ? 'Signature is not from a key of this identity' : 'Not enough signatures' };
}
