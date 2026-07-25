import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { hiddenDefinitionHash } from './round-proof.mjs';

function toHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

export class RevealCoordinator {
  constructor({ repository, gateway, revealVdxfKey, clock = () => Date.now() }) {
    this.repository = repository;
    this.gateway = gateway;
    this.revealVdxfKey = revealVdxfKey;
    this.clock = clock;
  }

  async prepare({ roundRecordId }) {
    const round = this.repository.getRound(roundRecordId);
    const definition = this.repository.getRoundPrivateDefinition(roundRecordId);
    const resultSet = this.repository.getRoundResultSet(roundRecordId);
    if (!round || round.chain_id !== 'vrsctest') {
      throw new Error('Reveal preparation is enabled for VRSCTEST rounds only');
    }
    if (
      round.status !== 'closed' ||
      !round.commitment_txid ||
      !resultSet?.resultsTxid ||
      !definition ||
      this.clock() < Number(round.closes_at_ms)
    ) {
      throw new Error(
        'Closed round with confirmed commitment and results publication is required',
      );
    }
    if (hiddenDefinitionHash(definition) !== round.commitment_hash) {
      throw new Error('Hidden definition no longer matches the round commitment');
    }
    const reveal = {
      schemaVersion: 1,
      hiddenDefinition: definition,
      commitmentTxid: round.commitment_txid,
    };
    const operationKey = `${round.chain_id}:${round.round_id}:reveal:v1`;
    const prepared = await this.gateway.prepareIdentityUpdate({
      journalId: crypto.randomUUID(),
      operationType: 'round-reveal',
      operationKey,
      changes: { [this.revealVdxfKey]: [toHex(canonicalJson(reveal))] },
      now: this.clock(),
    });
    return { roundRecordId, operationKey, reveal, journal: prepared.entry };
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
      this.repository.confirmRoundReveal({
        roundRecordId,
        revealTxid: result.entry.txid,
        now: this.clock(),
      });
    }
    return { ...result, reveal: this.repository.getRoundReveal(roundRecordId) };
  }
}
