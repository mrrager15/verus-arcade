export const WORD_GRID_GAME_ID = 'word-grid';
export const WORD_GRID_VERSION = '1.0.0';
export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

export function normalizeGuess(value) {
  if (typeof value !== 'string') {
    throw new Error('Guess must be a string');
  }
  const guess = value.toLowerCase();
  if (!/^[a-z]{5}$/.test(guess)) {
    throw new Error('Guess must contain exactly five ASCII letters');
  }
  return guess;
}

export function evaluateGuess(guess, answer) {
  if (!/^[a-z]{5}$/.test(guess) || !/^[a-z]{5}$/.test(answer)) {
    throw new Error('Guess and answer must be normalized five-letter words');
  }
  const pattern = new Array(WORD_LENGTH).fill('x');
  const remaining = {};
  for (let index = 0; index < WORD_LENGTH; index++) {
    if (guess[index] === answer[index]) {
      pattern[index] = 'g';
    } else {
      remaining[answer[index]] = (remaining[answer[index]] ?? 0) + 1;
    }
  }
  for (let index = 0; index < WORD_LENGTH; index++) {
    if (pattern[index] === 'g') continue;
    if ((remaining[guess[index]] ?? 0) > 0) {
      pattern[index] = 'y';
      remaining[guess[index]]--;
    }
  }
  return pattern;
}

export function applyGuess({ guess, answer, sequence }) {
  const normalized = normalizeGuess(guess);
  const pattern = evaluateGuess(normalized, answer);
  const solved = pattern.every((value) => value === 'g');
  const terminal = solved || sequence >= MAX_GUESSES;
  return {
    word: normalized,
    pattern,
    solved,
    guessesUsed: sequence,
    guessesLeft: Math.max(0, MAX_GUESSES - sequence),
    terminal,
  };
}
