/**
 * Planning en definitie van een nieuwe Daily-ronde (ronde-rotatie).
 *
 * Pure functies zonder I/O, zodat de operator-CLI (scripts/operator) dun blijft
 * en alles hier unit-testbaar is.
 *
 * Een Daily loopt standaard van 00:00:00 UTC op de rondedatum tot 00:00:00 UTC
 * de dag erna. Het record-ID is `<game>:<versie>:JJJJ-MM-DD` (bv.
 * `word-grid:1.0.0:2026-11-12`), hetzelfde patroon als de v1-rondes.
 */
import crypto from 'node:crypto';

import { DEFAULT_GAME, gameGenerator, parseGameOption } from './games/generators.mjs';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** JJJJ-MM-DD van een tijdstip, in UTC. */
export function utcDateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Ronde-ID van een Daily: `<game>:<versie>:<datum>` (zonder game: Word Grid 1.0.0). */
export function dailyRoundRecordId(date, game = DEFAULT_GAME) {
  return `${game.gameId}:${game.gameVersion}:${date}`;
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
export function testRoundSchedule({ minutes, now = Date.now(), game = DEFAULT_GAME }) {
  const n = Number(minutes);
  if (!Number.isSafeInteger(n) || n < 3 || n > 180) throw new Error('--test-minutes moet tussen 3 en 180 liggen');
  const opensAtMs = Math.floor(now / 60_000) * 60_000;
  const closesAtMs = opensAtMs + n * 60_000;
  const iso = new Date(opensAtMs).toISOString();
  const date = iso.slice(0, 10);
  const slot = `${iso.slice(11, 13)}${iso.slice(14, 16)}`;
  return {
    date,
    recordId: `${dailyRoundRecordId(date, game)}T${slot}`,
    opensAt: iso,
    closesAt: new Date(closesAtMs).toISOString(),
    opensAtMs,
    closesAtMs,
  };
}

/**
 * Games die nog rondes in definitieschema 1 krijgen (alleen Word Grid 1.0.0).
 * Fase 8: pas omzetten als het generieke pad (schema 2 → resultaat schema 3)
 * end-to-end bewezen is; tot dan blijft de echte Daily op het beproefde pad.
 */
const LEGACY_DEFINITION_GAMES = new Set(['word-grid@1.0.0']);

/**
 * Bouwt de geheime rondedefinitie voor een Daily van een game: de puzzel komt
 * van de generator van die game, plus een salt. Alleen de sha256 hiervan komt
 * op de chain. Schema 2 (fase 8) voor elke game; Word Grid 1.0.0 voorlopig nog
 * schema 1 (zie hierboven). `random` en `answers` (alleen Word Grid) zijn
 * injecteerbaar voor tests.
 */
export function createDailyHiddenDefinition({
  schedule,
  chainId = 'vrsctest',
  game = DEFAULT_GAME,
  answers,
  schemaVersion = LEGACY_DEFINITION_GAMES.has(`${game.gameId}@${game.gameVersion}`) ? 1 : 2,
  random = { bytes: (n) => crypto.randomBytes(n), int: (max) => crypto.randomInt(0, max) },
}) {
  const generator = gameGenerator(game.gameId, game.gameVersion);
  const base = {
    roundId: schedule.recordId ?? dailyRoundRecordId(schedule.date, game),
    chainId,
    gameId: game.gameId,
    gameVersion: game.gameVersion,
    date: schedule.date,
    opensAt: schedule.opensAt,
    closesAt: schedule.closesAt,
  };
  if (schemaVersion === 1) {
    if (!LEGACY_DEFINITION_GAMES.has(`${game.gameId}@${game.gameVersion}`)) throw new Error('Schema 1 bestaat alleen voor Word Grid 1.0.0');
    const puzzleSeed = random.bytes(32).toString('hex');
    const { answer } = generator.createPuzzle({ random, ...(answers ? { answers } : {}) });
    return { schemaVersion: 1, ...base, puzzleSeed, answer, salt: random.bytes(32).toString('hex') };
  }
  if (schemaVersion !== 2) throw new Error(`Onbekend definitieschema ${schemaVersion}`);
  const puzzle = generator.createPuzzle({ random, ...(answers ? { answers } : {}) });
  return { schemaVersion: 2, ...base, puzzle, salt: random.bytes(32).toString('hex') };
}

/**
 * Leest `--date`, `--opens-at`, `--closes-at`, `--test-minutes` en `--game` uit CLI-argumenten.
 * Onbekende opties zijn een fout, zodat een typefout nooit stil genegeerd wordt.
 */
export function parseRoundCreateOptions(argv = []) {
  const options = {};
  const names = { '--date': 'date', '--opens-at': 'opensAt', '--closes-at': 'closesAt', '--test-minutes': 'testMinutes', '--game': 'game' };
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
  if ('testMinutes' in options && ['date', 'opensAt', 'closesAt'].some((k) => k in options)) throw new Error('--test-minutes gaat niet samen met --date/--opens-at/--closes-at');
  if ('game' in options) options.game = parseGameOption(options.game);
  return options;
}
