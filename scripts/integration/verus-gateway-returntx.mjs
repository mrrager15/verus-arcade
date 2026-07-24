import { DatabaseSync } from 'node:sqlite';

import { migrate } from '../../server/db/migrate.mjs';
import { ArcadeRepository } from '../../server/db/repository.mjs';
import { VerusGateway } from '../../server/verus/gateway.mjs';
import { rpc } from '../../server/rpc.mjs';

const ACK = 'TEST_VRSCTEST_GATEWAY_RETURNTX';
const IDENTITY = 'i9ARtCeKDBH84LvevYPoMxtZNxfts3c5SN';
const IDENTITY_NAME = 'arcade-storage-poc@';

if (process.env.VERUS_GATEWAY_TEST_ACK !== ACK) {
  throw new Error(
    `Set VERUS_GATEWAY_TEST_ACK=${ACK} to allow VRSCTEST wallet signing without broadcast`,
  );
}

const before = await rpc('getidentity', [IDENTITY]);
if (before?.status !== 'active' || before.identity?.identityaddress !== IDENTITY) {
  throw new Error('Dedicated VRSCTEST PoC identity is not active');
}
const [existingEntry] = Object.entries(before.identity.contentmultimap ?? {});
if (!existingEntry) {
  throw new Error('PoC identity has no existing content to use for a no-op merge');
}
const [vdxfKey, values] = existingEntry;

const database = new DatabaseSync(':memory:');
try {
  migrate(database);
  const gateway = new VerusGateway({
    rpc: { call: rpc },
    repository: new ArcadeRepository(database),
    network: 'vrsctest',
    identityName: IDENTITY_NAME,
    identityIAddress: IDENTITY,
  });
  const prepared = await gateway.prepareIdentityUpdate({
    journalId: 'vrsctest-gateway-returntx',
    operationType: 'integration-noop-returntx',
    operationKey: 'vrsctest-gateway-returntx',
    changes: { [vdxfKey]: values },
    now: Date.now(),
  });
  const after = await rpc('getidentity', [IDENTITY]);
  if (after.txid !== before.txid || after.vout !== before.vout) {
    throw new Error('Identity anchor changed during a non-broadcast integration test');
  }
  console.log(
    JSON.stringify(
      {
        operation: 'vrsctest-gateway-returntx',
        identity: IDENTITY,
        state: prepared.entry.state,
        signedTransactionBytes: prepared.entry.raw_transaction.length / 2,
        derivedTxid: prepared.entry.txid,
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
