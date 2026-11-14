/**
 * Answer word list for the daily word round (English, 5 letters).
 * Curated common words — every answer should feel fair to guess.
 * Guesses are validated as "any 5 alphabetic letters" for the MVP;
 * a full guess dictionary is a later refinement.
 */
import { ANSWERS } from '../shared/games/word-grid/1.0.0/answers.mjs';

export { ANSWERS };

/** Pick a cryptographically random answer. */
export function pickAnswer() {
  const crypto = globalThis.crypto;
  const idx = crypto.getRandomValues(new Uint32Array(1))[0] % ANSWERS.length;
  return ANSWERS[idx];
}
