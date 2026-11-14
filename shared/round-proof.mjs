/**
 * De publieke bewijsstukken van een ronde nakijken: commitment, reveal en
 * result-descriptor, zoals de operator ze op `Arcade@` zet.
 *
 * Fase 4: één versie voor server, browser en losse verifier. Vroeger stond dit
 * twee keer (server/round-proof.mjs en src/lib/proof-verifier.ts); de uitkomsten
 * zijn die van de serverversie (de browserversie was op vier randgevallen
 * soepeler), bewezen met `fixtures/round-reveal-vectors.json`.
 *
 * Geen Node-imports: de sha256 wordt meegegeven (`node:crypto` op de server,
 * `browser-safe` in de browser).
 */
import { canonicalJson } from './canonical-json.mjs';
import { gameRules } from './games/index.mjs';

export const HIDDEN_DEFINITION_KEYS = Object.freeze([
  'schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'date', 'opensAt', 'closesAt', 'puzzleSeed', 'answer', 'salt',
]);

/** Schema 2 (fase 8): voor elke game; de puzzel controleert de game zelf. */
export const HIDDEN_DEFINITION_KEYS_V2 = Object.freeze([
  'schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'date', 'opensAt', 'closesAt', 'puzzle', 'salt',
]);

export const COMMITMENT_KEYS = Object.freeze([
  'schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'date', 'opensAt', 'closesAt', 'hiddenDefinitionSha256',
]);

export const RESULT_DESCRIPTOR_KEYS = Object.freeze([
  'schemaVersion', 'algorithm', 'roundId', 'chainId', 'gameId', 'gameVersion', 'leafCount', 'rootSha256', 'bundleSha256',
]);

export const RESULT_ALGORITHM = 'arcade-merkle-sha256-jcs-v1';

const HEX64 = /^[0-9a-f]{64}$/;

/** @param {any} value @param {readonly string[]} keys */
const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** @param {any} value */
const usableChainId = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');

/**
 * @param {any} definition
 * @returns {{ opensAt: number, closesAt: number }}
 */
function validTimes(definition) {
  const opensAt = Date.parse(definition.opensAt);
  const closesAt = Date.parse(definition.closesAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= opensAt) {
    throw new Error('Round timestamps are invalid');
  }
  return { opensAt, closesAt };
}

/**
 * Controleert de vorm van een geheime rondedefinitie (schema 1 of 2); gooit bij een fout.
 * @param {any} definition
 * @returns {{ opensAt: number, closesAt: number }}
 */
export function validateHiddenDefinition(definition) {
  if (definition?.schemaVersion === 2) return validateHiddenDefinitionV2(definition);
  if (
    definition?.schemaVersion !== 1 ||
    !exactKeys(definition, HIDDEN_DEFINITION_KEYS) ||
    !usableChainId(definition.chainId) ||
    typeof definition.roundId !== 'string' ||
    typeof definition.gameId !== 'string' ||
    typeof definition.gameVersion !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(definition.date) ||
    !HEX64.test(definition.puzzleSeed) ||
    !/^[a-z]{5}$/.test(definition.answer) ||
    !HEX64.test(definition.salt)
  ) {
    throw new Error('Hidden round definition does not match schema version 1');
  }
  return validTimes(definition);
}

