/**
 * Attestaties lezen (fase 2b), gedeeld door server, browser en losse verifier
 * (fase 4): een deellink ontleden, de getoonde velden tegen de verzegelde wortel
 * controleren en de `signaturedata` opbouwen die de handtekening van Arcade@
 * draagt. Geen Node-imports: sha256 komt van @noble/hashes, base64 van atob/btoa.
 *
 * Attestaties *maken* (zouten, `node:crypto`) blijft in server/attestation.mjs.
 */
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';

import { bytesToHex, encodeMmrHashes, mmrRoot, verifyMmrDisclosure } from './verus-mmr.mjs';

export const ATTESTATION_SCHEMA = 'arcade-attestation';
export const ATTESTATION_VERSION = 1;
/** Vaste volgorde van de bladeren. Een veld moet op zijn eigen plaats staan. */
export const ATTESTATION_FIELDS = Object.freeze(['player', 'round', 'streak', 'rounds', 'solved', 'prev']);
export const ALWAYS_DISCLOSED = Object.freeze(['player', 'round']);
export const NO_PREVIOUS = 'none';
export const DISCLOSURE_VERSION = 1;
export const HASH_SHA256 = 5;

const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
// Daily `…:JJJJ-MM-DD` of testronde `…:JJJJ-MM-DDTUUMM` (server/test-rounds.mjs).
const DAILY_ROUND = /^([a-z0-9-]+):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2}(?:T\d{4})?)$/;
const HEX32 = /^[0-9a-f]{64}$/;
const MAX_LINK_LENGTH = 3000;

export class AttestationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'AttestationError';
    this.code = code;
  }
}

/** @param {string} message @returns {never} */
export const fail = (message) => { throw new AttestationError('INVALID_ATTESTATION', message); };

/** @param {Uint8Array} bytes */
export const sha256 = (bytes) => nobleSha256(bytes);

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Base64 ontleden; `null` als het geen (canonieke) base64 is. @param {string} text */
function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  let binary;
  try { binary = atob(text); } catch { return null; }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return toBase64(bytes) === text ? bytes : null;
}

/** @param {Uint8Array} bytes */
const toHex = (bytes) => bytesToHex(bytes);

/**
 * `word-grid:1.0.0:2026-11-10` → `{ game, version, date }` (bij een testronde: `date` met tijdslot, sorteerbaar).
 * @param {string} roundId
 */
export function parseDailyRoundId(roundId) {
  const match = DAILY_ROUND.exec(roundId ?? '');
  if (!match) fail(`Not a Daily round id: ${roundId}`);
  const [, game, version, date] = /** @type {RegExpExecArray} */ (match);
  return { game, version, date };
}

/**
 * Leest en controleert een openbaarmaking (zonder de handtekening; die komt
 * apart, want daarvoor is de identiteit van Arcade@ op tekenhoogte nodig).
 * @param {any} descriptor
 * @returns {{ root: string, fields: Record<string, string> }}
 */
export function readAttestationDisclosure(descriptor) {
  let checked;
  try {
    checked = verifyMmrDisclosure(descriptor, { sha256 });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (checked.leafCount !== ATTESTATION_FIELDS.length) fail('Not an Arcade attestation (field count)');
  /** @type {Record<string, string>} */
  const fields = {};
  for (const { index, data } of checked.disclosed) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const colon = text.indexOf(':');
    const name = text.slice(0, colon);
    if (colon < 1 || ATTESTATION_FIELDS[index] !== name) fail('Field is not in its own position');
    if (name in fields) fail('Field disclosed twice');
    fields[name] = text.slice(colon + 1);
  }
  for (const name of ALWAYS_DISCLOSED) if (!(name in fields)) fail(`Disclosure must include ${name}`);
  if (!I_ADDRESS.test(fields.player)) fail('Invalid player');
  parseDailyRoundId(fields.round);
  for (const key of ['streak', 'rounds', 'solved']) if (key in fields && !/^(0|[1-9]\d*)$/.test(fields[key])) fail(`Invalid ${key}`);
  if ('prev' in fields && fields.prev !== NO_PREVIOUS && !HEX32.test(fields.prev)) fail('Invalid prev');
  return { root: checked.root, fields };
}

