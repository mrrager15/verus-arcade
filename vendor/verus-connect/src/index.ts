export { verusAuth } from './middleware.js';
export { DaemonSigner } from './signer-daemon.js';
export { LiteSigner } from './signer-lite.js';
export { createChallenge, verifyResponse } from './auth.js';
export type { VerifyResult } from './auth.js';
export {
  KNOWN_CHAINS,
  MultiChainSigner,
  buildRegistry,
  defaultConfPath,
  parseConf,
} from './chain-registry.js';
export type { KnownChain, ChainEntry, BuildRegistryOptions } from './chain-registry.js';
export type { VerusConnectConfig, Signer, Challenge, VerifiedLogin } from './types.js';
