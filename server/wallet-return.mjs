/**
 * Terugkeer uit Verus Mobile zonder HTTPS (redirect-transport).
 *
 * Verus Mobile (TestFlight, nov 2026) weigert een POST-antwoord naar een
 * http://-URL ("Response POST URLs must use HTTPS"). Lokaal op het LAN hebben
 * we geen certificaat, dus gebruiken we voor de login dezelfde weg als voor de
 * handtekening van fase 1: Mobile opent de browser op de telefoon met het
 * antwoord in de URL, en de server leest het daaruit.
 *
 * Dit bestand bevat alleen de pure delen (parsen en de landingspagina), zodat
 * ze unit-testbaar zijn; de Express-route staat in app.mjs.
 */

/** VDXF-key waaronder Mobile het base64url-antwoord in de query zet (verus-connect, TYPE_REDIRECT). */
export const LOGIN_RESPONSE_QUERY_KEY = 'i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC';
/** Ruim boven wat een GenericResponse ooit wordt; beschermt tegen onzin-URL's. */
const MAX_ENCODED_LENGTH = 87_382;

export class WalletReturnError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WalletReturnError';
    this.code = code;
  }
}

/**
 * Haalt challenge-ID en antwoordbytes uit de query van de redirect-URL.
 * `query` is een URLSearchParams. Gooit WalletReturnError bij elke afwijking.
 */
export function parseLoginReturnQuery(query) {
  const challengeId = query.get('challengeId') ?? '';
  if (!/^[0-9a-f]{32}$/.test(challengeId)) {
    throw new WalletReturnError('INVALID_CHALLENGE_ID', 'Login return needs a 32-hex challengeId');
  }
  const values = query.getAll(LOGIN_RESPONSE_QUERY_KEY);
  const encoded = values[0] ?? '';
  if (values.length !== 1 || encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new WalletReturnError('INVALID_CALLBACK', 'Invalid wallet response encoding');
  }
  const body = Buffer.from(encoded, 'base64url');
  if (body.toString('base64url') !== encoded) {
    throw new WalletReturnError('INVALID_CALLBACK', 'Noncanonical wallet response encoding');
  }
  return { challengeId, body };
}

/**
 * Haalt de GenericResponse-bytes uit de query van een wallet-redirect
 * (fase 1 en 2: `?<GENERIC_RESPONSE_QUERY_KEY>=<base64url>`). Eén waarde,
 * canonieke base64url, hooguit 87382 tekens. Gooit WalletReturnError.
 */
export function parseGenericResponseQuery(query, queryKey) {
  const values = query.getAll(queryKey);
  const encoded = values[0] ?? '';
  if (values.length !== 1 || encoded.length === 0 || encoded.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new WalletReturnError('INVALID_CALLBACK', 'Invalid wallet response encoding');
  }
  const body = Buffer.from(encoded, 'base64url');
  if (body.toString('base64url') !== encoded) {
    throw new WalletReturnError('INVALID_CALLBACK', 'Noncanonical wallet response encoding');
  }
  return body;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * Kale landingspagina voor de browser op de telefoon na een wallet-actie.
 * `kind` is 'login', 'sign' of 'publish'; `ok` zegt of de server het antwoord aanvaardde;
 * `error` is een foutcode (nooit een boodschap met details).
 */
export function walletReturnPage({ kind, ok, error = null }) {
  const what = kind === 'login' ? 'Inloggen' : kind === 'publish' ? 'Publicatie' : 'Handtekening';
  const title = ok ? (kind === 'publish' ? 'Publicatie ontvangen' : `${what} gelukt`) : `${what} niet verwerkt`;
  const hint = ok
    ? kind === 'publish'
      ? 'Je wallet heeft de transactie gemaakt. Zodra ze bevestigd is, staat je resultaat in je VerusID; het scherm waar je speelt toont dat. Je kunt dit venster sluiten.'
      : 'Je kunt dit venster sluiten. Kijk op het scherm waar je Verus Arcade speelt.'
    : `De server heeft het antwoord niet aanvaard${error ? ` (code ${escapeHtml(error)})` : ''}. Probeer het opnieuw vanaf het scherm waar je speelt.`;
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verus Arcade — ${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0f172a;color:#e2e8f0}
main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .75rem}p{line-height:1.5;color:#94a3b8}
.mark{font-size:3rem;line-height:1;margin-bottom:1rem}</style></head>
<body><main><div class="mark">${ok ? '✓' : '✕'}</div><h1>${escapeHtml(title)}</h1><p>${hint}</p></main></body></html>`;
}

/**
 * Express-handler voor de redirect-terugkeer van de login. Geeft de bytes door
 * aan verus-connects POST-route op dezelfde server (zelfde poort als waarop dit
 * verzoek binnenkwam), zodat verificatie en sessie-aanmaak ongewijzigd blijven.
 * `fetchImpl` is injecteerbaar voor tests.
 */
export function createLoginReturnHandler({ walletReturnPath, loginPostPath = '/verus/verusidlogin', debug = false, fetchImpl = fetch }) {
  return async (request, response) => {
    const destination = new URLSearchParams({ kind: 'login' });
    try {
      const query = new URL(request.originalUrl, 'http://callback.invalid').searchParams;
      const { challengeId, body } = parseLoginReturnQuery(query);
      const port = request.socket.localPort;
      const upstream = await fetchImpl(`http://127.0.0.1:${port}${loginPostPath}/${challengeId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
      });
      if (!upstream.ok) {
        throw new WalletReturnError(upstream.status === 404 ? 'CHALLENGE_EXPIRED' : 'VERIFICATION_FAILED', 'Login response rejected');
      }
      destination.set('ok', '1');
    } catch (error) {
      destination.set('returnError', error instanceof WalletReturnError ? error.code : 'INTERNAL_ERROR');
      if (debug) console.error('[arcade] login-return failed:', error);
    }
    response.set('Cache-Control', 'no-store');
    response.set('Referrer-Policy', 'no-referrer');
    response.redirect(303, `${walletReturnPath}?${destination.toString()}`);
  };
}
