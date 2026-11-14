/**
 * Resultaatsets controleren: een resultaatrecord valideren en de Merkle-wortel
 * uit een inclusiebewijs nabouwen. Gedeeld door server, browser en losse
 * verifier (fase 4); sha256 van @noble, geen Buffer.
 *
 * Het *opbouwen* van een resultaatset blijft in server/result-set.mjs; de tests
 * bouwen daar en controleren hier, zodat beide kanten tegen elkaar getest zijn.
 *
 *   blad = sha256(0x00 ‖ canonieke JSON van het record)
 *   knoop = sha256(0x01 ‖ links ‖ rechts)   (oneven laatste: met zichzelf)
 *   lege set = sha256(0x02)
 */
import { sha256 } from '@noble/hashes/sha2';

import { canonicalJson } from './canonical-json.mjs';
import { gameRules } from './games/index.mjs';

export const RESULT_ALGORITHM = 'arcade-merkle-sha256-jcs-v1';

const encoder = new TextEncoder();

/** @param {Uint8Array[]} parts */
function hashParts(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return sha256(out);
}

/** @param {Uint8Array} bytes */
export const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** @param {string} hex */
function fromHex(hex) {
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

/** @param {string} recordJson */
export const leafHash = (recordJson) => hashParts(Uint8Array.of(0), encoder.encode(recordJson));
/** @param {Uint8Array} left @param {Uint8Array} right */
export const nodeHash = (left, right) => hashParts(Uint8Array.of(1), left, right);
export const emptyRoot = () => hashParts(Uint8Array.of(2));

/** Canonieke base64 van precies `length` bytes? @param {unknown} text @param {number} length */
export function isCanonicalBase64(text, length) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return false;
  let binary;
  try { binary = atob(text); } catch { return false; }
  if (binary.length !== length) return false;
  return btoa(binary) === text;
}

const BASE_KEYS = ['schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'playerIAddress', 'status', 'guesses', 'score'];

/**
 * Schema 1: het v1-record. Schema 2 (fase 1): identiek plus `playerSignature`,
 * null of { height, signature } met de native Verus-handtekening (73 bytes,
 * base64) van de speler over het bericht uit server/verus/attempt-message.mjs.
 * Oude rondes blijven schema 1 en verifiëren ongewijzigd.
 * @param {any} value
 */
function validatePlayerSignature(value) {
  if (value === null) return true;
  return (
    value !== undefined &&
    typeof value === 'object' &&
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.height) &&
    value.height >= 1 &&
    value.height <= 0xffff_ffff &&
    typeof value.signature === 'string' &&
    /^[A-Za-z0-9+/]{98}==$/.test(value.signature) &&
    isCanonicalBase64(value.signature, 73)
  );
}

