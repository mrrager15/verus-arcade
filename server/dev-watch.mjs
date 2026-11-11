/**
 * Dev: start de server en herstart hem vanzelf als Claude code wijzigt of de
 * frontend opnieuw bouwt. Zo hoeft Simon na een fix niets te doen.
 *
 *   npm run server:watch          → server/auth.mjs (echte Daily)
 *   npm run server:watch -- --test → server/test-server.mjs (testrondes)
 *
 * Herstart bij: een gewijzigd `.mjs`-bestand onder server/ (niet server/data, niet
 * tests) of een nieuwe build (`build/handler.js`, na `npm run build`). Met 3 s
 * rust, zodat een build of een reeks bewerkingen eerst klaar is.
 * Waarom: de server laadt pagina-onderdelen pas bij het eerste bezoek; na een
 * nieuwe build zoekt een oude server bestanden die niet meer bestaan (500).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const entry = process.argv.includes('--test') ? 'server/test-server.mjs' : 'server/auth.mjs';
const QUIET_MS = 3000;
let child = null;
let timer = null;
let pending = [];

function start() {
  child = spawn(process.execPath, ['--env-file-if-exists=.env', entry], { stdio: 'inherit' });
  const current = child;
  current.on('exit', (code, signal) => {
    if (child === current) {
      child = null;
      console.log(`[watch] server gestopt (${code ?? signal}); start opnieuw bij de volgende wijziging.`);
    }
  });
}

function scheduleRestart(reason) {
  pending.push(reason);
  clearTimeout(timer);
  timer = setTimeout(() => {
    const reasons = [...new Set(pending)].slice(0, 5).join(', ');
    pending = [];
    console.log(`[watch] gewijzigd: ${reasons} → server herstarten`);
    const old = child;
    child = null;
    if (old) {
      old.once('exit', start);
      old.kill();
    } else {
      start();
    }
  }, QUIET_MS);
}

fs.watch('server', { recursive: true }, (_event, file) => {
  const name = String(file ?? '').replaceAll('\\', '/');
  if (!name.endsWith('.mjs') || name.startsWith('data/') || name.includes('.test.')) return;
  scheduleRestart(path.join('server', name));
});

// build/ wordt bij elke build vervangen; daarom de handler pollen in plaats van de map te volgen.
fs.watchFile('build/handler.js', { interval: 2000 }, (now, before) => {
  if (now.mtimeMs > 0 && now.mtimeMs !== before.mtimeMs) scheduleRestart('build/');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearTimeout(timer);
    if (child) child.kill();
    process.exit(0);
  });
}

console.log(`[watch] ${entry} draait; herstart vanzelf bij wijzigingen in server/ of een nieuwe build.`);
start();
