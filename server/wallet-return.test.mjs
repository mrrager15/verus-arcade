import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOGIN_RESPONSE_QUERY_KEY,
  parseGenericResponseQuery,
  parseLoginReturnQuery,
  walletReturnPage,
} from './wallet-return.mjs';

const CHALLENGE = 'ab'.repeat(16);
const BYTES = Buffer.from([1, 2, 3, 250, 251, 252]);
const ENCODED = BYTES.toString('base64url');

function query(entries) {
  return new URLSearchParams(entries);
}

test('geldige redirect-query levert challenge-ID en bytes', () => {
  const parsed = parseLoginReturnQuery(query([['challengeId', CHALLENGE], [LOGIN_RESPONSE_QUERY_KEY, ENCODED]]));
  assert.equal(parsed.challengeId, CHALLENGE);
  assert.deepEqual(parsed.body, BYTES);
});

test('challenge-ID moet 32 hex zijn', () => {
  assert.throws(() => parseLoginReturnQuery(query([[LOGIN_RESPONSE_QUERY_KEY, ENCODED]])), /INVALID_CHALLENGE_ID|challengeId/);
  assert.throws(() => parseLoginReturnQuery(query([['challengeId', 'ABC'], [LOGIN_RESPONSE_QUERY_KEY, ENCODED]])), /challengeId/);
});

test('antwoord moet precies één canonieke base64url-waarde zijn', () => {
  assert.throws(() => parseLoginReturnQuery(query([['challengeId', CHALLENGE]])), /encoding/);
  assert.throws(
    () => parseLoginReturnQuery(query([['challengeId', CHALLENGE], [LOGIN_RESPONSE_QUERY_KEY, ENCODED], [LOGIN_RESPONSE_QUERY_KEY, ENCODED]])),
    /encoding/,
  );
  assert.throws(() => parseLoginReturnQuery(query([['challengeId', CHALLENGE], [LOGIN_RESPONSE_QUERY_KEY, 'AQID+g==']])), /encoding/);
  // Niet-canoniek: 'AQ' en 'AR' decoderen tot dezelfde byte; alleen 'AQ' mag.
  assert.throws(() => parseLoginReturnQuery(query([['challengeId', CHALLENGE], [LOGIN_RESPONSE_QUERY_KEY, 'AR']])), /Noncanonical/);
  assert.equal(parseLoginReturnQuery(query([['challengeId', CHALLENGE], [LOGIN_RESPONSE_QUERY_KEY, 'AQ']])).body[0], 1);
});

test('landingspagina toont uitkomst zonder details te lekken', () => {
  const ok = walletReturnPage({ kind: 'login', ok: true });
  assert.match(ok, /Inloggen gelukt/);
  assert.match(ok, /sluiten/);
  const bad = walletReturnPage({ kind: 'sign', ok: false, error: 'INVALID_<CALLBACK>' });
  assert.match(bad, /Handtekening niet verwerkt/);
  assert.match(bad, /INVALID_&lt;CALLBACK&gt;/);
  assert.doesNotMatch(bad, /<CALLBACK>/);
});

test('login-return geeft bytes door aan de POST-route en landt op de pagina', async () => {
  const { default: express } = await import('express');
  const { once } = await import('node:events');
  const { createLoginReturnHandler } = await import('./wallet-return.mjs');
  const received = [];
  const app = express();
  app.post('/verus/verusidlogin/:id', express.raw({ type: '*/*' }), (request, response) => {
    received.push({ id: request.params.id, body: Buffer.from(request.body) });
    if (request.params.id === 'ff'.repeat(16)) return response.status(404).json({ error: 'gone' });
    response.json({ status: 'ok' });
  });
  app.get('/verus/login-return', createLoginReturnHandler({ walletReturnPath: '/verus/wallet-return' }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const ok = await fetch(`${base}/verus/login-return?challengeId=${CHALLENGE}&${LOGIN_RESPONSE_QUERY_KEY}=${ENCODED}`, { redirect: 'manual' });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/verus/wallet-return?kind=login&ok=1');
    assert.equal(received.length, 1);
    assert.equal(received[0].id, CHALLENGE);
    assert.deepEqual(received[0].body, BYTES);

    const expired = await fetch(`${base}/verus/login-return?challengeId=${'ff'.repeat(16)}&${LOGIN_RESPONSE_QUERY_KEY}=${ENCODED}`, { redirect: 'manual' });
    assert.match(expired.headers.get('location'), /returnError=CHALLENGE_EXPIRED/);

    const bad = await fetch(`${base}/verus/login-return?challengeId=nope`, { redirect: 'manual' });
    assert.match(bad.headers.get('location'), /returnError=INVALID_CHALLENGE_ID/);
    assert.equal(received.length, 2, 'ongeldige query bereikt de POST-route niet');
  } finally {
    server.close();
  }
});

test('parseGenericResponseQuery: één canonieke base64url-waarde onder de gevraagde key', () => {
  const key = 'iAbcKey';
  assert.deepEqual(parseGenericResponseQuery(query([[key, ENCODED]]), key), BYTES);
  assert.throws(() => parseGenericResponseQuery(query([]), key), /encoding/);
  assert.throws(() => parseGenericResponseQuery(query([[key, ENCODED], [key, ENCODED]]), key), /encoding/);
  assert.throws(() => parseGenericResponseQuery(query([[key, 'AR']]), key), /Noncanonical/);
  assert.throws(() => parseGenericResponseQuery(query([[key, 'a+b']]), key), /encoding/);
});
