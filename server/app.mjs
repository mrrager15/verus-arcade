/**
 * Shared Verus Arcade app setup — used by both dev (auth.mjs) and
 * production (prod.mjs). Everything is env-driven so the same code runs
 * locally against vrsctest and on the VPS against mainnet VRSC.
 *
 * Env:
 *   ARCADE_ORIGIN       public origin for the wallet callback
 *                       (dev: http://<LAN-IP>:8100, prod: https://verusarcade.com)
 *   ARCADE_CHAINS       comma list of chains (default "vrsc,vrsctest")
 *   ARCADE_DEFAULT_CHAIN default chain (default first of ARCADE_CHAINS)
 *   ARCADE_VRSC_CONF    path to VRSC.conf (default Windows %APPDATA% path)
 *   ARCADE_VRSCTEST_CONF path to vrsctest.conf
 */
import express from 'express';
import crypto from 'node:crypto';
import { verusAuth } from 'verus-connect/server';
import { gameRouter, registerSession } from './game.mjs';

const ORIGIN = process.env.ARCADE_ORIGIN ?? 'http://192.168.0.235:8100';
const CHAINS = (process.env.ARCADE_CHAINS ?? 'vrsc,vrsctest').split(',').map((c) => c.trim());
const DEFAULT_CHAIN = process.env.ARCADE_DEFAULT_CHAIN ?? CHAINS[0];

const APPDATA = process.env.APPDATA ?? '';
const confOverrides = {};
if (CHAINS.includes('vrsc')) {
  confOverrides.vrsc = process.env.ARCADE_VRSC_CONF ?? `${APPDATA}\\Komodo\\VRSC\\VRSC.conf`;
}
if (CHAINS.includes('vrsctest')) {
  confOverrides.vrsctest = process.env.ARCADE_VRSCTEST_CONF ?? `${APPDATA}\\Komodo\\vrsctest\\vrsctest.conf`;
}

/** Build the Express app with /verus (auth) and /api (game) mounted. */
export function makeArcadeApp() {
  const app = express();

  app.use(
    '/verus',
    verusAuth({
      mode: 'daemon',
      // Friendly name resolves per chain (Arcade@ has a different i-address
      // on mainnet vs testnet).
      iAddress: process.env.ARCADE_ID ?? 'Arcade@',
      callbackUrl: `${ORIGIN.replace(/\/+$/, '')}/verus/verusidlogin`,
      chains: CHAINS,
      defaultChain: DEFAULT_CHAIN,
      confPathOverrides: confOverrides,
      debug: process.env.ARCADE_DEBUG === '1',
      onLogin: (login) => {
        const token = crypto.randomBytes(24).toString('hex');
        registerSession(token, { iAddress: login.iAddress, friendlyName: login.friendlyName });
        console.log(`[arcade] login verified: ${login.friendlyName} (${login.iAddress}) via ${login.chainName}`);
        return { sessionToken: token };
      },
    })
  );

  app.use('/api', gameRouter);
  return app;
}

export const config = { ORIGIN, CHAINS, DEFAULT_CHAIN };
