/**
 * VDXF-keys berekenen zonder SDK (fase 4): dezelfde uitkomst als
 * `verus-typescript-primitives` `getDataKey(naam, namespace)` voor gewone
 * namen onder een namespace-ID (zoals `arcade.player.result.<ronde>` onder
 * Arcade@). Nagekeken in de tests tegen de SDK en tegen echte keys.
 *
 *   ouder  = hash160( sha256d( hash160(namespace) ‖ sha256d("::") ) )
 *   per naamdeel van rechts naar links (gesplitst op "."), behalve het eerste:
 *            ouder = hash160( sha256d( ouder ‖ sha256d(deel) ) )
 *   key    = base58check(102, hash160( sha256d( ouder ‖ sha256d(eerste deel) ) ))
 * Namen worden met de "C-locale" klein gemaakt (alleen A–Z).
 */
import { ripemd160 } from '@noble/hashes/legacy';
import { sha256 } from '@noble/hashes/sha2';

import { decodeBase58Check, I_ADDRESS_VERSION } from './verus-signature.mjs';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const encoder = new TextEncoder();

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** sha256(sha256(…)) over de aaneengeschakelde delen. @param {...Uint8Array} parts */
const sha256d = (...parts) => sha256(sha256(concat(parts)));
/** @param {Uint8Array} bytes */
const hash160 = (bytes) => ripemd160(sha256(bytes));
/** Kleine letters zoals de daemon (C-locale): alleen A–Z. @param {string} text */
const lowerC = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Base58Check met één versiebyte.
 * @param {Uint8Array} hash @param {number} version
 */
export function encodeBase58Check(hash, version) {
  const payload = concat([Uint8Array.of(version), hash]);
  const bytes = concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = '';
  while (value > 0n) { text = ALPHABET[Number(value % 58n)] + text; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; text = `1${text}`; }
  return text;
}

/**
 * De VDXF-key (i-adres) van `name` in de namespace van een identiteit.
 * @param {string} name  bv. `arcade.player.result.word-grid:1.0.0:2026-11-10`
 * @param {string} namespaceId  i-adres van de namespace, bv. Arcade@
 */
export function vdxfDataKey(name, namespaceId) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,200}$/.test(name) || name.includes('::') || name.endsWith('.')) {
    throw new Error('Unsupported key name');
  }
  const decoded = decodeBase58Check(namespaceId);
  if (decoded.version !== I_ADDRESS_VERSION) throw new Error('Namespace must be an i-address');
  let parent = hash160(sha256d(decoded.hash, sha256d(encoder.encode('::'))));
  const parts = name.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    parent = hash160(sha256d(parent, sha256d(encoder.encode(lowerC(parts[i])))));
  }
  return encodeBase58Check(hash160(sha256d(parent, sha256d(encoder.encode(lowerC(parts[0]))))), I_ADDRESS_VERSION);
}
