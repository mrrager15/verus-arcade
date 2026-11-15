import crypto from 'node:crypto';

import { canonicalJson } from './canonical-json.mjs';
import { roundKeyFromSalt } from '../shared/round-key.mjs';
import { validateCommitment } from '../shared/round-proof.mjs';
import { hiddenDefinitionHash, validateHiddenDefinition } from './round-proof.mjs';

function toHex(value) {
  return Buffer.from(value, 'utf8').toString('hex');
}

/**
 * De publieke commitment van een ronde, zoals ze op de operator-ID komt.
 * Schema 1: zoals altijd. Schema 2 (fase 5): met `roundEncryptionAddress`, het
 * zs-adres uit de salt van de definitie (shared/round-key.mjs). Ook gebruikt om
 * de commitment van een bestaande ronde opnieuw op te bouwen (bewijs-API).
 */
export function publicCommitment({ definition, hiddenDefinitionSha256, schema = 1 }) {
  if (schema !== 1 && schema !== 2) throw new Error('Commitment schema must be 1 or 2');
  const commitment = {
    schemaVersion: schema,
    roundId: definition.roundId,
    chainId: definition.chainId,
    gameId: definition.gameId,
    gameVersion: definition.gameVersion,
    date: definition.date,
    opensAt: definition.opensAt,
    closesAt: definition.closesAt,
    hiddenDefinitionSha256,
  };
  if (schema === 2) commitment.roundEncryptionAddress = roundKeyFromSalt(definition.salt).address;
  validateCommitment(commitment);
  return commitment;
}

export class RoundCoordinator {
  constructor({ repository, gateway, commitmentVdxfKey, clock = () => Date.now() }) {
    this.repository = repository;
    this.gateway = gateway;
    this.commitmentVdxfKey = commitmentVdxfKey;
    this.clock = clock;
  }

  /**
   * `withEncryptionAddress` (fase 5, standaard uit): publiceer commitment-schema 2,
   * met het adres waarnaar spelers hun actie-bundel versleutelen. Het adres volgt
   * uit de salt van de definitie; na de reveal rekent iedereen dat na. Voorlopig
   * alleen aan voor testrondes: de echte Daily blijft schema 1 tot de lezers
   * (publieke verifier) gemerged zijn.
   */
  async prepare({ hiddenDefinition, withEncryptionAddress = false }) {
    const { opensAt, closesAt } = validateHiddenDefinition(hiddenDefinition);
    if (hiddenDefinition.chainId !== 'vrsctest') {
      throw new Error('Round preparation is enabled for VRSCTEST only');
    }
    const hiddenDefinitionSha256 = hiddenDefinitionHash(hiddenDefinition);
    const commitment = publicCommitment({ definition: hiddenDefinition, hiddenDefinitionSha256, schema: withEncryptionAddress ? 2 : 1 });
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
      commitmentSchema: commitment.schemaVersion,
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
