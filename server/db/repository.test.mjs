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
      { version: 3, filename: '003_round_results.sql' },
      { version: 4, filename: '004_round_reveals.sql' },
      { version: 5, filename: '005_attempt_presentation.sql' },
      { version: 6, filename: '006_attempt_signatures.sql' },
      { version: 7, filename: '007_player_publications.sql' },
      { version: 8, filename: '008_attestations.sql' },
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

test('round finalization includes completed and abandoned reservations exactly once', () => {
  const { database, repository } = setup();
  repository.createRound({
    id: 'round-record',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    commitmentHash: 'b'.repeat(64),
    privateDefinition: { answer: 'crane' },
    opensAt: 1_000,
    closesAt: 2_000,
    now: 0,
  });
  repository.openRound({ id: 'round-record', commitmentTxid: 'a'.repeat(64) });
  reserve(repository);
  repository.recordAttemptAction({
    attemptId: 'attempt-1',
    actionId: 'action-1',
    sequence: 1,
    canonicalAction: JSON.stringify({
      type: 'guess',
      payload: { word: 'crane' },
      gameVersion: '1.0.0',
    }),
    actionHash: 'hash-1',
    response: { solved: true, terminal: true },
    terminal: true,
    resultHash: 'result-hash',
    now: 1_500,
  });
  repository.reserveDailyAttempt({
    attemptId: 'attempt-2',
    chainId: 'vrsctest',
    playerIAddress: 'i-player-2',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 1_600,
  });

  const finalized = repository.finalizeRoundResults({
    roundRecordId: 'round-record',
    now: 2_000,
  });
  assert.equal(finalized.created, true);
  assert.equal(finalized.resultSet.leafCount, 2);
  assert.deepEqual(finalized.resultSet.statusCounts, {
    solved: 1,
    unsolved: 0,
    abandoned: 1,
  });
  assert.equal(repository.getRound('round-record').status, 'closed');
  assert.equal(
    database.prepare('SELECT status FROM attempts WHERE id = ?').get('attempt-2').status,
    'abandoned',
  );
  assert.equal(
    repository.finalizeRoundResults({ roundRecordId: 'round-record', now: 3_000 })
      .created,
    false,
  );
  const proof = repository.getResultProof({
    roundRecordId: 'round-record',
    playerIAddress: 'i-player',
  });
  assert.equal(proof.rootSha256, finalized.resultSet.rootSha256);
  database.close();
});

