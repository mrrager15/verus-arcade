#!/usr/bin/env node
/**
 * verus-connect CLI — multi-chain VerusID auth server.
 *
 * Usage:
 *   verus-connect start
 *   verus-connect start --port 8100
 *
 * Config via .env or environment variables:
 *
 *   --- Required ---
 *   SIGNING_IADDRESS    VerusID used to sign challenges (must live on DEFAULT_CHAIN)
 *   CALLBACK_URL        Where wallets POST signed responses
 *
 *   --- Daemon mode (multi-chain) ---
 *   CHAINS              Comma-separated supported chains, e.g. "vrsc,varrr,vdex"
 *                       RPC creds are read from each chain's standard .conf file:
 *                         VRSC      ~/.komodo/VRSC/VRSC.conf
 *                         PBaaS     ~/.verus/pbaas/<hex>/<hex>.conf
 *   DEFAULT_CHAIN       Chain used for challenge issuance when client omits chain
 *                       (e.g. "vrsc"). Must be in CHAINS.
 *   CONF_PATH_<NAME>    Optional override for a chain's conf path
 *                       e.g. CONF_PATH_VRSC=/custom/VRSC.conf
 *
 *   --- Lite mode (single-chain, serverless) ---
 *   PRIVATE_KEY         WIF private key
 *   VERIFY_NODE_URL     Public node for verification
 *   CHAIN               Single chain name for lite mode (default: vrsc)
 *
 *   --- Server ---
 *   PORT                Server port (default: 8100)
 *   HOST                Server host (default: 127.0.0.1)
 *   CORS_ORIGINS        Comma-separated allowed origins (default: *)
 *   DEBUG               1 / true to enable debug logging
 */

import fs from 'fs';
import path from 'path';
import express from 'express';
import { verusAuth } from './middleware.js';
import { KNOWN_CHAINS } from './chain-registry.js';

