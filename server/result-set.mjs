import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { gameRules } from '../shared/games/index.mjs';

export const RESULT_ALGORITHM = 'arcade-merkle-sha256-jcs-v1';

function hash(...buffers) {
  const digest = crypto.createHash('sha256');
  for (const buffer of buffers) digest.update(buffer);
  return digest.digest();
}

function leafHash(recordJson) {
  return hash(Buffer.from([0]), Buffer.from(recordJson, 'utf8'));
}

function nodeHash(left, right) {
  return hash(Buffer.from([1]), left, right);
}

const BASE_KEYS = [
  'schemaVersion',
  'roundId',
  'chainId',
  'gameId',
  'gameVersion',
  'playerIAddress',
  'status',
  'guesses',
  'score',
];

/**
 * Schema 1: het v1-record. Schema 2 (fase 1): identiek plus `playerSignature`,
 * null of { height, signature } met de native Verus-handtekening (73 bytes,
 * base64) van de speler over het bericht uit server/verus/attempt-message.mjs.
 * Oude rondes blijven schema 1 en verifiëren ongewijzigd.
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
    Buffer.from(value.signature, 'base64').length === 73 &&
    Buffer.from(value.signature, 'base64').toString('base64') === value.signature
  );
}

// Schema 3 (fase 8): voor elke game. `actions` met canonieke zetten van de game,
// `score` met `actionsUsed`; verder gelijk aan schema 2 (met playerSignature).
const V3_KEYS = ['schemaVersion', 'roundId', 'chainId', 'gameId', 'gameVersion', 'playerIAddress', 'status', 'actions', 'score', 'playerSignature'];

function validateRecordV3(record) {
  const fail = (why) => { throw new Error(`Result record does not match schema version 3: ${why}`); };
  if (Object.keys(record).length !== V3_KEYS.length || V3_KEYS.some((key) => !(key in record))) fail('keys');
  if (
    !record.roundId || !record.chainId || !record.gameId || !record.gameVersion || !record.playerIAddress ||
    [record.chainId, record.playerIAddress].some((value) => typeof value !== 'string' || value.includes('\0')) ||
    !String(record.roundId).startsWith(`${record.gameId}:${record.gameVersion}:`)
  ) fail('round or player');
  let rules;
  try { rules = gameRules(record.gameId, record.gameVersion); } catch (error) { fail(error.message); }
  if (!['solved', 'unsolved', 'abandoned'].includes(record.status)) fail('status');
  if (!Array.isArray(record.actions) || record.actions.length > rules.meta.maxActions) fail('actions');
  record.actions.forEach((action, index) => {
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

function validateRecord(record) {
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
      (guess, index) =>
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

function levelsFromLeaves(leaves) {
  if (leaves.length === 0) return [];
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const level = levels.at(-1);
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(nodeHash(level[index], level[index + 1] ?? level[index]));
    }
    levels.push(next);
  }
  return levels;
}

export function buildResultSet(records) {
  const entries = records.map((record) => {
    validateRecord(record);
    const sortKey = `${record.chainId}\0${record.playerIAddress}`;
    const recordJson = canonicalJson(record);
    return { record, sortKey, recordJson, leaf: leafHash(recordJson) };
  });
  entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.sortKey), Buffer.from(right.sortKey)),
  );
  for (let index = 1; index < entries.length; index++) {
    if (entries[index - 1].sortKey === entries[index].sortKey) {
      throw new Error('Duplicate result identity key');
    }
  }
  const levels = levelsFromLeaves(entries.map((entry) => entry.leaf));
  const root =
    entries.length === 0 ? hash(Buffer.from([2])) : levels.at(-1)[0];
  const bundle = entries.map((entry) => entry.record);
  const bundleJson = canonicalJson(bundle);
  return {
    algorithm: RESULT_ALGORITHM,
    rootSha256: root.toString('hex'),
    leafCount: entries.length,
    bundle,
    bundleJson,
    bundleSha256: hash(Buffer.from(bundleJson, 'utf8')).toString('hex'),
    entries: entries.map((entry, leafIndex) => ({
      ...entry,
      leafIndex,
      leafSha256: entry.leaf.toString('hex'),
    })),
    levels,
  };
}

export function createInclusionProof(resultSet, leafIndex) {
  if (
    !Number.isSafeInteger(leafIndex) ||
    leafIndex < 0 ||
    leafIndex >= resultSet.leafCount
  ) {
    throw new Error('Leaf index is outside the result set');
  }
  let index = leafIndex;
  const siblings = [];
  for (let levelIndex = 0; levelIndex < resultSet.levels.length - 1; levelIndex++) {
    const level = resultSet.levels[levelIndex];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    siblings.push({
      position: isRight ? 'left' : 'right',
      sha256: (level[siblingIndex] ?? level[index]).toString('hex'),
    });
    index = Math.floor(index / 2);
  }
  return {
    algorithm: RESULT_ALGORITHM,
    record: resultSet.entries[leafIndex].record,
    leafIndex,
    leafCount: resultSet.leafCount,
    siblings,
    rootSha256: resultSet.rootSha256,
  };
}

/**
 * Wortel die uit een inclusiebewijs volgt (hex), of null als het bewijs niet
 * klopt in vorm, record of posities. Gebruikt door verifyInclusionProof en door
 * het compacte spelersrecord (v2), dat de wortel niet meedraagt.
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
    validateRecord(proof.record);
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
      const siblingHash = Buffer.from(sibling.sha256, 'hex');
      current =
        sibling.position === 'left'
          ? nodeHash(siblingHash, current)
          : nodeHash(current, siblingHash);
      index = Math.floor(index / 2);
    }
    return current.toString('hex');
  } catch {
    return null;
  }
}

export function verifyInclusionProof(proof) {
  if (!/^[0-9a-f]{64}$/.test(proof?.rootSha256 ?? '')) return false;
  const root = inclusionRoot(proof);
  return root !== null && root === proof.rootSha256;
}
