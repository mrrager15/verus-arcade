/**
 * Multi-chain registry for verus-connect v4.
 *
 * Operators declare which chains they want to support via CHAINS=vrsc,varrr.
 * Per-chain RPC credentials are read from each daemon's standard conf file —
 * no need to copy-paste user/pass into .env.
 *
 * Conf file locations:
 *   VRSC      ~/.komodo/VRSC/VRSC.conf
 *   PBaaS     ~/.verus/pbaas/<hex>/<hex>.conf
 *               where <hex> is the system_id's hash160 in REVERSED byte order
 *               (matches how verusd lays out PBaaS chain datadirs)
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { DaemonSigner } from './signer-daemon.js';

export interface KnownChain {
  /** Friendly name as used in CHAINS=... */
  name: string;
  /** Display name shown to users */
  displayName: string;
  /** Chain i-address (system_id in LoginConsentRequest) */
  systemId: string;
}

/**
 * Built-in table of well-known Verus chains.
 * Add new entries here when supporting additional PBaaS chains.
 */
export const KNOWN_CHAINS: Record<string, KnownChain> = {
  vrsc:  { name: 'vrsc',  displayName: 'VRSC',  systemId: 'i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV' },
  vrsctest: { name: 'vrsctest', displayName: 'VRSCTEST', systemId: 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq' },
  varrr: { name: 'varrr', displayName: 'vARRR', systemId: 'iExBJfZYK7KREDpuhj6PzZBzqMAKaFg7d2' },
  vdex:  { name: 'vdex',  displayName: 'vDEX',  systemId: 'iHog9UCTrn95qpUBFCZ7kKz7qWdMA8MQ6N' },
  chips: { name: 'chips', displayName: 'CHIPS', systemId: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP' },
};

interface ConfCreds {
  rpcuser: string;
  rpcpassword: string;
  rpcport: number;
  rpchost: string;
}

/** Resolve the standard conf-file path for a given chain. */
export function defaultConfPath(chain: KnownChain): string {
  if (chain.name === 'vrsc') {
    return path.join(os.homedir(), '.komodo', 'VRSC', 'VRSC.conf');
  }
  // PBaaS: dirname is hash160 of system_id in reversed byte order
  const bs58check = require('bs58check');
  const hash = bs58check.decode(chain.systemId).slice(1) as Buffer;
  const hex = Buffer.from(hash).reverse().toString('hex');
  return path.join(os.homedir(), '.verus', 'pbaas', hex, `${hex}.conf`);
}

/** Parse rpcuser/rpcpassword/rpcport/rpchost from a verusd .conf file. */
export function parseConf(confPath: string): ConfCreds {
  const text = fs.readFileSync(confPath, 'utf-8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    out[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  if (!out.rpcuser || !out.rpcpassword || !out.rpcport) {
    throw new Error(`conf file ${confPath} missing rpcuser/rpcpassword/rpcport`);
  }
  return {
    rpcuser: out.rpcuser,
    rpcpassword: out.rpcpassword,
    rpcport: parseInt(out.rpcport, 10),
    rpchost: out.rpchost || '127.0.0.1',
  };
}

/** Build an authenticated RPC URL from parsed creds. */
function rpcUrlFromCreds(c: ConfCreds): string {
  return `http://${encodeURIComponent(c.rpcuser)}:${encodeURIComponent(c.rpcpassword)}@${c.rpchost}:${c.rpcport}`;
}

export interface ChainEntry {
  chain: KnownChain;
  signer: DaemonSigner;
  healthy: boolean;
  lastChecked: number;
  lastError?: string;
}

export class MultiChainSigner {
  /** Map keyed by both name and systemId for easy lookup */
  private byName = new Map<string, ChainEntry>();
  private bySystemId = new Map<string, ChainEntry>();
  public defaultChainName: string;
  private healthTimer?: NodeJS.Timeout;

  constructor(entries: ChainEntry[], defaultChainName: string) {
    for (const e of entries) {
      this.byName.set(e.chain.name, e);
      this.bySystemId.set(e.chain.systemId, e);
    }
    if (!this.byName.has(defaultChainName)) {
      throw new Error(`DEFAULT_CHAIN=${defaultChainName} is not in CHAINS list`);
    }
    this.defaultChainName = defaultChainName;
  }

  /**
   * Build a degenerate single-chain registry (used by lite mode where the
   * sole signer is the verusid-ts-client LiteSigner). The signer parameter
   * is anything implementing the Signer interface.
   */
  static singleChain(signer: any, chainName: string): MultiChainSigner {
    const chain = KNOWN_CHAINS[chainName.toLowerCase()];
    if (!chain) {
      throw new Error(`Unknown chain "${chainName}"`);
    }
    const entry: ChainEntry = {
      chain,
      signer: signer as DaemonSigner,
      healthy: true,
      lastChecked: Date.now(),
    };
    return new MultiChainSigner([entry], chain.name);
  }

  /** Returns the entry for a system_id, or undefined if chain not configured. */
  forSystemId(systemId: string): ChainEntry | undefined {
    return this.bySystemId.get(systemId);
  }

  forName(name: string): ChainEntry | undefined {
    return this.byName.get(name);
  }

  defaultChain(): ChainEntry {
    return this.byName.get(this.defaultChainName)!;
  }

  list(): ChainEntry[] {
    return [...this.byName.values()];
  }

  /** Run a one-shot health check across all chains. */
  async checkHealth(): Promise<void> {
    await Promise.all(this.list().map(async (e) => {
      try {
        const synced = await e.signer.checkSynced();
        e.healthy = synced.synced;
        e.lastError = synced.synced ? undefined : `not synced (${synced.blocks}/${synced.longestchain})`;
      } catch (err: any) {
        e.healthy = false;
        e.lastError = err?.message ? String(err.message).slice(0, 100) : 'unreachable';
      }
      e.lastChecked = Date.now();
    }));
  }

  /** Start periodic health polling (default every 30s). Idempotent. */
  startHealthPolling(intervalMs = 30_000): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      this.checkHealth().catch(() => { /* logged per-chain */ });
    }, intervalMs);
    if (this.healthTimer.unref) this.healthTimer.unref();
  }

  stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
  }
}

export interface BuildRegistryOptions {
  /** List of chain names from CHAINS=... env var */
  chains: string[];
  /** Default chain name (must be in chains) */
  defaultChain: string;
  /** Optional per-chain conf path overrides, keyed by chain name */
  confPathOverrides?: Record<string, string>;
}

/** Build a MultiChainSigner from operator config. Reads each chain's conf file. */
export function buildRegistry(opts: BuildRegistryOptions): MultiChainSigner {
  const entries: ChainEntry[] = [];
  for (const name of opts.chains) {
    const chain = KNOWN_CHAINS[name.toLowerCase()];
    if (!chain) {
      throw new Error(`Unknown chain "${name}" — known: ${Object.keys(KNOWN_CHAINS).join(', ')}`);
    }
    const confPath = opts.confPathOverrides?.[name.toLowerCase()] || defaultConfPath(chain);
    let creds: ConfCreds;
    try {
      creds = parseConf(confPath);
    } catch (err: any) {
      throw new Error(`Failed to load ${chain.displayName} conf at ${confPath}: ${err.message}`);
    }
    const signer = new DaemonSigner(rpcUrlFromCreds(creds));
    entries.push({
      chain,
      signer,
      healthy: false,        // flipped true on first checkHealth()
      lastChecked: 0,
    });
  }
  return new MultiChainSigner(entries, opts.defaultChain.toLowerCase());
}
