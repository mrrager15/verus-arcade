import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';
import { ResultCoordinator } from '../../server/result-coordinator.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';

const ACK = 'PREPARE_VRSCTEST_RESULT_DESCRIPTOR_RETURNTX';
const IDENTITY_NAME = 'arcade-storage-poc@';
const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const RESULTS_VDXF_KEY = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';

if (process.env.VERUS_RESULT_TEST_ACK !== ACK) {
  throw new Error(
    `Set VERUS_RESULT_TEST_ACK=${ACK} to prepare a VRSCTEST results transaction without broadcast`,
  );
}

const before = await rpc('getidentity', [IDENTITY]);
const database = new DatabaseSync(':memory:');
try {
  migrate(database);
  const repository = new ArcadeRepository(database);
  repository.createRound({
    id: 'result-returntx-fixture',
    chainId: 'vrsctest',
    gameId: 'word-grid',
    gameVersion: '1.0.0',
    roundId: 'word-grid:1.0.0:returntx-fixture',
    commitmentHash: 'b'.repeat(64),
    opensAt: 1_000,
    closesAt: 2_000,
    now: 0,
  });
  repository.openRound({
    id: 'result-returntx-fixture',
    commitmentTxid: 'a'.repeat(64),
  });
  repository.finalizeRoundResults({
    roundRecordId: 'result-returntx-fixture',
    now: 2_000,
  });

  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
  });
  const coordinator = new ResultCoordinator({
    repository,
    gateway,
    resultsVdxfKey: RESULTS_VDXF_KEY,
  });
  const prepared = await coordinator.prepare({
    roundRecordId: 'result-returntx-fixture',
  });
  const after = await rpc('getidentity', [IDENTITY]);
  if (after.txid !== before.txid || after.vout !== before.vout) {
    throw new Error('Identity anchor changed during non-broadcast result preparation');
  }
  console.log(
    JSON.stringify(
      {
        operation: 'result-descriptor-returntx',
        network: 'vrsctest',
        identity: IDENTITY,
        vdxfKey: RESULTS_VDXF_KEY,
        algorithm: prepared.descriptor.algorithm,
        rootSha256: prepared.descriptor.rootSha256,
        bundleSha256: prepared.descriptor.bundleSha256,
        leafCount: prepared.descriptor.leafCount,
        journalState: prepared.journal.state,
        signedTransactionBytes: prepared.journal.raw_transaction.length / 2,
        derivedTxid: prepared.journal.txid,
        bundleIncludedOnChain: false,
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
