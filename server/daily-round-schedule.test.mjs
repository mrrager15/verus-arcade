import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDailyHiddenDefinition,
  dailyRoundRecordId,
  dailyRoundSchedule,
  parseRoundCreateOptions,
  utcDateOf,
} from './daily-round-schedule.mjs';
import { hiddenDefinitionHash, validateHiddenDefinition } from './round-proof.mjs';

// 2026-11-08T19:30:00Z — een avond in Brussel, nog dezelfde UTC-dag.
const NOW = Date.parse('2026-11-08T19:30:00.000Z');

test('standaardplanning: vandaag (UTC), 00:00 tot 00:00 de dag erna', () => {
  const schedule = dailyRoundSchedule({ now: NOW });
  assert.equal(schedule.date, '2026-11-08');
  assert.equal(schedule.opensAt, '2026-11-08T00:00:00.000Z');
  assert.equal(schedule.closesAt, '2026-11-09T00:00:00.000Z');
  assert.equal(schedule.closesAtMs - schedule.opensAtMs, 24 * 60 * 60 * 1000);
});

test('expliciete datum met eigen openings- en sluitingstijd', () => {
  const schedule = dailyRoundSchedule({
    date: '2026-11-09',
    opensAt: '2026-11-09T06:00:00Z',
    closesAt: '2026-11-09T18:00:00Z',
    now: NOW,
  });
  assert.equal(schedule.opensAt, '2026-11-09T06:00:00.000Z');
  assert.equal(schedule.closesAt, '2026-11-09T18:00:00.000Z');
});

test('ongeldige datums en volgordes worden geweigerd', () => {
  assert.throws(() => dailyRoundSchedule({ date: '8-11-2026', now: NOW }), /JJJJ-MM-DD/);
  assert.throws(() => dailyRoundSchedule({ date: '2026-02-30', now: NOW }), /bestaat niet/);
  assert.throws(
    () => dailyRoundSchedule({ date: '2026-11-09', closesAt: '2026-11-09T00:00:00Z', now: NOW }),
    /na opensAt/,
  );
  assert.throws(() => dailyRoundSchedule({ date: '2026-11-07', now: NOW }), /verleden/);
  assert.throws(() => dailyRoundSchedule({ opensAt: 'gisteren', now: NOW }), /opensAt/);
});

test('record-ID volgt het v1-patroon', () => {
  assert.equal(dailyRoundRecordId('2026-11-08'), 'word-grid:1.0.0:2026-11-08');
  assert.equal(utcDateOf(Date.parse('2026-11-08T23:59:59Z')), '2026-11-08');
  assert.equal(utcDateOf(Date.parse('2026-11-09T00:00:00Z')), '2026-11-09');
});

test('geheime definitie voldoet aan schema 1 en is hashbaar', () => {
  const schedule = dailyRoundSchedule({ now: NOW });
  let byteCall = 0;
  const definition = createDailyHiddenDefinition({
    schedule,
    answers: ['crane', 'plane'],
    random: {
      bytes: () => Buffer.alloc(32, byteCall++ === 0 ? 0x11 : 0x22),
      int: (max) => max - 1,
    },
  });
  assert.deepEqual(definition, {
    schemaVersion: 1,
    roundId: 'word-grid:1.0.0:2026-11-08',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    date: '2026-11-08',
    opensAt: '2026-11-08T00:00:00.000Z',
    closesAt: '2026-11-09T00:00:00.000Z',
    puzzleSeed: '11'.repeat(32),
    answer: 'plane',
    salt: '22'.repeat(32),
  });
  assert.doesNotThrow(() => validateHiddenDefinition(definition));
  assert.match(hiddenDefinitionHash(definition), /^[0-9a-f]{64}$/);
});

test('echte willekeur levert een geldig antwoord uit de lijst', () => {
  const schedule = dailyRoundSchedule({ now: NOW });
  const a = createDailyHiddenDefinition({ schedule });
  const b = createDailyHiddenDefinition({ schedule });
  assert.match(a.answer, /^[a-z]{5}$/);
  assert.notEqual(a.salt, b.salt, 'twee rondes mogen nooit dezelfde salt krijgen');
  assert.throws(() => createDailyHiddenDefinition({ schedule, answers: [] }), /antwoordenlijst/);
});

test('CLI-opties: bekend, met waarde, niet dubbel', () => {
  assert.deepEqual(parseRoundCreateOptions([]), {});
  assert.deepEqual(
    parseRoundCreateOptions(['--date', '2026-11-09', '--closes-at', '2026-11-09T12:00:00Z']),
    { date: '2026-11-09', closesAt: '2026-11-09T12:00:00Z' },
  );
  assert.throws(() => parseRoundCreateOptions(['--datum', 'x']), /Onbekende optie/);
  assert.throws(() => parseRoundCreateOptions(['--date']), /vereist een waarde/);
  assert.throws(() => parseRoundCreateOptions(['--date', '--closes-at', 'x']), /vereist een waarde/);
  assert.throws(() => parseRoundCreateOptions(['--date', 'a', '--date', 'b']), /dubbel/);
});
