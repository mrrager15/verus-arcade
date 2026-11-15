#!/usr/bin/env node
/**
 * Fase 4: het Arcade-profiel van een speler nagaan met alleen de chain (geen
 * server, geen daemon, geen .env), met dezelfde code als de browser.
 *
 *   node scripts/agent/profile-check.mjs <i-adres van de speler> [--url https://…]
 */
import crypto from 'node:crypto';

import { createChainReader } from '../../shared/chain-reader.mjs';
import { verifyProfileIndependently } from '../../shared/independent-profile.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : undefined;
const playerId = args.find((a, i) => !a.startsWith('--') && (urlIndex < 0 || i !== urlIndex + 1));
if (!playerId) throw new Error('Gebruik: node scripts/agent/profile-check.mjs <i-adres> [--url …]');

const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const r = await verifyProfileIndependently({ playerId, reader: createChainReader({ url, limits: { timeMs: 60_000 } }), sha256Hex });
const bundle = (b) => ({
  verdict: b.verdict, height: b.height, revealHeight: b.revealHeight, sealed: b.sealed, sealedBeforeReveal: b.sealedBeforeReveal,
  actions: b.actions, receipt: b.receipt, replay: b.replay, matchesResult: b.matchesResult, duplicates: b.duplicates, problems: b.problems,
});
console.log(JSON.stringify({
  verdict: r.verdict,
  name: r.name,
  source: r.source,
  ignored: r.ignored,
  unreadable: r.unreadable,
  problems: r.problems,
  results: r.results.map((x) => ({
    round: x.round, v: x.recordVersion, status: x.status, root: x.root, replay: x.replay, roundVerdict: x.roundVerdict, height: x.height,
    ...(x.testRound ? { testRound: true } : {}), ...(x.bundle ? { bundle: bundle(x.bundle) } : {}),
  })),
  // Fase 5: verzegelde bundels van rondes zonder resultaat in de ID.
  sealedOnly: r.sealedOnly.map((x) => ({ round: x.round, roundVerdict: x.roundVerdict, ...(x.testRound ? { testRound: true } : {}), bundle: bundle(x.check) })),
}, null, 2));
