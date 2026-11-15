/**
 * Fase 5: een hele ronde naspelen.
 *
 * De lijst van resultaten staat niet op de chain (alleen haar Merkle-wortel); ze
 * komt van de Arcade-server. Daarom eerst: is dit precies de lijst waarvan de
 * operator de wortel publiceerde? Pas dan gebruiken we haar:
 *
 *  1. De ronde zelf, van de chain (`verifyRoundIndependently`): commitment,
 *     resultaten (wortel, aantal) en reveal (puzzel, salt).
 *  2. De wortel van de gekregen lijst (`resultSetRoot`) moet gelijk zijn aan de
 *     wortel op de chain, met hetzelfde aantal spelers. Anders: stoppen.
 *  3. Per speler: de zetten naspelen met de regels tegen de onthulde puzzel.
 *  4. In een ronde met versleuteladres: per speler de verzegelde bundel in zijn
 *     eigen ID (`verifyPlayerBundleIndependently`), vergeleken met zijn resultaat.
 *
 * Een speler met een geldig ontvangstbewijs die NIET in de lijst staat, vind je
 * hier niet (de lijst noemt hem niet): dat ziet zijn eigen profiel.
 */
import { recordActionValues } from './action-bundle.mjs';
import { ChainReadError, isUnavailable, STATUS } from './chain-reader.mjs';
import { BUNDLE_VERDICT, verifyPlayerBundleIndependently } from './independent-bundle.mjs';
import { ARCADE_OPERATOR_ID, VERDICT, operatorForRound, verifyRoundIndependently } from './independent-round.mjs';
import { replayResultRecord } from './replay.mjs';
import { resultSetRoot } from './result-set.mjs';
import { definitionPuzzle } from './round-proof.mjs';

/**
 * Oordelen over de naspeelcontrole.
 *  verified     de lijst is de officiële lijst, elk resultaat volgt uit zijn zetten, geen bundel is fout
 *  partial      idem, maar niet elke bundel was te lezen
 *  invalid      de lijst is niet de officiële, of een resultaat of bundel klopt aantoonbaar niet
 *  incomplete   de ronde is nog niet (helemaal) gepubliceerd: nog niets na te spelen
 *  not-found · unavailable · wrong-chain   zoals bij de rondecontrole
 */
export const REPLAY_VERDICT = Object.freeze({
  VERIFIED: 'verified', PARTIAL: 'partial', INVALID: 'invalid', INCOMPLETE: 'incomplete',
  NOT_FOUND: 'not-found', UNAVAILABLE: 'unavailable', WRONG_CHAIN: 'wrong-chain',
});

/**
 * @typedef {import('./independent-bundle.mjs').BundleCheck} BundleCheck
 * @typedef {{
 *   playerId: string, status: string, actions: string[], signed: boolean,
 *   replay: 'ok' | 'failed', replayReason: string | null,
 *   bundle: BundleCheck | null, bundleSkipped: boolean,
 * }} ReplayPlayer
 */

/**
 * @param {{
 *   roundId: string,
 *   records: any[] | null,
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   operatorId?: string,
 *   serviceId?: string,
 *   maxBundles?: number,
 * }} input  `records`: de lijst van de server, of null als die (nog) niet te krijgen was.
 */
