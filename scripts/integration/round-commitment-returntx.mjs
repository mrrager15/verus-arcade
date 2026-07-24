import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';
import { RoundCoordinator } from '../../server/round-coordinator.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';
import { ANSWERS } from '../../server/words.mjs';

const ACK = 'PREPARE_VRSCTEST_ROUND_COMMITMENT_RETURNTX';
const IDENTITY_NAME = 'arcade-storage-poc@';
const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const COMMITMENT_VDXF_KEY = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';

if (process.env.VERUS_ROUND_TEST_ACK !== ACK) {
  throw new Error(
    `Set VERUS_ROUND_TEST_ACK=${ACK} to prepare a VRSCTEST round transaction without broadcast`,
  );
}

const before = await rpc('getidentity', [IDENTITY]);
const date = '2026-07-26';
const randomIndex = crypto.randomInt(0, ANSWERS.length);
const hiddenDefinition = {
  schemaVersion: 1,
  roundId: `word-grid:1.0.0:${date}`,
  chainId: 'vrsctest',
  gameId: 'word-grid',
  gameVersion: '1.0.0',
  date,
  opensAt: `${date}T00:00:00.000Z`,
  closesAt: '2026-07-27T00:00:00.000Z',
  puzzleSeed: crypto.randomBytes(32).toString('hex'),
  answer: ANSWERS[randomIndex],
  salt: crypto.randomBytes(32).toString('hex'),
};

const database = new DatabaseSync(':memory:');
try {
  migrate(database);
  const repository = new ArcadeRepository(database);
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
  });
  const coordinator = new RoundCoordinator({
    repository,
    gateway,
    commitmentVdxfKey: COMMITMENT_VDXF_KEY,
  });
  const prepared = await coordinator.prepare({ hiddenDefinition });
  const after = await rpc('getidentity', [IDENTITY]);
  if (after.txid !== before.txid || after.vout !== before.vout) {
    throw new Error('Identity anchor changed during non-broadcast round preparation');
  }
  const serializedCommitment = JSON.stringify(prepared.commitment);
  if (
    serializedCommitment.includes(hiddenDefinition.answer) ||
    serializedCommitment.includes(hiddenDefinition.salt)
  ) {
    throw new Error('Public commitment leaked private round data');
  }
  console.log(
    JSON.stringify(
      {
        operation: 'round-commitment-returntx',
        network: 'vrsctest',
        identity: IDENTITY,
        vdxfKey: COMMITMENT_VDXF_KEY,
        roundId: prepared.recordId,
        hiddenDefinitionSha256:
          prepared.commitment.hiddenDefinitionSha256,
        journalState: prepared.journal.state,
        signedTransactionBytes: prepared.journal.raw_transaction.length / 2,
        derivedTxid: prepared.journal.txid,
        privateFieldsInPublicCommitment: false,
        broadcast: false,
        identityAnchorUnchanged: true,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
