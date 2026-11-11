/**
 * Word Grid 1.0.0 — puzzel van de dag (alleen op de server).
 * `random.int(max)` geeft een geheel getal in [0, max); injecteerbaar voor tests.
 */
import { ANSWERS } from './answers.mjs';
import { validatePuzzle } from './rules.mjs';

export function createPuzzle({ random, answers = ANSWERS }) {
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('Geen antwoordenlijst beschikbaar');
  return validatePuzzle({ answer: answers[random.int(answers.length)] });
}
