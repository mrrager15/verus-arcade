import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { RevealCoordinator } from './reveal-coordinator.mjs';
import { hiddenDefinitionHash, verifyRoundReveal } from './round-proof.mjs';

const REVEAL_KEY = 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj';
const TXID = 'c'.repeat(64);
const definition = Object.freeze({
  schemaVersion: 1,
  roundId: 'word-grid:1.0.0:2026-07-27',
  chainId: 'vrsctest',
  gameId: 'word-grid',
  gameVersion: '1.0.0',
  date: '2026-07-27',
  opensAt: '2026-07-27T00:00:00.000Z',
  closesAt: '2026-07-28T00:00:00.000Z',
  puzzleSeed: '11'.repeat(32),
  answer: 'crane',
  salt: '22'.repeat(32),
});

function setup({ resultsConfirmed = true } = {}) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  repository.createRound({
    id: definition.roundId,
    chainId: definition.chainId,
    gameId: definition.gameId,
    gameVersion: definition.gameVersion,
    roundId: definition.roundId,
    commitmentHash: hiddenDefinitionHash(definition),
    privateDefinition: definition,
    opensAt: Date.parse(definition.opensAt),
    closesAt: Date.parse(definition.closesAt),
    now: 0,
  });
  repository.openRound({ id: definition.roundId, commitmentTxid: 'a'.repeat(64) });
  repository.finalizeRoundResults({
    roundRecordId: definition.roundId,
    now: Date.parse(definition.closesAt),
  });
  if (resultsConfirmed) {
    repository.confirmRoundResults({
      roundRecordId: definition.roundId,
      resultsTxid: 'b'.repeat(64),
    });
  }
  let confirmed = false;
  const calls = [];
  const gateway = {
    async prepareIdentityUpdate(input) {
      calls.push(input);
      return { entry: { state: 'signed', txid: TXID } };
    },
    async submit() {
      return { submitted: true, entry: { state: 'submitted', txid: TXID } };
    },
    async reconcile() {
      return {
        confirmed,
        entry: { state: confirmed ? 'confirmed' : 'submitted', txid: TXID },
      };
    },
  };
  return {
    database,
    repository,
    calls,
    coordinator: new RevealCoordinator({
      repository,
      gateway,
      revealVdxfKey: REVEAL_KEY,
      clock: () => Date.parse(definition.closesAt) + 1,
    }),
    confirm() {
      confirmed = true;
    },
  };
}

test('reveal preparation is independently verifiable and stays private in storage', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({
    roundRecordId: definition.roundId,
  });
  const encoded = context.calls[0].changes[REVEAL_KEY][0];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'hex').toString('utf8')), prepared.reveal);
  assert.equal(
    verifyRoundReveal({
      commitment: {
        schemaVersion: 1,
        roundId: definition.roundId,
        chainId: definition.chainId,
        gameId: definition.gameId,
        gameVersion: definition.gameVersion,
        date: definition.date,
        opensAt: definition.opensAt,
        closesAt: definition.closesAt,
        hiddenDefinitionSha256: hiddenDefinitionHash(definition),
      },
      reveal: prepared.reveal,
    }),
    true,
  );
  assert.equal(context.repository.getRoundReveal(definition.roundId), null);
  context.database.close();
});

test('public reveal appears only after transaction confirmation', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({
    roundRecordId: definition.roundId,
  });
  const pending = await context.coordinator.reconcile({
    roundRecordId: definition.roundId,
    operationKey: prepared.operationKey,
  });
  assert.equal(pending.reveal, null);
  context.confirm();
  const confirmed = await context.coordinator.reconcile({
    roundRecordId: definition.roundId,
    operationKey: prepared.operationKey,
  });
  assert.equal(confirmed.reveal.revealTxid, TXID);
  assert.equal(context.repository.getRound(definition.roundId).status, 'revealed');
  context.database.close();
});

test('reveal cannot be prepared before the results identity update is confirmed', async () => {
  const context = setup({ resultsConfirmed: false });
  await assert.rejects(
    () =>
      context.coordinator.prepare({
        roundRecordId: definition.roundId,
      }),
    /results publication/,
  );
  assert.equal(context.calls.length, 0);
  context.database.close();
});
