import assert from 'node:assert/strict';
import test from 'node:test';

import { replayResultRecord } from './replay.mjs';

const base = { roundId: 'x', chainId: 'vrsctest', playerIAddress: 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g', playerSignature: null };

test('replay: Word Grid (schema 2) en Number Target (schema 3) kloppen of vallen door de mand', () => {
  const wg = { ...base, schemaVersion: 2, gameId: 'word-grid', gameVersion: '1.0.0', status: 'solved', guesses: [{ sequence: 1, word: 'slate' }, { sequence: 2, word: 'crane' }], score: { solved: true, guessesUsed: 2 } };
  assert.deepEqual(replayResultRecord(wg, { answer: 'crane' }), { ok: true });
  assert.equal(replayResultRecord(wg, { answer: 'plane' }).ok, false, 'ander antwoord: niet opgelost');
  assert.equal(replayResultRecord({ ...wg, status: 'unsolved' }, { answer: 'crane' }).ok, false);
  const lost = { ...wg, status: 'unsolved', guesses: ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee', 'fffff'].map((word, i) => ({ sequence: i + 1, word })) };
  assert.deepEqual(replayResultRecord(lost, { answer: 'crane' }), { ok: true });
  assert.equal(replayResultRecord({ ...lost, guesses: lost.guesses.slice(0, 3) }, { answer: 'crane' }).ok, false, 'verloren na 3 zetten kan niet');
  assert.deepEqual(replayResultRecord({ ...wg, status: 'abandoned', guesses: [{ sequence: 1, word: 'slate' }] }, { answer: 'crane' }), { ok: true });

  const puzzle = { numbers: [100, 25, 3, 7, 7, 1], target: 728, solution: '(100+3)*7+7' };
  const nt = { ...base, schemaVersion: 3, gameId: 'number-target', gameVersion: '1.0.0', status: 'solved', actions: [{ sequence: 1, value: '100*7' }, { sequence: 2, value: '(100+3)*7+7' }], score: { solved: true, actionsUsed: 2 } };
  assert.deepEqual(replayResultRecord(nt, puzzle), { ok: true });
  assert.equal(replayResultRecord(nt, { ...puzzle, numbers: [100, 25, 3, 7, 8, 1], target: 721, solution: '(100+3)*7' }).ok, false, 'ander getal: de zet is ongeldig');
  assert.match(replayResultRecord({ ...nt, actions: [{ sequence: 1, value: '8*100' }] }, puzzle).reason, /not one of the numbers/);
});
