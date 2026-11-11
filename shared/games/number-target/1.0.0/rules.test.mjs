import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createPuzzle } from './generator.mjs';
import { MAX_TARGET, MIN_TARGET, calculate, validatePuzzle } from './rules.mjs';

test('number-target: 500 willekeurige puzzels zijn geldig en haalbaar', () => {
  const random = { int: (max) => crypto.randomInt(0, max) };
  for (let i = 0; i < 500; i++) {
    const puzzle = createPuzzle({ random });
    assert.equal(puzzle.numbers.filter((n) => n > 10).length, 2, 'twee grote getallen');
    assert.equal(new Set(puzzle.numbers.filter((n) => n > 10)).size, 2, 'grote getallen verschillen');
    assert.ok(puzzle.target >= MIN_TARGET && puzzle.target <= MAX_TARGET);
    assert.equal(calculate(puzzle.solution, puzzle.numbers), puzzle.target);
  }
});

test('number-target: zelfde toeval geeft dezelfde puzzel', () => {
  const seeded = (seed) => ({ int: (max) => { seed = (seed * 48271) % 2147483647; return seed % max; } });
  assert.deepEqual(createPuzzle({ random: seeded(42) }), createPuzzle({ random: seeded(42) }));
  assert.notDeepEqual(createPuzzle({ random: seeded(42) }), createPuzzle({ random: seeded(43) }));
});

test('number-target: puzzel met foute voorbeeldoplossing of verkeerde getallen wordt geweigerd', () => {
  const good = { numbers: [100, 25, 3, 7, 7, 1], target: 728, solution: '(100+3)*7+7' };
  assert.doesNotThrow(() => validatePuzzle(good));
  assert.throws(() => validatePuzzle({ ...good, target: 729 }), /does not reach/);
  assert.throws(() => validatePuzzle({ ...good, solution: '(100+3) * 7 + 7' }), /does not reach/);
  assert.throws(() => validatePuzzle({ ...good, numbers: [100, 25, 3, 7, 7, 11] }), /must be/);
  assert.throws(() => validatePuzzle({ ...good, numbers: [100, 25, 3, 7, 7] }), /must be/);
  assert.throws(() => validatePuzzle({ ...good, target: 100, solution: '100' }), /must be/);
  assert.throws(() => validatePuzzle({ ...good, extra: 1 }), /must be/);
});
