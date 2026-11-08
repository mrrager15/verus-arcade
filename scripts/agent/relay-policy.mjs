/**
 * Whitelist-beleid van de relay, los van I/O zodat het unit-testbaar is.
 * rpc-relay.mjs importeert dit; relay-policy.test.mjs test het.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Lezen en lokaal tekenen/ontsleutelen. Niets dat een transactie uitzendt. */
export const RPC_ALLOWED = new Set([
  'getinfo', 'getblockcount', 'getblock', 'getblockhash', 'getbestblockhash',
  'getrawtransaction', 'decoderawtransaction', 'getrawmempool',
  'getidentity', 'getidentitycontent', 'getidentityhistory', 'getidentitieswithaddress',
  'listidentities', 'getvdxfid',
  'getcurrency', 'listcurrencies', 'getcurrencystate', 'estimateconversion',
  'verifysignature', 'verifyhash', 'verifymessage', 'getsignatureinfo',
  'signdata', 'decryptdata', 'signmessage', 'signhash',
  'getbalance', 'listunspent', 'getaddressutxos', 'z_listaddresses', 'z_getbalance',
  'z_exportviewingkey', 'z_getnewaddress', 'getnewaddress',
  'z_getoperationstatus',
]);

/** Expliciet verboden, ook al zou iemand ze toevoegen: deze zenden uit of verplaatsen geld. */
export const RPC_FORBIDDEN = new Set([
  'sendrawtransaction', 'sendcurrency', 'sendtoaddress', 'sendmany', 'z_sendmany',
  'updateidentity', 'registeridentity', 'registernamecommitment', 'revokeidentity', 'recoveridentity',
  'definecurrency', 'makeoffer', 'takeoffer', 'closeoffers',
  'dumpprivkey', 'z_exportkey', 'z_exportwallet', 'dumpwallet', 'importprivkey', 'z_importkey',
  'z_getoperationresult', 'stop',
]);

export const RUN_ALLOWED = [
  { cmd: 'npm', args: ['test'] },
  { cmd: 'npm', args: ['run', 'check'] },
  { cmd: 'npm', args: ['run', 'build'] },
  { cmd: 'npm', args: ['run', 'test:storage-poc'] },
  { cmd: 'npm', args: ['install'] },
  { cmd: 'npm', args: ['ci'] },
];
export const SCRIPT_DIRS = ['scripts/integration', 'scripts/operator', 'scripts/storage-poc', 'scripts/agent'];
export const ENV_ALLOWED = /^(VERUS_[A-Z0-9_]+_ACK|ARCADE_[A-Z0-9_]+|NODE_ENV)$/;

export function checkRpc(method, params) {
  if (typeof method !== 'string') throw new Error('method moet een string zijn');
  if (RPC_FORBIDDEN.has(method)) throw new Error(`RPC-methode verboden: ${method}`);
  if (!RPC_ALLOWED.has(method)) throw new Error(`RPC-methode niet toegestaan: ${method}`);
  if (!Array.isArray(params)) throw new Error('params moet een array zijn');
  if (method === 'z_getoperationstatus' && !(Array.isArray(params[0]) && params[0].length > 0)) {
    throw new Error('z_getoperationstatus vereist een expliciete lijst van opids');
  }
}

/**
 * Vertaalt een run-verzoek naar een uitvoerbaar commando, of gooit.
 * `exists` is injecteerbaar voor tests.
 */
export function resolveRun({ cmd, args = [], env = {} }, { repoRoot, platform = process.platform, exists = fs.existsSync, execPath = process.execPath }) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw new Error('args moet een lijst van strings zijn');
  }
  for (const key of Object.keys(env)) {
    if (!ENV_ALLOWED.test(key) || typeof env[key] !== 'string') {
      throw new Error(`omgevingsvariabele niet toegestaan: ${key}`);
    }
  }
  if (cmd === 'node') {
    const script = args[0] ?? '';
    const normalized = script.replace(/\\/g, '/');
    if (normalized.includes('..')) throw new Error(`script niet toegestaan: ${script}`);
    const inAllowedDir = SCRIPT_DIRS.some((d) => normalized.startsWith(d + '/'));
    const abs = path.resolve(repoRoot, normalized);
    if (!inAllowedDir || !abs.startsWith(repoRoot) || !exists(abs) || !/\.m?js$/.test(abs)) {
      throw new Error(`script niet toegestaan of niet gevonden: ${script}`);
    }
    return { cmd: execPath, args: [abs, ...args.slice(1)], env };
  }
  const match = RUN_ALLOWED.find((r) => r.cmd === cmd && r.args.length === args.length && r.args.every((a, i) => a === args[i]));
  if (!match) throw new Error(`commando niet toegestaan: ${cmd} ${args.join(' ')}`);
  const bin = platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  return { cmd: bin, args, env };
}
