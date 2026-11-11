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
import { gameRouter, registerSession, resolveSession } from './game.mjs';
import { createDailyRouter } from './daily-router.mjs';
import { loadConfig } from './config.mjs';
import { canonicalLoginPrincipal } from './login-principal.mjs';
import { createSessionToken } from './session-store.mjs';
import { createLoginReturnHandler, walletReturnPage } from './wallet-return.mjs';

const runtime = loadConfig();
const confOverrides = { [runtime.network]: runtime.confPath };
// Hoe Verus Mobile antwoorden terugstuurt (zelfde schakelaar als fase 1):
// 'redirect' werkt over http op het LAN, 'post' vereist HTTPS.
const walletResponseMode = (process.env.WALLET_RESPONSE_MODE ?? 'redirect').trim();
if (!['redirect', 'post'].includes(walletResponseMode)) {
  throw new Error('WALLET_RESPONSE_MODE must be redirect or post');
}
const LOGIN_RETURN_PATH = '/verus/login-return';
const WALLET_RETURN_PATH = '/verus/wallet-return';

/** Build the Express app with /verus (auth) and /api (game) mounted. */
export function makeArcadeApp({ dailyService = null, attemptSignatureService = null, playerPublicationService = null, attestationService = null } = {}) {
  const app = express();

  // Landingspagina voor de browser op de telefoon na een wallet-actie
  // (login of handtekening). Toont alleen "gelukt"/"niet verwerkt" en een code.
  app.get(WALLET_RETURN_PATH, (request, response) => {
    const kind = ['sign', 'publish'].includes(request.query.kind) ? request.query.kind : 'login';
    const ok = request.query.signed === '1' || request.query.ok === '1';
    const error = typeof request.query.returnError === 'string' ? request.query.returnError.slice(0, 40) : null;
    response.set('Cache-Control', 'no-store');
    const challenge = typeof request.query.challenge === 'string' ? request.query.challenge : null;
    response.type('html').send(walletReturnPage({ kind, ok, error, challenge }));
  });

  // Redirect-transport voor de login: Mobile opent deze URL met het getekende
  // antwoord in de query; de handler geeft het door aan verus-connects
  // POST-route en stuurt de telefoon naar de landingspagina.
  app.get(
    LOGIN_RETURN_PATH,
    createLoginReturnHandler({ walletReturnPath: WALLET_RETURN_PATH, debug: runtime.debug }),
  );

  app.use(
    '/verus',
    verusAuth({
      mode: 'daemon',
      // Friendly name resolves per chain (Arcade@ has a different i-address
      // on mainnet vs testnet).
      iAddress: runtime.arcadeIdentity,
      callbackUrl: `${runtime.origin}/verus/verusidlogin`,
      // Met redirect-transport krijgt elke challenge ook een TYPE_REDIRECT-envelop;
      // de frontend zet die in de QR (zie src/routes/+page.svelte).
      redirectUrl: walletResponseMode === 'redirect' ? `${runtime.origin}${LOGIN_RETURN_PATH}` : undefined,
      chains: [runtime.network],
      defaultChain: runtime.network,
      confPathOverrides: confOverrides,
      debug: runtime.debug,
      onLogin: (login) => {
        const token = createSessionToken();
        registerSession(
          token,
          canonicalLoginPrincipal(login, runtime.network),
        );
        console.log(`[arcade] login verified: ${login.friendlyName} (${login.iAddress}) via ${login.chainName}`);
        return { sessionToken: token };
      },
    })
  );

  app.use('/api', gameRouter);
  if (dailyService) {
    app.use(
      '/api/v1',
      createDailyRouter({
        dailyService,
        resolveSession,
        attemptSignatureService,
        playerPublicationService,
        attestationService,
        // Na een handtekening of publicatie landt de telefoon op dezelfde landingspagina;
        // de router zet zelf `kind=sign` of `kind=publish` in de query.
        walletReturnPath: WALLET_RETURN_PATH,
      }),
    );
  }
  return app;
}

export const config = {
  ORIGIN: runtime.origin,
  CHAINS: [runtime.network],
  DEFAULT_CHAIN: runtime.network,
  runtime,
};
