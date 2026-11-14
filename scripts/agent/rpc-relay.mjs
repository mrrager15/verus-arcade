#!/usr/bin/env node
/**
 * RPC-relay voor Claude.
 *
 * Doel: Claude werkt in een Linux-omgeving die niet bij de Windows-daemon kan.
 * Deze relay draait op Windows, naast de daemon, en voert verzoeken uit die als
 * JSON-bestand in een gedeelde map verschijnen. Het antwoord gaat als JSON terug.
 *
 *   <relay>/requests/<id>.json   ← Claude schrijft een verzoek
 *   <relay>/responses/<id>.json  → relay schrijft het antwoord
 *   <relay>/log/                 → alle verwerkte verzoeken en relay.log
 *   <relay>/heartbeat.json       → bewijs dat de relay draait (elke seconde)
 *
 * Veiligheidsregels (hard in de code, niet configureerbaar):
 *   - Alleen VRSCTEST. Bij mainnet stopt de relay direct.
 *   - Alleen RPC-methodes uit de whitelist hieronder. Geen updateidentity,
 *     geen sendcurrency, geen sendrawtransaction. Schrijven gaat uitsluitend
 *     via de bestaande journaled scripts in scripts/integration en scripts/operator.
 *   - Alleen repo-commando's uit de whitelist (npm test, npm run check, ...).
 *   - Verzoeken ouder dan 10 minuten worden genegeerd.
 *   - Geen geheimen in de gedeelde map: RPC-credentials komen uit vrsctest.conf.
 *
 * Starten (PowerShell, in de repo-map):
 *   node scripts/agent/rpc-relay.mjs
 * Andere relay-map:
 *   $env:ARCADE_RELAY_DIR = 'C:\pad\naar\.relay'; node scripts/agent/rpc-relay.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../server/config.mjs';
import { VerusRpcClient } from '../../server/verus/rpc-client.mjs';
import { checkRpc, resolveRun as resolveRunPolicy } from './relay-policy.mjs';

// ---------- paden ----------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
// Sinds de verhuizing naar C:\dev (nov 2026) staan de notities in `werkmap/` in de repo
// (git negeert die map); daarvoor in de map `Arcade v2` naast de repo.
const RELAY_DIR = process.env.ARCADE_RELAY_DIR
  ?? (fs.existsSync(path.resolve(REPO_ROOT, 'werkmap'))
    ? path.resolve(REPO_ROOT, 'werkmap', '.relay')
    : path.resolve(REPO_ROOT, '..', 'Arcade v2', '.relay'));
const DIRS = {
  requests: path.join(RELAY_DIR, 'requests'),
  responses: path.join(RELAY_DIR, 'responses'),
  log: path.join(RELAY_DIR, 'log'),
};
const HEARTBEAT = path.join(RELAY_DIR, 'heartbeat.json');
const LOGFILE = path.join(DIRS.log, 'relay.log');

// ---------- beleid (whitelists) staat in relay-policy.mjs ----------

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 200 * 1024;
const REQUEST_TTL_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_MS = 1000;

// ---------- hulpfuncties ----------

function now() { return new Date().toISOString(); }

function log(line) {
  const text = `${now()} ${line}`;
  console.log(text);
  fs.appendFileSync(LOGFILE, text + '\n');
}

function ensureDirs() {
  for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
}

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** Windows (antivirus, sync-clients) kan een bestand kort vergrendelen; daarom tot 5 pogingen. */
function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      sleepSync(200 * attempt);
    }
  }
}

function parseConf(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  return out;
}

function truncate(text) {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return text.slice(0, MAX_OUTPUT_BYTES) + `\n... [afgekapt, ${text.length} bytes totaal]`;
}

// ---------- uitvoeren ----------

async function handleRpc(client, req) {
  const { method, params = [] } = req;
  checkRpc(method, params);
  return client.call(method, params);
}

function resolveRun(req) {
  return resolveRunPolicy(req, { repoRoot: REPO_ROOT });
}

function handleRun(req) {
  const { cmd, args, env } = resolveRun(req);
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    // Geen shell:true (DEP0190): op Windows is npm een .cmd-bestand, dus via cmd.exe
    // met een argumentenlijst; node-scripts draaien direct via process.execPath.
    const viaCmd = process.platform === 'win32' && /\.cmd$/i.test(cmd);
    const child = viaCmd
      ? spawn('cmd.exe', ['/d', '/s', '/c', cmd, ...args], { cwd: REPO_ROOT, env: { ...process.env, ...env }, windowsHide: true })
      : spawn(cmd, args, { cwd: REPO_ROOT, env: { ...process.env, ...env }, windowsHide: true });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        stdout: truncate(stdout),
        stderr: truncate(stderr),
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, error: String(error), stdout, stderr });
    });
  });
}