/**
 * Bouwt uit het compacte record (zoals in de ID van de speler) de verzegelde
 * `mmrdescriptor` en de `signaturedata` zoals `signdata` ze geeft.
 * @param {any} record
 * @param {{ serviceId: string, systemId: string }} context ondertekenaar en netwerk
 */
export function expandSealedRecord(record, { serviceId, systemId }) {
  if (record?.schema !== ATTESTATION_SCHEMA || record.version !== ATTESTATION_VERSION) fail('Not an Arcade attestation record');
  parseDailyRoundId(record.round);
  if (typeof record.leaves !== 'string' || typeof record.signature !== 'string' || !Number.isSafeInteger(record.height)) fail('Incomplete attestation record');
  const raw = fromBase64(record.leaves);
  if (!raw || raw.length !== ATTESTATION_FIELDS.length * 32) return fail('Invalid leaves');
  const leaves = Array.from({ length: ATTESTATION_FIELDS.length }, (_, i) => raw.slice(i * 32, (i + 1) * 32));
  const root = toHex(mmrRoot(leaves, (/** @type {Uint8Array} */ l, /** @type {Uint8Array} */ r) => sha256(concat([l, r]))));
  return {
    mmrdescriptor: {
      version: 1, objecthashtype: HASH_SHA256, mmrhashtype: HASH_SHA256,
      mmrroot: { version: 1, flags: 0, objectdata: root },
      mmrhashes: { version: 1, flags: 0, objectdata: encodeMmrHashes(leaves) },
    },
    signaturedata: { version: 1, systemid: systemId, hashtype: HASH_SHA256, signaturehash: root, identityid: serviceId, signaturetype: 1, signature: record.signature },
    signatureheight: record.height,
  };
}

/**
 * Deellink (base64url van JSON) terug naar de inhoud.
 * @param {string} text
 */
export function decodeDisclosureLink(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_LINK_LENGTH || !/^[A-Za-z0-9_-]+$/.test(text)) fail('Invalid disclosure link');
  try {
    const base64 = text.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
    const binary = atob(base64);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
  } catch {
    return fail('Invalid disclosure link');
  }
}

/**
 * Leest een deellink-inhoud en controleert alles wat zonder chain kan: vorm,
 * velden op hun plaats, zouten, en dat de wortel uit de bladeren volgt.
 * De handtekening en de aanwezigheid in de ID van de speler controleert de
 * aanroeper (daarvoor is de chain nodig).
 * @param {any} payload
 * @param {{ serviceId: string, systemId: string }} context
 */
export function readDisclosurePayload(payload, { serviceId, systemId }) {
  if (payload?.v !== DISCLOSURE_VERSION || !Array.isArray(payload.fields) || payload.fields.length > ATTESTATION_FIELDS.length) fail('Unsupported disclosure');
  const expanded = expandSealedRecord(payload.record, { serviceId, systemId });
  const datadescriptors = payload.fields.map((/** @type {unknown} */ entry) => {
    if (!Array.isArray(entry) || entry.length !== 3 || entry.some((x) => typeof x !== 'string')) fail('Invalid disclosed field');
    const [name, value, saltBase64] = /** @type {string[]} */ (entry);
    const salt = fromBase64(saltBase64);
    if (!salt || salt.length !== 32) return fail('Invalid salt');
    return { version: 1, flags: 2, objectdata: toHex(new TextEncoder().encode(`${name}:${value}`)), salt: toHex(salt) };
  });
  const { root, fields } = readAttestationDisclosure({ ...expanded.mmrdescriptor, datadescriptors });
  if (fields.round !== payload.record.round) fail('Round does not match the sealed record');
  return { root, fields, record: payload.record, signaturedata: expanded.signaturedata, signatureheight: expanded.signatureheight };
}
