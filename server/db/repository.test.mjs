import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './migrate.mjs';
import { ArcadeRepository, RepositoryConflictError } from './repository.mjs';

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
    [
      { version: 1, filename: '001_initial.sql' },
      { version: 2, filename: '002_round_private_definition.sql' },
    ],
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

function reserve(repository) {
  return repository.reserveDailyAttempt({
    attemptId: 'attempt-1',
    chainId: 'vrsctest',
    playerIAddress: 'i-player',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 1_000,
  });
}

test('actions are sequential and exact retries replay the stored response', () => {
  const { database, repository } = setup();
  reserve(repository);
  const input = {
    attemptId: 'attempt-1',
    actionId: 'action-1',
    sequence: 1,
    canonicalAction: '{"guess":"crane"}',
    actionHash: 'hash-1',
    response: { pattern: ['x', 'x', 'y', 'x', 'g'] },
    now: 2_000,
  };
  assert.equal(repository.recordAttemptAction(input).replayed, false);
  assert.deepEqual(repository.recordAttemptAction(input), {
    replayed: true,
    response: input.response,
  });
  assert.equal(
    database.prepare('SELECT status FROM attempts WHERE id = ?').get('attempt-1')
      .status,
    'active',
  );
  database.close();
});

test('action ID, sequence conflicts, and gaps fail closed', () => {
  const { database, repository } = setup();
  reserve(repository);
  repository.recordAttemptAction({
    attemptId: 'attempt-1',
    actionId: 'action-1',
    sequence: 1,
    canonicalAction: '{"guess":"crane"}',
    actionHash: 'hash-1',
    response: { accepted: true },
    now: 2_000,
  });
  assert.throws(
    () =>
      repository.recordAttemptAction({
        attemptId: 'attempt-1',
        actionId: 'action-1',
        sequence: 1,
        canonicalAction: '{"guess":"slate"}',
        actionHash: 'hash-2',
        response: {},
        now: 3_000,
      }),
    (error) =>
      error instanceof RepositoryConflictError &&
      error.code === 'ACTION_ID_CONFLICT',
  );
  assert.throws(
    () =>
      repository.recordAttemptAction({
        attemptId: 'attempt-1',
        actionId: 'action-2',
        sequence: 1,
        canonicalAction: '{"guess":"crane"}',
        actionHash: 'hash-1',
        response: {},
        now: 3_000,
      }),
    (error) => error.code === 'ACTION_SEQUENCE_CONFLICT',
  );
  assert.throws(
    () =>
      repository.recordAttemptAction({
        attemptId: 'attempt-1',
        actionId: 'action-3',
        sequence: 3,
        canonicalAction: '{"guess":"slate"}',
        actionHash: 'hash-2',
        response: {},
        now: 3_000,
      }),
    (error) => error.code === 'ACTION_SEQUENCE_OUT_OF_ORDER',
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) count FROM attempt_actions').get().count,
    1,
  );
  database.close();
});

test('chain operation planning is idempotent and rejects key reuse', () => {
  const { database, repository } = setup();
  const intent = {
    id: 'journal-1',
    operationType: 'round-commitment',
    operationKey: 'vrsctest:word-grid:2026-07-25:commit',
    chainId: 'vrsctest',
    identityIAddress: 'i-operator',
    payloadHash: 'payload-hash-1',
    now: 1_000,
  };
  assert.equal(repository.planChainOperation(intent).created, true);
  assert.equal(
    repository.planChainOperation({ ...intent, id: 'journal-2' }).created,
    false,
  );
  assert.throws(
    () =>
      repository.planChainOperation({
        ...intent,
        id: 'journal-3',
        payloadHash: 'different-payload',
      }),
    (error) => error.code === 'CHAIN_OPERATION_CONFLICT',
  );
  database.close();
});

test('journal reconciles an uncertain submission through explicit transitions', () => {
  const { database, repository } = setup();
  const operationKey = 'vrsctest:word-grid:2026-07-25:commit';
  repository.planChainOperation({
    id: 'journal-1',
    operationType: 'round-commitment',
    operationKey,
    chainId: 'vrsctest',
    identityIAddress: 'i-operator',
    payloadHash: 'payload-hash-1',
    now: 1_000,
  });
  repository.transitionChainOperation({
    operationKey,
    expectedState: 'planned',
    nextState: 'signed',
    rawTransaction: 'raw-transaction',
    now: 2_000,
  });
  repository.transitionChainOperation({
    operationKey,
    expectedState: 'signed',
    nextState: 'uncertain',
    txid: 'a'.repeat(64),
    errorCode: 'RPC_TIMEOUT',
    now: 3_000,
  });
  const confirmed = repository.transitionChainOperation({
    operationKey,
    expectedState: 'uncertain',
    nextState: 'confirmed',
    txid: 'a'.repeat(64),
    now: 4_000,
  });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.error_code, null);
  assert.throws(
    () =>
      repository.transitionChainOperation({
        operationKey,
        expectedState: 'uncertain',
        nextState: 'confirmed',
        now: 5_000,
      }),
    (error) => error.code === 'CHAIN_OPERATION_STATE_CONFLICT',
  );
  database.close();
});
