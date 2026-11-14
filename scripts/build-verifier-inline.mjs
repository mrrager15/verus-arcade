#!/usr/bin/env node
/**
 * Fase 4: na `vite build --config vite.verifier.config.ts` het script en de CSS
 * in build-verifier/index.html zetten, zodat het één zelfstandig bestand is:
 * werkt vanaf elke statische host én vanaf schijf (file://), waar losse
 * module-scripts geblokkeerd worden. Gooit als er iets anders dan één JS- en
 * hooguit één CSS-bestand is, zodat een stille splitsing opvalt.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('build-verifier');
const htmlPath = path.join(OUT, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)];
const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
if (scripts.length !== 1 || styles.length > 1) throw new Error(`Expected 1 script and at most 1 stylesheet, found ${scripts.length} and ${styles.length}`);

const read = (ref) => fs.readFileSync(path.join(OUT, ref.replace(/^\.\//, '')), 'utf8');
const js = read(scripts[0][1]).replaceAll('</script', '<\\/script');
html = html.replace(scripts[0][0], () => `<script type="module">${js}</script>`);
if (styles.length === 1) {
  const css = read(styles[0][1]).replaceAll('</style', '<\\/style');
  html = html.replace(styles[0][0], () => `<style>${css}</style>`);
}
fs.writeFileSync(htmlPath, html);

// Wat over is, mag weg: alles staat nu in index.html.
const assets = path.join(OUT, 'assets');
const left = fs.existsSync(assets) ? fs.readdirSync(assets) : [];
if (left.some((f) => !/\.(js|css)$/.test(f))) throw new Error(`Unexpected assets: ${left.join(', ')}`);
fs.rmSync(assets, { recursive: true, force: true });
console.log(`build-verifier/index.html: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, self-contained`);
