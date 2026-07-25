const STATUS_ORDER = Object.freeze({
  solved: 0,
  unsolved: 1,
  abandoned: 2,
  in_progress: 3,
});

function scoreKey(entry) {
  return entry.status === 'solved'
    ? `0:${String(entry.guessesUsed).padStart(3, '0')}`
    : entry.status === 'unsolved'
      ? `1:${String(entry.guessesUsed).padStart(3, '0')}`
      : entry.status === 'abandoned'
        ? '2'
        : null;
}

export function rankLeaderboard(entries) {
  const sorted = entries
    .map((entry) => ({ ...entry }))
    .sort(
      (left, right) =>
        STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
        (left.guessesUsed ?? 0) - (right.guessesUsed ?? 0) ||
        Buffer.compare(
          Buffer.from(left.playerIAddress, 'utf8'),
          Buffer.from(right.playerIAddress, 'utf8'),
        ),
    );
  let previousKey = null;
  let previousRank = null;
  return sorted.map((entry, index) => {
    const key = scoreKey(entry);
    const rank =
      key === null
        ? null
        : key === previousKey
          ? previousRank
          : index + 1;
    if (key !== null) {
      previousKey = key;
      previousRank = rank;
    }
    return { ...entry, rank };
  });
}
