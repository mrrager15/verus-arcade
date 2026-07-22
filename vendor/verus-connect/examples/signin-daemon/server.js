/**
 * signin-daemon — verus-connect daemon-mode demo.
 *
 * Caller runs this server alongside a local verusd. The middleware signs
 * challenges and verifies wallet responses via daemon RPC. Multi-chain:
 * list every chain whose VerusIDs you want to accept. Your VerusID brand
 * appears in the wallet prompt.
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
const CHAINS = (process.env.CHAINS || 'vrsc').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const DEFAULT_CHAIN = (process.env.DEFAULT_CHAIN || CHAINS[0]).toLowerCase();

if (!SIGNING_IADDRESS || !CALLBACK_URL) {
  console.error('Error: SIGNING_IADDRESS and CALLBACK_URL are required. See .env.example.');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use('/verus', verusAuth({
  mode: 'daemon',
  iAddress: SIGNING_IADDRESS,
  callbackUrl: CALLBACK_URL,
  redirectUrl: REDIRECT_URL,
  chains: CHAINS,
  defaultChain: DEFAULT_CHAIN,
}));

const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`[signin-daemon] listening on http://${HOST}:${PORT}`);
  console.log(`[signin-daemon] signing as ${SIGNING_IADDRESS} (daemon mode)`);
  console.log(`[signin-daemon] callback ${CALLBACK_URL}`);
  console.log(`[signin-daemon] chains ${CHAINS.join(', ')} (default ${DEFAULT_CHAIN})`);
});
