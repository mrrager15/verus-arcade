/**
 * Fase 4: welke VRSCTEST-RPC de onafhankelijke verifier gebruikt. Standaard de
 * publieke node; een eigen keuze wordt per browser onthouden (localStorage, in
 * try/catch: in een privévenster kan opslag ontbreken), maar alleen als die RPC
 * echt VRSCTEST antwoordde.
 */
import { DEFAULT_RPC_URL } from '../../shared/chain-reader.mjs';

export { DEFAULT_RPC_URL };

const STORAGE_KEY = 'arcade.verifier.rpcUrl';

export function rememberedRpcUrl(): string {
	try {
		return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_RPC_URL;
	} catch {
		return DEFAULT_RPC_URL;
	}
}

/** Onthouden na een controle; niet bij een RPC die niet antwoordde of geen VRSCTEST is. */
export function rememberRpcUrl(url: string, verdict: string) {
	if (verdict === 'unavailable' || verdict === 'wrong-chain') return;
	try {
		if (url === DEFAULT_RPC_URL) localStorage.removeItem(STORAGE_KEY);
		else localStorage.setItem(STORAGE_KEY, url);
	} catch {
		/* geen opslag: dan niet onthouden */
	}
}

export function rpcHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
