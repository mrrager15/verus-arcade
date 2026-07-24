import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './migrate.mjs';
import { ArcadeRepository } from './repository.mjs';

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  return { database, repository: new ArcadeRepository(database) };
}

test('migrations are ordered and idempotent', () => {
  const { database } = setup();
  migrate(database);
  assert.deepEqual(
    database
      .prepare('SELECT version, filename FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => ({ version: Number(row.version), filename: row.filename })),
    [{ version: 1, filename: '001_initial.sql' }],
  );
  assert.equal(database.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  database.close();
});

test('durable sessions store a hash instead of the bearer token', () => {
  const { database, repository } = setup();
  const token = 'a'.repeat(43);
  repository.createSession({
    token,
    chainId: 'vrsctest',
    iAddress: 'i-player',
    friendlyName: 'player@',
    now: 1_000,
    expiresAt: 61_000,
  });
  const stored = database.prepare('SELECT token_hash FROM sessions').get();
  assert.notEqual(stored.token_hash, token);
  assert.equal(stored.token_hash.length, 64);
  assert.equal(repository.resolveSession(token, 60_999)?.user.iAddress, 'i-player');
  assert.equal(repository.resolveSession(token, 61_000), null);
  assert.equal(repository.revokeSession(token, 2_000), true);
  assert.equal(repository.revokeSession(token, 2_001), false);
  database.close();
});

test('Daily reservation returns the original attempt for duplicate requests', () => {
  const { database, repository } = setup();
  const input = {
    attemptId: 'attempt-1',
    chainId: 'vrsctest',
    playerIAddress: 'i-player',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 1_000,
  };
  const first = repository.reserveDailyAttempt(input);
  const duplicate = repository.reserveDailyAttempt({
    ...input,
    attemptId: 'attempt-2',
    now: 2_000,
  });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.attempt.id, 'attempt-1');
  assert.equal(
    database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
    1,
  );
  database.close();
});

test('the same player can reserve different rounds and game versions', () => {
  const { database, repository } = setup();
  const base = {
    chainId: 'vrsctest',
    playerIAddress: 'i-player',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 1_000,
  };
  assert.equal(
    repository.reserveDailyAttempt({ ...base, attemptId: 'attempt-1' }).created,
    true,
  );
  assert.equal(
    repository.reserveDailyAttempt({
      ...base,
      attemptId: 'attempt-2',
      roundId: '2026-07-26',
    }).created,
    true,
  );
  assert.equal(
    repository.reserveDailyAttempt({
      ...base,
      attemptId: 'attempt-3',
      gameVersion: '2.0.0',
    }).created,
    true,
  );
  database.close();
});
