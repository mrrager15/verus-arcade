/**
 * Resultaatsets opbouwen (server). De controle (record valideren, wortel uit
 * een inclusiebewijs) staat sinds fase 4 in shared/result-set.mjs en wordt hier
 * doorgegeven; het opbouwen gebruikt dezelfde blad- en knoophashes.
 */
import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { emptyRoot, leafHash, nodeHash, RESULT_ALGORITHM, toHex, validateResultRecord } from '../shared/result-set.mjs';

export { inclusionRoot, RESULT_ALGORITHM, validateResultRecord, verifyInclusionProof } from '../shared/result-set.mjs';

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
    validateResultRecord(record);
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
  const root = entries.length === 0 ? emptyRoot() : levels.at(-1)[0];
  const bundle = entries.map((entry) => entry.record);
  const bundleJson = canonicalJson(bundle);
  return {
    algorithm: RESULT_ALGORITHM,
    rootSha256: toHex(root),
    leafCount: entries.length,
    bundle,
    bundleJson,
    bundleSha256: crypto.createHash('sha256').update(bundleJson, 'utf8').digest('hex'),
    entries: entries.map((entry, leafIndex) => ({
      ...entry,
      leafIndex,
      leafSha256: toHex(entry.leaf),
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
      sha256: toHex(level[siblingIndex] ?? level[index]),
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
