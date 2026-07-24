import { rpc } from './rpc.mjs';

const txid = process.argv[2];
if (!/^[0-9a-f]{64}$/.test(txid ?? '')) {
  throw new Error('Usage: node scripts/storage-poc/tx-status.mjs <64-char-lowercase-txid>');
}

const raw = await rpc('getrawtransaction', [txid, 1]);
let wallet = null;
try {
  wallet = await rpc('gettransaction', [txid]);
} catch {
  // A read-only node or non-wallet transaction may not provide wallet metadata.
}

console.log(
  JSON.stringify(
    {
      txid,
      confirmations: raw.confirmations ?? 0,
      blockhash: raw.blockhash ?? null,
      blocktime: raw.blocktime ?? null,
      serializedBytes: typeof raw.hex === 'string' ? raw.hex.length / 2 : null,
      walletFee: wallet?.fee ?? null,
      walletTime: wallet?.time ?? null,
    },
    null,
    2,
  ),
);
