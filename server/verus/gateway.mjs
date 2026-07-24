import crypto from 'node:crypto';

import { RepositoryConflictError } from '../db/repository.mjs';

export class VerusGatewayError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'VerusGatewayError';
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function validateVdxfChanges(changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    throw new VerusGatewayError('INVALID_CHANGES', 'VDXF changes must be an object');
  }
  for (const [key, values] of Object.entries(changes)) {
    if (!/^i[1-9A-HJ-NP-Za-km-z]{20,40}$/.test(key)) {
      throw new VerusGatewayError('INVALID_VDXF_KEY', `Invalid VDXF key: ${key}`);
    }
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.some((value) => typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value))
    ) {
      throw new VerusGatewayError(
        'INVALID_VDXF_VALUE',
        `VDXF values for ${key} must be non-empty even-length hex strings`,
      );
    }
  }
}

export class VerusGateway {
  constructor({
    rpc,
    repository,
    network,
    identityName,
    identityIAddress,
    minimumConfirmations = 1,
  }) {
    if (network !== 'vrsctest') {
      throw new VerusGatewayError(
        'NETWORK_NOT_ALLOWED',
        'Verus gateway writes are enabled for VRSCTEST only',
      );
    }
    if (!identityName?.endsWith('@') || !identityIAddress) {
      throw new VerusGatewayError(
        'IDENTITY_REQUIRED',
        'Identity friendly name and i-address are required',
      );
    }
    this.rpc = rpc;
    this.repository = repository;
    this.network = network;
    this.identityName = identityName;
    this.identityIAddress = identityIAddress;
    this.minimumConfirmations = minimumConfirmations;
  }

  async assertVrsctest() {
    const info = await this.rpc.call('getinfo');
    if (info?.testnet !== true) {
      throw new VerusGatewayError(
        'DAEMON_NETWORK_MISMATCH',
        'RPC daemon did not report testnet=true',
      );
    }
    return info;
  }

  async prepareIdentityUpdate({
    journalId,
    operationType,
    operationKey,
    changes,
    now,
  }) {
    validateVdxfChanges(changes);
    await this.assertVrsctest();
    const current = await this.rpc.call('getidentity', [this.identityIAddress]);
    if (current?.status !== 'active') {
      throw new VerusGatewayError('IDENTITY_NOT_ACTIVE', 'Identity is not active');
    }
    if (current.identity?.identityaddress !== this.identityIAddress) {
      throw new VerusGatewayError(
        'IDENTITY_MISMATCH',
        'RPC returned a different identity than requested',
      );
    }

    const contentmultimap = structuredClone(
      current.identity.contentmultimap ?? {},
    );
    for (const [key, values] of Object.entries(changes)) {
      contentmultimap[key] = [...values];
    }
    const intent = {
      identityIAddress: this.identityIAddress,
      baseTxid: current.txid ?? null,
      baseVout: current.vout ?? null,
      contentmultimap,
    };
    const payloadHash = sha256(JSON.stringify(intent));
    const planned = this.repository.planChainOperation({
      id: journalId,
      operationType,
      operationKey,
      chainId: this.network,
      identityIAddress: this.identityIAddress,
      payloadHash,
      now,
    });
    if (!planned.created) {
      return { created: false, entry: planned.entry };
    }

    try {
      const rawTransaction = await this.rpc.call('updateidentity', [
        { name: this.identityName, contentmultimap },
        true,
      ]);
      if (
        typeof rawTransaction !== 'string' ||
        !/^(?:[0-9a-f]{2})+$/i.test(rawTransaction)
      ) {
        throw new VerusGatewayError(
          'INVALID_SIGNED_TRANSACTION',
          'updateidentity returntx did not return transaction hex',
        );
      }
      const decoded = await this.rpc.call('decoderawtransaction', [
        rawTransaction,
      ]);
      const entry = this.repository.transitionChainOperation({
        operationKey,
        expectedState: 'planned',
        nextState: 'signed',
        rawTransaction,
        txid: decoded.txid ?? null,
        now,
      });
      return { created: true, entry };
    } catch (error) {
      if (error instanceof RepositoryConflictError) throw error;
      this.repository.transitionChainOperation({
        operationKey,
        expectedState: 'planned',
        nextState: 'failed',
        errorCode: error.code ?? 'SIGNING_FAILED',
        now,
      });
      throw error;
    }
  }

  async submit({ operationKey, now }) {
    await this.assertVrsctest();
    const entry = this.repository.getChainOperation(operationKey);
    if (!entry) {
      throw new VerusGatewayError(
        'CHAIN_OPERATION_NOT_FOUND',
        'Chain operation does not exist',
      );
    }
    if (entry.state !== 'signed') {
      return { submitted: false, entry };
    }
    try {
      const txid = await this.rpc.call('sendrawtransaction', [
        entry.raw_transaction,
      ]);
      return {
        submitted: true,
        entry: this.repository.transitionChainOperation({
          operationKey,
          expectedState: 'signed',
          nextState: 'submitted',
          txid,
          now,
        }),
      };
    } catch (error) {
      if (error.submissionUncertain !== true) throw error;
      return {
        submitted: false,
        entry: this.repository.transitionChainOperation({
          operationKey,
          expectedState: 'signed',
          nextState: 'uncertain',
          txid: entry.txid,
          errorCode: error.code ?? 'RPC_SUBMISSION_UNCERTAIN',
          now,
        }),
      };
    }
  }

  async reconcile({ operationKey, now }) {
    await this.assertVrsctest();
    const entry = this.repository.getChainOperation(operationKey);
    if (!entry) {
      throw new VerusGatewayError(
        'CHAIN_OPERATION_NOT_FOUND',
        'Chain operation does not exist',
      );
    }
    if (entry.state === 'confirmed') return { confirmed: true, entry };
    if (!['submitted', 'uncertain'].includes(entry.state) || !entry.txid) {
      return { confirmed: false, entry };
    }
    try {
      const transaction = await this.rpc.call('getrawtransaction', [
        entry.txid,
        1,
      ]);
      if ((transaction.confirmations ?? 0) < this.minimumConfirmations) {
        return { confirmed: false, entry };
      }
      return {
        confirmed: true,
        entry: this.repository.transitionChainOperation({
          operationKey,
          expectedState: entry.state,
          nextState: 'confirmed',
          txid: entry.txid,
          now,
        }),
      };
    } catch (error) {
      if (error.code === -5 || error.code === 'TX_NOT_FOUND') {
        return { confirmed: false, entry };
      }
      throw error;
    }
  }
}