test('round finalization fails before close without changing attempts', () => {
  const { database, repository } = setup();
  repository.createRound({
    id: 'round-record',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    commitmentHash: 'b'.repeat(64),
    opensAt: 1_000,
    closesAt: 2_000,
    now: 0,
  });
  repository.openRound({ id: 'round-record', commitmentTxid: 'a'.repeat(64) });
  reserve(repository);
  assert.throws(
    () => repository.finalizeRoundResults({ roundRecordId: 'round-record', now: 1_999 }),
    (error) => error.code === 'ROUND_NOT_FINALIZABLE',
  );
  assert.equal(
    database.prepare('SELECT status FROM attempts WHERE id = ?').get('attempt-1').status,
    'reserved',
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

test('listRounds geeft de rondes van een chain, nieuwste opening eerst', () => {
  const { database, repository } = setup();
  for (const [id, opensAt] of [['r-oud', 1_000], ['r-nieuw', 5_000], ['r-midden', 3_000]]) {
    repository.createRound({
      id,
      chainId: 'vrsctest',
      gameId: 'word-grid',
      gameVersion: '1.0.0',
      roundId: id,
      commitmentHash: 'b'.repeat(64),
      privateDefinition: null,
      opensAt,
      closesAt: opensAt + 1_000,
      now: 0,
    });
  }
  assert.deepEqual(
    repository.listRounds({ chainId: 'vrsctest' }).map((round) => round.id),
    ['r-nieuw', 'r-midden', 'r-oud'],
  );
  assert.deepEqual(repository.listRounds({ chainId: 'vrsctest', limit: 1 }).map((r) => r.id), ['r-nieuw']);
  assert.deepEqual(repository.listRounds({ chainId: 'vrsc' }), []);
  database.close();
});

test('player_publications: aanmaken, ontvangstbewijs, bevestigen, en nooit stil overschrijven', () => {
  const { database, repository } = setup();
  repository.createRound({
    id: 'round-record', chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', roundId: '2026-07-25',
    commitmentHash: 'b'.repeat(64), privateDefinition: { answer: 'crane' }, opensAt: 1_000, closesAt: 2_000, now: 0,
  });
  repository.openRound({ id: 'round-record', commitmentTxid: 'a'.repeat(64) });
  reserve(repository);
  const base = {
    attemptId: 'attempt-1', contentKey: 'iBPk7CJiyoVSS1enhnJbyKXiqtZGoiNFcx', contentKeyFqn: 'Arcade.VRSCTEST.::arcade.player.result.x',
    recordJson: '{"a":1}', recordSha256: 'c'.repeat(64), requestIdHex: 'd'.repeat(40), requestHex: 'ee', walletUri: 'verus://x',
    responseMode: 'redirect', createdHeight: 100, expiresHeight: 160, now: 5,
  };
  const created = repository.createPlayerPublication(base);
  assert.equal(created.status, 'pending');
  assert.equal(repository.getPlayerPublicationByRequestId('d'.repeat(40)).attemptId, 'attempt-1');
  assert.throws(() => repository.createPlayerPublication(base), (e) => e.code === 'PLAYER_PUBLICATION_EXISTS');

  // Bevestigen zonder ontvangstbewijs kan niet.
  assert.throws(() => repository.markPlayerPublicationPublished({ attemptId: 'attempt-1', publishedTxid: '1'.repeat(64), publishedHeight: 105, now: 6 }), (e) => e.code === 'PLAYER_PUBLICATION_CONFLICT');

  const receipt = repository.markPlayerPublicationReceipt({ attemptId: 'attempt-1', receiptTxid: '1'.repeat(64), now: 6 });
  assert.equal(receipt.created, true);
  assert.equal(receipt.publication.status, 'receipt');
  assert.equal(repository.markPlayerPublicationReceipt({ attemptId: 'attempt-1', receiptTxid: '1'.repeat(64), now: 7 }).created, false, 'zelfde txid is idempotent');
  assert.throws(() => repository.markPlayerPublicationReceipt({ attemptId: 'attempt-1', receiptTxid: '2'.repeat(64), now: 7 }), (e) => e.code === 'PLAYER_PUBLICATION_CONFLICT');
  assert.equal(repository.listPlayerPublicationsAwaitingConfirmation().length, 1);

  const published = repository.markPlayerPublicationPublished({ attemptId: 'attempt-1', publishedTxid: '1'.repeat(64), publishedHeight: 105, now: 8 });
  assert.equal(published.status, 'published');
  assert.equal(published.publishedHeight, 105);
  assert.equal(repository.listPlayerPublicationsAwaitingConfirmation().length, 0);
  // Een gepubliceerd record wordt nooit vervangen door een nieuw verzoek.
  assert.throws(() => repository.createPlayerPublication({ ...base, requestIdHex: 'f'.repeat(40) }), (e) => e.code === 'PLAYER_PUBLICATION_EXISTS');
  // Mismatch alleen vanuit 'receipt'; daarna mag een nieuw verzoek.
  assert.equal(repository.markPlayerPublicationMismatch({ attemptId: 'attempt-1', now: 9 }).status, 'published');
  database.close();
});

test('player_publications: verlopen of mismatch mag vervangen worden', () => {
  const { database, repository } = setup();
  repository.createRound({
    id: 'round-record', chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0', roundId: '2026-07-25',
    commitmentHash: 'b'.repeat(64), privateDefinition: null, opensAt: 1_000, closesAt: 2_000, now: 0,
  });
  repository.openRound({ id: 'round-record', commitmentTxid: 'a'.repeat(64) });
  reserve(repository);
  const base = {
    attemptId: 'attempt-1', contentKey: 'iBPk7CJiyoVSS1enhnJbyKXiqtZGoiNFcx', contentKeyFqn: 'fqn', recordJson: '{}',
    recordSha256: 'c'.repeat(64), requestIdHex: 'd'.repeat(40), requestHex: 'ee', walletUri: 'verus://x',
    responseMode: 'redirect', createdHeight: 100, expiresHeight: 160, now: 5,
  };
  repository.createPlayerPublication(base);
  assert.equal(repository.markPlayerPublicationExpired('attempt-1').status, 'expired');
  const second = repository.createPlayerPublication({ ...base, requestIdHex: 'e'.repeat(40) });
  assert.equal(second.requestIdHex, 'e'.repeat(40));
  repository.markPlayerPublicationReceipt({ attemptId: 'attempt-1', receiptTxid: '1'.repeat(64), now: 6 });
  assert.equal(repository.markPlayerPublicationMismatch({ attemptId: 'attempt-1', now: 7 }).status, 'mismatch');
  assert.equal(repository.createPlayerPublication({ ...base, requestIdHex: 'f'.repeat(40) }).status, 'pending');
  database.close();
});
