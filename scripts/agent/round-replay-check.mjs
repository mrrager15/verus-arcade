#!/usr/bin/env node
/**
 * Fase 5: een hele ronde naspelen met dezelfde code als de naspeelpagina in de browser.
 *
 *   node scripts/agent/round-replay-check.mjs <ronde-id> [--server http://127.0.0.1:8100] [--records <bestand.json>] [--url https://…]
 *
 * De lijst van resultaten komt van de Arcade-server (`/api/v1/rounds/<id>/results`)
 * of uit een JSON-bestand (`{ "records": [...] }` of een kale lijst); al het andere
 * van de chain via de publieke RPC. De lijst wordt eerst tegen de wortel op de chain
 * gecontroleerd. Een testronde (ronde-ID met tijdslot) staat op de test-operator-ID.
 * Exitcode 0 bij `verified`, anders 1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { createChainReader } from '../../shared/chain-reader.mjs';
import { verifyRoundReplayIndependently } from '../../shared/independent-replay.mjs';

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (['--url', '--server', '--records'].includes(args[i])) { options[args[i].slice(2)] = args[i + 1]; i += 1; } else positional.push(args[i]);
}
const [roundId] = positional;
if (!roundId) throw new Error('Gebruik: node scripts/agent/round-replay-check.mjs <ronde-id> [--server …] [--records <bestand>] [--url …]');

let records = null;
let listSource;
if (options.records) {
  const parsed = JSON.parse(fs.readFileSync(options.records, 'utf8'));
  records = Array.isArray(parsed) ? parsed : parsed.records;
  listSource = options.records;
} else {
  const server = (options.server ?? 'http://127.0.0.1:8100').replace(/\/$/, '');
  listSource = `${server}/api/v1/rounds/${encodeURIComponent(roundId)}/results`;
  const response = await fetch(listSource);
  const body = await response.json();
  if (response.ok) records = body.records;
  else listSource += ` → ${response.status} ${body.error?.code ?? ''}`;
}

const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const reader = createChainReader({ url: options.url, limits: { timeMs: 90_000 } });
const r = await verifyRoundReplayIndependently({ roundId, records, reader, sha256Hex });
const bundle = (b) => b && ({
  verdict: b.verdict, height: b.height, revealHeight: b.revealHeight, sealed: b.sealed, sealedBeforeReveal: b.sealedBeforeReveal,
  receipt: b.receipt, replay: b.replay, matchesResult: b.matchesResult, duplicates: b.duplicates, problems: b.problems,
});
console.log(JSON.stringify({
  roundId,
  operatorId: r.operatorId,
  verdict: r.verdict,
  roundVerdict: r.round.verdict,
  listSource,
  set: r.set,
  sealing: r.sealing,
  players: r.players.map((p) => ({
    playerId: p.playerId, status: p.status, actions: p.actions, signed: p.signed, replay: p.replay,
    ...(p.replayReason ? { replayReason: p.replayReason } : {}), ...(p.bundleSkipped ? { bundleSkipped: true } : {}), ...(r.sealing ? { bundle: bundle(p.bundle) } : {}),
  })),
  problems: r.problems,
  source: reader.stats(),
}, null, 2));
if (r.verdict !== 'verified') process.exitCode = 1;
