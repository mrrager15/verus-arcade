import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { DailyService } from './daily-service.mjs';
import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { verifyInclusionProof } from './result-set.mjs';

const PRINCIPAL = Object.freeze({
  chain: 'vrsctest',
  iAddress: 'i-player',
  friendlyName: 'player@',
});

function setup({ now = 2_000 } = {}) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const service = new DailyService({
    repository,
    clock: () => now,
    createId: () => 'attempt-generated',
  });
  return { database, repository, service };
}

function createRound(repository) {
  repository.createRound({
    id: 'round-record-1',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    commitmentHash: 'commitment-hash',
    privateDefinition: { answer: 'crane', salt: 'test-salt' },
    opensAt: 1_000,
    closesAt: 10_000,
    now: 500,
  });
}

test('Daily reservation is blocked until the commitment is confirmed', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  assert.throws(
    () => service.reserveAttempt({ principal: PRINCIPAL, roundId: 'round-record-1' }),
    (error) => error.code === 'ROUND_NOT_OPEN' && error.httpStatus === 409,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
    0,
  );
  database.close();
});

test('confirmed open round reserves once and exact retries resume it', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const first = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  const retry = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(first.attempt.id, retry.attempt.id);
  database.close();
});

test('current round discovery is public-safe and existing-attempt lookup is read-only', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const current = service.getCurrentRound();
  assert.equal(current.id, 'round-record-1');
  assert.equal(current.availability, 'open');
  assert.equal(current.commitment.transaction.status, 'confirmed');
  assert.equal(JSON.stringify(current).includes('crane'), false);
  assert.equal(
    service.getRoundAttempt({ principal: PRINCIPAL, roundId: 'round-record-1' }),
    null,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) count FROM attempts').get().count,
    0,
  );
  const reserved = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  assert.equal(
    service.getRoundAttempt({
      principal: PRINCIPAL,
      roundId: 'round-record-1',
    }).id,
    reserved.attempt.id,
  );
  database.close();
});

test('round time and chain boundaries fail closed', () => {
  const early = setup({ now: 999 });
  createRound(early.repository);
  early.repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  assert.throws(
    () =>
      early.service.reserveAttempt({
        principal: PRINCIPAL,
        roundId: 'round-record-1',
      }),
    (error) => error.code === 'ROUND_NOT_OPEN',
  );
  early.database.close();

  const current = setup();
  createRound(current.repository);
  current.repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  assert.throws(
    () =>
      current.service.reserveAttempt({
        principal: { ...PRINCIPAL, chain: 'vrsc' },
        roundId: 'round-record-1',
      }),
    (error) => error.code === 'ROUND_CHAIN_MISMATCH',
  );
  current.database.close();
});

test('attempt lookup is scoped to the authenticated chain and identity', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const { attempt } = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  assert.equal(
    service.getAttempt({ principal: PRINCIPAL, attemptId: attempt.id }).id,
    attempt.id,
  );
  assert.throws(
    () =>
      service.getAttempt({
        principal: { ...PRINCIPAL, iAddress: 'i-attacker' },
        attemptId: attempt.id,
      }),
    (error) => error.code === 'ATTEMPT_NOT_FOUND',
  );
  database.close();
});

test('server-authoritative action solves, persists, and replays exactly', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const { attempt } = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  const action = {
    actionId: 'action-0001',
    sequence: 1,
    type: 'guess',
    payload: { word: 'CRANE' },
    gameVersion: '1.0.0',
  };
  const first = service.submitAction({
    principal: PRINCIPAL,
    attemptId: attempt.id,
    action,
  });
  const replay = service.submitAction({
    principal: PRINCIPAL,
    attemptId: attempt.id,
    action,
  });
  assert.equal(first.replayed, false);
  assert.equal(first.result.solved, true);
  assert.deepEqual(first.result.pattern, ['g', 'g', 'g', 'g', 'g']);
  assert.equal(first.result.answer, 'crane');
  assert.deepEqual(replay, { replayed: true, result: first.result });
  const stored = repository.getAttemptForPlayer({
    attemptId: attempt.id,
    chainId: PRINCIPAL.chain,
    playerIAddress: PRINCIPAL.iAddress,
  });
  assert.equal(stored.status, 'completed');
  assert.equal(stored.result_hash.length, 64);
  const resumed = service.getAttempt({
    principal: PRINCIPAL,
    attemptId: attempt.id,
  });
  assert.equal(resumed.actions.length, 1);
  assert.equal(resumed.actions[0].word, 'crane');
  assert.equal(resumed.terminalResult.answer, 'crane');
  database.close();
});

