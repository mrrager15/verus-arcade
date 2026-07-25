import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';
import { RevealCoordinator } from '../../server/reveal-coordinator.mjs';
import { hiddenDefinitionHash, verifyRoundReveal } from '../../server/round-proof.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';

const ACK = 'PREPARE_VRSCTEST_REVEAL_RETURNTX';
const IDENTITY_NAME = 'arcade-storage-poc@';
const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const REVEAL_VDXF_KEY = 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj';

if (process.env.VERUS_REVEAL_TEST_ACK !== ACK) {
  throw new Error(
    `Set VERUS_REVEAL_TEST_ACK=${ACK} to prepare a VRSCTEST reveal without broadcast`,
  );
}

const definition = {
  schemaVersion: 1,
  roundId: 'word-grid:1.0.0:reveal-returntx-fixture',
  chainId: 'vrsctest',
  gameId: 'word-grid',
  gameVersion: '1.0.0',
  date: '2026-07-23',
  opensAt: '2026-07-23T00:00:00.000Z',
  closesAt: '2026-07-24T00:00:00.000Z',
  puzzleSeed: '11'.repeat(32),
  answer: 'crane',
  salt: '22'.repeat(32),
};
const commitmentHash = hiddenDefinitionHash(definition);
const before = await rpc('getidentity', [IDENTITY]);
const database = new DatabaseSync(':memory:');
try {
  migrate(database);
  const repository = new ArcadeRepository(database);
  repository.createRound({
    id: definition.roundId,
    chainId: definition.chainId,
    gameId: definition.gameId,
    gameVersion: definition.gameVersion,
    roundId: definition.roundId,
    commitmentHash,
    privateDefinition: definition,
    opensAt: Date.parse(definition.opensAt),
    closesAt: Date.parse(definition.closesAt),
    now: Date.parse(definition.opensAt) - 1,
  });
  repository.openRound({
    id: definition.roundId,
    commitmentTxid: 'a'.repeat(64),
  });
  repository.finalizeRoundResults({
    roundRecordId: definition.roundId,
    now: Date.parse(definition.closesAt),
  });
  repository.confirmRoundResults({
    roundRecordId: definition.roundId,
    resultsTxid: 'b'.repeat(64),
  });
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
  });
  const coordinator = new RevealCoordinator({
    repository,
    gateway,
    revealVdxfKey: REVEAL_VDXF_KEY,
  });
  const prepared = await coordinator.prepare({ roundRecordId: definition.roundId });
  const after = await rpc('getidentity', [IDENTITY]);
  if (after.txid !== before.txid || after.vout !== before.vout) {
    throw new Error('Identity anchor changed during non-broadcast reveal preparation');
  }
  const independentlyVerified = verifyRoundReveal({
    commitment: {
      schemaVersion: 1,
      roundId: definition.roundId,
      chainId: definition.chainId,
      gameId: definition.gameId,
      gameVersion: definition.gameVersion,
      date: definition.date,
      opensAt: definition.opensAt,
      closesAt: definition.closesAt,
      hiddenDefinitionSha256: commitmentHash,
    },
    reveal: prepared.reveal,
  });
  if (!independentlyVerified) {
    throw new Error('Prepared reveal did not reproduce its commitment');
  }
  console.log(
    JSON.stringify(
      {
        operation: 'round-reveal-returntx',
        network: 'vrsctest',
        identity: IDENTITY,
        vdxfKey: REVEAL_VDXF_KEY,
        hiddenDefinitionSha256: commitmentHash,
        independentlyVerified,
        publicRevealBeforeConfirmation:
          repository.getRoundReveal(definition.roundId) !== null,
        journalState: prepared.journal.state,
        signedTransactionBytes: prepared.journal.raw_transaction.length / 2,
        derivedTxid: prepared.journal.txid,
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