// Schema 3 (fase 8): voor elke game. `actions` met canonieke zetten van de game,
// `score` met `actionsUsed`; verder gelijk aan schema 2 (met playerSignature).
const V3_KEYS = ['schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'playerIAddress', 'status', 'actions', 'score', 'playerSignature'];

/** @param {any} record */
function validateRecordV3(record) {
  const fail = (/** @type {string} */ why) => { throw new Error(`Result record does not match schema version 3: ${why}`); };
  if (Object.keys(record).length !== V3_KEYS.length || V3_KEYS.some((key) => !(key in record))) fail('keys');
  if (
    !record.roundId || !record.chainId || !record.gameId || !record.gameVersion || !record.playerIAddress ||
    [record.chainId, record.playerIAddress].some((value) => typeof value !== 'string' || value.includes('\0')) ||
    !String(record.roundId).startsWith(`${record.gameId}:${record.gameVersion}:`)
  ) fail('round or player');
  /** @type {any} */
  let rules;
  try { rules = gameRules(record.gameId, record.gameVersion); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (!['solved', 'unsolved', 'abandoned'].includes(record.status)) fail('status');
  if (!Array.isArray(record.actions) || record.actions.length > rules.meta.maxActions) fail('actions');
  record.actions.forEach((/** @type {any} */ action, /** @type {number} */ index) => {
    if (!action || typeof action !== 'object' || Object.keys(action).length !== 2 || action.sequence !== index + 1 || typeof action.value !== 'string') fail(`action ${index + 1}`);
    let canonical;
    try { canonical = rules.normalizeAction(action.value); } catch { fail(`action ${index + 1} is not valid for ${record.gameId}`); }
    if (canonical !== action.value) fail(`action ${index + 1} is not canonical`);
  });
  if (
    !record.score || Object.keys(record.score).length !== 2 ||
    typeof record.score.solved !== 'boolean' || record.score.actionsUsed !== record.actions.length ||
    record.score.solved !== (record.status === 'solved')
  ) fail('score');
  if (!validatePlayerSignature(record.playerSignature)) fail('playerSignature');
}

/**
 * Een resultaatrecord (schema 1, 2 of 3) valideren; gooit bij een afwijking.
 * @param {any} record
 */
export function validateResultRecord(record) {
  const version = record?.schemaVersion;
  if (version === 3) return validateRecordV3(record);
  if (version !== 1 && version !== 2) {
    throw new Error('Result record does not match schema version 1 or 2');
  }
  const keys = version === 2 ? [...BASE_KEYS, 'playerSignature'] : BASE_KEYS;
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !(key in record)) ||
    !record.roundId ||
    !record.chainId ||
    !record.gameId ||
    !record.gameVersion ||
    !record.playerIAddress ||
    [record.chainId, record.playerIAddress].some(
      (value) => typeof value !== 'string' || value.includes('\0'),
    ) ||
    !['solved', 'unsolved', 'abandoned'].includes(record.status) ||
    !Array.isArray(record.guesses) ||
    record.guesses.some(
      (/** @type {any} */ guess, /** @type {number} */ index) =>
        Object.keys(guess).length !== 2 ||
        guess.sequence !== index + 1 ||
        !/^[a-z]{5}$/.test(guess.word),
    ) ||
    Object.keys(record.score ?? {}).length !== 2 ||
    typeof record.score.solved !== 'boolean' ||
    !Number.isSafeInteger(record.score.guessesUsed) ||
    record.score.guessesUsed !== record.guesses.length ||
    record.score.solved !== (record.status === 'solved') ||
    (version === 2 && !validatePlayerSignature(record.playerSignature))
  ) {
    throw new Error(`Result record does not match schema version ${version}`);
  }
}

/**
 * Wortel die uit een inclusiebewijs volgt (hex), of null als het bewijs niet
 * klopt in vorm, record of posities. Gebruikt door verifyInclusionProof en door
 * het compacte spelersrecord (v2/v3), dat de wortel niet meedraagt.
 * @param {any} proof
 * @returns {string | null}
 */
export function inclusionRoot(proof) {
  try {
    let expectedSiblingCount = 0;
    for (let width = proof?.leafCount; Number.isSafeInteger(width) && width > 1;) {
      expectedSiblingCount++;
      width = Math.ceil(width / 2);
    }
    if (
      proof?.algorithm !== RESULT_ALGORITHM ||
      !Number.isSafeInteger(proof.leafIndex) ||
      !Number.isSafeInteger(proof.leafCount) ||
      proof.leafCount < 1 ||
      proof.leafIndex < 0 ||
      proof.leafIndex >= proof.leafCount ||
      !Array.isArray(proof.siblings) ||
      proof.siblings.length !== expectedSiblingCount
    ) {
      return null;
    }
    validateResultRecord(proof.record);
    let current = leafHash(canonicalJson(proof.record));
    let index = proof.leafIndex;
    for (const sibling of proof.siblings) {
      if (
        !['left', 'right'].includes(sibling?.position) ||
        !/^[0-9a-f]{64}$/.test(sibling?.sha256)
      ) {
        return null;
      }
      const expectedPosition = index % 2 === 1 ? 'left' : 'right';
      if (sibling.position !== expectedPosition) return null;
      const siblingHash = fromHex(sibling.sha256);
      current = sibling.position === 'left' ? nodeHash(siblingHash, current) : nodeHash(current, siblingHash);
      index = Math.floor(index / 2);
    }
    return toHex(current);
  } catch {
    return null;
  }
}

/** @param {any} proof */
export function verifyInclusionProof(proof) {
  if (!/^[0-9a-f]{64}$/.test(proof?.rootSha256 ?? '')) return false;
  const root = inclusionRoot(proof);
  return root !== null && root === proof.rootSha256;
}