/** @param {any} definition */
function validateHiddenDefinitionV2(definition) {
  if (
    !exactKeys(definition, HIDDEN_DEFINITION_KEYS_V2) ||
    !usableChainId(definition.chainId) ||
    typeof definition.roundId !== 'string' ||
    typeof definition.gameId !== 'string' ||
    typeof definition.gameVersion !== 'string' ||
    !definition.roundId.startsWith(`${definition.gameId}:${definition.gameVersion}:`) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(definition.date) ||
    !HEX64.test(definition.salt)
  ) {
    throw new Error('Hidden round definition does not match schema version 2');
  }
  try {
    gameRules(definition.gameId, definition.gameVersion).validatePuzzle(definition.puzzle);
  } catch (error) {
    throw new Error(`Hidden round definition has an invalid puzzle: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validTimes(definition);
}

/**
 * De puzzel van een definitie, in de vorm van het gamecontract (schema 1: Word Grid).
 * @param {any} definition
 */
export function definitionPuzzle(definition) {
  validateHiddenDefinition(definition);
  return definition.schemaVersion === 1 ? { answer: definition.answer } : definition.puzzle;
}

/**
 * De tekst waarover de commitment-hash gaat (na vormcontrole).
 * @param {any} definition
 */
export function hiddenDefinitionText(definition) {
  validateHiddenDefinition(definition);
  return canonicalJson(definition);
}

/**
 * Vorm van een publieke commitment (schema 1); gooit bij een fout.
 * @param {any} commitment
 */
export function validateCommitment(commitment) {
  if (
    commitment?.schemaVersion !== 1 ||
    !exactKeys(commitment, COMMITMENT_KEYS) ||
    !usableChainId(commitment.chainId) ||
    ['roundId', 'gameId', 'gameVersion', 'date', 'opensAt', 'closesAt'].some((key) => typeof commitment[key] !== 'string') ||
    !HEX64.test(commitment.hiddenDefinitionSha256)
  ) {
    throw new Error('Commitment does not match schema version 1');
  }
  validTimes(commitment);
}

/**
 * Vorm van een result-descriptor (schema 1) en of hij bij de commitment hoort; gooit bij een fout.
 * @param {any} descriptor
 * @param {any} [commitment]
 */
export function validateResultDescriptor(descriptor, commitment) {
  if (
    descriptor?.schemaVersion !== 1 ||
    !exactKeys(descriptor, RESULT_DESCRIPTOR_KEYS) ||
    descriptor.algorithm !== RESULT_ALGORITHM ||
    !usableChainId(descriptor.chainId) ||
    ['roundId', 'gameId', 'gameVersion'].some((key) => typeof descriptor[key] !== 'string') ||
    !Number.isSafeInteger(descriptor.leafCount) || descriptor.leafCount < 0 ||
    !HEX64.test(descriptor.rootSha256) ||
    !HEX64.test(descriptor.bundleSha256)
  ) {
    throw new Error('Result descriptor does not match schema version 1');
  }
  if (commitment && ['roundId', 'chainId', 'gameId', 'gameVersion'].some((key) => descriptor[key] !== commitment[key])) {
    throw new Error('Result descriptor belongs to another round');
  }
}

/**
 * Alles behalve de hash: hoort deze reveal bij deze commitment? Geeft de tekst
 * om te hashen, of de reden waarom het niet klopt.
 * @param {{ commitment: any, reveal: any }} input
 * @returns {{ text: string, display: string } | { reason: string, display: string | null }}
 */
function revealPrecheck({ commitment, reveal }) {
  const definition = reveal?.hiddenDefinition;
  /** @type {string | null} */
  let display = null;
  // Voor de pagina: ook bij een ongeldige definitie de hash tonen als dat kan.
  try { if (definition) display = canonicalJson(definition); } catch { display = null; }
  if (commitment?.schemaVersion !== 1 || !HEX64.test(commitment?.hiddenDefinitionSha256)) return { reason: 'commitment', display };
  if (reveal?.schemaVersion !== 1 || !HEX64.test(reveal?.commitmentTxid) || !definition) return { reason: 'reveal', display };
  const sameMetadata = ['roundId', 'chainId', 'gameId', 'gameVersion', 'date', 'opensAt', 'closesAt']
    .every((key) => commitment[key] === definition[key]);
  if (!sameMetadata) return { reason: 'metadata', display };
  try {
    return { text: hiddenDefinitionText(definition), display: /** @type {string} */ (display) };
  } catch {
    return { reason: 'definition', display };
  }
}

/**
 * @typedef {{ valid: boolean, recomputedSha256: string | null, reason: string | null }} RevealCheck
 */

/**
 * Klopt de reveal met de commitment? Synchroon (server, met `node:crypto`).
 * @param {{ commitment: any, reveal: any }} input
 * @param {(text: string) => string} sha256Hex  sha256 van de UTF-8-tekst, als hex
 * @returns {RevealCheck}
 */
export function verifyRoundRevealSync(input, sha256Hex) {
  const pre = revealPrecheck(input);
  const recomputedSha256 = pre.display === null ? null : sha256Hex(pre.display);
  if ('reason' in pre) return { valid: false, recomputedSha256, reason: pre.reason };
  const valid = recomputedSha256 === input.commitment.hiddenDefinitionSha256;
  return { valid, recomputedSha256, reason: valid ? null : 'hash' };
}

/**
 * Klopt de reveal met de commitment? Asynchroon (browser, Web Crypto of browser-safe).
 * @param {{ commitment: any, reveal: any }} input
 * @param {(text: string) => Promise<string>} sha256Hex  sha256 van de UTF-8-tekst, als hex
 * @returns {Promise<RevealCheck>}
 */
export async function verifyRoundReveal(input, sha256Hex) {
  const pre = revealPrecheck(input);
  const recomputedSha256 = pre.display === null ? null : await sha256Hex(pre.display);
  if ('reason' in pre) return { valid: false, recomputedSha256, reason: pre.reason };
  const valid = recomputedSha256 === input.commitment.hiddenDefinitionSha256;
  return { valid, recomputedSha256, reason: valid ? null : 'hash' };
}
