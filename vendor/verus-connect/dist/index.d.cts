import { S as Signer, C as Challenge } from './server-BWrK_4pG.cjs';
export { V as VerifiedLogin, a as VerusConnectConfig, v as verusAuth } from './server-BWrK_4pG.cjs';
import 'express';

/**
 * Daemon mode signer — all crypto delegated to local verusd via RPC.
 */

declare class DaemonSigner implements Signer {
    private rpcUrl;
    constructor(rpcUrl: string);
    private rpc;
    sign(address: string, dataHex: string): Promise<string>;
    verify(address: string, signature: string, dataHash: string): Promise<boolean>;
    verifyMessage(address: string, signature: string, messageHex: string): Promise<boolean>;
    getBlockHeight(): Promise<number>;
    getIdentity(nameOrId: string): Promise<any>;
    getSignatureInfo(identityId: string, signature: string): Promise<{
        height: number;
    }>;
    checkSynced(): Promise<{
        synced: boolean;
        blocks: number;
        longestchain: number;
    }>;
}

/**
 * Lite mode signer — signs with verusid-ts-client (offline).
 * Verifies via a public Verus node.
 * No local daemon needed.
 *
 * TODO: Replace verusid-ts-client with direct @noble/secp256k1 signing.
 */

declare class LiteSigner implements Signer {
    private privateKey;
    private verifyNodeUrl;
    private verusId;
    constructor(wifKey: string, verifyNodeUrl: string);
    private nodeRpc;
    sign(address: string, dataHash: string): Promise<string>;
    signRequest(address: string, request: any, chainIAddress: string): Promise<any>;
    verify(address: string, signature: string, dataHash: string): Promise<boolean>;
    verifyMessage?(address: string, signature: string, messageHex: string): Promise<boolean>;
    getBlockHeight(): Promise<number>;
    getIdentity(nameOrId: string): Promise<any>;
    getSignatureInfo(identityId: string, signature: string): Promise<{
        height: number;
    }>;
}

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

