import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from './db/migrate.mjs';
import { ArcadeRepository } from './db/repository.mjs';
import { createHash } from 'node:crypto';

import { roundKeyFromSalt } from '../shared/round-key.mjs';
import { validateCommitment, verifyRoundRevealSync } from '../shared/round-proof.mjs';
import { DailyService } from './daily-service.mjs';
import { publicCommitment, RoundCoordinator } from './round-coordinator.mjs';

const COMMITMENT_KEY = 'iBd1Kqg2cqUeJbSkhgmqkYR2HMdg3U3BT7';
const TXID = 'a'.repeat(64);
const DEFINITION = Object.freeze({
  schemaVersion: 1,
  roundId: 'word-grid:1.0.0:2026-07-26',
  chainId: 'vrsctest',
  gameId: 'word-grid',
  gameVersion: '1.0.0',
  date: '2026-07-26',
  opensAt: '2026-07-26T00:00:00.000Z',
  closesAt: '2026-07-27T00:00:00.000Z',
  puzzleSeed: '11'.repeat(32),
  answer: 'crane',
  salt: '22'.repeat(32),
});

function setup() {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const calls = [];
  let confirmed = false;
  const gateway = {
    async prepareIdentityUpdate(input) {
      calls.push({ method: 'prepare', input });
      return {
        created: true,
        entry: { state: 'signed', txid: TXID, operation_key: input.operationKey },
      };
    },
    async submit(input) {
      calls.push({ method: 'submit', input });
      return { submitted: true, entry: { state: 'submitted', txid: TXID } };
    },
    async reconcile(input) {
      calls.push({ method: 'reconcile', input });
      return {
        confirmed,
        entry: { state: confirmed ? 'confirmed' : 'submitted', txid: TXID },
      };
    },
  };
  const coordinator = new RoundCoordinator({
    repository,
    gateway,
    commitmentVdxfKey: COMMITMENT_KEY,
    clock: () => 1_000,
  });
  return {
    database,
    repository,
    coordinator,
    calls,
    setConfirmed(value) {
      confirmed = value;
    },
  };
}

test('prepare stores hidden definition and sends only canonical commitment', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({
    hiddenDefinition: DEFINITION,
  });
  assert.equal(
    prepared.commitment.hiddenDefinitionSha256,
    'cf4115c05d4b7ae456c94db1aa62a80eccf8bf60eb43753a09698dea949c454f',
  );
  const round = context.repository.getRound(DEFINITION.roundId);
  assert.equal(round.status, 'commit_pending');
  assert.deepEqual(
    context.repository.getRoundPrivateDefinition(DEFINITION.roundId),
    DEFINITION,
  );
  const [encoded] =
    context.calls[0].input.changes[COMMITMENT_KEY];
  const publicCommitment = JSON.parse(Buffer.from(encoded, 'hex').toString('utf8'));
  assert.equal(publicCommitment.answer, undefined);
  assert.equal(publicCommitment.salt, undefined);
  assert.equal(
    publicCommitment.hiddenDefinitionSha256,
    prepared.commitment.hiddenDefinitionSha256,
  );
  context.database.close();
});

test('prepare publiceert schema 1 byte voor byte zoals altijd (standaard)', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({ hiddenDefinition: DEFINITION });
  const [encoded] = context.calls[0].input.changes[COMMITMENT_KEY];
  // Met de hand uitgeschreven: canonieke JSON, sleutels gesorteerd, geen adres.
  assert.equal(
    Buffer.from(encoded, 'hex').toString('utf8'),
    '{"chainId":"vrsctest","closesAt":"2026-07-27T00:00:00.000Z","date":"2026-07-26","gameId":"word-grid","gameVersion":"1.0.0",'
      + '"hiddenDefinitionSha256":"cf4115c05d4b7ae456c94db1aa62a80eccf8bf60eb43753a09698dea949c454f","opensAt":"2026-07-26T00:00:00.000Z",'
      + '"roundId":"word-grid:1.0.0:2026-07-26","schemaVersion":1}',
  );
  assert.equal(prepared.commitment.schemaVersion, 1);
  assert.equal('roundEncryptionAddress' in prepared.commitment, false);
  assert.equal(context.repository.getRound(DEFINITION.roundId).commitment_schema, 1);
  context.database.close();
});

