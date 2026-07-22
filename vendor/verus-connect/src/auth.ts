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

import {
  GenericRequest,
  GenericResponse,
  AuthenticationRequestOrdinalVDXFObject,
  AuthenticationRequestDetails,
  ResponseURI,
  VerifiableSignatureData,
  CompactIAddressObject,
} from 'verus-typescript-primitives';
import { BN } from 'bn.js';
import { createHash } from 'crypto';
import type { Signer, Challenge } from './types.js';
import type { MultiChainSigner } from './chain-registry.js';

const createSha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/**
 * Resolve a friendly VerusID name (e.g. `myid@`) to its i-address.
 * Pass-through if input already looks like an i-address.
 */
async function resolveToIAddress(signer: Signer, nameOrIAddr: string): Promise<string> {
  if (/^i[a-zA-Z0-9]{33,34}$/.test(nameOrIAddr)) return nameOrIAddr;
  const info = await signer.getIdentity(nameOrIAddr);
  const iaddr = info?.identity?.identityaddress || info?.identityaddress;
  if (!iaddr) throw new Error(`Could not resolve ${nameOrIAddr} to an i-address`);
  return iaddr;
}

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
export async function createChallenge(
  signer: Signer,
  signingAddress: string,
  callbackUrl: string,
  chainIAddress: string,
  challengeId: string,
  options: { uriType?: 'post' | 'redirect'; redirectUrl?: string } = {},
): Promise<Challenge> {
  const uriType = options.uriType ?? 'post';
  if (uriType === 'redirect' && !options.redirectUrl) {
    throw new Error('createChallenge: redirectUrl is required when uriType=redirect');
  }

  const createdAt = Math.floor(Date.now() / 1000);
  const signingIAddr = await resolveToIAddress(signer, signingAddress);
  const perChallengeCallback = `${callbackUrl.replace(/\/+$/, '')}/${challengeId}`;

  // Testnet chains need FLAG_IS_TESTNET on the envelope and VRSCTEST as the
  // root system for compact address encoding — otherwise Verus Mobile in
  // testnet mode rejects with "Cannot validate request made for mainnet".
  const isTestnet = chainIAddress === 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq'; // VRSCTEST system id
  const rootSystemName = isTestnet ? 'VRSCTEST' : 'VRSC';

  const authDetail = new AuthenticationRequestOrdinalVDXFObject({
    data: new AuthenticationRequestDetails({}),
  });

  const placeholderSig = new VerifiableSignatureData({
    identityID: CompactIAddressObject.fromAddress(signingIAddr, rootSystemName),
    systemID: CompactIAddressObject.fromAddress(chainIAddress, rootSystemName),
    isTestnet,
  });

  let responseURIs;
  if (uriType === 'post') {
    responseURIs = [ResponseURI.fromUriString(perChallengeCallback, ResponseURI.TYPE_POST)];
  } else {
    const base = options.redirectUrl!;
    const sep = base.includes('?') ? '&' : '?';
    const perChallengeRedirect = `${base}${sep}challengeId=${challengeId}`;
    responseURIs = [ResponseURI.fromUriString(perChallengeRedirect, ResponseURI.TYPE_REDIRECT)];
  }

  const request = new GenericRequest({
    details: [authDetail],
    createdAt: new BN(createdAt),
    responseURIs,
    signature: placeholderSig,
  });
  if (isTestnet) request.setIsTestnet();

  let signed: GenericRequest;
  if (signer.signRequest) {
    // Lite mode: verusid-ts-client signs the pre-built envelope in-place.
    signed = await signer.signRequest(signingIAddr, request, chainIAddress);
  } else {
    // Daemon mode: pass the envelope's raw sha256 to signdata. The daemon's
    // signdata internally wraps it as IdentitySignatureHash(height, sys, id, prefix, datahash)
    // before signing, and records the same height in the returned IdentitySignature blob.
    // Pre-wrapping client-side (via getDetailsIdentitySignatureHash) would cause a double-wrap
    // that mobile's offline verifyHashOffline cannot recover from.
    request.setSigned();
    const rawSha = request.getRawDataSha256();
    const sigB64 = await signer.sign(signingIAddr, rawSha.toString('hex'));
    request.signature!.signatureAsVch = Buffer.from(sigB64, 'base64');
    signed = request;
  }

  return {
    id: challengeId,
    deepLink: signed.toWalletDeeplinkUri(),
    requestBytes: signed.toBuffer(),
    createdAt,
  };
}

