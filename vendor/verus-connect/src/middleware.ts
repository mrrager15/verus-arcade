/**
 * Express middleware for VerusID authentication, payments, and identity requests.
 * Auto-detects daemon vs lite mode from config.
 * V4 with v3 route compatibility: login, pay-deeplink, generic-request, identity-update-request.
 */

import { Router, json as jsonParser, raw as rawParser } from 'express';
import crypto from 'crypto';
import { createRequire } from 'module';
import path from 'path';
// LiteSigner is lazy-loaded only when lite mode is requested (PRIVATE_KEY set).
// This avoids importing verusid-ts-client in native/daemon mode where it's not needed.
let LiteSigner: any = null;
import { createChallenge, verifyResponse } from './auth.js';
import type { LoginEvidence } from './auth.js';
import { buildRegistry, MultiChainSigner, KNOWN_CHAINS } from './chain-registry.js';
import type { VerusConnectConfig, VerifiedLogin } from './types.js';

// Smart module resolution for peer dependencies
function createSmartRequire() {
  const strategies: ReturnType<typeof createRequire>[] = [];
  try {
    strategies.push(createRequire(path.join(process.cwd(), 'noop.js')));
  } catch { /* ignore */ }
  const entryScript = require.main?.filename ?? process.argv[1];
  if (entryScript) {
    try {
      const baseDir = path.dirname(entryScript);
      if (baseDir !== process.cwd()) {
        strategies.push(createRequire(path.join(baseDir, 'noop.js')));
      }
    } catch { /* ignore */ }
  }
  return (id: string) => {
    let lastErr: Error | undefined;
    for (const req of strategies) {
      try { return req(id); } catch (err: any) { lastErr = err; }
    }
    throw lastErr ?? new Error(`Cannot find module '${id}'`);
  };
}

const smartRequire = createSmartRequire();

// Lazy-loaded Verus libraries (for pay-deeplink, generic-request, etc.)
let primitives: any = null;
let bs58check: any = null;
let BN: any = null;
let primitivesLoaded = false;

function loadPrimitives(): boolean {
  if (primitivesLoaded) return !!primitives;
  primitivesLoaded = true;
  try {
    primitives = smartRequire('verus-typescript-primitives');
    try { bs58check = smartRequire('bs58check'); } catch {
      try { bs58check = smartRequire('verus-typescript-primitives/node_modules/bs58check'); } catch {
        console.warn('[verus-connect] bs58check not found — pay-deeplink address resolution limited');
      }
    }
    try { BN = smartRequire('bn.js'); } catch {
      try { BN = smartRequire('verus-typescript-primitives/node_modules/bn.js'); } catch {
        console.warn('[verus-connect] bn.js not found — pay-deeplink may not work');
      }
    }
    return true;
  } catch {
    console.warn('[verus-connect] verus-typescript-primitives not found — pay-deeplink, generic-request, identity-update-request unavailable');
    return false;
  }
}

/** Generate a random i-address (hash160 with version byte 102) */
function randomIAddress(): string {
  if (!bs58check) return crypto.randomBytes(16).toString('hex');
  const buf = Buffer.alloc(21);
  buf[0] = 102;
  crypto.randomBytes(20).copy(buf, 1);
  return bs58check.encode(buf);
}

// ── Rate limiter (shared across all routes) ──────────────────────
const MAX_REQUESTS_PER_MIN = 30;
const rateLimits = new Map<string, { count: number; reset: number }>();

// [H3 fix] Clean up expired rate limit entries every 2 minutes
const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimits) {
    if (data.reset <= now) rateLimits.delete(ip);
  }
}, 120_000);
if (rateLimitCleanup.unref) rateLimitCleanup.unref();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const limit = rateLimits.get(ip);
  if (limit && limit.reset > now && limit.count >= MAX_REQUESTS_PER_MIN) {
    return true;
  }
  if (!limit || limit.reset <= now) {
    rateLimits.set(ip, { count: 1, reset: now + 60_000 });
  } else {
    limit.count++;
  }
  return false;
}

