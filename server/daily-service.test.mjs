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

test('action validation accepts normalized five-letter guesses and rejects conflicting reuse', () => {
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
  service.submitAction({
    principal: PRINCIPAL,
    attemptId: attempt.id,
    action: {
      actionId: 'action-0001',
      sequence: 1,
      type: 'guess',
      payload: { word: 'rates' },
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

// ---- Fase 8: een tweede game via hetzelfde platform --------------------------

const NT_PUZZLE = Object.freeze({ numbers: [100, 25, 3, 7, 7, 1], target: 728, solution: '(100+3)*7+7' });

function createNumberTargetRound(repository) {
  repository.createRound({
    id: 'nt-1',
    chainId: 'vrsctest',
    gameId: 'number-target',
    gameVersion: '1.0.0',
    roundId: 'number-target:1.0.0:2026-11-13',
    commitmentHash: 'commitment-hash',
    privateDefinition: {
      schemaVersion: 2,
      roundId: 'number-target:1.0.0:2026-11-13',
      chainId: 'vrsctest',
      gameId: 'number-target',
      gameVersion: '1.0.0',
      date: '2026-11-13',
      opensAt: new Date(1_000).toISOString(),
      closesAt: new Date(10_000).toISOString(),
      puzzle: NT_PUZZLE,
      salt: 'ab'.repeat(32),
    },
    opensAt: 1_000,
    closesAt: 10_000,
    now: 500,
  });
  repository.openRound({ id: 'nt-1', commitmentTxid: 'b'.repeat(64) });
}

test('fase 8: Number Target speelt via dezelfde service en geeft resultaatschema 3', () => {
  const { database, repository, service } = setup();
  createNumberTargetRound(repository);
  const { attempt } = service.reserveAttempt({ principal: PRINCIPAL, roundId: 'nt-1' });
  const act = (sequence, value, id = `nt-action-${sequence}`) => service.submitAction({
    principal: PRINCIPAL, attemptId: attempt.id,
    action: { actionId: id, sequence, type: 'action', payload: { value }, gameVersion: '1.0.0' },
  });
  // Een zet die de regels weigeren, telt niet als poging.
  assert.throws(() => act(1, '8*100', 'nt-bad-1'), (error) => error.code === 'INVALID_ACTION' && /not one of the numbers/.test(error.message));
  assert.throws(() => act(1, '100/3', 'nt-bad-2'), (error) => error.code === 'INVALID_ACTION');
  const miss = act(1, ' 100 × 7 ');
  assert.deepEqual(miss.result, { feedback: { value: 700, distance: 28, solved: false, actionsUsed: 1, actionsLeft: 4 }, solved: false, actionsUsed: 1, actionsLeft: 4, terminal: false });
  const hit = act(2, '(100+3)*7+7');
  assert.equal(hit.result.solved, true);
  assert.equal(hit.result.terminal, true);
  assert.deepEqual(hit.result.reveal, { solution: '(100+3)*7+7' });
  assert.throws(() => act(3, '100'), (error) => ['ATTEMPT_NOT_ACTIVE', 'MAX_GUESSES_EXCEEDED'].includes(error.code));
  const resumed = service.getAttempt({ principal: PRINCIPAL, attemptId: attempt.id });
  assert.deepEqual(resumed.actions.map((a) => a.value), ['100*7', '(100+3)*7+7']);
  assert.equal(resumed.actions[0].feedback.value, 700);
  assert.equal(resumed.actions[0].word, undefined);

  repository.finalizeRoundResults({ roundRecordId: 'nt-1', now: 10_000 });
  const proof = repository.getResultProof({ roundRecordId: 'nt-1', playerIAddress: PRINCIPAL.iAddress });
  assert.ok(verifyInclusionProof(proof));
  assert.deepEqual(proof.record, {
    schemaVersion: 3,
    roundId: 'number-target:1.0.0:2026-11-13',
    chainId: 'vrsctest',
    gameId: 'number-target',
    gameVersion: '1.0.0',
    playerIAddress: PRINCIPAL.iAddress,
    status: 'solved',
    actions: [{ sequence: 1, value: '100*7' }, { sequence: 2, value: '(100+3)*7+7' }],
    score: { solved: true, actionsUsed: 2 },
    playerSignature: null,
  });
  const board = service.getLeaderboard({ roundId: 'nt-1' });
  assert.equal(board.entries[0].guessesUsed, 2);
  assert.equal(board.entries[0].status, 'solved');
  database.close();
});

test('fase 8: games-lijst en huidige ronde per game, met openbare puzzel', () => {
  const { database, repository, service } = setup({ now: 2_000 });
  assert.deepEqual(service.listGames().map((g) => g.slug), ['number-target', 'word-grid']);
  assert.equal(service.listGames().find((g) => g.slug === 'number-target').maxActions, 5);
  assert.equal(service.getCurrentRound({ gameId: 'number-target' }), null);
  createNumberTargetRound(repository);
  const round = service.getCurrentRound({ gameId: 'number-target' });
  assert.equal(round.roundId, 'number-target:1.0.0:2026-11-13');
  assert.deepEqual(round.puzzle, { numbers: [100, 25, 3, 7, 7, 1], target: 728 });
  assert.ok(!('solution' in round.puzzle), 'de voorbeeldoplossing blijft geheim tot na afloop');
  assert.throws(() => service.getCurrentRound({ gameId: 'chess' }), (error) => error.code === 'GAME_NOT_FOUND' && error.httpStatus === 404);
  createRound(repository);
  repository.openRound({ id: 'round-record-1', commitmentTxid: 'a'.repeat(64) });
  assert.deepEqual(service.getCurrentRound().puzzle, {}, 'Word Grid toont niets van de puzzel');
  database.close();
});
