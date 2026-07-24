/**
 * Minimal JSON-RPC client for the local vrsctest daemon.
 * Credentials are read from the daemon's own conf file — nothing to configure.
 */
import fs from 'node:fs';
import { loadConfig } from './config.mjs';
import { VerusRpcClient } from './verus/rpc-client.mjs';

const runtime = loadConfig();
const CONF_PATH = runtime.confPath;

function parseConf(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  return out;
}

const conf = parseConf(CONF_PATH);
const client = new VerusRpcClient({
  url: `http://${conf.rpchost ?? '127.0.0.1'}:${conf.rpcport}`,
  username: conf.rpcuser,
  password: conf.rpcpassword,
});

export async function rpc(method, params = []) {
  return client.call(method, params);
}