/** [M3 fix] Sanitise error messages — strip internal details */
function safeErrorMessage(err: any, fallback: string): string {
  // Never reflect raw error messages that might contain internal paths, URLs, or stack traces
  if (!err || !err.message) return fallback;
  const msg = String(err.message);
  // Allow short, simple error messages through. Block anything that looks like a path, URL, or stack.
  if (msg.length > 200 || msg.includes('/') || msg.includes('\\') || msg.includes('at ') || msg.includes('node_modules')) {
    return fallback;
  }
  return msg;
}

// ── Input validators ─────────────────────────────────────────────

/** [M9 fix] Validate address format */
function isValidAddress(addr: unknown): addr is string {
  if (typeof addr !== 'string') return false;
  if (addr.length < 1 || addr.length > 100) return false;
  // Only allow alphanumeric, @, . (for VerusID names) and base58 chars
  if (!/^[a-zA-Z0-9@._]+$/.test(addr)) return false;
  return true;
}

/** [M9 fix] Validate identity name */
function isValidIdentity(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  if (id.length < 1 || id.length > 100) return false;
  if (!/^[a-zA-Z0-9@._]+$/.test(id)) return false;
  return true;
}

/** [M9 fix] Validate flags (must be integer 0-15) */
function isValidFlags(flags: unknown): flags is number {
  if (typeof flags !== 'number') return false;
  if (!Number.isInteger(flags) || flags < 0 || flags > 15) return false;
  return true;
}

/** [M9 fix] Validate minimumsignatures (must be integer 1-13) */
function isValidMinSigs(sigs: unknown): sigs is number {
  if (typeof sigs !== 'number') return false;
  if (!Number.isInteger(sigs) || sigs < 1 || sigs > 13) return false;
  return true;
}

/** [M9 fix] Validate primaryaddresses (array of strings) */
function isValidAddressArray(arr: unknown): arr is string[] {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0 || arr.length > 13) return false;
  return arr.every(a => typeof a === 'string' && /^R[a-zA-Z0-9]{33}$/.test(a));
}

/** [M8 fix] Validate generic request details — limit array size and object depth */
function isValidDetailsArray(details: unknown): details is any[] {
  if (!Array.isArray(details)) return false;
  if (details.length === 0 || details.length > 20) return false;
  // Basic sanity check — each detail should be an object
  return details.every(d => d !== null && typeof d === 'object' && !Array.isArray(d));
}

