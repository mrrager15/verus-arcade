/**
 * Leest (alleen lezen) het Arcade-profiel van een speler van de chain, precies
 * zoals GET /api/v1/profile/:id dat doet.
 *   node scripts/operator/player-profile.mjs <i-adres>
 * Laadt `.env` zelf (service-ID nodig voor de namespace; de relay geeft die niet door).
 */
import fs from 'node:fs';

try { if (fs.existsSync('.env')) process.loadEnvFile('.env'); } catch { /* omgeving levert het */ }
const { loadConfig } = await import('../../server/config.mjs');
const { createRuntimeServices } = await import('../../server/runtime-services.mjs');

const playerId = process.argv[2];
if (!playerId) throw new Error('Gebruik: node scripts/operator/player-profile.mjs <i-adres>');
const services = createRuntimeServices({ runtime: loadConfig() });
try {
  if (!services.playerPublicationService) throw new Error('Publicaties staan uit: ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF ontbreken in .env');
  const profile = await services.playerPublicationService.profile({ playerId });
  console.log(JSON.stringify({ ...profile, results: profile.results.map(({ record, ...rest }) => rest) }, null, 2));
} finally {
  services.close();
}