export async function verifyRoundReplayIndependently({ roundId, records, reader, sha256Hex, operatorId = operatorForRound(roundId), serviceId = ARCADE_OPERATOR_ID, maxBundles = 12 }) {
  const round = await verifyRoundIndependently({ roundId, reader, sha256Hex, operatorId });
  const result = {
    roundId,
    operatorId,
    /** @type {string} */
    verdict: REPLAY_VERDICT.UNAVAILABLE,
    round,
    /** Heeft deze ronde een versleuteladres (commitment-schema 2)? Dan kunnen spelers bundels verzegeld hebben. */
    sealing: round.parts.commitment.value?.schemaVersion === 2,
    /** @type {{ status: 'ok' | 'mismatch' | 'not-given' | 'unknown', computedRoot: string | null, officialRoot: string | null, count: number | null, officialCount: number | null }} */
    set: { status: 'unknown', computedRoot: null, officialRoot: null, count: null, officialCount: null },
    /** @type {any} */
    puzzle: null,
    /** @type {ReplayPlayer[]} */
    players: [],
    /** @type {string[]} */
    problems: [...round.problems],
    source: round.source,
  };
  const finish = (/** @type {string} */ verdict, /** @type {string} */ problem = '') => {
    result.verdict = verdict;
    if (problem) result.problems.push(problem);
    const stats = reader.stats();
    result.source.calls = stats.calls;
    result.source.elapsedMs = stats.elapsedMs;
    return result;
  };
  const message = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error));

  if (round.verdict === VERDICT.WRONG_CHAIN) return finish(REPLAY_VERDICT.WRONG_CHAIN);
  if (round.verdict === VERDICT.UNAVAILABLE) return finish(REPLAY_VERDICT.UNAVAILABLE);
  if (round.verdict === VERDICT.NOT_FOUND) return finish(REPLAY_VERDICT.NOT_FOUND);
  if (round.verdict === VERDICT.INVALID) return finish(REPLAY_VERDICT.INVALID);
  if (round.verdict !== VERDICT.VERIFIED) return finish(REPLAY_VERDICT.INCOMPLETE);

  // 2. Is de gekregen lijst de lijst waarvan de operator de wortel publiceerde?
  const official = round.parts.results.status === STATUS.CONFIRMED ? round.parts.results.value : null;
  result.set.officialRoot = official?.rootSha256 ?? null;
  result.set.officialCount = official?.leafCount ?? null;
  if (records === null) {
    result.set.status = 'not-given';
    return finish(REPLAY_VERDICT.UNAVAILABLE, 'the result list could not be loaded from the Arcade server');
  }
  /** @type {any[]} */
  let ordered;
  try {
    const set = resultSetRoot(records);
    result.set.computedRoot = set.rootSha256;
    result.set.count = set.leafCount;
    ordered = set.records;
  } catch (error) {
    result.set.status = 'mismatch';
    return finish(REPLAY_VERDICT.INVALID, `result list: ${message(error)}`);
  }
  if (!official || result.set.computedRoot !== official.rootSha256 || result.set.count !== official.leafCount || ordered.some((r) => r.roundId !== roundId)) {
    result.set.status = 'mismatch';
    return finish(REPLAY_VERDICT.INVALID, 'the result list from the server is not the list whose root is on chain');
  }
  result.set.status = 'ok';

  // 3–4. Per speler: naspelen, en (als de ronde het toelaat) de verzegelde bundel.
  const puzzle = definitionPuzzle(round.parts.reveal.value.hiddenDefinition);
  result.puzzle = puzzle;
  let unread = false;
  for (const [index, record] of ordered.entries()) {
    const outcome = replayResultRecord(record, puzzle);
    /** @type {string[]} */
    let actions = [];
    try { actions = recordActionValues(record); } catch { /* ongeldige vorm: het naspelen meldt het al */ }
    /** @type {ReplayPlayer} */
    const player = {
      playerId: record.playerIAddress, status: record.status, actions, signed: Boolean(record.playerSignature),
      replay: outcome.ok ? 'ok' : 'failed', replayReason: outcome.ok ? null : outcome.reason, bundle: null, bundleSkipped: false,
    };
    if (result.sealing) {
      if (index >= maxBundles) player.bundleSkipped = true;
      else {
        try {
          player.bundle = await verifyPlayerBundleIndependently({ playerId: record.playerIAddress, roundId, round, reader, officialRecord: record, serviceId });
        } catch (error) {
          if (!(error instanceof ChainReadError) || !isUnavailable(error)) throw error;
          result.problems.push(`bundle of ${record.playerIAddress}: ${message(error)}`);
          unread = true;
        }
        if (player.bundle?.verdict === BUNDLE_VERDICT.UNAVAILABLE) unread = true;
      }
    }
    result.players.push(player);
  }

  const bad = result.players.some((p) => p.replay === 'failed' || p.bundle?.verdict === BUNDLE_VERDICT.INVALID);
  return finish(bad ? REPLAY_VERDICT.INVALID : unread ? REPLAY_VERDICT.PARTIAL : REPLAY_VERDICT.VERIFIED);
}
