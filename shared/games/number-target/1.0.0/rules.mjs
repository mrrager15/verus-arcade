/**
 * Number Target 1.0.0 — spelregels volgens het Arcade-gamecontract v1.
 *
 * Zes getallen en een doel tussen 101 en 999. Elke zet is een berekening met
 * + - * / en haakjes. Elk getal mag hoogstens zo vaak als het in de lijst staat;
 * elk tussenresultaat moet een positief geheel getal zijn (delen dus alleen
 * als het opgaat). Opgelost als de uitkomst het doel is; hoogstens 5 zetten.
 *
 * Dit bestand is het hele regelwerk: zonder imports, deterministisch, zonder
 * I/O. Zijn sha256 (met LF-regeleinden) staat in het manifest op de chain.
 */

export const meta = Object.freeze({
  contract: 1,
  slug: 'number-target',
  version: '1.0.0',
  name: 'Number Target',
  maxActions: 5,
  inputHint: 'a calculation with the numbers, e.g. (25+3)*4',
});

export const LARGE_NUMBERS = Object.freeze([25, 50, 75, 100]);
export const MIN_TARGET = 101;
export const MAX_TARGET = 999;
export const MAX_ACTION_LENGTH = 60;
const MAX_VALUE = 1_000_000_000;

/** @typedef {{ numbers: number[], target: number, solution: string }} Puzzle */
/** @typedef {{ numbers: number[], target: number, actions: string[], solved: boolean }} State */
/** @typedef {{ kind: 'num', value: number } | { kind: 'op', op: string, left: Node, right: Node }} Node */

/**
 * Canonieke vorm van een zet: zonder spaties, met * en / als tekens.
 * Controleert alleen de vorm; welke getallen mogen, hangt af van de puzzel.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeAction(value) {
  if (typeof value !== 'string') throw new Error('A calculation must be text');
  const text = value
    .replace(/\s+/g, '')
    .replace(/[×xX]/g, '*')
    .replace(/[÷:]/g, '/')
    .replace(/[−–]/g, '-');
  if (text.length === 0) throw new Error('Type a calculation');
  if (text.length > MAX_ACTION_LENGTH) throw new Error(`A calculation has at most ${MAX_ACTION_LENGTH} characters`);
  if (!/^[0-9+\-*/()]+$/.test(text)) throw new Error('Use only numbers, + - * / and brackets');
  parse(text);
  return text;
}

/**
 * Leest een berekening (geen min-teken vooraan, geen voorloopnullen).
 * @param {string} text
 * @returns {Node}
 */
function parse(text) {
  let pos = 0;
  /** @returns {Node} */
  function expression() {
    let node = term();
    while (text[pos] === '+' || text[pos] === '-') {
      const op = text[pos++];
      node = { kind: 'op', op, left: node, right: term() };
    }
    return node;
  }
  /** @returns {Node} */
  function term() {
    let node = factor();
    while (text[pos] === '*' || text[pos] === '/') {
      const op = text[pos++];
      node = { kind: 'op', op, left: node, right: factor() };
    }
    return node;
  }
  /** @returns {Node} */
  function factor() {
    if (text[pos] === '(') {
      pos++;
      const node = expression();
      if (text[pos] !== ')') throw new Error('A bracket is not closed');
      pos++;
      return node;
    }
    const match = /^[1-9][0-9]{0,2}/.exec(text.slice(pos));
    if (!match) throw new Error(`Expected a number at position ${pos + 1}`);
    pos += match[0].length;
    return { kind: 'num', value: Number(match[0]) };
  }
  const tree = expression();
  if (pos !== text.length) throw new Error(`Unexpected "${text[pos]}" at position ${pos + 1}`);
  return tree;
}

/**
 * Rekent een boom uit met de regels van het spel en telt de gebruikte getallen.
 * @param {Node} node
 * @param {number[]} used
 * @returns {number}
 */
