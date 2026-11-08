/**
 * Operator-CLI voor Daily-rondes op VRSCTEST.
 *
 *   node scripts/operator/round-lifecycle.mjs list
 *   node scripts/operator/round-lifecycle.mjs inspect <ronde-id>
 *
 *   Nieuwe ronde (ronde-rotatie), drie gescheiden stappen:
 *   node scripts/operator/round-lifecycle.mjs round-create [--date JJJJ-MM-DD] [--opens-at ISO] [--closes-at ISO]
 *   node scripts/operator/round-lifecycle.mjs round-submit <ronde-id>
 *   node scripts/operator/round-lifecycle.mjs round-open   <ronde-id>
 *
 *   Afsluiten en publiceren (ongewijzigd t.o.v. v1):
 *   finalize | results-prepare | results-submit | results-reconcile |
 *   reveal-prepare | reveal-submit | reveal-reconcile  <ronde-id>
 *
 * Elke muterende actie vereist VERUS_OPERATOR_ACK met de exacte waarde uit
 * `acknowledgements` hieronder. Tekenen, uitzenden en bevestigen blijven
 * bewust gescheiden stappen (zie docs/OPERATOR_RUNBOOK.md).
 *
 * De operator-ID is `Arcade@` op VRSCTEST; te overschrijven met
 * VERUS_OPERATOR_IDENTITY_NAME en VERUS_OPERATOR_IDENTITY_I_ADDRESS.
 */
import path from 'node:path';

import {
  createDailyHiddenDefinition,
  dailyRoundSchedule,
  parseRoundCreateOptions,
} from '../../server/daily-round-schedule.mjs';
import { ResultCoordinator } from '../../server/result-coordinator.mjs';
import { RevealCoordinator } from '../../server/reveal-coordinator.mjs';
import { RoundCoordinator } from '../../server/round-coordinator.mjs';
import { createRuntimeServices } from '../../server/runtime-services.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';

const IDENTITY_NAME = process.env.VERUS_OPERATOR_IDENTITY_NAME ?? 'Arcade@';
const IDENTITY_I_ADDRESS =
  process.env.VERUS_OPERATOR_IDENTITY_I_ADDRESS ??
  'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';
// VDXF-keys v1 (zie Arcade v2/STATUS.md, "Vaste gegevens").
const COMMITMENT_VDXF_KEY = 'i5m7tdxizT2PWqLakjjdwsnMAoUqFQXEj7';
const RESULTS_VDXF_KEY = 'iEuNeBozij6ZkEYeDaz7w5BCYAU5r714cA';
const REVEAL_VDXF_KEY = 'iCbAUhPCoibgTsmRe8WbJGJTDFmk7mQQuj';

const [action, ...rest] = process.argv.slice(2);

const acknowledgements = {
  'round-create': 'CREATE_VRSCTEST_ROUND',
  'round-submit': 'SUBMIT_VRSCTEST_ROUND',
  'round-open': 'OPEN_VRSCTEST_ROUND',
  finalize: 'FINALIZE_VRSCTEST_ROUND',
  'results-prepare': 'PREPARE_VRSCTEST_RESULTS_RETURNTX',
  'results-submit': 'SUBMIT_VRSCTEST_RESULTS',
  'results-reconcile': 'RECONCILE_VRSCTEST_RESULTS',
  'reveal-prepare': 'PREPARE_VRSCTEST_REVEAL_RETURNTX',
  'reveal-submit': 'SUBMIT_VRSCTEST_REVEAL',
  'reveal-reconcile': 'RECONCILE_VRSCTEST_REVEAL',
};
const readOnly = ['list', 'inspect'];
const withoutRoundId = ['list', 'round-create'];
const supported = [...readOnly, ...Object.keys(acknowledgements)];

function usage() {
  return [
    'Gebruik:',
    '  node scripts/operator/round-lifecycle.mjs list',
    '  node scripts/operator/round-lifecycle.mjs round-create [--date JJJJ-MM-DD] [--opens-at ISO] [--closes-at ISO]',
    `  node scripts/operator/round-lifecycle.mjs ${supported.filter((a) => !withoutRoundId.includes(a)).join('|')} <ronde-id>`,
  ].join('\n');
}

if (!supported.includes(action)) throw new Error(usage());
const roundRecordId = withoutRoundId.includes(action) ? null : rest[0];
if (!withoutRoundId.includes(action) && !roundRecordId) throw new Error(usage());
if (!readOnly.includes(action) && process.env.VERUS_OPERATOR_ACK !== acknowledgements[action]) {
  throw new Error(`Zet VERUS_OPERATOR_ACK=${acknowledgements[action]} voor ${action}`);
}

const databasePath =
  process.env.ARCADE_DATABASE_PATH ?? path.resolve('server', 'data', 'arcade.sqlite');
const services = createRuntimeServices({ databasePath });

function journalSummary(entry) {
  return entry ? { state: entry.state, txid: entry.txid, error: entry.error_code ?? null } : null;
}

function roundSummary(round) {
  return {
    roundId: round.id,
    status: round.status,
    opensAt: new Date(Number(round.opens_at_ms)).toISOString(),
    closesAt: new Date(Number(round.closes_at_ms)).toISOString(),
    commitmentTxid: round.commitment_txid,
  };
}

