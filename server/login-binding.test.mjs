import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';

import { LOGIN_SECRET_HEADER, createLoginBinding } from './login-binding.mjs';

const CHALLENGE = 'ab'.repeat(16);

/** Nagebootste verus-connect-routes achter de binding. */
function makeApp(binding) {
  const app = express();
  app.use('/verus', binding.router);
  const fake = express.Router();
  fake.post('/login', (_req, res) => res.json({ challengeId: CHALLENGE, deepLinkRedirect: 'verus://x' }));
  fake.get('/result/:id', (_req, res) => res.json({ status: 'verified', data: { sessionToken: 'tok' } }));
  app.use('/verus', fake);
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('login-binding: alleen de browser met het geheim krijgt de sessie', async () => {
  const binding = createLoginBinding({ createSecret: () => 'geheim-van-deze-browser' });
  await withServer(makeApp(binding), async (base) => {
    const login = await (await fetch(`${base}/verus/login`, { method: 'POST' })).json();
    assert.equal(login.challengeId, CHALLENGE);
    assert.equal(login.loginSecret, 'geheim-van-deze-browser');
    assert.equal(login.deepLinkRedirect, 'verus://x', 'de rest van het antwoord blijft gelijk');

    const zonder = await fetch(`${base}/verus/result/${CHALLENGE}`);
    assert.equal(zonder.status, 403);
    assert.equal((await zonder.json()).code, 'LOGIN_OTHER_BROWSER');

    const fout = await fetch(`${base}/verus/result/${CHALLENGE}`, { headers: { [LOGIN_SECRET_HEADER]: 'gok' } });
    assert.equal(fout.status, 403);

    const goed = await fetch(`${base}/verus/result/${CHALLENGE}`, { headers: { [LOGIN_SECRET_HEADER]: 'geheim-van-deze-browser' } });
    assert.equal(goed.status, 200);
    assert.equal((await goed.json()).data.sessionToken, 'tok');

    const onbekend = await fetch(`${base}/verus/result/${'cd'.repeat(16)}`, { headers: { [LOGIN_SECRET_HEADER]: 'geheim-van-deze-browser' } });
    assert.equal(onbekend.status, 404);
  });
});

test('login-binding: een binding vervalt na de ttl', () => {
  let clock = 1_000;
  const binding = createLoginBinding({ ttlMs: 500, now: () => clock, createSecret: () => 's' });
  // Binding maken zoals de router dat doet, via een nagebootst antwoord.
  const response = { statusCode: 200, json: (body) => body };
  let sent;
  binding.router.stack[0].route.stack[0].handle({}, response, () => { sent = response.json({ challengeId: CHALLENGE }); });
  assert.equal(sent.loginSecret, 's');
  assert.equal(binding.matches(CHALLENGE, 's'), true);
  clock += 501;
  assert.equal(binding.matches(CHALLENGE, 's'), false);
  assert.equal(binding.size(), 0);
});
