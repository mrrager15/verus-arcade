/**
 * Alleen lezen: welke hulpmiddelen staan op deze pc (voor de overstap naar Claude Code).
 *   node scripts/agent/tool-check.mjs
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = (cmd) => { try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim(); } catch (e) { return `niet gevonden (${String(e.stderr || e.message).split('\n')[0].slice(0, 120)})`; } };
const home = os.homedir();
console.log(JSON.stringify({
  node: process.version,
  npm: run('npm --version'),
  git: run('git --version'),
  gitBash: fs.existsSync('C:\\Program Files\\Git\\bin\\bash.exe'),
  claudeWhere: run('where claude'),
  claudeLocalBin: fs.existsSync(path.join(home, '.local', 'bin', 'claude.exe')),
  claudeVersion: run('claude --version'),
  winget: run('where winget'),
  cDevExists: fs.existsSync('C:\\dev'),
  cDevEntries: fs.existsSync('C:\\dev') ? fs.readdirSync('C:\\dev') : null,
  repoSizeHint: fs.readdirSync('.').length,
  relayDir: fs.existsSync(path.resolve('werkmap', '.relay')) ? path.resolve('werkmap', '.relay') : 'onbekend',
  gitRemote: run('git remote get-url origin'),
}, null, 2));
