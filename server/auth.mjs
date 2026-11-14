/**
 * Verus Arcade — DEV backend (phase 1).
 *
 * Runs the shared Arcade app (verus-connect daemon-mode login + game API)
 * against the local daemons. For production see prod.mjs.
 *
 * Start:     node server/auth.mjs
 * Requires:  verusd running for the configured chains, Arcade@ in the wallet.
 */
import fs from 'node:fs';

import { makeArcadeApp, config } from './app.mjs';
import { createRuntimeServices } from './runtime-services.mjs';

const PORT = config.runtime.authPort;
const services = createRuntimeServices({ runtime: config.runtime });
const app = makeArcadeApp({
  dailyService: services.dailyService,
  attemptSignatureService: services.attemptSignatureService,
  playerPublicationService: services.playerPublicationService,
  attestationService: services.attestationService,
  gameManifestService: services.gameManifestService,
});
console.log(
  services.attemptSignatureService
    ? '[arcade] wallet sign requests: enabled'
    : '[arcade] wallet sign requests: disabled (set ARCADE_SERVICE_ID and ARCADE_SERVICE_WIF)',
);

// Als er een build is (`npm run build`), serveert deze server ook de frontend, op
// dezelfde poort als de wallet-callbacks. Die poort laat de Windows-firewall al toe,
// zodat pagina's en deellinks op elk toestel in het LAN werken (poort 5173 van
// `npm run dev` is alleen op de pc zelf bereikbaar). Zelfde opbouw als prod.mjs.
const buildHandler = new URL('../build/handler.js', import.meta.url);
const servesFrontend = fs.existsSync(buildHandler);
if (servesFrontend) {
  const { handler } = await import(buildHandler.href);
  app.use(handler);
}

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[arcade] dev backend on ${config.ORIGIN}  (chains: ${config.CHAINS.join(', ')})`);
  console.log(`[arcade] routes: /verus/*, /api/v1/*${servesFrontend ? ', frontend uit build/ (na een wijziging: npm run build)' : ''}`);
});

function shutdown() {
  server.close(() => {
    services.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
