/**
 * signin-lite — verus-connect lite-mode demo.
 *
 * Caller runs this server. The middleware signs challenges offline with a WIF
 * private key and verifies wallet responses via a public Verus node — no
 * local verusd required. Your VerusID brand appears in the wallet prompt.
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verusAuth } from 'verus-connect/server';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// .env loader (no dotenv dependency)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

const PORT = Number(process.env.PORT || 3030);
const SIGNING_IADDRESS = process.env.SIGNING_IADDRESS;
const CALLBACK_URL = process.env.CALLBACK_URL;
const REDIRECT_URL = process.env.REDIRECT_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const VERIFY_NODE_URL = process.env.VERIFY_NODE_URL || 'https://api.verus.services';

if (!SIGNING_IADDRESS || !CALLBACK_URL || !PRIVATE_KEY) {
  console.error('Error: SIGNING_IADDRESS, CALLBACK_URL, and PRIVATE_KEY are required. See .env.example.');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/verus', verusAuth({
  mode: 'lite',
  iAddress: SIGNING_IADDRESS,
  callbackUrl: CALLBACK_URL,
  redirectUrl: REDIRECT_URL,
  privateKey: PRIVATE_KEY,
  verifyNodeUrl: VERIFY_NODE_URL,
}));

function redactCreds(url) {
  try {
    const u = new URL(url);
    if (u.username) { u.username = 'USER'; u.password = 'PASS'; }
    return u.toString();
  } catch { return url; }
}

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[signin-lite] listening on http://${HOST}:${PORT}`);
  console.log(`[signin-lite] signing as ${SIGNING_IADDRESS} (lite mode)`);
  console.log(`[signin-lite] callback ${CALLBACK_URL}`);
  console.log(`[signin-lite] verifier ${redactCreds(VERIFY_NODE_URL)}`);
});
