/**
 * Fase 4: de chain lezen zonder onze server, via een (publieke) Verus-RPC.
 *
 * Gedeeld tussen browser, server en de losse verifier: geen Node-imports, alleen
 * `fetch`. Standaard `https://api.verustest.net` (CORS `*`, gemeten 14 nov 2026);
 * de gebruiker kan een eigen daemon opgeven.
 *
 * Regels (fase-4-ontwerp):
 *  - Alleen VRSCTEST: `getinfo` moet de VRSCTEST-chain tonen, anders WRONG_CHAIN.
 *  - Grenzen zoals Vatermark: één tijdsbudget per lezer (12 s), hooguit 32 waarden
 *    per key per venster en 1024 history-items. Over een grens = LIMIT_EXCEEDED.
 *  - Een leesfout (RPC weg, time-out, grens, vreemd antwoord) is "niet beschikbaar",
 *    nooit "ongeldig": een RPC-fout bewijst geen fraude. `isUnavailable()` zegt welke.
 *  - Lezen in een hoogtevenster (`heightAtTime`, `windowForTimes`) in plaats van de
 *    hele geschiedenis: `Arcade@` krijgt elke dag nieuwe updates.
 *
 * Eén lezer = één controle: het tijdsbudget loopt vanaf het aanmaken.
 */

export const VRSCTEST_CHAIN_ID = 'iJhCezBExJHvtyH3fGhNnt2NhU4Ztkf2yq';
export const DEFAULT_RPC_URL = 'https://api.verustest.net';
export const LIMITS = Object.freeze({ timeMs: 12_000, valuesPerKey: 32, historyEntries: 1024 });

/** Uitkomst van één onderdeel van een controle. */
export const STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  PENDING: 'pending',
  MISSING: 'missing',
  UNAVAILABLE: 'unavailable',
  INVALID: 'invalid',
});

/** RPC-foutcode van de daemon voor "geen informatie over deze transactie". */
const RPC_NOT_FOUND = -5;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
const TXID = /^[0-9a-f]{64}$/;

/** @typedef {'UNAVAILABLE'|'RPC_ERROR'|'TIMEOUT'|'LIMIT_EXCEEDED'|'WRONG_CHAIN'|'INVALID_INPUT'} ChainReadErrorCode */

export class ChainReadError extends Error {
  /**
   * @param {ChainReadErrorCode} code
   * @param {string} message
   * @param {{ rpcCode?: number | null }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ChainReadError';
    /** @type {ChainReadErrorCode} */
    this.code = code;
    /** @type {number | null} */
    this.rpcCode = extra.rpcCode ?? null;
  }
}

/**
 * Hoort deze fout bij "niet beschikbaar" (lezen lukte niet)? Alleen een verkeerde
 * chain of een fout in onze eigen invoer is iets anders.
 * @param {unknown} error
 */
export function isUnavailable(error) {
  return error instanceof ChainReadError && error.code !== 'WRONG_CHAIN' && error.code !== 'INVALID_INPUT';
}

/** @param {string} message */
const unavailable = (message) => new ChainReadError('UNAVAILABLE', message);

/** @param {unknown} value @param {string} what */
function checkIAddress(value, what) {
  if (typeof value !== 'string' || !I_ADDRESS.test(value)) throw new ChainReadError('INVALID_INPUT', `Invalid ${what}`);
}

/** @param {number} fromHeight @param {number} toHeight */
function checkRange(fromHeight, toHeight) {
  if (!Number.isSafeInteger(fromHeight) || !Number.isSafeInteger(toHeight) || fromHeight < 0 || toHeight < fromHeight) {
    throw new ChainReadError('INVALID_INPUT', 'Invalid height range');
  }
}

/**
 * @typedef {{ txid: string, vout: number | null, height: number, contentmultimap: Record<string, unknown[]> }} HistoryEntry
 * @typedef {{ tip: number, chainId: string, version: string }} ChainInfo
 */

/**
 * @param {{
 *   url?: string,
 *   fetch?: (url: string, init: RequestInit) => Promise<Response>,
 *   now?: () => number,
 *   limits?: Partial<{ timeMs: number, valuesPerKey: number, historyEntries: number }>,
 *   contentType?: string,
 * }} [options]
 */
