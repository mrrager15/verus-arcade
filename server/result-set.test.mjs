import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResultSet,
  createInclusionProof,
  verifyInclusionProof,
} from './result-set.mjs';

function record(playerIAddress, status = 'unsolved', guesses = ['crane']) {
  return {
    schemaVersion: 1,
    roundId: 'word-grid:1.0.0:2026-07-27',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    playerIAddress,
    status,
    guesses: guesses.map((word, index) => ({ sequence: index + 1, word })),
    score: { solved: status === 'solved', guessesUsed: guesses.length },
  };
}

test('empty, single, and odd result sets have stable roots', () => {
  assert.equal(
    buildResultSet([]).rootSha256,
    'dbc1b4c900ffe48d575b5da5c638040125f65db0fe3e24494b76ea986457d986',
  );
  assert.equal(
    buildResultSet([record('i-a')]).rootSha256,
    'cb8fff2b01e760181e276a1a206fed32b4300ae919360da07b5092d3451c9e1d',
  );
  assert.equal(
    buildResultSet([record('i-c'), record('i-a'), record('i-b')]).rootSha256,
    'e80420822bfb6790efa8e849064e63e564b004f8b3501fb6321db3e0f68572b3',
  );
});

test('input order cannot change the result root', () => {
  const ordered = [record('i-a'), record('i-b'), record('i-c')];
  assert.equal(
    buildResultSet(ordered).rootSha256,
    buildResultSet(ordered.toReversed()).rootSha256,
  );
});

test('proofs verify for first, middle, and duplicated odd leaves', () => {
  const resultSet = buildResultSet([record('i-a'), record('i-b'), record('i-c')]);
  for (let index = 0; index < resultSet.leafCount; index++) {
    assert.equal(verifyInclusionProof(createInclusionProof(resultSet, index)), true);
  }
  const changed = createInclusionProof(resultSet, 1);
  changed.record = record('i-b', 'solved', ['crane']);
  assert.equal(verifyInclusionProof(changed), false);
  const extraLevel = createInclusionProof(resultSet, 1);
  extraLevel.siblings.push({ position: 'right', sha256: '0'.repeat(64) });
  assert.equal(verifyInclusionProof(extraLevel), false);
});

test('duplicate identities and malformed records fail closed', () => {
  assert.throws(
    () => buildResultSet([record('i-a'), record('i-a')]),
    /Duplicate result identity/,
  );
  assert.throws(
    () => buildResultSet([{ ...record('i-a'), extra: true }]),
    /schema version 1/,
  );
});
