/**
 * Nachtelijke cyclus in één commando (opruimronde A2, 11 nov 2026).
 *
 *   VERUS_OPERATOR_ACK=RUN_VRSCTEST_DAILY_CYCLE node scripts/operator/daily-cycle.mjs [--max-wait <s>] [--no-create]
 *
 * Doet voor elke gesloten ronde, oudste eerst: finalize → results (wachten op
 * bevestiging) → attestaties → reveal (wachten op bevestiging); daarna zorgt het
 * dat de Daily van elke game voor vandaag en morgen (UTC) bestaan en open zijn (aanmaken →
 * uitzenden → wachten). Elke stap is het bestaande operator-commando met zijn
 * eigen ACK; tussen twee identity-updates op de operator-ID wacht het altijd op
 * een bevestiging. Herstartbaar: wordt `--max-wait` (standaard 480 s) bereikt,
 * dan stopt het met exitcode 3 en gaat een volgende aanroep verder.
 * Met ARCADE_TEST_ROUNDS=1: alleen testrondes afsluiten (geen nieuwe Daily's).
 *
 * Exitcodes: 0 klaar, 3 nog bezig (opnieuw uitvoeren), 1 geblokkeerd of fout.
 * Elke run voegt een regel toe aan server/data/daily-cycle.log (git negeert server/data).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { STEP_ACKS, missingDailyDates, nextRoundStep } from '../../server/daily-cycle-plan.mjs';
import { dailyGames } from '../../server/games/generators.mjs';
import { applyTestRoundEnvironment } from '../../server/test-rounds.mjs';

const ACK = 'RUN_VRSCTEST_DAILY_CYCLE';
if (process.env.VERUS_OPERATOR_ACK !== ACK) throw new Error(`Zet VERUS_OPERATOR_ACK=${ACK}`);
const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);
const maxWaitS = flag('--max-wait') === -1 ? 480 : Number(args[flag('--max-wait') + 1]);
if (!Number.isSafeInteger(maxWaitS) || maxWaitS < 10 || maxWaitS > 3600) throw new Error('--max-wait moet tussen 10 en 3600 s liggen');
const noCreate = args.includes('--no-create');
const mode = applyTestRoundEnvironment();
const deadline = Date.now() + maxWaitS * 1000;
const POLL_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const steps = [];

/** Voert een bestaand operator-script uit en geeft zijn JSON-uitvoer terug. */
function run(script, scriptArgs, ack) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    if (ack) env.VERUS_OPERATOR_ACK = ack; else delete env.VERUS_OPERATOR_ACK;
    const child = spawn(process.execPath, [path.join('scripts', 'operator', script), ...scriptArgs], { env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* geen JSON */ }
      const error = code === 0 ? null : (json?.message ?? err.split('\n').find((l) => /Error/.test(l)) ?? `exit ${code}`);
      resolve({ code, json, error });
    });
  });
}

const lifecycle = (action, roundId, extra = []) => run('round-lifecycle.mjs', [action, ...(roundId ? [roundId] : []), ...extra], STEP_ACKS[action]);

/** Werkt één ronde zo ver mogelijk af. 'done' | 'pending' | 'blocked'. */
async function advance(roundId) {
  let attestationsDone = false;
  for (;;) {
    const inspected = await run('round-lifecycle.mjs', ['inspect', roundId], null);
    if (inspected.code !== 0) { steps.push({ round: roundId, action: 'inspect', error: inspected.error }); return 'blocked'; }
    const step = nextRoundStep(inspected.json, { now: Date.now(), attestationsDone });
    if (step.done) return 'done';
    if (step.blocked) { steps.push({ round: roundId, blocked: step.blocked }); return 'blocked'; }
    if (step.action === 'attestations-create') {
      const made = await run('attestations.mjs', ['create', roundId], STEP_ACKS['attestations-create']);
      steps.push({ round: roundId, action: step.action, created: made.json?.created?.length ?? 0, ...(made.error ? { warning: made.error } : {}) });
      attestationsDone = true; // een fout hier blokkeert de reveal niet; later opnieuw te maken
      continue;
    }
    const result = await lifecycle(step.action, roundId);
    if (result.code !== 0) { steps.push({ round: roundId, action: step.action, error: result.error }); return 'blocked'; }
    if (!step.wait) { steps.push({ round: roundId, action: step.action, status: result.json?.roundStatus }); continue; }
    const again = nextRoundStep(result.json, { now: Date.now(), attestationsDone });
    if (again.action === step.action) {
      if (Date.now() + POLL_MS > deadline) { steps.push({ round: roundId, action: step.action, pending: true }); return 'pending'; }
      await sleep(POLL_MS);
    } else {
      steps.push({ round: roundId, action: step.action, confirmed: true });
    }
  }
}

// Nooit twee cycli tegelijk (bv. Windows-taakplanner en Claude): slotbestand, verouderd na 30 min.
const LOCK = path.resolve('server', 'data', 'daily-cycle.lock');
try {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
} catch {
  let stale = true;
  try { stale = Date.now() - JSON.parse(fs.readFileSync(LOCK, 'utf8')).at > 30 * 60 * 1000; } catch { /* onleesbaar = verouderd */ }
  if (!stale) {
    console.log(JSON.stringify({ operation: 'daily-cycle', outcome: 'blocked', steps: [{ blocked: 'another daily cycle is running' }] }, null, 2));
    process.exit(1);
  }
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: Date.now() }));
}

let outcome = 'done';
try {
  const listed = await run('round-lifecycle.mjs', ['list'], null);
  if (listed.code !== 0) throw new Error(listed.error);
  const rounds = [...listed.json.rounds].sort((a, b) => Date.parse(a.opensAt) - Date.parse(b.opensAt));
  for (const round of rounds) {
    if (Date.parse(round.closesAt) > Date.now() && round.status === 'open') continue; // loopt nog
    const state = await advance(round.roundId);
    if (state !== 'done') { outcome = state; break; }
  }
  if (outcome === 'done' && !mode.testMode && !noCreate) {
    // Fase 8: een Daily per geregistreerde game (hoogste versie), vandaag en morgen.
    const wanted = dailyGames().flatMap((game) =>
      missingDailyDates(rounds.map((r) => r.roundId), Date.now(), `${game.gameId}:${game.gameVersion}`)
        .map((date) => ({ game, date })));
    for (const { game, date } of wanted) {
      const created = await lifecycle('round-create', null, ['--game', `${game.gameId}@${game.gameVersion}`, '--date', date]);
      const roundId = created.json?.round?.roundId;
      steps.push({ round: roundId ?? date, action: 'round-create', ...(created.error ? { error: created.error } : {}) });
      if (created.code !== 0 || !roundId) { outcome = 'blocked'; break; }
      const state = await advance(roundId);
      if (state !== 'done') { outcome = state; break; }
    }
  }
} catch (error) {
  outcome = 'blocked';
  steps.push({ error: error.message });
}

try { fs.unlinkSync(LOCK); } catch { /* al weg */ }
const summary = { operation: 'daily-cycle', at: new Date().toISOString(), testMode: mode.testMode, outcome, steps };
console.log(JSON.stringify(summary, null, 2));
try { fs.appendFileSync(path.resolve('server', 'data', 'daily-cycle.log'), `${JSON.stringify(summary)}\n`); } catch { /* log is best effort */ }
process.exitCode = outcome === 'done' ? 0 : outcome === 'pending' ? 3 : 1;
