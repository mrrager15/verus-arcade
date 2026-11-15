#!/usr/bin/env node
/**
 * Fase 5: de actie-bundel van een speler nagaan met alleen de chain (geen
 * server, geen daemon, geen .env), met dezelfde code als de browser.
 *
 *   node scripts/agent/bundle-check.mjs <i-adres van de speler> <ronde-id> [--url https://…] [--operator <i-adres>]
 *
 * 1. De ronde zoals de operator-ID haar publiceerde (commitment met versleuteladres,
 *    resultaten, reveal). Een testronde (ronde-ID met tijdslot) staat op de
 *    test-operator-ID; `--operator` kiest een andere.
 * 2. De bundel in de ID van de speler: verzegeld, vóór de reveal, te openen met de
 *    sleutel uit de onthulde salt, ontvangstbewijs van Arcade@, naspelen.
 *
 * Vergelijken met het officiële resultaat doet dit script niet (`not-checked`):
 * daarvoor is het bewezen resultaatrecord van de speler nodig (profiel).
 */
import crypto from 'node:crypto';

import { createChainReader } from '../../shared/chain-reader.mjs';
import { verifyPlayerBundleIndependently } from '../../shared/independent-bundle.mjs';
import { ARCADE_OPERATOR_ID, verifyRoundIndependently } from '../../shared/independent-round.mjs';

/** `arcade-storage-poc@`: de operator-ID van testrondes (server/test-rounds.mjs). */
const TEST_OPERATOR_ID = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const TEST_ROUND = /:\d{4}-\d{2}-\d{2}T\d{4}$/;

const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--url' || args[i] === '--operator') { options[args[i].slice(2)] = args[i + 1]; i += 1; } else positional.push(args[i]);
}
const [playerId, roundId] = positional;
if (!playerId || !roundId) throw new Error('Gebruik: node scripts/agent/bundle-check.mjs <i-adres> <ronde-id> [--url …] [--operator <i-adres>]');
const operatorId = options.operator ?? (TEST_ROUND.test(roundId) ? TEST_OPERATOR_ID : ARCADE_OPERATOR_ID);

const sha256Hex = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const reader = createChainReader({ url: options.url, limits: { timeMs: 60_000 } });
const round = await verifyRoundIndependently({ roundId, reader, sha256Hex, operatorId });
const bundle = await verifyPlayerBundleIndependently({ playerId, roundId, round, reader });
const part = (p) => ({ status: p.status, txid: p.txid, height: p.height, ...(p.problem ? { problem: p.problem } : {}) });
console.log(JSON.stringify({
  playerId,
  roundId,
  operatorId,
  round: {
    verdict: round.verdict,
    commitmentSchema: round.parts.commitment.value?.schemaVersion ?? null,
    roundEncryptionAddress: round.parts.commitment.value?.roundEncryptionAddress ?? null,
    commitment: part(round.parts.commitment), results: part(round.parts.results), reveal: part(round.parts.reveal),
    problems: round.problems,
  },
  bundle,
  source: reader.stats(),
}, null, 2));
if (bundle.verdict !== 'verified') process.exitCode = 1;
