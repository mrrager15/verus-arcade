import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';

function toHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

export class ResultCoordinator {
  constructor({ repository, gateway, resultsVdxfKey, clock = () => Date.now() }) {
    this.repository = repository;
    this.gateway = gateway;
    this.resultsVdxfKey = resultsVdxfKey;
    this.clock = clock;
  }

  async prepare({ roundRecordId }) {
    const round = this.repository.getRound(roundRecordId);
    const resultSet = this.repository.getRoundResultSet(roundRecordId);
    if (!round || round.chain_id !== 'vrsctest') {
      throw new Error('Result preparation is enabled for VRSCTEST rounds only');
    }
    if (round.status !== 'closed' || !resultSet) {
      throw new Error('Round must have an immutable final result set');
    }
    const descriptor = {
      schemaVersion: 1,
      algorithm: resultSet.algorithm,
      roundId: round.round_id,
      chainId: round.chain_id,
      gameId: round.game_id,
      gameVersion: round.game_version,
      leafCount: resultSet.leafCount,
      rootSha256: resultSet.rootSha256,
      bundleSha256: resultSet.bundleSha256,
    };
    const operationKey = `${round.chain_id}:${round.round_id}:results:v1`;
    const prepared = await this.gateway.prepareIdentityUpdate({
      journalId: crypto.randomUUID(),
      operationType: 'round-results',
      operationKey,
      changes: {
        [this.resultsVdxfKey]: [toHex(canonicalJson(descriptor))],
      },
      now: this.clock(),
    });
    return { roundRecordId, operationKey, descriptor, journal: prepared.entry };
  }

  async submit({ operationKey }) {
    return this.gateway.submit({ operationKey, now: this.clock() });
  }

  async reconcile({ roundRecordId, operationKey }) {
    const result = await this.gateway.reconcile({
      operationKey,
      now: this.clock(),
    });
    if (result.confirmed) {
      this.repository.confirmRoundResults({
        roundRecordId,
        resultsTxid: result.entry.txid,
      });
    }
    return {
      ...result,
      resultSet: this.repository.getRoundResultSet(roundRecordId),
    };
  }
}
