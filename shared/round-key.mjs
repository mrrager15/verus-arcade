/**
 * Fase 5: de versleutelsleutel van een ronde, afgeleid uit de salt van de ronde.
 *
 * Spelers versleutelen hun actie-bundel naar het ADRES (staat in het commitment);
 * lezen kan alleen wie de salt kent. Vóór de reveal is dat alleen de operator,
 * erna iedereen: de reveal onthult de salt, en hieruit volgt de leessleutel.
 * Geen daemon, geen wallet, geen extra geheim. Gedeeld: browser, server en losse
 * verifier; alleen @noble.
 *
 *   ivk         = BLAKE2b-256(salt, "ArcadeRoundIvkV1"), hoogste 5 bits op 0 (251 bits, zoals een Sapling-ivk)
 *   diversifier = BLAKE2b-88(salt ‖ teller, "ArcadeRoundDivV1"), eerste teller met een geldig punt
 *   g_d         = DiversifyHash(diversifier)   (Jubjub-groepshash, personalisatie "Zcash_gd")
 *   pk_d        = [ivk] g_d
 *   adres       = bech32("zs", diversifier ‖ pk_d)   (Verus gebruikt "zs" ook op VRSCTEST)
 *
 * Het adres is een geldig Sapling-adres waarnaar de daemon wil versleutelen
 * (`encrypttoaddress`), en `decryptdata` aanvaardt de `ivk` als hex. Er hoort
 * geen spending key bij: er kan nooit geld naartoe.
 * Nagekeken tegen de daemon op `fixtures/round-key-bundle.json` (fase 5 stap 1).
 */
import { jubjub_groupHash } from '@noble/curves/misc';
import { blake2b } from '@noble/hashes/blake2b';

const text = (/** @type {string} */ value) => new TextEncoder().encode(value);
const IVK_PERSONALIZATION = text('ArcadeRoundIvkV1');
const DIVERSIFIER_PERSONALIZATION = text('ArcadeRoundDivV1');
const DIVERSIFY_PERSONALIZATION = text('Zcash_gd');
const SAPLING_HRP = 'zs';
const DIVERSIFIER_BYTES = 11;
const ADDRESS_BYTES = 43;
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const HEX64 = /^[0-9a-f]{64}$/;

/** Vorm van een Sapling-adres (zonder de controlesom na te rekenen). */
export const SAPLING_ADDRESS_PATTERN = /^zs1[02-9ac-hj-np-z]{75}$/;

export class RoundKeyError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RoundKeyError';
    this.code = 'INVALID_ROUND_KEY';
  }
}

/** @param {string} message @returns {never} */
const fail = (message) => { throw new RoundKeyError(message); };

/** @param {Uint8Array} bytes */
const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {string} hex */
const fromHex = (hex) => Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));

/** @param {Uint8Array} bytes */
function littleEndian(bytes) {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

// ── bech32 (BIP-173), alleen wat een Sapling-adres nodig heeft ───────────────

/** @param {number[]} values */
function polymod(values) {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const value of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= generators[i];
  }
  return chk >>> 0;
}

/** @param {string} hrp */
const hrpExpand = (hrp) => [...Array.from(hrp, (c) => c.charCodeAt(0) >> 5), 0, ...Array.from(hrp, (c) => c.charCodeAt(0) & 31)];

/** 8-bits bytes naar groepen van 5 bits, met opvulling. @param {Uint8Array} bytes */
function toWords(bytes) {
  /** @type {number[]} */
  const words = [];
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

/** Groepen van 5 bits terug naar bytes; de opvulling moet nul zijn. @param {number[]} words */
function fromWords(words) {
  /** @type {number[]} */
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (const word of words) {
    acc = (acc << 5) | word;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >>> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) fail('Invalid address padding');
  return Uint8Array.from(bytes);
}

/**
 * Een Sapling-adres uit diversifier (11 bytes) en pk_d (32 bytes).
 * @param {Uint8Array} diversifier @param {Uint8Array} pkd
 */
export function saplingAddress(diversifier, pkd) {
  if (diversifier.length !== DIVERSIFIER_BYTES || pkd.length !== 32) fail('Invalid address parts');
  const words = toWords(Uint8Array.of(...diversifier, ...pkd));
  const mod = polymod([...hrpExpand(SAPLING_HRP), ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${SAPLING_HRP}1${[...words, ...checksum].map((w) => BECH32[w]).join('')}`;
}

/**
 * Een Sapling-adres ontleden; gooit als vorm of controlesom niet klopt.
 * @param {string} address
 * @returns {{ diversifier: Uint8Array, pkd: Uint8Array }}
 */
export function parseSaplingAddress(address) {
  if (typeof address !== 'string' || !SAPLING_ADDRESS_PATTERN.test(address)) fail('Not a Sapling address');
  const words = Array.from(address.slice(SAPLING_HRP.length + 1), (c) => BECH32.indexOf(c));
  if (polymod([...hrpExpand(SAPLING_HRP), ...words]) !== 1) fail('Address checksum does not match');
  const bytes = fromWords(words.slice(0, -6));
  if (bytes.length !== ADDRESS_BYTES) fail('Invalid address length');
  return { diversifier: bytes.slice(0, DIVERSIFIER_BYTES), pkd: bytes.slice(DIVERSIFIER_BYTES) };
}

/**
 * De ronde-sleutel uit de salt (64 hex-tekens, zoals in de rondedefinitie).
 * @param {string} saltHex
 * @returns {{ ivk: Uint8Array, ivkHex: string, diversifier: Uint8Array, pkd: Uint8Array, address: string }}
 */
export function roundKeyFromSalt(saltHex) {
  if (typeof saltHex !== 'string' || !HEX64.test(saltHex)) fail('Round salt must be 64 hex characters');
  const salt = fromHex(saltHex);
  const ivk = blake2b(salt, { dkLen: 32, personalization: IVK_PERSONALIZATION });
  ivk[31] &= 0x07;
  const scalar = littleEndian(ivk);
  if (scalar === 0n) fail('Round key is zero');
  for (let counter = 0; counter < 256; counter++) {
    const diversifier = blake2b(Uint8Array.of(...salt, counter), { dkLen: DIVERSIFIER_BYTES, personalization: DIVERSIFIER_PERSONALIZATION });
    let gd;
    try { gd = jubjub_groupHash(diversifier, DIVERSIFY_PERSONALIZATION); } catch { continue; } // ±de helft is geen geldig punt
    const pkd = gd.multiply(scalar).toRawBytes();
    return { ivk, ivkHex: toHex(ivk), diversifier, pkd, address: saplingAddress(diversifier, pkd) };
  }
  return fail('No valid diversifier for this salt');
}

/**
 * Hoort dit adres bij deze salt? Dat rekent de verifier na de reveal na: een
 * operator die een ander adres publiceerde, kan de bundels niet laten lezen.
 * @param {string} address @param {string} saltHex
 */
export function addressMatchesSalt(address, saltHex) {
  try { return roundKeyFromSalt(saltHex).address === address; } catch { return false; }
}