interface KnownChain {
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
declare const KNOWN_CHAINS: Record<string, KnownChain>;
interface ConfCreds {
    rpcuser: string;
    rpcpassword: string;
    rpcport: number;
    rpchost: string;
}
/** Resolve the standard conf-file path for a given chain. */
declare function defaultConfPath(chain: KnownChain): string;
/** Parse rpcuser/rpcpassword/rpcport/rpchost from a verusd .conf file. */
declare function parseConf(confPath: string): ConfCreds;
interface ChainEntry {
    chain: KnownChain;
    signer: DaemonSigner;
    healthy: boolean;
    lastChecked: number;
    lastError?: string;
}
declare class MultiChainSigner {
    /** Map keyed by both name and systemId for easy lookup */
    private byName;
    private bySystemId;
    defaultChainName: string;
    private healthTimer?;
    constructor(entries: ChainEntry[], defaultChainName: string);
    /**
     * Build a degenerate single-chain registry (used by lite mode where the
     * sole signer is the verusid-ts-client LiteSigner). The signer parameter
     * is anything implementing the Signer interface.
     */
    static singleChain(signer: any, chainName: string): MultiChainSigner;
    /** Returns the entry for a system_id, or undefined if chain not configured. */
    forSystemId(systemId: string): ChainEntry | undefined;
    forName(name: string): ChainEntry | undefined;
    defaultChain(): ChainEntry;
    list(): ChainEntry[];
    /** Run a one-shot health check across all chains. */
    checkHealth(): Promise<void>;
    /** Start periodic health polling (default every 30s). Idempotent. */
    startHealthPolling(intervalMs?: number): void;
    stopHealthPolling(): void;
}
interface BuildRegistryOptions {
    /** List of chain names from CHAINS=... env var */
    chains: string[];
    /** Default chain name (must be in chains) */
    defaultChain: string;
    /** Optional per-chain conf path overrides, keyed by chain name */
    confPathOverrides?: Record<string, string>;
}
/** Build a MultiChainSigner from operator config. Reads each chain's conf file. */
declare function buildRegistry(opts: BuildRegistryOptions): MultiChainSigner;

/**
 * VerusID login challenge creation and response verification.
 * Uses verus-typescript-primitives GenericRequest/Response envelopes.
 *
 * Multi-chain: challenge creation picks a chain (defaulting to the registry's default);
 * verification routes to the chain named in the response's signature.systemID.
 *
 * Challenge identity = SHA256 of the issued request's serialized bytes
 * (request.getRawDataSha256). The wallet echoes this back as response.requestHash,
 * which we look up directly — no separate random challenge_id needed.
 */

/**
 * Create a login challenge deep link for a specific chain.
 *
 * `uriType` selects which ResponseURI the envelope carries (the wallet picks
 * the FIRST matching URI it understands and Verus-Mobile prefers TYPE_POST
 * over TYPE_REDIRECT when both are present — so we emit one envelope per
 * surface and let the caller pick):
 *
 *   - `'post'` (default): envelope has a single TYPE_POST ResponseURI pointing
 *     at `${callbackUrl}/${challengeId}`. Wallet POSTs the signed response
 *     server-to-server. Used by the QR-scan flow (wallet and browser on
 *     different devices; server callback + result polling is the only path
 *     that works there).
 *
 *   - `'redirect'`: envelope has a single TYPE_REDIRECT ResponseURI pointing
 *     at `${redirectUrl}?challengeId=${challengeId}`. Wallet appends the
 *     base64url-encoded response as a URL param (vdxfid
 *     `i9JzVt59mAVHqjc8WAQJx7bEFAQ4ffuhrC`) and calls Linking.openURL().
 *     Used by the deeplink-click flow on mobile (wallet and browser on the
 *     same device). Requires `redirectUrl`.
 */
declare function createChallenge(signer: Signer, signingAddress: string, callbackUrl: string, chainIAddress: string, challengeId: string, options?: {
    uriType?: 'post' | 'redirect';
    redirectUrl?: string;
}): Promise<Challenge>;
interface LoginEvidence {
    /** Hex-encoded SHA256 of the wallet's signed decision (response envelope). */
    decisionHash: string;
    /** Base64 signature produced by the user's identity over decisionHash. */
    decisionSignature: string;
    /** Hex-encoded SHA256 of the server-issued challenge (request envelope). */
    challengeHash: string;
    /** Base64 signature produced by the server's signing identity over challengeHash. */
    challengeSignature: string;
    /** The server's signing identity (i.e. the operator that issued the challenge). */
    challengeSigningId: string;
    /** Verus systemId (chain) the signatures were produced on. */
    systemId: string;
    /** Unix seconds when verification completed. */
    verifiedAt: number;
}
interface VerifyResult {
    identityAddress: string;
    friendlyName: string;
    systemId: string;
    chainName: string;
    /**
     * Cryptographic receipt the caller can independently re-verify against any
     * Verus node's `verifysignature` RPC.
     */
    evidence: LoginEvidence;
}
/**
 * Verify a signed login response from a wallet.
 *
 * Inputs:
 * - storedRequestBytes — the signed GenericRequest we issued, looked up by challengeId.
 * - responseBytes — raw bytes the wallet POSTed (response.toBuffer()).
 *
 * Verification steps:
 * 1. If response.requestHash is set, it must equal sha256(storedRequestBytes).
 * 2. Resolve signature.systemID to a configured chain.
 * 3. Request signature valid (server-signed; mostly a sanity re-check).
 * 4. Identity is active.
 * 5. Response signature valid (proves wallet holder approved).
 */
declare function verifyResponse(registry: MultiChainSigner, storedRequestBytes: Buffer, responseBytes: Buffer): Promise<VerifyResult>;

export { type BuildRegistryOptions, type ChainEntry, Challenge, DaemonSigner, KNOWN_CHAINS, type KnownChain, LiteSigner, MultiChainSigner, Signer, type VerifyResult, buildRegistry, createChallenge, defaultConfPath, parseConf, verifyResponse };
