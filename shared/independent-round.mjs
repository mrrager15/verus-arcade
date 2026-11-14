/**
 * Fase 4: een Daily nagaan met alleen de chain (geen server van Arcade).
 *
 * Leest via de chain-lezer de updates van de operator-ID (`Arcade@`) rond de
 * datum van de ronde en zoekt daarin de drie bewijsstukken onder de `.v1`-keys:
 *
 *   commitment  vóór het spel: sha256 van de geheime definitie
 *   results     na het spel: Merkle-wortel en aantal spelers
 *   reveal      daarna: de definitie zelf (puzzel en zout)
 *
 * Per stuk: de transactie waarin het verscheen, bevestigingen en vorm. Dan:
 * klopt de reveal met de commitment (zelfde hash als vóór het spel vastgelegd),
 * en wijst de reveal naar de echte commitment-transactie?
 *
 * Uitkomst (`verdict`): verified · incomplete (nog niet alles gepubliceerd) ·
 * not-found · unavailable (lezen lukte niet: géén oordeel) · invalid (iets klopt
 * aantoonbaar niet) · wrong-chain. Tijdstippen (commitment vóór de opening,
 * resultaten na de sluiting) zijn informatie, geen oordeel: blocktijden kunnen
 * wat afwijken en een ronde opent pas als haar commitment bevestigd is.
 *
 * Gedeeld: browser, server en losse verifier. De sha256 wordt meegegeven.
 */
import { ChainReadError, decodeHexJson, isUnavailable, STATUS } from './chain-reader.mjs';
import { validateCommitment, validateResultDescriptor, verifyRoundReveal } from './round-proof.mjs';

export const ARCADE_OPERATOR_ID = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
/** VDXF-keys `Arcade::round.commitment.v1`, `…results.v1`, `…reveal.v1`. */
export const ROUND_KEYS = Object.freeze({
  commitment: 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7',
  results: 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA',
  reveal: 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj',
});

export const VERDICT = Object.freeze({
  VERIFIED: 'verified',
  INCOMPLETE: 'incomplete',
  NOT_FOUND: 'not-found',
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
  WRONG_CHAIN: 'wrong-chain',
});

const DAY_MS = 86_400_000;
const ROUND_ID = /^([a-z0-9][a-z0-9-]*):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2})(?:T(\d{2})(\d{2}))?$/;

/**
 * `word-grid:1.0.0:2026-11-13` (Daily) of `…:2026-11-11T1524` (testronde) ontleden.
 * @param {string} roundId
 */
export function parseRoundId(roundId) {
  const match = typeof roundId === 'string' ? ROUND_ID.exec(roundId) : null;
  const opensMs = match ? Date.parse(`${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}:00Z`) : Number.NaN;
  if (!match || !Number.isFinite(opensMs)) throw new ChainReadError('INVALID_INPUT', 'Invalid round ID');
  return { gameId: match[1], gameVersion: match[2], date: match[3], approxOpensMs: opensMs };
}

/**
 * @typedef {import('./chain-reader.mjs').HistoryEntry} HistoryEntry
 * @typedef {{ status: string, txid: string | null, height: number | null, confirmations: number | null,
 *             value: any, problem: string | null, recomputedSha256?: string | null }} Part
 */

/** @returns {Part} */
const emptyPart = () => ({ status: STATUS.MISSING, txid: null, height: null, confirmations: null, value: null, problem: null });

/**
 * De verschillende waarden onder `keyId` die bij deze ronde horen, elk met de update waarin ze verschenen.
 * @param {HistoryEntry[]} history  oudste eerst
 * @param {string} keyId
 * @param {(decoded: any) => boolean} belongs
 */
function findValues(history, keyId, belongs) {
  /** @type {Map<string, { value: any, entry: HistoryEntry }>} */
  const found = new Map();
  for (const entry of history) {
    const values = entry.contentmultimap?.[keyId];
    if (!Array.isArray(values)) continue;
    for (const raw of values) {
      const decoded = decodeHexJson(raw);
      if (decoded === null || !belongs(decoded)) continue;
      const key = JSON.stringify(raw);
      if (!found.has(key)) found.set(key, { value: decoded, entry });
    }
  }
  return [...found.values()];
}

