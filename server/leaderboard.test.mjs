import assert from 'node:assert/strict';
import test from 'node:test';

import { rankLeaderboard } from './leaderboard.mjs';

test('leaderboard uses skill ties without completion-time tie breaks', () => {
  const ranked = rankLeaderboard([
    { playerIAddress: 'i-c', status: 'unsolved', guessesUsed: 6 },
    { playerIAddress: 'i-b', status: 'solved', guessesUsed: 2 },
    { playerIAddress: 'i-a', status: 'solved', guessesUsed: 2 },
    { playerIAddress: 'i-d', status: 'abandoned', guessesUsed: 1 },
    { playerIAddress: 'i-e', status: 'in_progress', guessesUsed: 4 },
  ]);
  assert.deepEqual(
    ranked.map(({ playerIAddress, rank }) => [playerIAddress, rank]),
    [
      ['i-a', 1],
      ['i-b', 1],
      ['i-c', 3],
      ['i-d', 4],
      ['i-e', null],
    ],
  );
});

test('changing insertion order cannot change ranks or display order', () => {
  const entries = [
    { playerIAddress: 'i-b', status: 'solved', guessesUsed: 3 },
    { playerIAddress: 'i-a', status: 'solved', guessesUsed: 3 },
  ];
  assert.deepEqual(rankLeaderboard(entries), rankLeaderboard(entries.toReversed()));
});