async function processRequest(client, file) {
  const id = path.basename(file, '.json');
  const responseFile = path.join(DIRS.responses, `${id}.json`);
  const started = now();
  let req;
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > REQUEST_TTL_MS) throw new Error('verzoek verlopen (ouder dan 10 minuten)');
    if (stat.size > MAX_REQUEST_BYTES) throw new Error('verzoek te groot');
    req = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (req.id && req.id !== id) throw new Error('id in bestand komt niet overeen met bestandsnaam');

    let result;
    if (req.type === 'rpc') {
      log(`rpc  ${id} ${req.method} ${JSON.stringify(req.params ?? []).slice(0, 200)}`);
      result = await handleRpc(client, req);
    } else if (req.type === 'run') {
      log(`run  ${id} ${req.cmd} ${(req.args ?? []).join(' ')}`);
      result = await handleRun(req);
    } else {
      throw new Error(`onbekend type: ${req.type}`);
    }
    writeJsonAtomic(responseFile, { id, ok: true, startedAt: started, finishedAt: now(), request: req, result });
    log(`ok   ${id}`);
  } catch (error) {
    const message = error?.message ?? String(error);
    writeJsonAtomic(responseFile, { id, ok: false, startedAt: started, finishedAt: now(), request: req ?? null, error: message, code: error?.code ?? null });
    log(`fail ${id} ${message}`);
  } finally {
    try { fs.renameSync(file, path.join(DIRS.log, `${id}.request.json`)); } catch { /* al weg */ }
  }
}

// ---------- hoofdlus ----------

async function main() {
  ensureDirs();
  const config = loadConfig();
  if (config.network !== 'vrsctest') {
    console.error('Relay weigert: ARCADE_NETWORK moet vrsctest zijn.');
    process.exit(1);
  }
  const conf = parseConf(config.confPath);
  const client = new VerusRpcClient({
    url: `http://${conf.rpchost ?? '127.0.0.1'}:${conf.rpcport}`,
    username: conf.rpcuser,
    password: conf.rpcpassword,
    timeoutMilliseconds: 60_000,
  });

  const info = await client.call('getinfo');
  if (info.name !== 'VRSCTEST' || info.testnet !== true) {
    console.error(`Relay weigert: daemon is ${info.name}, geen VRSCTEST.`);
    process.exit(1);
  }
  log(`relay gestart · daemon ${info.VRSCversion} · hoogte ${info.blocks} · map ${RELAY_DIR}`);
  console.log('\nRelay draait. Laat dit venster open. Stoppen met Ctrl+C.\n');

  let busy = false;
  let lastInfo = info;
  let lastInfoAt = Date.now();

  // De relay mag nooit stilletjes stoppen: alles wat ontsnapt wordt gelogd.
  process.on('uncaughtException', (error) => log(`UNCAUGHT ${error?.stack ?? error}`));
  process.on('unhandledRejection', (error) => log(`UNHANDLED ${error?.stack ?? error}`));

  setInterval(async () => {
   try {
    if (Date.now() - lastInfoAt > 30_000) {
      try { lastInfo = await client.call('getinfo'); lastInfoAt = Date.now(); } catch { /* laat oude staan */ }
    }
    // Heartbeat: direct schrijven, geen rename. Windows weigert een rename over een
    // bestand dat de client net leest (EPERM); een half geschreven heartbeat is onschuldig.
    try {
      fs.writeFileSync(HEARTBEAT, JSON.stringify({
        time: now(), pid: process.pid, chain: lastInfo.name, height: lastInfo.blocks,
        connections: lastInfo.connections, version: lastInfo.VRSCversion,
      }, null, 2));
    } catch { /* volgende seconde opnieuw */ }
    if (busy) return;
    const files = fs.readdirSync(DIRS.requests).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
      .map((f) => path.join(DIRS.requests, f)).sort();
    if (files.length === 0) return;
    busy = true;
    try { for (const f of files) await processRequest(client, f); }
    finally { busy = false; }
   } catch (error) {
    log(`LOOP-FOUT ${error?.stack ?? error}`);
    busy = false;
   }
  }, POLL_MS);
}

main().catch((error) => {
  console.error('Relay kon niet starten:', error.message);
  console.error('Controleer: draait verusd -chain=vrsctest, en bestaat vrsctest.conf?');
  process.exit(1);
});
