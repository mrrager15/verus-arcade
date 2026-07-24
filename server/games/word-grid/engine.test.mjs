import assert from 'node:assert/strict';
import test from 'node:test';

import { applyGuess, evaluateGuess, normalizeGuess } from './engine.mjs';

test('normalizes case and rejects malformed guesses', () => {
  assert.equal(normalizeGuess('CrAnE'), 'crane');
  assert.throws(() => normalizeGuess('four'), /five ASCII letters/);
  assert.throws(() => normalizeGuess('café!'), /five ASCII letters/);
});

test('duplicate letters consume unmatched answer letters once', () => {
  assert.deepEqual(evaluateGuess('eerie', 'serve'), ['x', 'g', 'g', 'x', 'g']);
  assert.deepEqual(evaluateGuess('apple', 'alley'), ['g', 'x', 'x', 'y', 'y']);
});

test('server result becomes terminal on solve or sixth guess', () => {
  assert.equal(applyGuess({ guess: 'crane', answer: 'crane', sequence: 1 }).terminal, true);
  const last = applyGuess({ guess: 'slate', answer: 'crane', sequence: 6 });
  assert.equal(last.terminal, true);
  assert.equal(last.guessesLeft, 0);
});
