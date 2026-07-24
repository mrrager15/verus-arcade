/**
 * Shared Verus Arcade app setup — used by both dev (auth.mjs) and
 * production (prod.mjs). Everything is env-driven so the same code runs
 * locally against vrsctest and on the VPS against mainnet VRSC.
 *
 * Env:
 *   ARCADE_ORIGIN       public origin for the wallet callback
 *                       (dev: http://<LAN-IP>:8100, prod: https://verusarcade.com)
 *   ARCADE_NETWORK      exactly one chain (default "vrsctest")
 *   ARCADE_VRSC_CONF    path to VRSC.conf (default Windows %APPDATA% path)
 *   ARCADE_VRSCTEST_CONF path to vrsctest.conf
 */
import express from 'express';
import { verusAuth } from 'verus-connect/server';
import { gameRouter, registerSession } from './game.mjs';
import { loadConfig } from './config.mjs';
import { createSessionToken } from './session-store.mjs';

const runtime = loadConfig();
const confOverrides = { [runtime.network]: runtime.confPath };

/** Build the Express app with /verus (auth) and /api (game) mounted. */
export function makeArcadeApp() {
  const app = express();

  app.use(
    '/verus',
    verusAuth({
      mode: 'daemon',
      // Friendly name resolves per chain (Arcade@ has a different i-address
      // on mainnet vs testnet).
      iAddress: runtime.arcadeIdentity,
      callbackUrl: `${runtime.origin}/verus/verusidlogin`,
      chains: [runtime.network],
      defaultChain: runtime.network,
      confPathOverrides: confOverrides,
      debug: runtime.debug,
      onLogin: (login) => {
        const token = createSessionToken();
        registerSession(token, {
          iAddress: login.iAddress,
          friendlyName: login.friendlyName,
          chain: login.chainName,
        });
        console.log(`[arcade] login verified: ${login.friendlyName} (${login.iAddress}) via ${login.chainName}`);
        return { sessionToken: token };
      },
    })
  );

  app.use('/api', gameRouter);
  return app;
}

export const config = {
  ORIGIN: runtime.origin,
  CHAINS: [runtime.network],
  DEFAULT_CHAIN: runtime.network,
  runtime,
};