test('prepare met versleuteladres (fase 5): commitment-schema 2, adres uit de salt', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({ hiddenDefinition: DEFINITION, withEncryptionAddress: true });
  const [encoded] = context.calls[0].input.changes[COMMITMENT_KEY];
  const published = JSON.parse(Buffer.from(encoded, 'hex').toString('utf8'));
  assert.deepEqual(published, prepared.commitment);
  assert.equal(published.schemaVersion, 2);
  assert.equal(published.roundEncryptionAddress, roundKeyFromSalt(DEFINITION.salt).address);
  assert.equal(published.hiddenDefinitionSha256, 'cf4115c05d4b7ae456c94db1aa62a80eccf8bf60eb43753a09698dea949c454f', 'de definitie en haar hash veranderen niet');
  assert.equal(published.salt, undefined);
  validateCommitment(published);
  assert.equal(context.repository.getRound(DEFINITION.roundId).commitment_schema, 2);
  // Na de reveal klopt het geheel: zelfde hash, en het adres hoort bij de onthulde salt.
  const reveal = { schemaVersion: 1, hiddenDefinition: DEFINITION, commitmentTxid: TXID };
  assert.deepEqual(verifyRoundRevealSync({ commitment: published, reveal }, (text) => createHash('sha256').update(text, 'utf8').digest('hex')), {
    valid: true, recomputedSha256: published.hiddenDefinitionSha256, reason: null,
  });
  // Dezelfde ronde nog eens voorbereiden met een ander schema is een conflict, geen stille wissel.
  await assert.rejects(context.coordinator.prepare({ hiddenDefinition: DEFINITION }), (error) => error.code === 'ROUND_DEFINITION_CONFLICT');
  assert.deepEqual(publicCommitment({ definition: DEFINITION, hiddenDefinitionSha256: published.hiddenDefinitionSha256, schema: 2 }), published);
  assert.throws(() => publicCommitment({ definition: DEFINITION, hiddenDefinitionSha256: published.hiddenDefinitionSha256, schema: 3 }), /schema/);
  context.database.close();
});

test('bewijs-API toont de commitment zoals ze gepubliceerd is (schema 1 of 2)', async () => {
  const plain = setup();
  await plain.coordinator.prepare({ hiddenDefinition: DEFINITION });
  const proof1 = new DailyService({ repository: plain.repository }).getRoundProof({ roundId: DEFINITION.roundId });
  assert.equal(proof1.commitment.schemaVersion, 1);
  assert.equal('roundEncryptionAddress' in proof1.commitment, false);
  plain.database.close();

  const sealed = setup();
  const prepared = await sealed.coordinator.prepare({ hiddenDefinition: DEFINITION, withEncryptionAddress: true });
  const proof2 = new DailyService({ repository: sealed.repository }).getRoundProof({ roundId: DEFINITION.roundId });
  const { transaction, ...commitment } = proof2.commitment;
  assert.deepEqual(commitment, prepared.commitment, 'zelfde velden als wat op de chain staat');
  assert.deepEqual(transaction, { status: 'pending', txid: null });
  sealed.database.close();
});

test('round opens only after journaled transaction confirmation', async () => {
  const context = setup();
  const prepared = await context.coordinator.prepare({
    hiddenDefinition: DEFINITION,
  });
  await context.coordinator.submit({ operationKey: prepared.operationKey });
  const pending = await context.coordinator.reconcile({
    recordId: prepared.recordId,
    operationKey: prepared.operationKey,
  });
  assert.equal(pending.confirmed, false);
  assert.equal(pending.round.status, 'commit_pending');

  context.setConfirmed(true);
  const confirmed = await context.coordinator.reconcile({
    recordId: prepared.recordId,
    operationKey: prepared.operationKey,
  });
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.round.status, 'open');
  assert.equal(confirmed.round.commitment_txid, TXID);
  context.database.close();
});

test('repeated preparation preserves an identical private definition', async () => {
  const context = setup();
  const first = await context.coordinator.prepare({
    hiddenDefinition: DEFINITION,
  });
  const second = await context.coordinator.prepare({
    hiddenDefinition: DEFINITION,
  });

  assert.equal(first.commitment.hiddenDefinitionSha256, second.commitment.hiddenDefinitionSha256);
  assert.deepEqual(
    context.repository.getRoundPrivateDefinition(DEFINITION.roundId),
    DEFINITION,
  );
  assert.equal(
    context.database.prepare('SELECT COUNT(*) count FROM rounds').get().count,
    1,
  );
  context.database.close();
});

test('repeated preparation rejects a changed private definition', async () => {
  const context = setup();
  await context.coordinator.prepare({ hiddenDefinition: DEFINITION });

  await assert.rejects(
    () =>
      context.coordinator.prepare({
        hiddenDefinition: { ...DEFINITION, answer: 'stare' },
      }),
    (error) => error.code === 'ROUND_DEFINITION_CONFLICT',
  );
  assert.deepEqual(
    context.repository.getRoundPrivateDefinition(DEFINITION.roundId),
    DEFINITION,
  );
  context.database.close();
});

test('round preparation rejects mainnet and unknown schema fields', async () => {
  const context = setup();
  await assert.rejects(
    () =>
      context.coordinator.prepare({
        hiddenDefinition: { ...DEFINITION, chainId: 'vrsc' },
      }),
    /VRSCTEST only/,
  );
  await assert.rejects(
    () =>
      context.coordinator.prepare({
        hiddenDefinition: { ...DEFINITION, extra: true },
      }),
    /schema version 1/,
  );
  assert.equal(
    context.database.prepare('SELECT COUNT(*) count FROM rounds').get().count,
    0,
  );
  context.database.close();
});