test('action validation rejects unknown words and conflicting action reuse', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const { attempt } = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  assert.throws(
    () =>
      service.submitAction({
        principal: PRINCIPAL,
        attemptId: attempt.id,
        action: {
          actionId: 'action-0001',
          sequence: 1,
          type: 'guess',
          payload: { word: 'zzzzz' },
          gameVersion: '1.0.0',
        },
      }),
    (error) => error.code === 'GUESS_NOT_IN_DICTIONARY' && error.httpStatus === 400,
  );
  service.submitAction({
    principal: PRINCIPAL,
    attemptId: attempt.id,
    action: {
      actionId: 'action-0001',
      sequence: 1,
      type: 'guess',
      payload: { word: 'slate' },
      gameVersion: '1.0.0',
    },
  });
  assert.throws(
    () =>
      service.submitAction({
        principal: PRINCIPAL,
        attemptId: attempt.id,
        action: {
          actionId: 'action-0001',
          sequence: 1,
          type: 'guess',
          payload: { word: 'apple' },
          gameVersion: '1.0.0',
        },
      }),
    (error) => error.code === 'ACTION_ID_CONFLICT',
  );
  database.close();
});

test('attempt proof is pending before close and independently valid after finalization', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  const { attempt } = service.reserveAttempt({
    principal: PRINCIPAL,
    roundId: 'round-record-1',
  });
  assert.deepEqual(
    service.getAttemptProof({ principal: PRINCIPAL, attemptId: attempt.id }),
    { status: 'pending', roundId: '2026-07-25' },
  );
  repository.finalizeRoundResults({ roundRecordId: 'round-record-1', now: 10_000 });
  const result = service.getAttemptProof({
    principal: PRINCIPAL,
    attemptId: attempt.id,
  });
  assert.equal(result.status, 'finalized');
  assert.equal(result.descriptor.leafCount, 1);
  assert.equal(result.descriptor.rootSha256, result.proof.rootSha256);
  assert.deepEqual(result.publication, { status: 'pending', txid: null });
  assert.equal(verifyInclusionProof(result.proof), true);
  database.close();
});

test('leaderboard moves from live to finalized and chain-verified with tied ranks', () => {
  const { database, repository, service } = setup();
  createRound(repository);
  repository.openRound({
    id: 'round-record-1',
    commitmentTxid: 'a'.repeat(64),
  });
  repository.reserveDailyAttempt({
    attemptId: 'attempt-a',
    chainId: 'vrsctest',
    playerIAddress: 'i-a',
    friendlyName: 'alice@',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 2_000,
  });
  repository.reserveDailyAttempt({
    attemptId: 'attempt-b',
    chainId: 'vrsctest',
    playerIAddress: 'i-b',
    friendlyName: 'bob@',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: '2026-07-25',
    now: 2_000,
  });
  for (const attemptId of ['attempt-a', 'attempt-b']) {
    repository.recordAttemptAction({
      attemptId,
      actionId: `${attemptId}-action`,
      sequence: 1,
      canonicalAction: JSON.stringify({
        type: 'guess',
        payload: { word: 'crane' },
        gameVersion: '1.0.0',
      }),
      actionHash: `${attemptId}-hash`,
      response: { solved: true, terminal: true, pattern: ['g', 'g', 'g', 'g', 'g'] },
      terminal: true,
      resultHash: `${attemptId}-result`,
      now: 3_000,
    });
  }
  const live = service.getLeaderboard({ roundId: 'round-record-1' });
  assert.equal(live.state, 'live');
  assert.deepEqual(live.entries.map((entry) => entry.rank), [1, 1]);
  assert.deepEqual(
    live.entries.map((entry) => entry.friendlyName),
    ['alice@', 'bob@'],
  );

  repository.finalizeRoundResults({
    roundRecordId: 'round-record-1',
    now: 10_000,
  });
  assert.equal(
    service.getLeaderboard({ roundId: 'round-record-1' }).state,
    'finalized',
  );
  repository.confirmRoundResults({
    roundRecordId: 'round-record-1',
    resultsTxid: 'c'.repeat(64),
  });
  const verified = service.getLeaderboard({ roundId: 'round-record-1' });
  assert.equal(verified.state, 'chain-verified');
  assert.equal(verified.resultRoot.length, 64);
  database.close();
});