export function createChainReader(options = {}) {
  const url = options.url ?? DEFAULT_RPC_URL;
  let parsed;
  try { parsed = new URL(url); } catch { throw new ChainReadError('INVALID_INPUT', 'Invalid RPC URL'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new ChainReadError('INVALID_INPUT', 'RPC URL must be http(s)');
  // `fetch` los aanroepen geeft in browsers "Illegal invocation": daarom binden.
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? (() => Date.now());
  const limits = { ...LIMITS, ...options.limits };
  // text/plain is een "simple request": geen CORS-preflight per aanroep. De daemon kijkt niet naar het type.
  const contentType = options.contentType ?? 'text/plain';
  const startedAt = now();
  const deadline = startedAt + limits.timeMs;
  let calls = 0;
  /** @type {Promise<ChainInfo> | null} */
  let infoPromise = null;
  /** @type {Map<number, number>} */
  const blockTimes = new Map();

  /**
   * Eén JSON-RPC-aanroep binnen het tijdsbudget.
   * @param {string} method
   * @param {unknown[]} [params]
   * @returns {Promise<any>}
   */
  async function call(method, params = []) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new ChainReadError('TIMEOUT', `Time budget of ${limits.timeMs} ms used up`);
    calls += 1;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(remaining) : undefined;
    /** @type {Response} */
    let response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: JSON.stringify({ jsonrpc: '1.0', id: calls, method, params }),
        signal,
      });
    } catch (error) {
      const name = /** @type {{ name?: string }} */ (error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ChainReadError('TIMEOUT', `RPC timed out (${method})`);
      throw unavailable(`RPC not reachable (${method})`);
    }
    let body;
    try { body = await response.json(); } catch { throw unavailable(`RPC returned no JSON (${method}, HTTP ${response.status})`); }
    // De daemon geeft een RPC-fout soms met HTTP 500, de publieke RPC met 200: eerst naar `error` kijken.
    if (body && typeof body === 'object' && body.error) {
      const rpcCode = Number(body.error.code);
      throw new ChainReadError('RPC_ERROR', `${method}: ${String(body.error.message ?? 'error').slice(0, 200)}`, { rpcCode: Number.isFinite(rpcCode) ? rpcCode : null });
    }
    if (!response.ok || !body || typeof body !== 'object' || !('result' in body)) throw unavailable(`RPC returned no result (${method}, HTTP ${response.status})`);
    return body.result;
  }

  /** Chain, hoogte en versie; weigert alles wat geen VRSCTEST is. Eén keer per lezer. */
  function info() {
    infoPromise ??= (async () => {
      const result = await call('getinfo');
      if (result?.chainid !== VRSCTEST_CHAIN_ID || result?.testnet !== true || result?.name !== 'VRSCTEST') {
        throw new ChainReadError('WRONG_CHAIN', 'This RPC does not serve VRSCTEST');
      }
      if (!Number.isSafeInteger(result.blocks) || result.blocks < 1) throw unavailable('RPC returned an invalid height');
      return { tip: result.blocks, chainId: result.chainid, version: String(result.VRSCversion ?? result.version ?? '') };
    })();
    // Een mislukte poging niet onthouden: een volgende aanroep mag opnieuw proberen.
    infoPromise.catch(() => { infoPromise = null; });
    return infoPromise;
  }

  /** @param {number} height @returns {Promise<number>} blocktijd in seconden */
  async function blockTime(height) {
    const cached = blockTimes.get(height);
    if (cached !== undefined) return cached;
    const block = await call('getblock', [String(height)]);
    if (block?.height !== height || !Number.isSafeInteger(block?.time)) throw unavailable('RPC returned an invalid block');
    blockTimes.set(height, block.time);
    return block.time;
  }

  /**
   * Een hoogte rond tijdstip `unixSeconds`: het blok dat er hoogstens `tolerance`
   * blokken vóór ligt (nooit erna, tenzij het tijdstip vóór blok 1 ligt).
   * Interpolatie met halveren als terugval: ±5 aanroepen op 1,3 miljoen blokken.
   * @param {number} unixSeconds
   * @param {{ tolerance?: number }} [options]
   */
  async function heightAtTime(unixSeconds, { tolerance = 30 } = {}) {
    if (!Number.isFinite(unixSeconds)) throw new ChainReadError('INVALID_INPUT', 'Invalid time');
    const { tip } = await info();
    let lo = 1;
    let hi = tip;
    let tLo = await blockTime(lo);
    let tHi = await blockTime(hi);
    if (unixSeconds <= tLo) return lo;
    if (unixSeconds > tHi) return hi;
    let interpolate = true;
    while (hi - lo > Math.max(1, tolerance)) {
      const width = hi - lo;
      let mid = interpolate && tHi > tLo
        ? lo + Math.round(((unixSeconds - tLo) / (tHi - tLo)) * width)
        : lo + Math.floor(width / 2);
      mid = Math.min(hi - 1, Math.max(lo + 1, mid));
      const tMid = await blockTime(mid);
      if (tMid < unixSeconds) { lo = mid; tLo = tMid; } else { hi = mid; tHi = tMid; }
      // Halveerde de interpolatie het interval niet, dan de volgende stap halveren.
      interpolate = !interpolate || hi - lo <= width / 2;
    }
    return lo;
  }

  /**
   * Hoogtevenster voor een tijdsbereik (milliseconden), begrensd door de tip.
   * @param {{ fromMs: number, toMs: number, tolerance?: number }} range
   */
  async function windowForTimes({ fromMs, toMs, tolerance = 30 }) {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) throw new ChainReadError('INVALID_INPUT', 'Invalid time range');
    const { tip } = await info();
    const fromHeight = await heightAtTime(Math.floor(fromMs / 1000), { tolerance });
    const toHeight = Math.min(tip, (await heightAtTime(Math.ceil(toMs / 1000), { tolerance })) + tolerance);
    return { fromHeight, toHeight, tip };
  }

  /**
   * De verschillende waarden onder één key van een identiteit in een hoogtevenster,
   * in volgorde van eerste voorkomen. `getidentitycontent` voegt de updates in het
   * venster samen en herhaalt daarbij een waarde bij elke update die ze meeneemt
   * (gemeten 14 nov: 27 waarden, 10 verschillende); de grens geldt voor verschillende.
   * @param {{ identityId: string, keyId: string, fromHeight: number, toHeight: number }} query
   * @returns {Promise<{ values: unknown[], rawCount: number, fullyQualifiedName: string | null }>}
   */
  async function identityContent({ identityId, keyId, fromHeight, toHeight }) {
    checkIAddress(identityId, 'identity');
    checkIAddress(keyId, 'key');
    checkRange(fromHeight, toHeight);
    const content = await call('getidentitycontent', [identityId, fromHeight, toHeight, false, toHeight, keyId]);
    if (content?.identity?.identityaddress !== identityId) throw unavailable('RPC returned another identity');
    const raw = content.identity.contentmultimap?.[keyId] ?? [];
    if (!Array.isArray(raw)) throw unavailable('RPC returned malformed content');
    const seen = new Set();
    const values = raw.filter((value) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (values.length > limits.valuesPerKey) {
      throw new ChainReadError('LIMIT_EXCEEDED', `More than ${limits.valuesPerKey} different values under one key in this window`);
    }
    return { values, rawCount: raw.length, fullyQualifiedName: typeof content.fullyqualifiedname === 'string' ? content.fullyqualifiedname : null };
  }

  /**
   * Updates van een identiteit in een hoogtevenster, oudste eerst, elk met de
   * volledige contentmultimap van dat moment (zo vind je de tx van een waarde).
   * @param {{ identityId: string, fromHeight: number, toHeight: number }} query
   * @returns {Promise<HistoryEntry[]>}
   */
  async function identityHistory({ identityId, fromHeight, toHeight }) {
    checkIAddress(identityId, 'identity');
    checkRange(fromHeight, toHeight);
    const reply = await call('getidentityhistory', [identityId, fromHeight, toHeight, false]);
    const entries = Array.isArray(reply?.history) ? reply.history : null;
    if (!entries) throw unavailable('RPC returned no identity history');
    if (entries.length > limits.historyEntries) {
      throw new ChainReadError('LIMIT_EXCEEDED', `More than ${limits.historyEntries} history entries in this window`);
    }
    return entries.map((/** @type {any} */ entry) => {
      const txid = entry?.output?.txid;
      if (typeof txid !== 'string' || !TXID.test(txid) || !Number.isSafeInteger(entry?.height)
        || entry?.identity?.identityaddress !== identityId) {
        throw unavailable('RPC returned a malformed history entry');
      }
      const cmm = entry.identity.contentmultimap;
      return {
        txid,
        vout: Number.isSafeInteger(entry.output.voutnum) ? entry.output.voutnum : null,
        height: entry.height,
        contentmultimap: cmm && typeof cmm === 'object' ? cmm : {},
      };
    }).sort((/** @type {HistoryEntry} */ a, /** @type {HistoryEntry} */ b) => a.height - b.height);
  }

  /**
   * Bevestigingen van een transactie, of `null` als de RPC haar niet kent.
   * @param {string} txid
   * @returns {Promise<{ confirmations: number, height: number | null } | null>}
   */
  async function transaction(txid) {
    if (typeof txid !== 'string' || !TXID.test(txid)) throw new ChainReadError('INVALID_INPUT', 'Invalid transaction ID');
    try {
      const tx = await call('getrawtransaction', [txid, 1]);
      if (!tx || typeof tx !== 'object' || (tx.txid !== undefined && tx.txid !== txid)) throw unavailable('RPC returned another transaction');
      return {
        confirmations: Number.isSafeInteger(tx.confirmations) && tx.confirmations > 0 ? tx.confirmations : 0,
        height: Number.isSafeInteger(tx.height) ? tx.height : null,
      };
    } catch (error) {
      if (error instanceof ChainReadError && error.code === 'RPC_ERROR' && error.rpcCode === RPC_NOT_FOUND) return null;
      throw error;
    }
  }

  /**
   * Een identiteit (nu, of zoals ze was op `height`), gecontroleerd op ID, chain en hoogte.
   * @param {{ identityId: string, height?: number }} query
   */
  async function identity({ identityId, height }) {
    checkIAddress(identityId, 'identity');
    if (height !== undefined && (!Number.isSafeInteger(height) || height < 1)) throw new ChainReadError('INVALID_INPUT', 'Invalid height');
    const record = await call('getidentity', height === undefined ? [identityId] : [identityId, height]);
    const id = record?.identity;
    if (!id || id.identityaddress !== identityId || id.systemid !== VRSCTEST_CHAIN_ID || !Number.isSafeInteger(record.blockheight)
      || (height !== undefined && record.blockheight > height) || typeof record.status !== 'string') {
      throw unavailable('RPC returned mismatched identity state');
    }
    return record;
  }

  /** Waar en hoeveel er gelezen is, voor de bronvermelding op de pagina. */
  function stats() {
    return { url, calls, elapsedMs: now() - startedAt, budgetMs: limits.timeMs };
  }

  return { url, call, info, blockTime, heightAtTime, windowForTimes, identityContent, identityHistory, transaction, identity, stats };
}

/**
 * De eerste update (oudste eerst) waarin `value` onder `keyId` staat: daar is de
 * waarde op de chain gezet. `null` als ze in deze geschiedenis niet voorkomt.
 * @param {HistoryEntry[]} history
 * @param {string} keyId
 * @param {unknown} value
 */
export function firstUpdateWithValue(history, keyId, value) {
  const wanted = JSON.stringify(value);
  for (const entry of history) {
    const values = entry.contentmultimap?.[keyId];
    if (Array.isArray(values) && values.some((v) => JSON.stringify(v) === wanted)) return entry;
  }
  return null;
}

/**
 * Een waarde zoals onze operator ze schrijft (UTF-8-JSON als hex) terug naar een object.
 * `null` als het geen hex-JSON is (bijvoorbeeld een DataDescriptor-object).
 * @param {unknown} value
 */
export function decodeHexJson(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}
