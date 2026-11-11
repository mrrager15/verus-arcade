import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createDailyHiddenDefinition, parseRoundCreateOptions, testRoundSchedule } from './daily-round-schedule.mjs';
import { computeDailyStats } from './attestation.mjs';
import { buildAttemptMessage } from './verus/attempt-message.mjs';
import { validateHiddenDefinition } from './round-proof.mjs';
import { applyTestRoundEnvironment, assertRoundMatchesMode, isTestRoundId, REAL_OPERATOR, TEST_OPERATOR } from './test-rounds.mjs';

const NOW = Date.parse('2026-11-11T11:57:42.123Z');

test('testrondes: schema met tijdslot, afgerond op de minuut', () => {
  const s = testRoundSchedule({ minutes: 15, now: NOW });
  assert.deepEqual(
    { recordId: s.recordId, date: s.date, opensAt: s.opensAt, closesAt: s.closesAt },
    { recordId: 'word-grid:1.0.0:2026-11-11T1157', date: '2026-11-11', opensAt: '2026-11-11T11:57:00.000Z', closesAt: '2026-11-11T12:12:00.000Z' },
  );
  for (const bad of [2, 181, 'x', 1.5]) assert.throws(() => testRoundSchedule({ minutes: bad, now: NOW }), /tussen 3 en 180/);
  const definition = createDailyHiddenDefinition({ schedule: s });
  assert.equal(definition.roundId, s.recordId);
  assert.doesNotThrow(() => validateHiddenDefinition(definition));
  assert.deepEqual(parseRoundCreateOptions(['--test-minutes', '15']), { testMinutes: '15' });
  assert.throws(() => parseRoundCreateOptions(['--test-minutes', '15', '--date', '2026-11-12']), /gaat niet samen/);
});

test('testrondes: herkenning, modus en database', () => {
  assert.equal(isTestRoundId('word-grid:1.0.0:2026-11-11T1157'), true);
  assert.equal(isTestRoundId('word-grid:1.0.0:2026-11-11'), false);
  assert.equal(isTestRoundId('word-grid:1.0.0:2026-11-11T11:57'), false);
  assert.throws(() => assertRoundMatchesMode('word-grid:1.0.0:2026-11-11T1157', false), /ARCADE_TEST_ROUNDS=1/);
  assert.throws(() => assertRoundMatchesMode('word-grid:1.0.0:2026-11-11', true), /geen testronde/);
  assert.doesNotThrow(() => assertRoundMatchesMode('word-grid:1.0.0:2026-11-11', false));

  const env = { ARCADE_TEST_ROUNDS: '1', ARCADE_DATABASE_PATH: '/x/arcade.sqlite' };
  const on = applyTestRoundEnvironment(env, '/repo');
  assert.equal(on.testMode, true);
  assert.equal(on.databasePath, path.resolve('/repo', 'server', 'data', 'arcade-test.sqlite'));
  assert.equal(env.ARCADE_DATABASE_PATH, on.databasePath); // wint van .env
  assert.deepEqual(on.operator, TEST_OPERATOR);
  const off = applyTestRoundEnvironment({}, '/repo');
  assert.deepEqual([off.testMode, off.databasePath, off.operator], [false, path.resolve('/repo', 'server', 'data', 'arcade.sqlite'), REAL_OPERATOR]);
  assert.throws(() => applyTestRoundEnvironment({ ARCADE_DATABASE_PATH: '/repo/server/data/arcade-test.sqlite' }, '/repo'), /hoort bij ARCADE_TEST_ROUNDS=1/);
  assert.throws(() => applyTestRoundEnvironment({ ARCADE_TEST_ROUNDS: 'ja' }, '/repo'), /0 of 1/);
  assert.notEqual(TEST_OPERATOR.iAddress, REAL_OPERATOR.iAddress);
});

test('testrondes: handtekeningsbericht en streak werken met tijdsloten', () => {
  assert.match(buildAttemptMessage({ roundId: 'word-grid:1.0.0:2026-11-11T1157', playerIAddress: 'i46DSxQV6VwA6xZYvcVrAdENrZCVi3Gc8g', actionsSha256: 'a'.repeat(64) }), /2026-11-11T1157/);
  const ids = ['word-grid:1.0.0:2026-11-11T1215', 'word-grid:1.0.0:2026-11-11T1157', 'word-grid:1.0.0:2026-11-11T1230'];
  const signedSolved = { signed: true, solved: true };
  const stats = computeDailyStats({ roundIds: ids, attempts: new Map([[ids[1], signedSolved], [ids[0], signedSolved], [ids[2], signedSolved]]) });
  assert.deepEqual(stats, { roundId: ids[2], streak: 3, rounds: 3, solved: 3 });
  const gap = computeDailyStats({ roundIds: ids, attempts: new Map([[ids[1], signedSolved], [ids[2], signedSolved]]) });
  assert.equal(gap.streak, 1);
});
