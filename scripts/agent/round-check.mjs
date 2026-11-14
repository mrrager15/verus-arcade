#!/usr/bin/env node
/**
 * Fase 4: een of meer rondes nagaan met alleen de chain (geen server, geen .env),
 * via dezelfde code als de onafhankelijke verifier in de browser.
 *
 *   node scripts/agent/round-check.mjs [ronde-id …] [--url https://…]
 *
 * Standaard: Word Grid en Number Target van 13 nov 2026 via api.verustest.net.
 * Exitcode 0 als elke ronde `verified` is, anders 1.
 */
import crypto from 'node:crypto';

import { createChainReader } from '../../shared/chain-reader.mjs';
import { verifyRoundIndependently } from '../../shared/independent-round.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
const rounds = args.filter((a, i) => !a.startsWith('--') && (urlIndex < 0 || i !== urlIndex + 1));
if (rounds.length === 0) rounds.push('word-grid:1.0.0:2026-11-13', 'number-target:1.0.0:2026-11-13');

const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
let allVerified = true;
for (const roundId of rounds) {
  // Eén lezer per ronde: elk zijn eigen tijdsbudget.
  const r = await verifyRoundIndependently({ roundId, reader: createChainReader({ url }), sha256Hex });
  if (r.verdict !== 'verified') allVerified = false;
  console.log(JSON.stringify({
    roundId: r.roundId,
    verdict: r.verdict,
    source: r.source,
    window: r.window,
    parts: Object.fromEntries(Object.entries(r.parts).map(([name, p]) => [name, {
      status: p.status, txid: p.txid, height: p.height, confirmations: p.confirmations, problem: p.problem,
      ...(name === 'reveal' && p.value ? { puzzle: p.value.hiddenDefinition?.puzzle ?? { answer: p.value.hiddenDefinition?.answer } } : {}),
      ...(name === 'results' && p.value ? { players: p.value.leafCount, root: p.value.rootSha256 } : {}),
    }])),
    timing: r.timing,
    problems: r.problems,
  }, null, 2));
}
process.exitCode = allVerified ? 0 : 1;
