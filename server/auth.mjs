/**
 * Verus Arcade — backend server (phase 1)
 *
 * Runs Verus Connect in daemon mode against the local vrsctest daemon.
 * The daemon holds the keys of Arcade@ (testnet) and signs login challenges —
 * this server never touches private keys.
 *
 * Also mounts the game API (daily word round) under /api.
 *
 * Start:     node server/auth.mjs
 * Requires:  verusd -chain=vrsctest running, with Arcade@ in its wallet.
 */
import express from 'express';
import crypto from 'node:crypto';
import { verusAuth } from 'verus-connect/server';
import { gameRouter, registerSession } from './game.mjs';

const LAN_IP = process.env.ARCADE_LAN_IP ?? '192.168.0.235';
const PORT = Number(process.env.ARCADE_AUTH_PORT ?? 8100);

// Testnet identity from phase 0 (see fase0-runbook.md in the Brainstorm folder)
const ARCADE_ID_VRSCTEST = 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp'; // Arcade@

const app = express();

app.use(
  '/verus',
  verusAuth({
    mode: 'daemon',
    iAddress: ARCADE_ID_VRSCTEST,
    // Verus Mobile on the phone POSTs the signed response here —
    // must be the LAN IP, not localhost.
    callbackUrl: `http://${LAN_IP}:${PORT}/verus/verusidlogin`,
    chains: ['vrsctest'],
    defaultChain: 'vrsctest',
    confPathOverrides: {
      // Windows datadir; verus-connect only knows the Linux default paths
      vrsctest: `${process.env.APPDATA}\\Komodo\\vrsctest\\vrsctest.conf`,
    },
    debug: true,
    onLogin: (login) => {
      // Issue a session token; the frontend receives it via /verus/result
      // polling (in the `data` field) and uses it as a Bearer token for /api.
      const token = crypto.randomBytes(24).toString('hex');
      registerSession(token, { iAddress: login.iAddress, friendlyName: login.friendlyName });
      console.log(`[arcade] login verified: ${login.friendlyName} (${login.iAddress}) via ${login.chainName}`);
      return { sessionToken: token };
    },
  })
);

app.use('/api', gameRouter);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[arcade] backend listening on http://${LAN_IP}:${PORT}`);
  console.log('[arcade] routes: /verus/* (auth), /api/* (game)');
});