// Load .env
const envPath = path.join(process.cwd(), '.env');
try {
  const content = fs.readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

const PORT = parseInt(process.env.PORT || '8100', 10);
const HOST = process.env.HOST || '127.0.0.1';
const SIGNING_IADDRESS = process.env.SIGNING_IADDRESS || '';
const CALLBACK_URL = process.env.CALLBACK_URL || process.env.SERVER_URL || '';

// Optional. Where the wallet redirects the user after a successful sign on
// mobile (TYPE_REDIRECT response URI). Defaults to the CALLBACK_URL's origin
// — the site root — which is usually the right landing place. Set explicitly
// (e.g. https://yoursite.com/login/return) if you want a different page.
function defaultRedirectUrl(): string {
  if (process.env.REDIRECT_URL) return process.env.REDIRECT_URL;
  try {
    return new URL(CALLBACK_URL).origin + '/';
  } catch {
    return '';
  }
}
const REDIRECT_URL = defaultRedirectUrl();

/**
 * Default CORS behaviour: lock to the callback URL's origin so a fresh
 * `verusAuth(...)` mount only accepts requests from the integrator's own
 * site — never accidentally becomes a signing oracle for random websites
 * under the operator's identity. Override by setting CORS_ORIGINS to a
 * specific list (preferred) or `*` (with full understanding that you're
 * delegating your VerusID's wallet-prompt branding to anyone who reaches
 * the endpoint).
 */
function defaultCorsOrigins(): string {
  if (process.env.CORS_ORIGINS) return process.env.CORS_ORIGINS;
  try {
    return new URL(CALLBACK_URL).origin;
  } catch {
    return '*';
  }
}
const CORS_ORIGINS = defaultCorsOrigins();

if (!SIGNING_IADDRESS) {
  console.error('Error: SIGNING_IADDRESS is required');
  process.exit(1);
}
if (!CALLBACK_URL) {
  console.error('Error: CALLBACK_URL is required');
  process.exit(1);
}

// Parse CHAINS and per-chain conf overrides
const chainsList = (process.env.CHAINS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const confPathOverrides: Record<string, string> = {};
for (const name of Object.keys(KNOWN_CHAINS)) {
  const envKey = `CONF_PATH_${name.toUpperCase()}`;
  if (process.env[envKey]) confPathOverrides[name] = process.env[envKey] as string;
}

// Per-chain verify-node URLs for multi-chain lite mode. Keyed by chain name.
// Falls back to VERIFY_NODE_URL (or its legacy alias API) for the VRSC entry.
const verifyNodeUrls: Record<string, string> = {};
for (const name of Object.keys(KNOWN_CHAINS)) {
  const envKey = `VERIFY_NODE_URL_${name.toUpperCase()}`;
  if (process.env[envKey]) verifyNodeUrls[name] = process.env[envKey] as string;
}

// Mode: explicit MODE wins; otherwise PRIVATE_KEY => lite, else daemon.
const isLite = (process.env.MODE === 'lite') || (!process.env.MODE && !!process.env.PRIVATE_KEY);
const isMultiChain = chainsList.length > 0;
const defaultChain = (process.env.DEFAULT_CHAIN || chainsList[0] || 'vrsc').toLowerCase();

if (!isLite && !isMultiChain) {
  console.error('Error: daemon mode requires CHAINS=... (comma-separated chain names)');
  process.exit(1);
}
if (isMultiChain && !chainsList.includes(defaultChain)) {
  console.error(`Error: DEFAULT_CHAIN=${defaultChain} must be one of CHAINS=${chainsList.join(',')}`);
  process.exit(1);
}

const app = express();

// CORS
const allowedOrigins = CORS_ORIGINS === '*' ? null : CORS_ORIGINS.split(',').map(s => s.trim());
app.use((req: any, res: any, next: any) => {
  const origin = req.headers.origin;
  if (!allowedOrigins || (origin && allowedOrigins.includes(origin))) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Mount auth middleware
app.use('/', verusAuth({
  mode: (process.env.MODE as any) || (isLite ? 'lite' : 'daemon'),
  iAddress: SIGNING_IADDRESS,
  callbackUrl: CALLBACK_URL,
  redirectUrl: REDIRECT_URL || undefined,
  chains: isMultiChain ? chainsList : undefined,
  defaultChain: isMultiChain ? defaultChain : undefined,
  confPathOverrides: (!isLite && isMultiChain) ? confPathOverrides : undefined,
  apiUrl: process.env.API_URL,
  privateKey: process.env.PRIVATE_KEY,
  // VERIFY_NODE_URL is the modern name. `API` is the legacy alias used by
  // earlier deployments (e.g. the rugpull and cryptoworld lite-mode
  // sidecars) — kept so a fresh dist can drop onto an old .env without
  // changing the env.
  verifyNodeUrl: process.env.VERIFY_NODE_URL || process.env.API,
  // For multi-chain lite, per-chain verify URLs override the single one.
  verifyNodeUrls: Object.keys(verifyNodeUrls).length ? verifyNodeUrls : undefined,
  ...(process.env.CHAIN ? { chain: process.env.CHAIN } as any : {}),
  debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
}));

app.listen(PORT, HOST, () => {
  const mode = isLite ? 'lite' : 'daemon';
  console.log(`verus-connect v4 listening on http://${HOST}:${PORT}`);
  console.log(`  Mode: ${mode}`);
  console.log(`  Signing ID: ${SIGNING_IADDRESS}`);
  console.log(`  Callback: ${CALLBACK_URL}`);
  if (isMultiChain) {
    console.log(`  Chains: ${chainsList.join(', ')}  (default: ${defaultChain})`);
  }
  console.log(`  CORS:  ${CORS_ORIGINS}`);
  if (CORS_ORIGINS === '*') {
    console.warn('  ⚠ CORS is set to `*` — any origin can call this server and trigger wallet');
    console.warn('    prompts under your signing identity. Prefer an explicit allow-list.');
  }
  console.log(`  Endpoints:`);
  console.log(`    GET  /chains             List supported chains + health`);
  console.log(`    POST /login              Create login challenge (body: { chain? })`);
  console.log(`    POST /verusidlogin       Wallet callback (auto)`);
  console.log(`    GET  /result/:id         Poll challenge status`);
  console.log(`    POST /pay-deeplink       Generate payment deep link`);
  console.log(`    POST /generic-request    Create generic request`);
  console.log(`    POST /identity-update-request  Create identity update request`);
  console.log(`    GET  /health             Health check`);
});
