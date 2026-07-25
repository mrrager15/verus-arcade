import path from 'node:path';

import { ResultCoordinator } from '../../server/result-coordinator.mjs';
import { RevealCoordinator } from '../../server/reveal-coordinator.mjs';
import { createRuntimeServices } from '../../server/runtime-services.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';

const IDENTITY_NAME = process.env.VERUS_OPERATOR_IDENTITY_NAME ??
  'arcade-storage-poc@';
const IDENTITY_I_ADDRESS = process.env.VERUS_OPERATOR_IDENTITY_I_ADDRESS ??
  'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const RESULTS_VDXF_KEY = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';
const REVEAL_VDXF_KEY = 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj';
const action = process.argv[2];
const roundRecordId = process.argv[3];

const acknowledgements = {
  finalize: 'FINALIZE_VRSCTEST_ROUND',
  'results-prepare': 'PREPARE_VRSCTEST_RESULTS_RETURNTX',
  'results-submit': 'SUBMIT_VRSCTEST_RESULTS',
  'results-reconcile': 'RECONCILE_VRSCTEST_RESULTS',
  'reveal-prepare': 'PREPARE_VRSCTEST_REVEAL_RETURNTX',
  'reveal-submit': 'SUBMIT_VRSCTEST_REVEAL',
  'reveal-reconcile': 'RECONCILE_VRSCTEST_REVEAL',
};
const supported = ['inspect', ...Object.keys(acknowledgements)];
if (!supported.includes(action) || !roundRecordId) {
  throw new Error(
    `Usage: node scripts/operator/round-lifecycle.mjs ${supported.join('|')} <round-record-id>`,
  );
}
if (
  action !== 'inspect' &&
  process.env.VERUS_OPERATOR_ACK !== acknowledgements[action]
) {
  throw new Error(
    `Set VERUS_OPERATOR_ACK=${acknowledgements[action]} for ${action}`,
  );
}

const databasePath =
  process.env.ARCADE_DATABASE_PATH ??
  path.resolve('server', 'data', 'arcade.sqlite');
const services = createRuntimeServices({ databasePath });
try {
  const { repository } = services;
  const round = repository.getRound(roundRecordId);
  if (!round) throw new Error('Round does not exist');
  if (round.chain_id !== 'vrsctest') {
    throw new Error('Operator lifecycle is enabled for VRSCTEST only');
  }
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY_I_ADDRESS,
    minimumConfirmations: 1,
  });
  const results = new ResultCoordinator({
    repository,
    gateway,
    resultsVdxfKey: RESULTS_VDXF_KEY,
  });
  const reveal = new RevealCoordinator({
    repository,
    gateway,
    revealVdxfKey: REVEAL_VDXF_KEY,
  });
  const resultsOperationKey = `vrsctest:${round.round_id}:results:v1`;
  const revealOperationKey = `vrsctest:${round.round_id}:reveal:v1`;

  if (action === 'finalize') {
    repository.finalizeRoundResults({ roundRecordId, now: Date.now() });
  } else if (action === 'results-prepare') {
    await results.prepare({ roundRecordId });
  } else if (action === 'results-submit') {
    await results.submit({ operationKey: resultsOperationKey });
  } else if (action === 'results-reconcile') {
    await results.reconcile({ roundRecordId, operationKey: resultsOperationKey });
  } else if (action === 'reveal-prepare') {
    await reveal.prepare({ roundRecordId });
  } else if (action === 'reveal-submit') {
    await reveal.submit({ operationKey: revealOperationKey });
  } else if (action === 'reveal-reconcile') {
    await reveal.reconcile({ roundRecordId, operationKey: revealOperationKey });
  }

  const currentRound = repository.getRound(roundRecordId);
  const resultSet = repository.getRoundResultSet(roundRecordId);
  const publicReveal = repository.getRoundReveal(roundRecordId);
  const resultJournal = repository.getChainOperation(resultsOperationKey);
  const revealJournal = repository.getChainOperation(revealOperationKey);
  console.log(
    JSON.stringify(
      {
        operation: `round-operator-${action}`,
        databasePath,
        roundId: roundRecordId,
        roundStatus: currentRound.status,
        closesAt: new Date(Number(currentRound.closes_at_ms)).toISOString(),
        resultSet: resultSet
          ? {
              leafCount: resultSet.leafCount,
              rootSha256: resultSet.rootSha256,
              bundleSha256: resultSet.bundleSha256,
              transaction: resultSet.resultsTxid,
            }
          : null,
        resultsJournal: resultJournal
          ? { state: resultJournal.state, txid: resultJournal.txid }
          : null,
        reveal: publicReveal
          ? { confirmed: true, txid: publicReveal.revealTxid }
          : null,
        revealJournal: revealJournal
          ? { state: revealJournal.state, txid: revealJournal.txid }
          : null,
        hiddenDefinitionPresent:
          repository.getRoundPrivateDefinition(roundRecordId) !== null,
      },
      null,
      2,
    ),
  );
} finally {
  services.close();
}