export function verusAuth(config: VerusConnectConfig): Router {
  if (!config.callbackUrl) throw new Error('verus-connect: callbackUrl is required');
  if (!config.iAddress) throw new Error('verus-connect: iAddress is required');

  // Mode resolution: explicit config.mode wins; otherwise privateKey => lite, else daemon.
  // (chains[] is no longer mode-determining — both modes can be multi-chain.)
  const mode = config.mode || (config.privateKey ? 'lite' : 'daemon');

  let registry: MultiChainSigner;
  if (mode === 'daemon') {
    if (!config.chains?.length) throw new Error('verus-connect: chains is required for daemon mode');
    if (!config.defaultChain) throw new Error('verus-connect: defaultChain is required for daemon mode');
    registry = buildRegistry({
      chains: config.chains,
      defaultChain: config.defaultChain,
      confPathOverrides: config.confPathOverrides,
    });
    // Initial health check (don't await; routes will check entry.healthy as it updates)
    registry.checkHealth().catch(() => { /* per-chain errors stored on entries */ });
    registry.startHealthPolling();
    console.log(`[verus-connect] Mode: daemon — chains: ${registry.list().map(e => e.chain.displayName).join(', ')}`);
  } else {
    if (!config.privateKey) throw new Error('verus-connect: privateKey is required for lite mode');
    // Lazy-load LiteSigner — only imports verusid-ts-client when actually needed
    if (!LiteSigner) {
      try {
        LiteSigner = require('./signer-lite.js').LiteSigner;
      } catch (e: any) {
        throw new Error('verus-connect: lite mode requires verusid-ts-client. Install it: npm run install:lite');
      }
    }

    if (config.chains?.length && config.chains.length > 1) {
      // Multi-chain lite: same WIF + signing iaddr, one LiteSigner per chain
      // with its own verifyNodeUrl. The signing identity must be exported to
      // every chain in the list (PBaaS children share the parent's identity
      // registry, so iaddress + R-addr are stable across chains).
      const urls = config.verifyNodeUrls || {};
      const entries = config.chains.map((name) => {
        const key = name.toLowerCase();
        const url = urls[key] || (key === 'vrsc' ? config.verifyNodeUrl : undefined);
        if (!url) {
          throw new Error(
            `verus-connect: multi-chain lite requires VERIFY_NODE_URL_${key.toUpperCase()} for chain "${name}"`,
          );
        }
        const chain = KNOWN_CHAINS[key];
        if (!chain) throw new Error(`Unknown chain "${name}"`);
        const signer = new LiteSigner(config.privateKey!, url);
        return { chain, signer, healthy: true, lastChecked: Date.now() };
      });
      const defaultChain = (config.defaultChain || config.chains[0]).toLowerCase();
      registry = new MultiChainSigner(entries, defaultChain);
      console.log(`[verus-connect] Mode: lite (multi-chain) — chains: ${registry.list().map(e => e.chain.displayName).join(', ')}`);
    } else {
      // Single-chain lite (legacy path)
      if (!config.verifyNodeUrl) throw new Error('verus-connect: verifyNodeUrl is required for single-chain lite mode');
      const liteSigner = new LiteSigner(config.privateKey, config.verifyNodeUrl);
      const liteChain = (config.chains?.[0] || (config as any).chain || 'vrsc');
      registry = MultiChainSigner.singleChain(liteSigner, liteChain);
      console.log(`[verus-connect] Mode: lite — chain: ${registry.defaultChain().chain.displayName}`);
    }
  }

  const apiUrl = config.apiUrl || 'https://api.verus.services';

  const debug = config.debug ?? false;

  const hasPrimitives = loadPrimitives();
  if (hasPrimitives) {
    console.log('[verus-connect] Primitives loaded — all routes available');
  }

  // Challenge + result storage (in-memory, auto-expire after 5 min).
  // Each challenge produces two envelopes — one TYPE_POST (the QR-scan path,
  // wallet POSTs response to /verusidlogin/:id) and one TYPE_REDIRECT (the
  // click-to-open-wallet path, wallet ships response back as a URL param).
  // The /verusidlogin handler matches an inbound response against either set
  // of stored request bytes since the wallet only signs one of them.
  const challenges = new Map<string, { created: number; deepLinkPost: string; deepLinkRedirect: string | null; systemId: string; chainName: string; requestBytesPost: Buffer; requestBytesRedirect: Buffer | null }>();
  const results = new Map<string, { iAddress: string; friendlyName: string; systemId: string; chainName: string; extra?: Record<string, unknown>; evidence?: LoginEvidence }>();

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [id, data] of challenges) {
      if (data.created < cutoff) {
        challenges.delete(id);
        results.delete(id);
      }
    }
  }, 60_000);
  if (cleanupTimer.unref) cleanupTimer.unref();

  const router = Router();

  // ── POST /login — create a new login challenge ──
  // Body: { chain?: string }   (defaults to registry.defaultChain)

  router.post('/login', jsonParser({ limit: '4kb' }), async (req: any, res) => {
    // [H2 fix] Rate limit all POST routes
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    try {
      const rawChain = req.body?.chain;
      // Defensive: reject anything that isn't a short alphanum chain name before we
      // reflect it back in an error message.
      if (rawChain !== undefined && (typeof rawChain !== 'string' || !/^[a-z0-9]{1,16}$/i.test(rawChain))) {
        return res.status(400).json({ error: 'Invalid chain name' });
      }
      const requestedChain = (rawChain as string | undefined)?.toLowerCase();
      const entry = requestedChain
        ? registry.forName(requestedChain)
        : registry.defaultChain();

      if (!entry) {
        return res.status(400).json({
          error: `Chain "${requestedChain}" is not supported by this site`,
          supported: registry.list().map(e => e.chain.name),
        });
      }
      if (!entry.healthy) {
        return res.status(503).json({
          error: `${entry.chain.displayName} is temporarily unavailable`,
          chain: entry.chain.name,
          reason: entry.lastError,
        });
      }

      // Check daemon is synced before generating challenge
      if (entry.signer.checkSynced) {
        const sync = await entry.signer.checkSynced();
        if (!sync.synced) {
          console.warn(`[verus-connect] ${entry.chain.displayName} not synced (${sync.blocks}/${sync.longestchain})`);
          return res.status(503).json({
            error: `${entry.chain.displayName} daemon is not synced to chain tip. Please wait and try again.`,
            blocks: sync.blocks,
            longestchain: sync.longestchain,
          });
        }
      }

      const challengeId = crypto.randomBytes(16).toString('hex');

      // Issue a POST-mode envelope (always — that's the canonical server-callback
      // path and works for QR-scan-from-another-device). If redirectUrl is set
      // also issue a REDIRECT-mode envelope so same-device deeplink-click flows
      // get a user-browser-redirect after sign. The two envelopes share the
      // challengeId; whichever the wallet completes is the one we'll match
      // against in /verusidlogin/:id.
      const postChallenge = await createChallenge(
        entry.signer,
        config.iAddress,
        config.callbackUrl,
        entry.chain.systemId,
        challengeId,
        { uriType: 'post' },
      );
      let redirectChallenge: typeof postChallenge | null = null;
      if (config.redirectUrl) {
        redirectChallenge = await createChallenge(
          entry.signer,
          config.iAddress,
          config.callbackUrl,
          entry.chain.systemId,
          challengeId,
          { uriType: 'redirect', redirectUrl: config.redirectUrl },
        );
      }

      challenges.set(challengeId, {
        created: Date.now(),
        deepLinkPost: postChallenge.deepLink,
        deepLinkRedirect: redirectChallenge?.deepLink ?? null,
        systemId: entry.chain.systemId,
        chainName: entry.chain.displayName,
        requestBytesPost: postChallenge.requestBytes,
        requestBytesRedirect: redirectChallenge?.requestBytes ?? null,
      });

      res.json({
        challengeId,
        // `uri`/`deepLink` kept for backward compatibility — they point at the
        // POST envelope which is what existing single-surface clients expect.
        uri: postChallenge.deepLink,
        deepLink: postChallenge.deepLink,
        // New: per-surface deeplinks so clients can render a QR (POST) AND a
        // tappable button (REDIRECT) at the same time. `deepLinkRedirect` is
        // null when REDIRECT_URL isn't configured.
        deepLinkPost: postChallenge.deepLink,
        deepLinkRedirect: redirectChallenge?.deepLink ?? null,
        chain: entry.chain.name,
        chainName: entry.chain.displayName,
        systemId: entry.chain.systemId,
      });
    } catch (err: any) {
      console.error('[verus-connect] Challenge creation failed:', err.message);
      res.status(500).json({ error: 'Failed to create login challenge' });
    }
  });

  // ── GET /chains — list supported chains and their current health ──
  router.get('/chains', (_req, res) => {
    res.json({
      default: registry.defaultChainName,
      chains: registry.list().map(e => ({
        name: e.chain.name,
        displayName: e.chain.displayName,
        systemId: e.chain.systemId,
        healthy: e.healthy,
        lastChecked: e.lastChecked || null,
      })),
    });
  });

  // ── POST /verusidlogin/:id — receive signed response from wallet (raw bytes) ──
  // Mobile POSTs response.toBuffer() as application/octet-stream; the per-challenge ID is
  // in the URL path so we can route without needing the wallet to echo a request reference.

  router.post('/verusidlogin/:id', rawParser({ type: '*/*', limit: '1mb' }), async (req, res) => {
    // [H2 fix] Rate limit
    const ip = (req as any).ip || (req as any).connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    try {
      const challengeId = req.params.id;
      const stored = challenges.get(challengeId);

      if (debug) {
        console.log('[verus-connect] /verusidlogin received challengeId=' + challengeId);
        console.log('[verus-connect] body bytes=' + (Buffer.isBuffer(req.body) ? req.body.length : 'n/a'));
      }

      if (!stored) {
        return res.status(404).json({ error: 'Challenge not found or expired' });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty response body — expected GenericResponse bytes' });
      }

      // Try verifying against the POST envelope first (most common path —
      // QR-scan response always lands here). If that fails, fall back to the
      // REDIRECT envelope, which the deeplink-click flow signs over instead.
      // We catch a parse/verify error on the first attempt as the trigger to
      // try the second; throwing without a redirect envelope to try lets the
      // original error propagate as before.
      let verifyOut;
      try {
        verifyOut = await verifyResponse(registry, stored.requestBytesPost, req.body);
      } catch (firstErr) {
        if (stored.requestBytesRedirect) {
          verifyOut = await verifyResponse(registry, stored.requestBytesRedirect, req.body);
        } else {
          throw firstErr;
        }
      }
      const { identityAddress, friendlyName, systemId, chainName, evidence } = verifyOut;

      const loginResult: VerifiedLogin = {
        iAddress: identityAddress,
        friendlyName,
        challengeId,
        systemId,
        chainName,
      };

      let extra: Record<string, unknown> | undefined;
      if (config.onLogin) {
        try {
          const hookResult = await config.onLogin(loginResult);
          if (hookResult && typeof hookResult === 'object') extra = hookResult;
        } catch (hookErr: any) {
          console.error('[verus-connect] onLogin hook error:', hookErr.message);
        }
      }

      results.set(challengeId, { iAddress: identityAddress, friendlyName, systemId, chainName, extra, evidence });
      if (debug) console.log(`[verus-connect] Login successful: ${identityAddress} on ${chainName}`);
      res.json({ status: 'ok' });
    } catch (err: any) {
      console.error('[verus-connect] Webhook error:', err.message);
      if (debug) console.error('[verus-connect] Stack:', err.stack);
      res.status(500).json({ error: 'Verification error' });
    }
  });

  // ── GET /result/:challengeId — poll for login result ──

  router.get('/result/:challengeId', (req, res) => {
    const { challengeId } = req.params;

    if (!challenges.has(challengeId)) {
      return res.status(404).json({ status: 'error', error: 'Challenge not found or expired' });
    }

    const result = results.get(challengeId);
    if (!result) {
      return res.json({ status: 'pending' });
    }

    return res.json({
      status: 'verified',
      iAddress: result.iAddress,
      friendlyName: result.friendlyName,
      systemId: result.systemId,
      chainName: result.chainName,
      data: result.extra,
      evidence: result.evidence,
    });
  });

  // ── POST /pay-deeplink — generate VerusPay invoice deep link ──

  router.post('/pay-deeplink', jsonParser({ limit: '10kb' }), async (req: any, res) => {
    // [H2 fix] Rate limit
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { address, amount, currency_id } = req.body;

    if (!isValidAddress(address)) {
      return res.status(400).json({ error: 'Invalid address format' });
    }
    if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0 || amount > 1e12) {
      return res.status(400).json({ error: 'Amount must be a positive number (max 1 trillion)' });
    }
    if (currency_id !== undefined && !isValidAddress(currency_id)) {
      return res.status(400).json({ error: 'Invalid currency_id format' });
    }
    if (!primitives || !bs58check || !BN) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    try {
      const chainId = currency_id || registry.defaultChain().chain.systemId;
      const VERSION_3 = new BN(3);

      let destType: any;
      let destBytes: Buffer;
      let resolvedAddress = address;

      if (address.includes('@')) {
        try {
          let rpcTarget = apiUrl;
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          try {
            const parsed = new URL(rpcTarget);
            if (parsed.username) {
              headers['Authorization'] = 'Basic ' + Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
              rpcTarget = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
            }
          } catch {}

          const rpcRes = await fetch(rpcTarget, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '1.0', id: 'pay', method: 'getidentity', params: [address] }),
          });
          const rpcData = await rpcRes.json() as any;
          const iAddress = rpcData?.result?.identity?.identityaddress;
          if (!iAddress) throw new Error('Identity not found');
          resolvedAddress = iAddress;
        } catch (e: any) {
          // [M3 fix] Don't reflect raw error
          return res.status(404).json({ error: 'Could not resolve identity' });
        }
        const decoded = bs58check.decode(resolvedAddress);
        destType = primitives.DEST_ID;
        destBytes = decoded.slice(1);
      } else if (address.startsWith('i')) {
        const decoded = bs58check.decode(address);
        destType = primitives.DEST_ID;
        destBytes = decoded.slice(1);
      } else {
        const decoded = bs58check.decode(address);
        destType = primitives.DEST_PKH;
        destBytes = decoded.slice(1);
      }

      const details = new primitives.VerusPayInvoiceDetails({
        amount: new BN(Math.round(amount * 1e8)),
        destination: new primitives.TransferDestination({
          type: destType,
          destinationBytes: destBytes,
        }),
        requestedcurrencyid: chainId,
      }, VERSION_3);

      const invoice = new primitives.VerusPayInvoice({ details, version: VERSION_3 });
      const deepLink = invoice.toWalletDeeplinkUri();

      return res.json({
        deep_link: deepLink,
        destination_type: destType.eq(primitives.DEST_ID) ? 'identity' : 'address',
        resolved_address: resolvedAddress,
      });
    } catch (err: any) {
      console.error('[verus-connect] pay-deeplink error:', err.message);
      // [M3 fix] Generic error to client
      return res.status(500).json({ error: 'Failed to generate payment deep link' });
    }
  });

  // ── POST /generic-request — create a GenericRequest deep link ──

  router.post('/generic-request', jsonParser({ limit: '100kb' }), async (req: any, res) => {
    // [H2 fix] Rate limit
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { details } = req.body;

    // [M8 fix] Validate details array
    if (!isValidDetailsArray(details)) {
      return res.status(400).json({ error: 'details must be an array of 1-20 objects' });
    }
    if (!primitives) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    try {
      const responseURIs: any[] = [];
      if (config.callbackUrl) {
        const ResponseURI = primitives.ResponseURI;
        const genericCallbackUrl = config.callbackUrl.replace(/\/verusidlogin$/, '/generic-response');
        responseURIs.push(ResponseURI.fromUriString(genericCallbackUrl, ResponseURI.TYPE_POST));
      }

      // Convert raw JSON details to proper OrdinalVDXFObject instances.
      // GeneralTypeOrdinalVDXFObject.fromJson expects data as hex string.
      const parsedDetails = details.map((d: any) => {
        if (d && typeof d.getByteLength === 'function') return d;
        const detail = { ...d };
        if (detail.data && typeof detail.data === 'string' && !/^[0-9a-fA-F]*$/.test(detail.data)) {
          detail.data = Buffer.from(detail.data, 'utf-8').toString('hex');
        }
        return primitives.GeneralTypeOrdinalVDXFObject.fromJson(detail);
      });

      const requestConfig: any = {
        details: parsedDetails,
        flags: primitives.GenericRequest.BASE_FLAGS,
      };

      if (responseURIs.length > 0) {
        requestConfig.responseURIs = responseURIs;
      }

      const request = new primitives.GenericRequest(requestConfig);
      const deepLink = request.toWalletDeeplinkUri();
      const qrString = request.toQrString();

      return res.json({
        deep_link: deepLink,
        qr_string: qrString,
        has_callback: !!config.callbackUrl,
      });
    } catch (err: any) {
      console.error('[verus-connect] generic-request error:', err.message);
      return res.status(500).json({ error: 'Failed to create generic request' });
    }
  });

  // ── POST /identity-update-request — create an identity update deep link ──

  router.post('/identity-update-request', jsonParser({ limit: '100kb' }), async (req: any, res) => {
    // [H2 fix] Rate limit
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
      return res.status(429).json({ error: 'Too many requests' });
    }

    const { identity, updates } = req.body;

    // [M9 fix] Validate inputs
    if (!isValidIdentity(identity)) {
      return res.status(400).json({ error: 'Invalid identity format' });
    }
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return res.status(400).json({ error: 'updates must be an object' });
    }
    if (!primitives) {
      return res.status(503).json({ error: 'Service unavailable' });
    }

    try {
      const responseURIs: any[] = [];
      if (config.callbackUrl) {
        const ResponseURI = primitives.ResponseURI;
        const idUpdateCallbackUrl = config.callbackUrl.replace(/\/verusidlogin$/, '/identity-update-response');
        responseURIs.push(ResponseURI.fromUriString(idUpdateCallbackUrl, ResponseURI.TYPE_POST));
      }

      const identityJson: any = {};
      if (identity.includes('@')) {
        identityJson.name = identity.replace(/@$/, '').split('.')[0];
      } else {
        identityJson.name = identity;
      }

      // Process contentmultimap
      if (updates.contentMultiMap || updates.contentmultimap) {
        const rawMap = updates.contentMultiMap || updates.contentmultimap;
        if (typeof rawMap !== 'object' || Array.isArray(rawMap)) {
          return res.status(400).json({ error: 'contentmultimap must be an object' });
        }
        const processedMap: any = {};
        for (const key in rawMap) {
          // [M9 fix] Validate VDXF key format (should be an i-address)
          if (!/^i[a-zA-Z0-9]{33,34}$/.test(key)) {
            return res.status(400).json({ error: 'Invalid VDXF key format' });
          }
          const val = rawMap[key];
          if (typeof val === 'string' && /^[0-9a-fA-F]+$/.test(val)) {
            processedMap[key] = val;
          } else if (typeof val === 'string') {
            processedMap[key] = Buffer.from(val, 'utf-8').toString('hex');
          } else if (Array.isArray(val)) {
            processedMap[key] = val.map((item: any) => {
              if (typeof item === 'string' && /^[0-9a-fA-F]+$/.test(item)) return item;
              if (typeof item === 'string') return Buffer.from(item, 'utf-8').toString('hex');
              return Buffer.from(JSON.stringify(item), 'utf-8').toString('hex');
            });
          } else if (typeof val === 'object' && val !== null) {
            processedMap[key] = Buffer.from(JSON.stringify(val), 'utf-8').toString('hex');
          } else {
            processedMap[key] = String(val);
          }
        }
        identityJson.contentmultimap = processedMap;
      }

      // [M9 fix] Validate typed fields
      if (updates.primaryaddresses || updates.primaryAddresses) {
        const addrs = updates.primaryaddresses || updates.primaryAddresses;
        if (!isValidAddressArray(addrs)) {
          return res.status(400).json({ error: 'primaryaddresses must be an array of valid R-addresses' });
        }
        identityJson.primaryaddresses = addrs;
      }
      if (updates.flags !== undefined) {
        if (!isValidFlags(updates.flags)) {
          return res.status(400).json({ error: 'flags must be an integer 0-15' });
        }
        identityJson.flags = updates.flags;
      }
      if (updates.minimumsignatures !== undefined) {
        if (!isValidMinSigs(updates.minimumsignatures)) {
          return res.status(400).json({ error: 'minimumsignatures must be an integer 1-13' });
        }
        identityJson.minimumsignatures = updates.minimumsignatures;
      }

      const updateDetails = primitives.IdentityUpdateRequestDetails.fromCLIJson(identityJson);
      const updateDetail = new primitives.IdentityUpdateRequestOrdinalVDXFObject({
        data: updateDetails,
      });

      const requestConfig: any = {
        details: [updateDetail],
        flags: primitives.GenericRequest.BASE_FLAGS,
      };

      if (responseURIs.length > 0) {
        requestConfig.responseURIs = responseURIs;
      }

      const request = new primitives.GenericRequest(requestConfig);
      const deepLink = request.toWalletDeeplinkUri();

      return res.json({
        deep_link: deepLink,
        qr_string: request.toQrString(),
        identity,
        has_callback: !!config.callbackUrl,
      });
    } catch (err: any) {
      // [M4 fix] Don't log stack traces
      console.error('[verus-connect] identity-update-request error:', err.message);
      return res.status(500).json({ error: 'Failed to create identity update request' });
    }
  });

  // ── GET /health — health check ──
  // [L4 fix] Minimal info — don't reveal internal state details

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode,
      primitivesLoaded: !!primitives,
    });
  });

  return router;
}
