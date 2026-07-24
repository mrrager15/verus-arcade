import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { DailyService } from './daily-service.mjs';
import { createDailyRouter } from './daily-router.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';

const TOKEN = 'a'.repeat(43);
const PRINCIPAL = Object.freeze({
  chain: 'vrsctest',
  iAddress: 'i-player',
  friendlyName: 'player@',
});

async function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const dailyService = new DailyService({
    repository,
    clock: () => 2_000,
    createId: () => 'attempt-generated',
  });
  const app = express();
  app.use(
    '/api/v1',
    createDailyRouter({
      dailyService,
      resolveSession: (token) =>
        token === TOKEN ? { user: PRINCIPAL, expiresAt: 10_000 } : null,
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    database,
    repository,
    server,
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
  };
}

async function close(context) {
  context.database.close();
  context.server.close();
  await once(context.server, 'close');
}

const authorization = { authorization: `Bearer ${TOKEN}` };

test('v1 API rejects missing authentication and exposes chain-bound principal', async () => {
  const context = await setup();
  try {
    const unauthorized = await fetch(`${context.baseUrl}/me`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, 'NOT_AUTHENTICATED');

    const authenticated = await fetch(`${context.baseUrl}/me`, {
      headers: authorization,
    });
    assert.equal(authenticated.status, 200);
    assert.deepEqual((await authenticated.json()).principal, PRINCIPAL);
  } finally {
    await close(context);
  }
});

test('v1 API returns 201 for reservation and 200 for idempotent resume', async () => {
  const context = await setup();
  try {
    context.repository.createRound({
      id: 'round-record-1',
      chainId: 'vrsctest',
      gameId: 'word-grid',
      gameVersion: '1.0.0',
      roundId: '2026-07-25',
      commitmentHash: 'commitment-hash',
      opensAt: 1_000,
      closesAt: 10_000,
      now: 500,
    });
    context.repository.openRound({
      id: 'round-record-1',
      commitmentTxid: 'a'.repeat(64),
    });
    const first = await fetch(
      `${context.baseUrl}/rounds/round-record-1/attempts`,
      { method: 'POST', headers: authorization },
    );
    const retry = await fetch(
      `${context.baseUrl}/rounds/round-record-1/attempts`,
      { method: 'POST', headers: authorization },
    );
    assert.equal(first.status, 201);
    assert.equal(retry.status, 200);
    assert.equal((await first.json()).attempt.id, (await retry.json()).attempt.id);

    const attempt = await fetch(
      `${context.baseUrl}/attempts/attempt-generated`,
      { headers: authorization },
    );
    assert.equal(attempt.status, 200);
    assert.equal((await attempt.json()).attempt.id, 'attempt-generated');
  } finally {
    await close(context);
  }
});

test('v1 API returns stable round-not-open error without creating an attempt', async () => {
  const context = await setup();
  try {
    context.repository.createRound({
      id: 'round-record-1',
      chainId: 'vrsctest',
      gameId: 'word-grid',
      gameVersion: '1.0.0',
      roundId: '2026-07-25',
      commitmentHash: 'commitment-hash',
      opensAt: 1_000,
      closesAt: 10_000,
      now: 500,
    });
    const response = await fetch(
      `${context.baseUrl}/rounds/round-record-1/attempts`,
      { method: 'POST', headers: authorization },
    );
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'ROUND_NOT_OPEN');
    assert.equal(
      context.database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
      0,
    );
  } finally {
    await close(context);
  }
});
