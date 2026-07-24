import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';
import { RoundCoordinator } from '../../server/round-coordinator.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';
import { ANSWERS } from '../../server/words.mjs';

const IDENTITY_NAME = 'arcade-storage-poc@';
const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const COMMITMENT_VDXF_KEY = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const DATE = '2026-07-27';
const RECORD_ID = `word-grid:1.0.0:${DATE}`;
const OPERATION_KEY = `vrsctest:${RECORD_ID}:commitment:v1`;
const action = process.argv[2];

const acknowledgements = {
  prepare: 'PREPARE_DURABLE_VRSCTEST_ROUND',
  submit: 'SUBMIT_DURABLE_VRSCTEST_ROUND',
  reconcile: 'RECONCILE_DURABLE_VRSCTEST_ROUND',
};
if (!(action in acknowledgements)) {
  throw new Error(
    'Usage: node scripts/integration/vrsctest-round-lifecycle.mjs prepare|submit|reconcile',
  );
}
if (process.env.VERUS_ROUND_LIFECYCLE_ACK !== acknowledgements[action]) {
  throw new Error(
    `Set VERUS_ROUND_LIFECYCLE_ACK=${acknowledgements[action]} for ${action}`,
  );
}

const dataDirectory = path.resolve('server', 'data');
fs.mkdirSync(dataDirectory, { recursive: true });
const databasePath = path.join(dataDirectory, 'vrsctest-round-lifecycle.sqlite');
const database = new DatabaseSync(databasePath);

try {
  database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
    minimumConfirmations: 1,
  });
  const coordinator = new RoundCoordinator({
    repository,
    gateway,
    commitmentVdxfKey: COMMITMENT_VDXF_KEY,
  });

  let result;
  if (action === 'prepare') {
    let definition = repository.getRoundPrivateDefinition(RECORD_ID);
    if (!definition) {
      definition = {
        schemaVersion: 1,
        roundId: RECORD_ID,
        chainId: 'vrsctest',
        gameId: 'word-grid',
        gameVersion: '1.0.0',
        date: DATE,
        opensAt: `${DATE}T00:00:00.000Z`,
        closesAt: '2026-07-28T00:00:00.000Z',
        puzzleSeed: crypto.randomBytes(32).toString('hex'),
        answer: ANSWERS[crypto.randomInt(0, ANSWERS.length)],
        salt: crypto.randomBytes(32).toString('hex'),
      };
    }
    result = await coordinator.prepare({ hiddenDefinition: definition });
  } else if (action === 'submit') {
    if (!repository.getRound(RECORD_ID)) {
      throw new Error('Prepare the durable round before submission');
    }
    result = await coordinator.submit({ operationKey: OPERATION_KEY });
  } else {
    if (!repository.getRound(RECORD_ID)) {
      throw new Error('Prepare the durable round before reconciliation');
    }
    result = await coordinator.reconcile({
      recordId: RECORD_ID,
      operationKey: OPERATION_KEY,
    });
  }

  const round = repository.getRound(RECORD_ID);
  const journal = repository.getChainOperation(OPERATION_KEY);
  console.log(
    JSON.stringify(
      {
        operation: `durable-round-${action}`,
        databasePath,
        roundId: RECORD_ID,
        roundStatus: round?.status ?? null,
        commitmentHash: round?.commitment_hash ?? null,
        hiddenDefinitionPersisted:
          repository.getRoundPrivateDefinition(RECORD_ID) !== null,
        journalState: journal?.state ?? null,
        txid: journal?.txid ?? null,
        broadcast:
          action === 'submit' ? result.submitted === true : false,
        confirmed:
          action === 'reconcile' ? result.confirmed === true : false,
      },
      null,
      2,
    ),
  );
} finally {
  database.close();
}