export interface LoginEvidence {
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

export interface VerifyResult {
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
export async function verifyResponse(
  registry: MultiChainSigner,
  storedRequestBytes: Buffer,
  responseBytes: Buffer,
): Promise<VerifyResult> {
  const request = new GenericRequest();
  request.fromBuffer(storedRequestBytes);

  const response = new GenericResponse();
  response.fromBuffer(responseBytes);

  // 1. If the wallet set requestHash, sanity-check it points at our stored request bytes.
  if (response.requestHash && response.requestHash.length > 0) {
    const requestBytesHash = createSha256(storedRequestBytes);
    if (!response.requestHash.equals(requestBytesHash)) {
      throw new Error('Response.requestHash does not match the issued request envelope');
    }
  }

  if (!request.isSigned() || !response.isSigned()) {
    throw new Error('Request and response must both be signed');
  }

  // 2. Chain comes from the request's signature (the server's chain).
  const systemId = request.signature!.systemID.toAddress();
  const entry = registry.forSystemId(systemId);
  if (!entry) throw new Error(`Chain ${systemId} is not supported on this site`);
  if (!entry.healthy) throw new Error(`${entry.chain.displayName} is temporarily unavailable`);
  const signer = entry.signer;

  // 3. Verify the REQUEST signature (server-signed) on the right chain.
  // Pass the envelope's raw sha256 as datahash; the daemon's verifysignature internally
  // wraps it with IdentitySignatureHash(height, sys, id, prefix, datahash) and verifies.
  const requestSigningId = request.signature!.identityID.toAddress();
  const requestSigB64 = request.signature!.signatureAsVch.toString('base64');
  const requestRawSha = request.getRawDataSha256().toString('hex');
  const reqOk = await signer.verify(requestSigningId, requestSigB64, requestRawSha);
  if (!reqOk) throw new Error('Request signature invalid — challenge was not issued by this server');

  // 4. Verify the response signer's identity is active.
  const responseSigningId = response.signature!.identityID.toAddress();
  const responseSigB64 = response.signature!.signatureAsVch.toString('base64');
  let idInfo: any;
  try {
    idInfo = await signer.getIdentity(responseSigningId);
  } catch {
    throw new Error('Could not resolve signing identity');
  }
  const idStatus = idInfo?.status ?? idInfo?.identity?.status;
  if (idStatus !== 'active') throw new Error('Signing identity is not active');

  // 5. Verify the RESPONSE signature (raw sha256; daemon wraps internally).
  const responseRawSha = response.getRawDataSha256().toString('hex');
  const respOk = await signer.verify(responseSigningId, responseSigB64, responseRawSha);
  if (!respOk) throw new Error('Response signature verification failed');

  const friendlyName =
    idInfo?.friendlyname ||
    idInfo?.fullyqualifiedname ||
    idInfo?.identity?.name ||
    responseSigningId;

  return {
    identityAddress: responseSigningId,
    friendlyName,
    systemId,
    chainName: entry.chain.displayName,
    evidence: {
      decisionHash: responseRawSha,
      decisionSignature: responseSigB64,
      challengeHash: requestRawSha,
      challengeSignature: requestSigB64,
      challengeSigningId: requestSigningId,
      systemId,
      verifiedAt: Math.floor(Date.now() / 1000),
    },
  };
}
