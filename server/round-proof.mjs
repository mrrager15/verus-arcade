import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { gameRules } from '../shared/games/index.mjs';

const HIDDEN_DEFINITION_KEYS = Object.freeze([
  'schemaVersion',
  'roundId',
  'chainId',
  'gameId',
  'gameVersion',
  'date',
  'opensAt',
  'closesAt',
  'puzzleSeed',
  'answer',
  'salt',
]);

// Schema 2 (fase 8): voor elke game; de puzzel controleert de game zelf.
const HIDDEN_DEFINITION_KEYS_V2 = Object.freeze([
  'schemaVersion',
  'roundId',
  'chainId',
  'gameId',
  'gameVersion',
  'date',
  'opensAt',
  'closesAt',
  'puzzle',
  'salt',
]);

/** De puzzel van een definitie, in de vorm van het gamecontract (schema 1: Word Grid). */
export function definitionPuzzle(definition) {
  validateHiddenDefinition(definition);
  return definition.schemaVersion === 1 ? { answer: definition.answer } : definition.puzzle;
}

export function validateHiddenDefinition(definition) {
  if (definition?.schemaVersion === 2) return validateHiddenDefinitionV2(definition);
  if (
    definition?.schemaVersion !== 1 ||
    Object.keys(definition).length !== HIDDEN_DEFINITION_KEYS.length ||
    HIDDEN_DEFINITION_KEYS.some((key) => !(key in definition)) ||
    typeof definition.chainId !== 'string' ||
    definition.chainId.length === 0 ||
    definition.chainId.includes('\0') ||
    typeof definition.roundId !== 'string' ||
    typeof definition.gameId !== 'string' ||
    typeof definition.gameVersion !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(definition.date) ||
    !/^[0-9a-f]{64}$/.test(definition.puzzleSeed) ||
    !/^[a-z]{5}$/.test(definition.answer) ||
    !/^[0-9a-f]{64}$/.test(definition.salt)
  ) {
    throw new Error('Hidden round definition does not match schema version 1');
  }
  const opensAt = Date.parse(definition.opensAt);
  const closesAt = Date.parse(definition.closesAt);
  if (
    !Number.isFinite(opensAt) ||
    !Number.isFinite(closesAt) ||
    closesAt <= opensAt
  ) {
    throw new Error('Round timestamps are invalid');
  }
  return { opensAt, closesAt };
}

function validateHiddenDefinitionV2(definition) {
  const keys = Object.keys(definition);
  if (
    keys.length !== HIDDEN_DEFINITION_KEYS_V2.length ||
    HIDDEN_DEFINITION_KEYS_V2.some((key) => !(key in definition)) ||
    typeof definition.chainId !== 'string' ||
    definition.chainId.length === 0 ||
    definition.chainId.includes('\0') ||
    typeof definition.roundId !== 'string' ||
    typeof definition.gameId !== 'string' ||
    typeof definition.gameVersion !== 'string' ||
    !definition.roundId.startsWith(`${definition.gameId}:${definition.gameVersion}:`) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(definition.date) ||
    !/^[0-9a-f]{64}$/.test(definition.salt)
  ) {
    throw new Error('Hidden round definition does not match schema version 2');
  }
  try {
    gameRules(definition.gameId, definition.gameVersion).validatePuzzle(definition.puzzle);
  } catch (error) {
    throw new Error(`Hidden round definition has an invalid puzzle: ${error.message}`);
  }
  const opensAt = Date.parse(definition.opensAt);
  const closesAt = Date.parse(definition.closesAt);
  if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= opensAt) {
    throw new Error('Round timestamps are invalid');
  }
  return { opensAt, closesAt };
}

export function hiddenDefinitionHash(definition) {
  validateHiddenDefinition(definition);
  return crypto
    .createHash('sha256')
    .update(canonicalJson(definition), 'utf8')
    .digest('hex');
}

export function verifyRoundReveal({ commitment, reveal }) {
  try {
    if (
      commitment?.schemaVersion !== 1 ||
      reveal?.schemaVersion !== 1 ||
      !/^[0-9a-f]{64}$/.test(commitment.hiddenDefinitionSha256) ||
      !/^[0-9a-f]{64}$/.test(reveal.commitmentTxid) ||
      !reveal.hiddenDefinition
    ) {
      return false;
    }
    const definition = reveal.hiddenDefinition;
    const matchingMetadata =
      commitment.roundId === definition.roundId &&
      commitment.chainId === definition.chainId &&
      commitment.gameId === definition.gameId &&
      commitment.gameVersion === definition.gameVersion &&
      commitment.date === definition.date &&
      commitment.opensAt === definition.opensAt &&
      commitment.closesAt === definition.closesAt;
    return (
      matchingMetadata &&
      hiddenDefinitionHash(definition) === commitment.hiddenDefinitionSha256
    );
  } catch {
    return false;
  }
}
