import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';

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

export function validateHiddenDefinition(definition) {
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