try {
  const { repository } = services;
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY_I_ADDRESS,
    minimumConfirmations: 1,
  });
  const commitmentOperationKey = (id) => `vrsctest:${id}:commitment:v1`;

  if (action === 'list') {
    const rounds = repository.listRounds({ chainId: 'vrsctest' });
    console.log(
      JSON.stringify(
        {
          operation: 'round-operator-list',
          databasePath,
          identity: { name: IDENTITY_NAME, iAddress: IDENTITY_I_ADDRESS },
          rounds: rounds.map((round) => ({
            ...roundSummary(round),
            commitmentJournal: journalSummary(
              repository.getChainOperation(commitmentOperationKey(round.id)),
            ),
          })),
        },
        null,
        2,
      ),
    );
  } else if (action === 'round-create') {
    // Stap 1 van 3: ronde in de database + getekende (niet uitgezonden) commitment.
    const options = parseRoundCreateOptions(rest);
    const schedule = dailyRoundSchedule(options);
    const coordinator = new RoundCoordinator({
      repository,
      gateway,
      commitmentVdxfKey: COMMITMENT_VDXF_KEY,
    });
    const recordId = `word-grid:1.0.0:${schedule.date}`;
    const existing = repository.getRound(recordId);
    let outcome;
    if (existing) {
      // Herhaald aanroepen is veilig: de bestaande ronde en haar journaal blijven staan.
      const journal = repository.getChainOperation(commitmentOperationKey(recordId));
      if (!journal || journal.state === 'failed') {
        throw new Error(
          `Ronde ${recordId} bestaat al maar haar commitment is niet getekend (journaal: ${journal?.state ?? 'ontbreekt'}). ` +
            'Kies een andere datum (--date) of verwijder de ronde uit de database.',
        );
      }
      outcome = {
        created: false,
        note:
          existing.status === 'open'
            ? 'Ronde bestond al en is open; niets veranderd.'
            : 'Ronde bestond al; niets veranderd. Ga verder met round-submit of round-open.',
      };
    } else {
      const hiddenDefinition = createDailyHiddenDefinition({ schedule });
      const prepared = await coordinator.prepare({ hiddenDefinition });
      outcome = { created: true, commitment: prepared.commitment };
    }
    const round = repository.getRound(recordId);
    console.log(
      JSON.stringify(
        {
          operation: 'round-operator-round-create',
          databasePath,
          identity: { name: IDENTITY_NAME, iAddress: IDENTITY_I_ADDRESS },
          ...outcome,
          round: roundSummary(round),
          commitmentJournal: journalSummary(
            repository.getChainOperation(commitmentOperationKey(recordId)),
          ),
          hiddenDefinitionPresent: repository.getRoundPrivateDefinition(recordId) !== null,
          nextStep: `node scripts/operator/round-lifecycle.mjs round-submit ${recordId}`,
        },
        null,
        2,
      ),
    );
  } else {
    const round = repository.getRound(roundRecordId);
    if (!round) throw new Error('Ronde bestaat niet');
    if (round.chain_id !== 'vrsctest') {
      throw new Error('Operator lifecycle is enabled for VRSCTEST only');
    }
    const rounds = new RoundCoordinator({
      repository,
      gateway,
      commitmentVdxfKey: COMMITMENT_VDXF_KEY,
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
    const operationKey = commitmentOperationKey(round.id);
    const resultsOperationKey = `vrsctest:${round.round_id}:results:v1`;
    const revealOperationKey = `vrsctest:${round.round_id}:reveal:v1`;
    let stepResult = null;

    if (action === 'round-submit') {
      // Stap 2 van 3: de getekende commitment uitzenden.
      stepResult = await rounds.submit({ operationKey });
    } else if (action === 'round-open') {
      // Stap 3 van 3: bevestiging controleren; bij 1+ bevestiging gaat de ronde open.
      stepResult = await rounds.reconcile({ recordId: round.id, operationKey });
    } else if (action === 'finalize') {
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
    const nextStep =
      action === 'round-submit' && stepResult?.submitted
        ? `node scripts/operator/round-lifecycle.mjs round-open ${roundRecordId} (herhaal tot roundStatus "open")`
        : action === 'round-open' && !stepResult?.confirmed
          ? 'Nog niet bevestigd; herhaal round-open over ongeveer een minuut'
          : null;
    console.log(
      JSON.stringify(
        {
          operation: `round-operator-${action}`,
          databasePath,
          identity: { name: IDENTITY_NAME, iAddress: IDENTITY_I_ADDRESS },
          roundId: roundRecordId,
          roundStatus: currentRound.status,
          opensAt: new Date(Number(currentRound.opens_at_ms)).toISOString(),
          closesAt: new Date(Number(currentRound.closes_at_ms)).toISOString(),
          commitment: {
            sha256: currentRound.commitment_hash,
            txid: currentRound.commitment_txid,
            journal: journalSummary(repository.getChainOperation(operationKey)),
          },
          resultSet: resultSet
            ? {
                leafCount: resultSet.leafCount,
                rootSha256: resultSet.rootSha256,
                bundleSha256: resultSet.bundleSha256,
                transaction: resultSet.resultsTxid,
              }
            : null,
          resultsJournal: journalSummary(repository.getChainOperation(resultsOperationKey)),
          reveal: publicReveal ? { confirmed: true, txid: publicReveal.revealTxid } : null,
          revealJournal: journalSummary(repository.getChainOperation(revealOperationKey)),
          hiddenDefinitionPresent: repository.getRoundPrivateDefinition(roundRecordId) !== null,
          ...(nextStep ? { nextStep } : {}),
        },
        null,
        2,
      ),
    );
  }
} finally {
  services.close();
}
