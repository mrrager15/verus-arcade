import assert from 'node:assert/strict';
import test from 'node:test';

import { STEP_ACKS, missingDailyDates, nextRoundStep } from './daily-cycle-plan.mjs';

const NOW = Date.parse('2026-11-12T00:05:00Z');
const round = (status, extra = {}) => ({ roundStatus: status, closesAt: '2026-11-12T00:00:00.000Z', ...extra });
const j = (state) => ({ state });

test('nachtcyclus: volgende stap per toestand van de ronde', () => {
  const cases = [
    [round('open', { closesAt: '2026-11-13T00:00:00.000Z' }), {}, { done: true, running: true }],
    [round('open'), {}, { action: 'finalize' }],
    [round('closed', { resultsJournal: null }), {}, { action: 'results-prepare' }],
    [round('closed', { resultsJournal: j('signed') }), {}, { action: 'results-submit' }],
    [round('closed', { resultsJournal: j('submitted') }), {}, { action: 'results-reconcile', wait: true }],
    [round('closed', { resultsJournal: j('confirmed'), revealJournal: null }), {}, { action: 'attestations-create' }],
    [round('closed', { resultsJournal: j('confirmed'), revealJournal: null }), { attestationsDone: true }, { action: 'reveal-prepare' }],
    [round('closed', { resultsJournal: j('confirmed'), revealJournal: j('signed') }), { attestationsDone: true }, { action: 'reveal-submit' }],
    [round('closed', { resultsJournal: j('confirmed'), revealJournal: j('submitted') }), { attestationsDone: true }, { action: 'reveal-reconcile', wait: true }],
    [round('revealed'), {}, { done: true }],
    [round('commit_pending', { commitment: { journal: j('signed') } }), {}, { action: 'round-submit' }],
    [round('commit_pending', { commitment: { journal: j('submitted') } }), {}, { action: 'round-open', wait: true }],
    [round('closed', { resultsJournal: j('failed') }), {}, { blocked: 'results journal failed' }],
    [round('closed', { resultsJournal: j('confirmed'), revealJournal: j('failed') }), { attestationsDone: true }, { blocked: 'reveal journal failed' }],
    [round('failed'), {}, { blocked: 'round failed' }],
    [round('commit_pending', { commitment: { journal: j('failed') } }), {}, { blocked: 'commitment journal failed' }],
  ];
  for (const [inspect, context, expected] of cases) {
    assert.deepEqual(nextRoundStep(inspect, { now: NOW, ...context }), expected, JSON.stringify(inspect));
  }
  for (const step of cases.map(([i, c]) => nextRoundStep(i, { now: NOW, ...c }).action).filter(Boolean)) {
    assert.ok(STEP_ACKS[step], `ACK voor ${step}`);
  }
});

test('nachtcyclus: vandaag en morgen moeten bestaan, nooit verder', () => {
  const ids = ['word-grid:1.0.0:2026-11-11', 'word-grid:1.0.0:2026-11-12'];
  assert.deepEqual(missingDailyDates(ids, NOW), ['2026-11-13']);
  assert.deepEqual(missingDailyDates([...ids, 'word-grid:1.0.0:2026-11-13'], NOW), []);
  assert.deepEqual(missingDailyDates([], NOW), ['2026-11-12', '2026-11-13']);
  assert.deepEqual(missingDailyDates(['word-grid:1.0.0:2026-11-12T0010'], NOW), ['2026-11-12', '2026-11-13'], 'testrondes tellen niet');
});
