/**
 * Integratietest voor server/verus/requests.mjs tegen de echte VRSCTEST-daemon.
 *
 * Doet alleen leesacties plus, als ARCADE_SERVICE_WIF gezet is, één lokale
 * tekenactie zonder transactie. Zendt niets uit.
 *
 *   VERUS_REQUESTS_ACK=CHECK_VRSCTEST_VERUS_REQUESTS node scripts/integration/verus-requests-readiness.mjs
 *
 * Omgeving: ARCADE_VRSCTEST_CONF (optioneel), VERUS_RPC_URL (optioneel, anders de
 * daemon), ARCADE_SERVICE_ID en ARCADE_SERVICE_WIF (optioneel, voor de zelftest).
 * Laadt .env uit de repo-map als dat bestaat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../server/config.mjs';
import { createVerusRequestsFromEnv, VerusRequestError } from '../../server/verus/requests.mjs';

const ACK = 'CHECK_VRSCTEST_VERUS_REQUESTS';
if (process.env.VERUS_REQUESTS_ACK !== ACK) {
  throw new Error(`Set VERUS_REQUESTS_ACK=${ACK} to run the VRSCTEST requests readiness check`);
}

// .env inlezen zonder extra dependency (alleen KEY=VALUE, geen export/quotes-magie)
const envFile = path.resolve('.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const config = loadConfig();
if (config.network !== 'vrsctest') throw new Error('Only vrsctest');
const confText = process.env.VERUS_RPC_URL ? undefined : fs.readFileSync(config.confPath, 'utf8');
const vr = createVerusRequestsFromEnv({ confText });

const results = {};
const step = async (name, fn) => {
  try {
    results[name] = { ok: true, ...(await fn()) };
  } catch (error) {
    results[name] = { ok: false, code: error instanceof VerusRequestError ? error.code : 'UNEXPECTED', message: error.message };
  }
};

const ARCADE_ID = process.env.ARCADE_SERVICE_ID ?? 'i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp';

await step('tip', async () => ({ height: await vr.tip() }));
await step('loadIdentity(Arcade@, nu)', async () => {
  const height = await vr.tip();
  const s = await vr.loadIdentity({ identityId: ARCADE_ID, signingHeight: height });
  return { name: s.name, primaryAddresses: s.primaryAddresses, minimumSignatures: s.minimumSignatures, currentActive: s.currentActive, revokedAtSigning: s.revokedAtSigning };
});
await step('loadIdentity(Arcade@, hoogte 1158342 = laatste v0-update)', async () => {
  const s = await vr.loadIdentity({ identityId: ARCADE_ID, signingHeight: 1158342 });
  return { historicalBlockheight: s.historical.blockheight, primaryAddresses: s.primaryAddresses };
});
await step('loadIdentity(toekomstige hoogte) moet CHAIN_UNAVAILABLE geven', async () => {
  try { await vr.loadIdentity({ identityId: ARCADE_ID, signingHeight: 4_000_000_000 }); return { ok: false, message: 'geen fout' }; }
  catch (error) { return { code: error.code, expected: error.code === 'CHAIN_UNAVAILABLE' }; }
});
await step('blockTime(1158342)', async () => ({ time: await vr.blockTime(1158342) }));
await step('status (service-WIF)', async () => await vr.status());

const allOk = Object.values(results).every((r) => r.ok !== false && r.expected !== false);
console.log(JSON.stringify({ allOk, results }, null, 2));
process.exit(allOk ? 0 : 1);
