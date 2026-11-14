/**
 * Fase 4: build van de losse verifier (`npm run build:verifier`).
 * Eén pagina zonder SvelteKit en zonder server; daarna maakt
 * scripts/build-verifier-inline.mjs er één zelfstandig HTML-bestand van
 * (build-verifier/index.html), dat ook vanaf schijf werkt.
 */
import { execSync } from 'node:child_process';

import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

function commit(): string {
	try {
		return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

export default defineConfig({
	root: 'verifier',
	base: './',
	plugins: [svelte({ preprocess: vitePreprocess(), compilerOptions: { runes: true } })],
	define: {
		'import.meta.env.VITE_VERIFIER_COMMIT': JSON.stringify(commit())
	},
	build: {
		outDir: '../build-verifier',
		emptyOutDir: true,
		assetsInlineLimit: 100_000_000,
		cssCodeSplit: false,
		modulePreload: false,
		rollupOptions: {
			// Eén JS-bestand (Vite 8 / rolldown: `codeSplitting: false`, vroeger `inlineDynamicImports`).
			output: { codeSplitting: false } as Record<string, unknown>
		}
	}
});
