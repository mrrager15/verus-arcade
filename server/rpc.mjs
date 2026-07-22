/**
 * Minimal JSON-RPC client for the local vrsctest daemon.
 * Credentials are read from the daemon's own conf file — nothing to configure.
 */
import fs from 'node:fs';

const CONF_PATH =
  process.env.ARCADE_CONF ?? `${process.env.APPDATA}\\Komodo\\vrsctest\\vrsctest.conf`;

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
const RPC_URL = `http://${conf.rpchost ?? '127.0.0.1'}:${conf.rpcport}`;
const AUTH = 'Basic ' + Buffer.from(`${conf.rpcuser}:${conf.rpcpassword}`).toString('base64');

export async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'arcade', method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message}`);
  return body.result;
}
