/**
 * Planning en definitie van een nieuwe Daily-ronde (ronde-rotatie).
 *
 * Pure functies zonder I/O, zodat de operator-CLI (scripts/operator) dun blijft
 * en alles hier unit-testbaar is.
 *
 * Een Daily loopt standaard van 00:00:00 UTC op de rondedatum tot 00:00:00 UTC
 * de dag erna. Het record-ID is `word-grid:1.0.0:JJJJ-MM-DD`, hetzelfde patroon
 * als de v1-rondes, zodat de verifier en het resultaatrecord niets hoeven te
 * veranderen.
 */
import crypto from 'node:crypto';

import { WORD_GRID_GAME_ID, WORD_GRID_VERSION } from './games/word-grid/engine.mjs';
import { ANSWERS } from './words.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JJJJ-MM-DD van een tijdstip, in UTC. */
export function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dailyRoundRecordId(date) {
  return `${WORD_GRID_GAME_ID}:${WORD_GRID_VERSION}:${date}`;
}

/**
 * Bepaalt datum, openings- en sluitingstijd van een Daily.
 * - `date` ontbreekt → vandaag (UTC).
 * - `opensAt` ontbreekt → 00:00 UTC op `date`.
 * - `closesAt` ontbreekt → 24 uur na de standaard-opening (dus 00:00 UTC de dag erna).
 * Gooit als de datum ongeldig is, de volgorde niet klopt, of de ronde al voorbij is.
 */
export function dailyRoundSchedule({ date, opensAt, closesAt, now = Date.now() } = {}) {
  const resolvedDate = date ?? utcDateOf(now);
  if (!DATE_PATTERN.test(resolvedDate)) {
    throw new Error(`Rondedatum moet JJJJ-MM-DD zijn, niet "${resolvedDate}"`);
  }
  const dayStart = Date.parse(`${resolvedDate}T00:00:00.000Z`);
  if (!Number.isFinite(dayStart) || utcDateOf(dayStart) !== resolvedDate) {
    throw new Error(`Rondedatum "${resolvedDate}" bestaat niet`);
  }
  const opensAtMs = opensAt ? Date.parse(opensAt) : dayStart;
  const closesAtMs = closesAt ? Date.parse(closesAt) : dayStart + DAY_MS;
  if (!Number.isFinite(opensAtMs)) throw new Error(`opensAt is geen geldige ISO-tijd: "${opensAt}"`);
  if (!Number.isFinite(closesAtMs)) throw new Error(`closesAt is geen geldige ISO-tijd: "${closesAt}"`);
  if (closesAtMs <= opensAtMs) throw new Error('closesAt moet na opensAt liggen');
  if (closesAtMs <= now) throw new Error('closesAt ligt in het verleden; deze ronde zou meteen gesloten zijn');
  return {
    date: resolvedDate,
    opensAt: new Date(opensAtMs).toISOString(),
    closesAt: new Date(closesAtMs).toISOString(),
    opensAtMs,
    closesAtMs,
  };
}

/**
 * Testronde (zie server/test-rounds.mjs): opent nu (afgerond op de minuut, UTC)
 * en sluit na `minutes` minuten. Record-ID met tijdslot: `…:JJJJ-MM-DDTUUMM`.
 */
export function testRoundSchedule({ minutes, now = Date.now() }) {
  const n = Number(minutes);
  if (!Number.isSafeInteger(n) || n < 3 || n > 180) throw new Error('--test-minutes moet tussen 3 en 180 liggen');
  const opensAtMs = Math.floor(now / 60_000) * 60_000;
  const closesAtMs = opensAtMs + n * 60_000;
  const iso = new Date(opensAtMs).toISOString();
  const date = iso.slice(0, 10);
  const slot = `${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return {
    date,
    recordId: `${dailyRoundRecordId(date)}T${slot}`,
    opensAt: iso,
    closesAt: new Date(closesAtMs).toISOString(),
    opensAtMs,
    closesAtMs,
  };
}

/**
 * Bouwt de geheime rondedefinitie (schema 1) voor een Daily: willekeurig
 * antwoord, puzzle-seed en salt. Alleen de sha256 hiervan komt op de chain.
 * `random` is injecteerbaar voor tests.
 */
export function createDailyHiddenDefinition({
  schedule,
  chainId = 'vrsctest',
  answers = ANSWERS,
  random = { bytes: (n) => crypto.randomBytes(n), int: (max) => crypto.randomInt(0, max) },
}) {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new Error('Geen antwoordenlijst beschikbaar');
  }
  return {
    schemaVersion: 1,
    roundId: schedule.recordId ?? dailyRoundRecordId(schedule.date),
    chainId,
    gameId: WORD_GRID_GAME_ID,
    gameVersion: WORD_GRID_VERSION,
    date: schedule.date,
    opensAt: schedule.opensAt,
    closesAt: schedule.closesAt,
    puzzleSeed: random.bytes(32).toString('hex'),
    answer: answers[random.int(answers.length)],
    salt: random.bytes(32).toString('hex'),
  };
}

/**
 * Leest `--date`, `--opens-at` en `--closes-at` uit CLI-argumenten.
 * Onbekende opties zijn een fout, zodat een typefout nooit stil genegeerd wordt.
 */
export function parseRoundCreateOptions(argv = []) {
  const options = {};
  const names = { '--date': 'date', '--opens-at': 'opensAt', '--closes-at': 'closesAt', '--test-minutes': 'testMinutes' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const key = names[flag];
    if (!key) throw new Error(`Onbekende optie: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} vereist een waarde`);
    if (key in options) throw new Error(`${flag} is dubbel opgegeven`);
    options[key] = value;
    index += 1;
  }
  if ('testMinutes' in options && Object.keys(options).length > 1) throw new Error('--test-minutes gaat niet samen met --date/--opens-at/--closes-at');
  return options;
}
