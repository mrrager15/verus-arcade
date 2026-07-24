import assert from 'node:assert/strict';
import test from 'node:test';

import { SessionStore, createSessionToken } from './session-store.mjs';

const USER = Object.freeze({
  iAddress: 'iPlayerAddress',
  friendlyName: 'player@',
  chain: 'vrsctest',
});

test('registers and resolves an opaque session before expiry', () => {
  let now = 1_000;
  const store = new SessionStore({ ttlSeconds: 60, clock: () => now });
  const token = createSessionToken();
  store.register(token, USER);
  assert.deepEqual(store.resolve(token)?.user, USER);
  assert.equal(store.size, 1);
  now += 59_999;
  assert.ok(store.resolve(token));
});

test('expires sessions and removes them from memory', () => {
  let now = 1_000;
  const store = new SessionStore({ ttlSeconds: 60, clock: () => now });
  const token = createSessionToken();
  store.register(token, USER);
  now += 60_000;
  assert.equal(store.resolve(token), null);
  assert.equal(store.size, 0);
});

test('revocation is immediate and idempotent', () => {
  const store = new SessionStore({ ttlSeconds: 60 });
  const token = createSessionToken();
  store.register(token, USER);
  assert.equal(store.revoke(token), true);
  assert.equal(store.revoke(token), false);
  assert.equal(store.resolve(token), null);
});

test('rejects malformed tokens and sessions without chain binding', () => {
  const store = new SessionStore({ ttlSeconds: 60 });
  assert.throws(() => store.register('short', USER), /invalid format/);
  assert.throws(
    () =>
      store.register(createSessionToken(), {
        iAddress: USER.iAddress,
      }),
    /iAddress and chain/,
  );
  assert.equal(store.resolve(''), null);
});

test('generated tokens are high-entropy and URL-safe', () => {
  const first = createSessionToken();
  const second = createSessionToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});
