/**
 * Fase 2: publicaties met ontvangstbewijs controleren op de chain.
 *   node scripts/operator/publications-reconcile.mjs            # controleren en bijwerken
 *   node scripts/operator/publications-reconcile.mjs --list     # alleen tonen, niets wijzigen
 *
 * Leest `.env` in dit proces (ARCADE_SERVICE_ID/-WIF, conf-pad) zoals `npm run server`
 * dat doet; de relay geeft die variabelen niet door. Alleen lezen op de chain:
 * er wordt nooit iets uitgezonden. Vereist VERUS_OPERATOR_ACK=RECONCILE_VRSCTEST_PUBLICATIONS
 * omdat statussen in de database veranderen.
 */
import fs from 'node:fs';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* geen .env: dan moet de omgeving het leveren */ }
// ARCADE_TEST_ROUNDS=1 → testdatabase (server/test-rounds.mjs); na .env, zodat de schakelaar wint.
(await import('../../server/test-rounds.mjs')).applyTestRoundEnvironment();

const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');

const listOnly = process.argv.includes('--list');
if (!listOnly && process.env.VERUS_OPERATOR_ACK !== 'RECONCILE_VRSCTEST_PUBLICATIONS') {
  throw new Error('Zet VERUS_OPERATOR_ACK=RECONCILE_VRSCTEST_PUBLICATIONS (of gebruik --list)');
}

const runtime = loadConfig();
if (runtime.network !== 'vrsctest') throw new Error('Alleen VRSCTEST');
const services = createRuntimeServices({ runtime });
try {
  const service = services.playerPublicationService;
  if (!service) throw new Error('Publicaties staan uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env');
  const awaiting = services.repository.listPlayerPublicationsAwaitingConfirmation({ limit: 200 });
  const all = services.database.prepare('SELECT attempt_id, kind, status, content_key, receipt_txid, published_txid, published_height, expires_height FROM player_publications ORDER BY created_at_ms DESC LIMIT 100').all();
  const output = {
    operation: listOnly ? 'publications-list' : 'publications-reconcile',
    databasePath: services.database.location?.() ?? null,
    publications: all.map((row) => ({
      attemptId: row.attempt_id, kind: row.kind, status: row.status, contentKey: row.content_key,
      receiptTxid: row.receipt_txid, publishedTxid: row.published_txid, publishedHeight: row.published_height, expiresHeight: row.expires_height,
    })),
    awaitingConfirmation: awaiting.length,
  };
  if (!listOnly) output.reconciled = await service.reconcile({ limit: 200 });
  console.log(JSON.stringify(output, null, 2));
} finally {
  services.close();
}