function evaluate(node, used) {
  if (node.kind === 'num') {
    used.push(node.value);
    return node.value;
  }
  const left = evaluate(node.left, used);
  const right = evaluate(node.right, used);
  let value;
  if (node.op === '+') value = left + right;
  else if (node.op === '-') value = left - right;
  else if (node.op === '*') value = left * right;
  else {
    if (left % right !== 0) throw new Error(`${left} / ${right} is not a whole number`);
    value = left / right;
  }
  if (value <= 0) throw new Error(`${left} ${node.op} ${right} is not positive`);
  if (value > MAX_VALUE) throw new Error('A result is too large');
  return value;
}

/**
 * Uitkomst van een (genormaliseerde) berekening met deze getallen; gooit bij een ongeldige.
 * @param {string} canonical
 * @param {number[]} numbers
 * @returns {number}
 */
export function calculate(canonical, numbers) {
  /** @type {number[]} */
  const used = [];
  const value = evaluate(parse(canonical), used);
  /** @type {Record<number, number>} */
  const available = {};
  for (const n of numbers) available[n] = (available[n] ?? 0) + 1;
  for (const n of used) {
    if (!available[n]) {
      throw new Error(numbers.includes(n) ? `${n} is used too often` : `${n} is not one of the numbers`);
    }
    available[n]--;
  }
  return value;
}

// ---- Gamecontract v1 ---------------------------------------------------------

/**
 * De puzzel: zes getallen (1–10 of 25/50/75/100), een doel 101–999 en een
 * voorbeeldoplossing die het doel echt haalt (onthuld na afloop).
 * @param {any} puzzle
 * @returns {Puzzle}
 */
export function validatePuzzle(puzzle) {
  const ok =
    puzzle !== null && typeof puzzle === 'object' && !Array.isArray(puzzle) &&
    Object.keys(puzzle).length === 3 &&
    Array.isArray(puzzle.numbers) && puzzle.numbers.length === 6 &&
    puzzle.numbers.every((/** @type {unknown} */ n) => Number.isInteger(n) && ((/** @type {number} */ (n) >= 1 && /** @type {number} */ (n) <= 10) || LARGE_NUMBERS.includes(/** @type {number} */ (n)))) &&
    Number.isInteger(puzzle.target) && puzzle.target >= MIN_TARGET && puzzle.target <= MAX_TARGET &&
    typeof puzzle.solution === 'string';
  if (!ok) throw new Error('Number Target puzzle must be { numbers: six numbers, target: 101-999, solution }');
  if (normalizeAction(puzzle.solution) !== puzzle.solution || calculate(puzzle.solution, puzzle.numbers) !== puzzle.target) {
    throw new Error('The example solution does not reach the target');
  }
  return puzzle;
}

/**
 * Wat de speler vóór het spelen ziet: de getallen en het doel.
 * @param {Puzzle} puzzle
 */
export function publicPuzzle(puzzle) {
  validatePuzzle(puzzle);
  return { numbers: [...puzzle.numbers], target: puzzle.target };
}

/**
 * @param {Puzzle} puzzle
 * @returns {State}
 */
export function newState(puzzle) {
  validatePuzzle(puzzle);
  return { numbers: [...puzzle.numbers], target: puzzle.target, actions: [], solved: false };
}

/** @param {State} state */
export function isTerminal(state) {
  return state.solved || state.actions.length >= meta.maxActions;
}

/**
 * @param {State} state
 * @param {unknown} action
 */
export function applyAction(state, action) {
  if (isTerminal(state)) throw new Error('The game is already over');
  const canonical = normalizeAction(action);
  const value = calculate(canonical, state.numbers);
  const solved = value === state.target;
  const actions = [...state.actions, canonical];
  return {
    state: { numbers: [...state.numbers], target: state.target, actions, solved },
    feedback: { value, distance: Math.abs(state.target - value), solved, actionsUsed: actions.length, actionsLeft: meta.maxActions - actions.length },
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
 * Na afloop: een berekening die het doel haalt.
 * @param {Puzzle} puzzle
 */
export function revealOnEnd(puzzle) {
  validatePuzzle(puzzle);
  return { solution: puzzle.solution };
}
