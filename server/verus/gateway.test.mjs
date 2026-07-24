import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../db/migrate.mjs';
import { ArcadeRepository } from '../db/repository.mjs';
import { VerusGateway } from './gateway.mjs';

const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const IDENTITY_NAME = 'arcade-storage-poc@';
const EXISTING_KEY = 'iFW67nkXn2L9jikSJezK2jRrP3obtBCvM7';
const NEW_KEY = 'iBd1Kqg2cqUeJbSkhgmqkYR2HMdg3U3BT7';
const RAW_TRANSACTION = '00aa11bb';
const TXID = 'a'.repeat(64);

function setup(handler) {
  const database = new DatabaseSync(':memory:');
  migrate(database);
  const repository = new ArcadeRepository(database);
  const calls = [];
  const rpc = {
    async call(method, params = []) {
      calls.push({ method, params });
      return handler(method, params);
    },
  };
  const gateway = new VerusGateway({
    rpc,
    repository,
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
  });
  return { database, repository, calls, gateway };
}

function defaultHandler(method) {
  if (method === 'getinfo') return { testnet: true };
  if (method === 'getidentity') {
    return {
      status: 'active',
      txid: 'b'.repeat(64),
      vout: 0,
      identity: {
        identityaddress: IDENTITY,
        contentmultimap: { [EXISTING_KEY]: ['aa'] },
      },
    };
  }
  if (method === 'updateidentity') return RAW_TRANSACTION;
  if (method === 'decoderawtransaction') return { txid: TXID };
  throw new Error(`Unexpected RPC ${method}`);
}

test('gateway is VRSCTEST-only and rejects invalid VDXF input', async () => {
  assert.throws(
    () =>
      new VerusGateway({
        rpc: {},
        repository: {},
        network: 'vrsc',
        identityName: IDENTITY_NAME,
        identityIAddress: IDENTITY,
      }),
    (error) => error.code === 'NETWORK_NOT_ALLOWED',
  );
  const context = setup(defaultHandler);
  await assert.rejects(
    () =>
      context.gateway.prepareIdentityUpdate({
        journalId: 'journal-1',
        operationType: 'round-commitment',
        operationKey: 'operation-1',
        changes: { invalid: ['aa'] },
        now: 1_000,
      }),
    (error) => error.code === 'INVALID_VDXF_KEY',
  );
  context.database.close();
});

test('prepare merges existing identity content and journals signed transaction', async () => {
  const context = setup(defaultHandler);
  const prepared = await context.gateway.prepareIdentityUpdate({
    journalId: 'journal-1',
    operationType: 'round-commitment',
    operationKey: 'operation-1',
    changes: { [NEW_KEY]: ['bb'] },
    now: 1_000,
  });
  assert.equal(prepared.entry.state, 'signed');
  assert.equal(prepared.entry.txid, TXID);
  const updateCall = context.calls.find((call) => call.method === 'updateidentity');
  assert.deepEqual(updateCall.params[0].contentmultimap, {
    [EXISTING_KEY]: ['aa'],
    [NEW_KEY]: ['bb'],
  });
  assert.equal(updateCall.params[1], true);

  const retry = await context.gateway.prepareIdentityUpdate({
    journalId: 'journal-2',
    operationType: 'round-commitment',
    operationKey: 'operation-1',
    changes: { [NEW_KEY]: ['bb'] },
    now: 2_000,
  });
  assert.equal(retry.created, false);
  assert.equal(
    context.calls.filter((call) => call.method === 'updateidentity').length,
    1,
  );
  context.database.close();
});

test('submission timeout becomes uncertain and later reconciles confirmed', async () => {
  let transactionVisible = false;
  const context = setup((method) => {
    if (['getinfo', 'getidentity', 'updateidentity', 'decoderawtransaction'].includes(method)) {
      return defaultHandler(method);
    }
    if (method === 'sendrawtransaction') {
      const error = new Error('Connection closed after submission');
      error.code = 'RPC_TIMEOUT';
      error.submissionUncertain = true;
      throw error;
    }
    if (method === 'getrawtransaction') {
      if (!transactionVisible) {
        const error = new Error('Not found');
        error.code = -5;
        throw error;
      }
      return { txid: TXID, confirmations: 2 };
    }
    throw new Error(`Unexpected RPC ${method}`);
  });
  await context.gateway.prepareIdentityUpdate({
    journalId: 'journal-1',
    operationType: 'round-commitment',
    operationKey: 'operation-1',
    changes: { [NEW_KEY]: ['bb'] },
    now: 1_000,
  });
  const submission = await context.gateway.submit({
    operationKey: 'operation-1',
    now: 2_000,
  });
  assert.equal(submission.entry.state, 'uncertain');
  assert.equal(
    (
      await context.gateway.reconcile({
        operationKey: 'operation-1',
        now: 3_000,
      })
    ).confirmed,
    false,
  );
  transactionVisible = true;
  const reconciled = await context.gateway.reconcile({
    operationKey: 'operation-1',
    now: 4_000,
  });
  assert.equal(reconciled.confirmed, true);
  assert.equal(reconciled.entry.state, 'confirmed');
  context.database.close();
});
