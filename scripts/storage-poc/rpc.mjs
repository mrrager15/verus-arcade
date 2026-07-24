import fs from 'node:fs';

const DEFAULT_CONF = `${process.env.APPDATA}\\Komodo\\vrsctest\\vrsctest.conf`;
const CONF_PATH = process.env.STORAGE_POC_CONF ?? DEFAULT_CONF;
const TIMEOUT_MS = Number(process.env.STORAGE_POC_RPC_TIMEOUT_MS ?? 15_000);

function parseConf(path) {
  const parsed = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const separator = value.indexOf('=');
    if (separator < 0) continue;
    parsed[value.slice(0, separator).trim().toLowerCase()] = value
      .slice(separator + 1)
      .trim();
  }
  return parsed;
}

const conf = parseConf(CONF_PATH);
const rpcUrl = `http://${conf.rpchost ?? '127.0.0.1'}:${conf.rpcport}`;
const authorization = `Basic ${Buffer.from(`${conf.rpcuser}:${conf.rpcpassword}`).toString('base64')}`;

export async function rpc(method, params = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: `storage-poc-${method}`,
        method,
        params,
      }),
      signal: controller.signal,
    });

    const body = await response.json();
    if (body.error) {
      const error = new Error(`RPC ${method} failed: ${body.error.message}`);
      error.code = body.error.code;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`RPC ${method} returned HTTP ${response.status}`);
    }
    return body.result;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`RPC ${method} timed out after ${TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function summarizeIdentity(result) {
  const identity = result?.identity ?? result;
  const contentmultimap = identity?.contentmultimap ?? {};
  return {
    name: identity?.name,
    identityaddress: identity?.identityaddress,
    status: result?.status,
    contentmultimapKeyCount: Object.keys(contentmultimap).length,
    contentmultimapValueCount: Object.values(contentmultimap).reduce(
      (total, values) => total + (Array.isArray(values) ? values.length : 0),
      0,
    ),
  };
}
