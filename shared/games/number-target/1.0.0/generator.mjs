/**
 * Number Target 1.0.0 — puzzel van de dag (alleen op de server).
 *
 * Twee grote getallen (verschillend, uit 25/50/75/100) en vier kleine (1–10).
 * Het doel wordt gebouwd door 2 tot 5 van die getallen willekeurig te
 * combineren, zodat het altijd haalbaar is; die berekening is de
 * voorbeeldoplossing. `random.int(max)` geeft een geheel getal in [0, max).
 */
import { LARGE_NUMBERS, MAX_ACTION_LENGTH, MAX_TARGET, MIN_TARGET, validatePuzzle } from './rules.mjs';

const OPS = ['+', '-', '*', '/'];

/** @param {{ int: (max: number) => number }} random */
function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = random.int(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Eén poging om een doel te bouwen; geeft null als het niet in het bereik valt. */
function tryTarget(numbers, random) {
  const count = 2 + random.int(4);
  let items = shuffle(numbers, random).slice(0, count).map((value) => ({ value, expr: String(value) }));
  while (items.length > 1) {
    const i = random.int(items.length);
    let j = random.int(items.length - 1);
    if (j >= i) j++;
    let [a, b] = [items[i], items[j]];
    const op = OPS[random.int(OPS.length)];
    if (op === '-' && a.value < b.value) [a, b] = [b, a];
    if (op === '/' && a.value < b.value) [a, b] = [b, a];
    let value;
    if (op === '+') value = a.value + b.value;
    else if (op === '-') value = a.value - b.value;
    else if (op === '*') value = a.value * b.value;
    else value = a.value % b.value === 0 ? a.value / b.value : 0;
    // Geen nutteloze stappen (×1, ÷1) en alleen positieve gehele tussenresultaten.
    if (value <= 0 || ((op === '*' || op === '/') && b.value === 1)) return null;
    items = items.filter((_, k) => k !== i && k !== j);
    items.push({ value, expr: `(${a.expr}${op}${b.expr})` });
  }
  const [{ value, expr }] = items;
  if (value < MIN_TARGET || value > MAX_TARGET) return null;
  const solution = expr.startsWith('(') ? expr.slice(1, -1) : expr;
  return solution.length <= MAX_ACTION_LENGTH ? { target: value, solution } : null;
}

/** @param {{ random: { int: (max: number) => number } }} input */
export function createPuzzle({ random }) {
  for (let round = 0; round < 50; round++) {
    const large = shuffle(LARGE_NUMBERS, random).slice(0, 2);
    const small = [0, 1, 2, 3].map(() => 1 + random.int(10));
    const numbers = [...large, ...small];
    for (let attempt = 0; attempt < 200; attempt++) {
      const built = tryTarget(numbers, random);
      if (built) return validatePuzzle({ numbers, target: built.target, solution: built.solution });
    }
  }
  throw new Error('Could not build a Number Target puzzle');
}
