/**
 * Verus Arcade — PRODUCTION server.
 *
 * One Node process serves everything: the built SvelteKit frontend plus the
 * /verus (login) and /api (game) routes. Sits behind Caddy, which terminates
 * TLS for verusarcade.com and reverse-proxies to this port.
 *
 * Build first:  npm run build   (adapter-node → build/)
 * Start:        node server/prod.mjs
 * Env:          PORT (default 3003), plus the ARCADE_* vars from app.mjs.
 */
import { handler } from '../build/handler.js';
import { makeArcadeApp, config } from './app.mjs';
import { createRuntimeServices } from './runtime-services.mjs';

const PORT = config.runtime.productionPort;
const services = createRuntimeServices();
const app = makeArcadeApp({ dailyService: services.dailyService });

// Everything not handled by /verus or /api falls through to SvelteKit.
app.use(handler);

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[arcade] production server on 127.0.0.1:${PORT}`);
  console.log(`[arcade] origin: ${config.ORIGIN}  chains: ${config.CHAINS.join(', ')}`);
});

function shutdown() {
  server.close(() => {
    services.close();
    process.exit(0);
  });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
