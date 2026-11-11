/**
 * Nachtelijke cyclus (opruimronde A2): pure planning, zonder I/O.
 *
 * Voor elke ronde bepaalt `nextRoundStep` uit de `inspect`-uitvoer van
 * scripts/operator/round-lifecycle.mjs welke stap nu kan. Het script
 * scripts/operator/daily-cycle.mjs voert die stappen één voor één uit en wacht
 * na elke uitgezonden identity-update tot ze bevestigd is, vóór de volgende
 * (twee onbevestigde updates op dezelfde operator-ID spenderen dezelfde output).
 * Herstartbaar: de journalen in de database zeggen waar elke ronde staat.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** VERUS_OPERATOR_ACK per stap (zelfde waarden als de losse commando's). */
export const STEP_ACKS = Object.freeze({
  'round-create': 'CREATE_VRSCTEST_ROUND',
  'round-submit': 'SUBMIT_VRSCTEST_ROUND',
  'round-open': 'OPEN_VRSCTEST_ROUND',
  finalize: 'FINALIZE_VRSCTEST_ROUND',
  'results-prepare': 'PREPARE_VRSCTEST_RESULTS_RETURNTX',
  'results-submit': 'SUBMIT_VRSCTEST_RESULTS',
  'results-reconcile': 'RECONCILE_VRSCTEST_RESULTS',
  'attestations-create': 'CREATE_VRSCTEST_ATTESTATIONS',
  'reveal-prepare': 'PREPARE_VRSCTEST_REVEAL_RETURNTX',
  'reveal-submit': 'SUBMIT_VRSCTEST_REVEAL',
  'reveal-reconcile': 'RECONCILE_VRSCTEST_REVEAL',
});

/**
 * Volgende stap voor één ronde.
 * @param {object} inspect uitvoer van `round-lifecycle.mjs inspect` (of een andere ronde-actie)
 * @param {{ now?: number, attestationsDone?: boolean }} context
 * @returns {{ action?: string, wait?: boolean, done?: boolean, running?: boolean, blocked?: string }}
 *   `wait`: na deze stap komt dezelfde stap terug tot de transactie bevestigd is.
 */
export function nextRoundStep(inspect, { now = Date.now(), attestationsDone = false } = {}) {
  const state = (journal) => journal?.state ?? null;
  const closesAt = Date.parse(inspect?.closesAt ?? '');
  switch (inspect?.roundStatus) {
    case 'revealed':
      return { done: true };
    case 'failed':
      return { blocked: 'round failed' };
    case 'commit_pending': {
      const commitment = state(inspect.commitment?.journal);
      if (commitment === 'signed') return { action: 'round-submit' };
      if (commitment === 'submitted') return { action: 'round-open', wait: true };
      return { blocked: `commitment journal ${commitment}` };
    }
    case 'open':
      if (!Number.isFinite(closesAt)) return { blocked: 'unknown close time' };
      return closesAt > now ? { done: true, running: true } : { action: 'finalize' };
    case 'closed': {
      const results = state(inspect.resultsJournal);
      if (results === null) return { action: 'results-prepare' };
      if (results === 'signed') return { action: 'results-submit' };
      if (results === 'submitted') return { action: 'results-reconcile', wait: true };
      if (results !== 'confirmed') return { blocked: `results journal ${results}` };
      if (!attestationsDone) return { action: 'attestations-create' };
      const reveal = state(inspect.revealJournal);
      if (reveal === null) return { action: 'reveal-prepare' };
      if (reveal === 'signed') return { action: 'reveal-submit' };
      if (reveal === 'submitted' || reveal === 'confirmed') return { action: 'reveal-reconcile', wait: true };
      return { blocked: `reveal journal ${reveal}` };
    }
    default:
      return { blocked: `unknown status ${inspect?.roundStatus}` };
  }
}

/** JJJJ-MM-DD in UTC. */
export function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Welke Daily's moeten er na de cyclus zijn: vandaag en morgen (UTC), zodat de
 * volgende ronde al bestaat als de huidige sluit. Nooit verder vooruit.
 * @param {string[]} existingRoundIds
 */
export function missingDailyDates(existingRoundIds, now = Date.now(), prefix = 'word-grid:1.0.0') {
  const wanted = [utcDate(now), utcDate(now + DAY_MS)];
  return wanted.filter((date) => !existingRoundIds.includes(`${prefix}:${date}`));
}
