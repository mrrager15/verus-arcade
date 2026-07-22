/**
 * Core types for verus-connect v4.
 */

export interface VerusConnectConfig {
  /** Mode: 'daemon' uses local RPC, 'lite' uses WIF key + public node */
  mode?: 'daemon' | 'lite';

  /** The VerusID i-address or friendly name used to sign challenges */
  iAddress: string;

  /** Callback URL where the wallet POSTs the signed response */
  callbackUrl: string;

  /**
   * Optional. Where the wallet sends the user's browser AFTER a successful
   * sign (TYPE_REDIRECT response URI). Used by mobile users tapping a
   * "Sign in" button on the same device the wallet runs on — wallet calls
   * Linking.openURL() to send them back. The sidecar appends
   * `?challengeId=<id>` so the landing page can finalise the session by
   * calling /result/:id. If unset, no TYPE_REDIRECT URI is included and
   * the flow stays POST-only (current behaviour; works for QR-scan from
   * a different device).
   */
  redirectUrl?: string;

  // --- Daemon mode (multi-chain) ---
  /** List of supported chains by friendly name, e.g. ['vrsc', 'varrr']. Required for daemon mode. */
  chains?: string[];

  /** Default chain name for challenge issuance when client doesn't specify. Must be in chains. */
  defaultChain?: string;

  /** Optional per-chain conf-path overrides, keyed by chain name */
  confPathOverrides?: Record<string, string>;

  // --- Lite mode ---
  /** Chain i-address for lite mode (single-chain only) */
  chainIAddress?: string;

  /** Public API URL for RPC calls (default: https://api.verus.services) */
  apiUrl?: string;

  /** WIF private key for signing (lite mode only) */
  privateKey?: string;

  /** Public Verus node URL for verification (lite mode, single-chain — required when chains is unset) */
  verifyNodeUrl?: string;

  /**
   * Per-chain public Verus node URLs (lite mode, multi-chain). Keyed by chain
   * name (lowercase, matches `chains`). When `chains` lists more than one
   * entry in lite mode, every listed chain must have a URL here. The signing
   * identity must exist on every listed chain.
   */
  verifyNodeUrls?: Record<string, string>;

  /** Enable debug logging and response saving to /tmp */
  debug?: boolean;

  /** Hook called after successful login */
  onLogin?: (login: VerifiedLogin) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
}

export interface VerifiedLogin {
  iAddress: string;
  friendlyName: string;
  challengeId: string;
  /** System (chain) i-address the user authenticated on */
  systemId: string;
  /** Friendly chain name, e.g. "VRSC" or "vARRR" */
  chainName: string;
}

export interface Signer {
  /** Sign a data hash and return the signature */
  sign(address: string, dataHash: string): Promise<string>;

  /** Sign a full GenericRequest envelope (lite mode handles internally) */
  signRequest?(address: string, request: any, chainIAddress: string): Promise<any>;

  /** Verify a signature against a data hash (hex) */
  verify(address: string, signature: string, dataHash: string): Promise<boolean>;

  /** Verify a signature against raw message data (hex) */
  verifyMessage?(address: string, signature: string, messageHex: string): Promise<boolean>;

  /** Get current block height */
  getBlockHeight(): Promise<number>;

  /** Get identity info */
  getIdentity(nameOrId: string): Promise<any>;

  /** Get info about a signature (block height it was signed at, etc.) */
  getSignatureInfo?(identityId: string, signature: string): Promise<{ height: number }>;

  /** Check if daemon is synced to chain tip */
  checkSynced?(): Promise<{ synced: boolean; blocks: number; longestchain: number }>;
}

export interface Challenge {
  id: string;
  deepLink: string;
  /** The signed request envelope bytes — needed to derive challengeHash and re-verify server-side. */
  requestBytes: Buffer;
  createdAt: number;
}
