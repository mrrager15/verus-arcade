/**
 * Verus Arcade — DEV backend (phase 1).
 *
 * Runs the shared Arcade app (verus-connect daemon-mode login + game API)
 * against the local daemons. For production see prod.mjs.
 *
 * Start:     node server/auth.mjs
 * Requires:  verusd running for the configured chains, Arcade@ in the wallet.
 */
import { makeArcadeApp, config } from './app.mjs';
import { createRuntimeServices } from './runtime-services.mjs';

const PORT = config.runtime.authPort;
const services = createRuntimeServices();
const app = makeArcadeApp({ dailyService: services.dailyService });

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[arcade] dev backend on ${config.ORIGIN}  (chains: ${config.CHAINS.join(', ')})`);
  console.log('[arcade] routes: /verus/*, /api/v1/*');
});

function shutdown() {
  server.close(() => {
    services.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
