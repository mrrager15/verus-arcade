import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { ResultCoordinator } from './result-coordinator.mjs';

const RESULTS_KEY = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';
const TXID = 'c'.repeat(64);

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  repository.createRound({
    id: 'round-record',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: 'word-grid:1.0.0:2026-07-27',
    commitmentHash: 'b'.repeat(64),
    opensAt: 1_000,
    closesAt: 2_000,
    now: 0,
  });
  repository.openRound({ id: 'round-record', commitmentTxid: 'a'.repeat(64) });
  repository.finalizeRoundResults({ roundRecordId: 'round-record', now: 2_000 });
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
    coordinator: new ResultCoordinator({
      repository,
      gateway,
      resultsVdxfKey: RESULTS_KEY,
      clock: () => 3_000,
    }),
    confirm() {
      confirmed = true;
    },
  };
}

test('result preparation sends only the compact descriptor', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({ roundRecordId: 'round-record' });
  const descriptor = JSON.parse(
    Buffer.from(context.calls[0].changes[RESULTS_KEY][0], 'hex').toString('utf8'),
  );
  assert.deepEqual(descriptor, prepared.descriptor);
  assert.equal(descriptor.leafCount, 0);
  assert.equal(descriptor.rootSha256.length, 64);
  assert.equal(descriptor.bundle, undefined);
  context.database.close();
});

test('result receipt is persisted only after confirmation', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({ roundRecordId: 'round-record' });
  const pending = await context.coordinator.reconcile({
    roundRecordId: 'round-record',
    operationKey: prepared.operationKey,
  });
  assert.equal(pending.resultSet.resultsTxid, null);
  context.confirm();
  const confirmed = await context.coordinator.reconcile({
    roundRecordId: 'round-record',
    operationKey: prepared.operationKey,
  });
  assert.equal(confirmed.resultSet.resultsTxid, TXID);
  context.database.close();
});
