#!/usr/bin/env node
/**
 * Client voor de RPC-relay. Gebruikt door Claude vanuit de Linux-omgeving,
 * maar werkt ook op Windows.
 *
 *   node scripts/agent/relay-client.mjs status
 *   node scripts/agent/relay-client.mjs rpc getinfo
 *   node scripts/agent/relay-client.mjs rpc getidentity '["Arcade@"]'
 *   node scripts/agent/relay-client.mjs run npm test
 *   node scripts/agent/relay-client.mjs run node scripts/integration/vrsctest-daily-readiness.mjs --env VERUS_DAILY_UI_ACK=CHECK_VRSCTEST_DAILY_UI_READINESS
 *
 * Schrijft een verzoek, wacht op het antwoord (standaard max 11 minuten) en
 * print het als JSON. Exitcode 0 bij ok, 1 bij fout, 2 bij time-out.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
// Sinds de verhuizing naar C:\dev (nov 2026) staan de notities in `werkmap/` in de repo
// (git negeert die map); daarvoor in de map `Arcade v2` naast de repo.
const RELAY_DIR = process.env.ARCADE_RELAY_DIR
  ?? (fs.existsSync(path.resolve(REPO_ROOT, 'werkmap'))
    ? path.resolve(REPO_ROOT, 'werkmap', '.relay')
    : path.resolve(REPO_ROOT, '..', 'Arcade v2', '.relay'));
const WAIT_MS = Number(process.env.ARCADE_RELAY_WAIT_MS ?? 11 * 60 * 1000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function heartbeat() {
  // De relay schrijft dit bestand elke seconde zonder rename; een lees-actie kan dus
  // een half bestand treffen. Twee pogingen met korte pauze.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(RELAY_DIR, 'heartbeat.json'), 'utf8'));
      const ageMs = Date.now() - Date.parse(hb.time);
      return { ...hb, ageMs, alive: ageMs < 15_000 };
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  return { alive: false };
}

async function send(request) {
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
  const reqDir = path.join(RELAY_DIR, 'requests');
  const resFile = path.join(RELAY_DIR, 'responses', `${id}.json`);
  fs.mkdirSync(reqDir, { recursive: true });
  const tmp = path.join(reqDir, `${id}.json.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ id, ...request }, null, 2));
  fs.renameSync(tmp, path.join(reqDir, `${id}.json`));
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(resFile)) {
      await sleep(200);
      return JSON.parse(fs.readFileSync(resFile, 'utf8'));
    }
    await sleep(500);
  }
  return null;
}

function parseArgs(argv) {
  const env = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env') {
      const [k, ...v] = (argv[++i] ?? '').split('=');
      env[k] = v.join('=');
    } else rest.push(argv[i]);
  }
  return { env, rest };
}

async function main() {
  const [mode, ...argv] = process.argv.slice(2);
  if (mode === 'status' || !mode) {
    const hb = heartbeat();
    console.log(JSON.stringify({ relayDir: RELAY_DIR, ...hb }, null, 2));
    process.exit(hb.alive ? 0 : 1);
  }
  if (!heartbeat().alive) {
    console.error(`Relay draait niet (geen recente heartbeat in ${RELAY_DIR}).`);
    console.error('Start op Windows: node scripts/agent/rpc-relay.mjs');
    process.exit(1);
  }
  let request;
  if (mode === 'rpc') {
    const [method, paramsJson] = argv;
    request = { type: 'rpc', method, params: paramsJson ? JSON.parse(paramsJson) : [] };
  } else if (mode === 'run') {
    const { env, rest } = parseArgs(argv);
    const [cmd, ...args] = rest;
    request = { type: 'run', cmd, args, env };
  } else {
    console.error('Gebruik: relay-client.mjs status | rpc <method> [paramsJson] | run <cmd> [args] [--env K=V]');
    process.exit(1);
  }
  const response = await send(request);
  if (!response) {
    console.error('Time-out: geen antwoord van de relay.');
    process.exit(2);
  }
  console.log(JSON.stringify(response, null, 2));
  process.exit(response.ok ? 0 : 1);
}

main();