/**
 * Een ronde nagaan met alleen de chain.
 * @param {{
 *   roundId: string,
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   operatorId?: string,
 *   marginDays?: number,
 *   laterDays?: number,
 * }} input
 */
export async function verifyRoundIndependently({ roundId, reader, sha256Hex, operatorId = ARCADE_OPERATOR_ID, marginDays = 2, laterDays = 30 }) {
  const { approxOpensMs } = parseRoundId(roundId);
  const parts = { commitment: emptyPart(), results: emptyPart(), reveal: emptyPart() };
  /** @type {string[]} */
  const problems = [];
  const result = {
    roundId,
    operatorId,
    /** @type {string} */
    verdict: VERDICT.UNAVAILABLE,
    /** @type {{ url: string, tip: number | null, version: string | null, calls: number, elapsedMs: number }} */
    source: { url: reader.url, tip: null, version: null, calls: 0, elapsedMs: 0 },
    /** @type {{ fromHeight: number, toHeight: number } | null} */
    window: null,
    parts,
    /** @type {{ commitmentBeforeOpen: boolean | null, resultsAfterClose: boolean | null, revealAfterResults: boolean | null } | null} */
    timing: null,
    problems,
  };
  const finish = (/** @type {string} */ verdict) => {
    result.verdict = verdict;
    const stats = reader.stats();
    result.source.calls = stats.calls;
    result.source.elapsedMs = stats.elapsedMs;
    return result;
  };

  // 1. Welke chain, en welk stuk ervan.
  /** @type {HistoryEntry[]} */
  let history;
  let tip;
  try {
    const info = await reader.info();
    tip = info.tip;
    result.source.tip = info.tip;
    result.source.version = info.version;
    const window = await reader.windowForTimes({ fromMs: approxOpensMs - marginDays * DAY_MS, toMs: approxOpensMs + DAY_MS + marginDays * DAY_MS });
    result.window = { fromHeight: window.fromHeight, toHeight: window.toHeight };
    history = await reader.identityHistory({ identityId: operatorId, fromHeight: window.fromHeight, toHeight: window.toHeight });
  } catch (error) {
    if (error instanceof ChainReadError && error.code === 'WRONG_CHAIN') return finish(VERDICT.WRONG_CHAIN);
    if (!isUnavailable(error)) throw error;
    problems.push(`chain: ${error instanceof Error ? error.message : String(error)}`);
    for (const part of Object.values(parts)) part.status = STATUS.UNAVAILABLE;
    return finish(VERDICT.UNAVAILABLE);
  }

  const lookup = () => ({
    commitment: findValues(history, ROUND_KEYS.commitment, (v) => v?.roundId === roundId),
    results: findValues(history, ROUND_KEYS.results, (v) => v?.roundId === roundId),
    reveal: findValues(history, ROUND_KEYS.reveal, (v) => v?.hiddenDefinition?.roundId === roundId),
  });
  let found = lookup();

  // 2. Resultaten of reveal kwamen later (pc stond uit)? Dan verder kijken, tot `laterDays` na de opening.
  const windowEnd = /** @type {{ fromHeight: number, toHeight: number }} */ (result.window).toHeight;
  if (found.commitment.length > 0 && (found.results.length === 0 || found.reveal.length === 0) && windowEnd < tip) {
    try {
      const later = await reader.windowForTimes({ fromMs: approxOpensMs + DAY_MS, toMs: approxOpensMs + DAY_MS + laterDays * DAY_MS });
      const fromHeight = windowEnd + 1;
      if (later.toHeight >= fromHeight) {
        history = [...history, ...await reader.identityHistory({ identityId: operatorId, fromHeight, toHeight: later.toHeight })];
        /** @type {{ fromHeight: number, toHeight: number }} */ (result.window).toHeight = later.toHeight;
        found = lookup();
      }
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      problems.push(`later window: ${error instanceof Error ? error.message : String(error)}`);
      if (found.results.length === 0) parts.results.status = STATUS.UNAVAILABLE;
      if (found.reveal.length === 0) parts.reveal.status = STATUS.UNAVAILABLE;
    }
  }

  const evaluated = await evaluateRound({ found, parts, problems, reader, sha256Hex, withTiming: true });
  result.timing = evaluated.timing;
  return finish(evaluated.verdict);
}

