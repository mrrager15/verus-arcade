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

const PORT = Number(process.env.ARCADE_AUTH_PORT ?? 8100);
const app = makeArcadeApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[arcade] dev backend on ${config.ORIGIN}  (chains: ${config.CHAINS.join(', ')})`);
  console.log('[arcade] routes: /verus/* (auth), /api/* (game)');
});
