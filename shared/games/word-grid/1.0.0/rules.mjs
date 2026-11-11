/**
 * Word Grid 1.0.0 — spelregels volgens het Arcade-gamecontract v1.
 *
 * Dit bestand is het hele regelwerk: zonder imports, deterministisch, zonder
 * I/O. De sha256 van deze tekst (met LF-regeleinden) staat in het manifest van
 * de game op de chain; elke verifier kan een gespeelde ronde hiermee naspelen.
 * Een wijziging aan de regels is een nieuwe versie (nieuwe map), nooit een
 * aanpassing van dit bestand.
 */

export const WORD_GRID_GAME_ID = 'word-grid';
export const WORD_GRID_VERSION = '1.0.0';
export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

export const meta = Object.freeze({
  contract: 1,
  slug: WORD_GRID_GAME_ID,
  version: WORD_GRID_VERSION,
  name: 'Word Grid',
  maxActions: MAX_GUESSES,
  inputHint: 'a five-letter word',
});

/**
 * @param {unknown} value
 * @returns {string}
 */
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

/**
 * @param {string} guess
 * @param {string} answer
 * @returns {Array<'g' | 'y' | 'x'>}
 */
export function evaluateGuess(guess, answer) {
  if (!/^[a-z]{5}$/.test(guess) || !/^[a-z]{5}$/.test(answer)) {
    throw new Error('Guess and answer must be normalized five-letter words');
  }
  /** @type {Array<'g' | 'y' | 'x'>} */
  const pattern = new Array(WORD_LENGTH).fill('x');
  /** @type {Record<string, number>} */
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

/**
 * Oude vorm (v1-server en Practice): één gok tegen het antwoord.
 * @param {{ guess: string, answer: string, sequence: number }} input
 */
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

// ---- Gamecontract v1 ---------------------------------------------------------

/** @typedef {{ answer: string }} Puzzle */
/** @typedef {{ answer: string, actions: string[], solved: boolean }} State */

/**
 * De puzzel van een ronde: alleen het antwoord.
 * @param {any} puzzle
 * @returns {Puzzle}
 */
export function validatePuzzle(puzzle) {
  if (
    puzzle === null || typeof puzzle !== 'object' || Array.isArray(puzzle) ||
    Object.keys(puzzle).length !== 1 || typeof puzzle.answer !== 'string' || !/^[a-z]{5}$/.test(puzzle.answer)
  ) {
    throw new Error('Word Grid puzzle must be { answer: five lowercase letters }');
  }
  return puzzle;
}

/**
 * Wat de speler vóór het spelen ziet: niets.
 * @param {Puzzle} puzzle
 */
export function publicPuzzle(puzzle) {
  validatePuzzle(puzzle);
  return {};
}

/**
 * Canonieke vorm van een zet: het woord in kleine letters.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAction(value) {
  return normalizeGuess(value);
}

/**
 * @param {Puzzle} puzzle
 * @returns {State}
 */
export function newState(puzzle) {
  validatePuzzle(puzzle);
  return { answer: puzzle.answer, actions: [], solved: false };
}

/** @param {State} state */
export function isTerminal(state) {
  return state.solved || state.actions.length >= MAX_GUESSES;
}

/**
 * Past één zet toe; geeft een nieuwe toestand en de feedback voor de speler.
 * @param {State} state
 * @param {unknown} action
 */
export function applyAction(state, action) {
  if (isTerminal(state)) throw new Error('The game is already over');
  const word = normalizeGuess(action);
  const pattern = evaluateGuess(word, state.answer);
  const solved = pattern.every((value) => value === 'g');
  const actions = [...state.actions, word];
  return {
    state: { answer: state.answer, actions, solved },
    feedback: { pattern, solved, actionsUsed: actions.length, actionsLeft: MAX_GUESSES - actions.length },
  };
}

/**
 * @param {State} state
 * @returns {{ status: 'solved' | 'unsolved', actionsUsed: number }}
 */
export function score(state) {
  return { status: state.solved ? 'solved' : 'unsolved', actionsUsed: state.actions.length };
}

/**
 * Wat de speler na afloop te zien krijgt.
 * @param {Puzzle} puzzle
 */
export function revealOnEnd(puzzle) {
  validatePuzzle(puzzle);
  return { answer: puzzle.answer };
}