/**
 * Stap 3–6 voor één ronde: per stuk transactie en bevestigingen, vorm, samenhang,
 * (optioneel) tijdstippen, en het oordeel. `found` komt uit `findValues` op de
 * geschiedenis van de operator; `parts` en `problems` worden ingevuld.
 * @param {{
 *   found: { commitment: Array<{ value: any, entry: HistoryEntry }>, results: Array<{ value: any, entry: HistoryEntry }>, reveal: Array<{ value: any, entry: HistoryEntry }> },
 *   parts: { commitment: Part, results: Part, reveal: Part },
 *   problems: string[],
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   withTiming: boolean,
 * }} input
 */
async function evaluateRound({ found, parts, problems, reader, sha256Hex, withTiming }) {
  /** @type {{ commitmentBeforeOpen: boolean | null, resultsAfterClose: boolean | null, revealAfterResults: boolean | null } | null} */
  let timing = null;
  // 3. Per stuk: één waarde, haar transactie en bevestigingen.
  for (const name of /** @type {const} */ (['commitment', 'results', 'reveal'])) {
    const matches = found[name];
    const part = parts[name];
    if (matches.length === 0) continue;
    const { value, entry } = matches[0];
    Object.assign(part, { value, txid: entry.txid, height: entry.height });
    if (matches.length > 1) {
      part.status = STATUS.INVALID;
      part.problem = `${matches.length} different values for this round`;
      continue;
    }
    try {
      const tx = await reader.transaction(entry.txid);
      if (tx === null) {
        part.status = STATUS.UNAVAILABLE;
        part.problem = 'transaction unknown to this RPC';
      } else {
        part.confirmations = tx.confirmations;
        part.status = tx.confirmations > 0 ? STATUS.CONFIRMED : STATUS.PENDING;
      }
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      part.status = STATUS.UNAVAILABLE;
      part.problem = error instanceof Error ? error.message : String(error);
    }
  }

  // 4. Vorm en samenhang.
  const { commitment, results, reveal } = parts;
  const usable = (/** @type {Part} */ part) => part.status === STATUS.CONFIRMED || part.status === STATUS.PENDING;
  if (usable(commitment)) {
    try { validateCommitment(commitment.value); } catch (error) {
      commitment.status = STATUS.INVALID;
      commitment.problem = error instanceof Error ? error.message : String(error);
    }
  }
  const commitmentOk = usable(commitment);
  if (usable(results)) {
    try { validateResultDescriptor(results.value, commitmentOk ? commitment.value : undefined); } catch (error) {
      results.status = STATUS.INVALID;
      results.problem = error instanceof Error ? error.message : String(error);
    }
  }
  if (usable(reveal) && commitmentOk) {
    const check = await verifyRoundReveal({ commitment: commitment.value, reveal: reveal.value }, sha256Hex);
    reveal.recomputedSha256 = check.recomputedSha256;
    if (!check.valid) {
      reveal.status = STATUS.INVALID;
      reveal.problem = `reveal does not match the commitment (${check.reason})`;
    } else if (reveal.value.commitmentTxid !== commitment.txid) {
      reveal.status = STATUS.INVALID;
      reveal.problem = 'reveal points to another commitment transaction';
    }
  }

  // 5. Tijdstippen: informatie, geen oordeel. Lukt het lezen niet, dan blijven ze leeg.
  if (withTiming && commitmentOk) {
    try {
      const opensAt = Date.parse(commitment.value.opensAt) / 1000;
      const closesAt = Date.parse(commitment.value.closesAt) / 1000;
      const time = async (/** @type {Part} */ part) => (part.height === null || !usable(part) ? null : reader.blockTime(part.height));
      const [tCommitment, tResults] = [await time(commitment), await time(results)];
      timing = {
        commitmentBeforeOpen: tCommitment === null ? null : tCommitment < opensAt,
        resultsAfterClose: tResults === null ? null : tResults >= closesAt,
        revealAfterResults: results.height === null || reveal.height === null || !usable(reveal) ? null : reveal.height >= results.height,
      };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
    }
  }

  // 6. Oordeel.
  const statuses = Object.values(parts).map((part) => part.status);
  for (const [name, part] of Object.entries(parts)) if (part.problem) problems.push(`${name}: ${part.problem}`);
  /** @type {string} */
  let verdict = VERDICT.INCOMPLETE;
  if (statuses.includes(STATUS.INVALID)) verdict = VERDICT.INVALID;
  else if (commitment.status === STATUS.UNAVAILABLE) verdict = VERDICT.UNAVAILABLE;
  else if (commitment.status === STATUS.MISSING) verdict = VERDICT.NOT_FOUND;
  else if (statuses.every((status) => status === STATUS.CONFIRMED)) verdict = VERDICT.VERIFIED;
  else if (statuses.includes(STATUS.UNAVAILABLE)) verdict = VERDICT.UNAVAILABLE;
  return { verdict, timing };
}

