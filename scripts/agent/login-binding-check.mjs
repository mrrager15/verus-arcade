/**
 * Live-controle van A3 (login gebonden aan de browser). Alleen lezen; maakt
 * één login-challenge aan die na 5 minuten vanzelf vervalt.
 *   node scripts/agent/login-binding-check.mjs [origin]   (standaard http://127.0.0.1:8100)
 */
const origin = process.argv[2] ?? 'http://127.0.0.1:8100';
const login = await fetch(`${origin}/verus/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chain: 'vrsctest' }),
});
const body = await login.json();
const result = (headers) => fetch(`${origin}/verus/result/${body.challengeId}`, { headers }).then(async (r) => ({ status: r.status, body: await r.json() }));
const withoutSecret = await result({});
const wrongSecret = await result({ 'x-login-secret': 'gok' });
const withSecret = await result({ 'x-login-secret': body.loginSecret ?? '' });
console.log(JSON.stringify({
  login: { status: login.status, challengeId: body.challengeId, hasSecret: typeof body.loginSecret === 'string', secretLength: body.loginSecret?.length ?? 0, secretInDeeplink: Boolean(body.loginSecret && JSON.stringify(body).replace(body.loginSecret, '').includes(body.loginSecret)) },
  withoutSecret, wrongSecret, withSecret,
}, null, 2));
