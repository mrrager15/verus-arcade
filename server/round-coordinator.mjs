import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function toHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

export class RoundCoordinator {
  constructor({ repository, gateway, commitmentVdxfKey, clock = () => Date.now() }) {
    this.repository = repository;
    this.gateway = gateway;
    this.commitmentVdxfKey = commitmentVdxfKey;
    this.clock = clock;
  }

  async prepare({ hiddenDefinition }) {
    const required = [
      'schemaVersion',
      'roundId',
      'chainId',
      'gameId',
      'gameVersion',
      'date',
      'opensAt',
      'closesAt',
      'puzzleSeed',
      'answer',
      'salt',
    ];
    if (
      hiddenDefinition?.schemaVersion !== 1 ||
      Object.keys(hiddenDefinition).length !== required.length ||
      required.some((key) => !(key in hiddenDefinition))
    ) {
      throw new Error('Hidden round definition does not match schema version 1');
    }
    if (hiddenDefinition.chainId !== 'vrsctest') {
      throw new Error('Round preparation is enabled for VRSCTEST only');
    }
    const opensAt = Date.parse(hiddenDefinition.opensAt);
    const closesAt = Date.parse(hiddenDefinition.closesAt);
    if (!Number.isFinite(opensAt) || !Number.isFinite(closesAt) || closesAt <= opensAt) {
      throw new Error('Round timestamps are invalid');
    }
    const hiddenDefinitionSha256 = sha256(canonicalJson(hiddenDefinition));
    const commitment = {
      schemaVersion: 1,
      roundId: hiddenDefinition.roundId,
      chainId: hiddenDefinition.chainId,
      gameId: hiddenDefinition.gameId,
      gameVersion: hiddenDefinition.gameVersion,
      date: hiddenDefinition.date,
      opensAt: hiddenDefinition.opensAt,
      closesAt: hiddenDefinition.closesAt,
      hiddenDefinitionSha256,
    };
    const recordId = hiddenDefinition.roundId;
    const operationKey = `${hiddenDefinition.chainId}:${recordId}:commitment:v1`;
    const now = this.clock();
    this.repository.createRound({
      id: recordId,
      chainId: hiddenDefinition.chainId,
      gameId: hiddenDefinition.gameId,
      gameVersion: hiddenDefinition.gameVersion,
      roundId: hiddenDefinition.roundId,
      commitmentHash: hiddenDefinitionSha256,
      privateDefinition: hiddenDefinition,
      opensAt,
      closesAt,
      now,
    });
    const prepared = await this.gateway.prepareIdentityUpdate({
      journalId: crypto.randomUUID(),
      operationType: 'round-commitment',
      operationKey,
      changes: {
        [this.commitmentVdxfKey]: [toHex(canonicalJson(commitment))],
      },
      now,
    });
    return { recordId, operationKey, commitment, journal: prepared.entry };
  }

  async submit({ operationKey }) {
    return this.gateway.submit({ operationKey, now: this.clock() });
  }

  async reconcile({ recordId, operationKey }) {
    const result = await this.gateway.reconcile({
      operationKey,
      now: this.clock(),
    });
    if (result.confirmed) {
      const round = this.repository.getRound(recordId);
      if (round.status === 'commit_pending') {
        this.repository.openRound({
          id: recordId,
          commitmentTxid: result.entry.txid,
        });
      }
    }
    return { ...result, round: this.repository.getRound(recordId) };
  }
}