/**
 * Meerdere rondes tegelijk nagaan met één leesbeurt van de operator-geschiedenis
 * (één venster van de vroegste tot de laatste ronde, plus een later venster als
 * resultaten of reveal ontbreken). Voor het profiel: de officiële wortel en de
 * puzzel per ronde komen hier vandaan. Zonder tijdstippen.
 * Gooit bij WRONG_CHAIN of als de geschiedenis niet te lezen is (de aanroeper
 * beslist dan "niet beschikbaar").
 * @param {{
 *   roundIds: string[],
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   operatorId?: string,
 *   marginDays?: number,
 *   laterDays?: number,
 * }} input
 * @returns {Promise<Map<string, { verdict: string, parts: { commitment: Part, results: Part, reveal: Part }, problems: string[] }>>}
 */
export async function verifyRoundsTogether({ roundIds, reader, sha256Hex, operatorId = ARCADE_OPERATOR_ID, marginDays = 2, laterDays = 30 }) {
  const unique = [...new Set(roundIds)];
  /** @type {Map<string, { verdict: string, parts: { commitment: Part, results: Part, reveal: Part }, problems: string[] }>} */
  const out = new Map();
  if (unique.length === 0) return out;
  const opens = unique.map((id) => parseRoundId(id).approxOpensMs);
  const first = Math.min(...opens);
  const last = Math.max(...opens);
  const { tip } = await reader.info();
  const window = await reader.windowForTimes({ fromMs: first - marginDays * DAY_MS, toMs: last + DAY_MS + marginDays * DAY_MS });
  let history = await reader.identityHistory({ identityId: operatorId, fromHeight: window.fromHeight, toHeight: window.toHeight });
  const lookup = (/** @type {string} */ roundId) => ({
    commitment: findValues(history, ROUND_KEYS.commitment, (v) => v?.roundId === roundId),
    results: findValues(history, ROUND_KEYS.results, (v) => v?.roundId === roundId),
    reveal: findValues(history, ROUND_KEYS.reveal, (v) => v?.hiddenDefinition?.roundId === roundId),
  });
  const incomplete = unique.some((id) => {
    const f = lookup(id);
    return f.commitment.length > 0 && (f.results.length === 0 || f.reveal.length === 0);
  });
  if (incomplete && window.toHeight < tip) {
    const later = await reader.windowForTimes({ fromMs: last + DAY_MS, toMs: last + DAY_MS + laterDays * DAY_MS });
    if (later.toHeight > window.toHeight) {
      history = [...history, ...await reader.identityHistory({ identityId: operatorId, fromHeight: window.toHeight + 1, toHeight: later.toHeight })];
    }
  }
  for (const roundId of unique) {
    const parts = { commitment: emptyPart(), results: emptyPart(), reveal: emptyPart() };
    /** @type {string[]} */
    const problems = [];
    const { verdict } = await evaluateRound({ found: lookup(roundId), parts, problems, reader, sha256Hex, withTiming: false });
    out.set(roundId, { verdict, parts, problems });
  }
  return out;
}
