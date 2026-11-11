/**
 * Fase 2, reconcile: leest van de chain of het record van een speler écht in
 * zijn VerusID staat, en koppelt het aan transactie en blokhoogte.
 *
 * Twee stappen (Vatermark-patroon), omdat `getidentitycontent` wel de bytes
 * maar niet de bron-transactie geeft:
 *   1. getidentitycontent(<speler>, …, <key>)   → huidige waarden onder onze key
 *   2. getidentityhistory(<speler>)             → in welke tx/hoogte elke waarde verscheen
 *
 * Een waarde onder de key kan drie vormen hebben; we proberen ze in volgorde:
 *   a. VdxfUniValue met een DataDescriptor (zo schrijft signdata met createmmr)
 *   b. een kale DataDescriptor
 *   c. ruwe UTF-8 (zo schrijft de v1-operator zijn eigen records)
 * Alleen de bytes van het record tellen; de sha256 ervan moet exact gelijk zijn
 * aan wat wij bij het verzoek bewaarden.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.mjs';
import { P } from './requests.mjs';

/** Grenzen uit de Vatermark-review: meer is verdacht of te duur om te lezen. */
export const MAX_RECORDS_PER_KEY = 32;
export const MAX_HISTORY_ENTRIES = 1024;

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

function descriptorData(descriptor) {
  if (!(descriptor instanceof P.DataDescriptor)) return null;
  if (descriptor.hasEncryptedData?.()) return null;
  return Buffer.isBuffer(descriptor.objectdata) ? descriptor.objectdata : null;
}

/**
 * Haalt de record-bytes uit één contentmultimap-waarde (hex). Geeft null als
 * de waarde niet te duiden is; gooit nooit.
 */
export function decodeContentValue(hex) {
  if (typeof hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = Buffer.from(hex, 'hex');
  try {
    const uni = new P.VdxfUniValue();
    const consumed = uni.fromBuffer(bytes, 0);
    if (consumed === bytes.length) {
      for (const entry of uni.values ?? []) {
        for (const value of Object.values(entry)) {
          const data = descriptorData(value);
          if (data) return { kind: 'univalue-descriptor', bytes: data };
        }
      }
    }
  } catch { /* volgende vorm */ }
  try {
    const descriptor = new P.DataDescriptor();
    const consumed = descriptor.fromBuffer(bytes, 0);
    const data = consumed === bytes.length ? descriptorData(descriptor) : null;
    if (data) return { kind: 'descriptor', bytes: data };
  } catch { /* volgende vorm */ }
  if (bytes.length > 0 && bytes.length <= 4096) return { kind: 'raw', bytes };
  return null;
}

/** Vaste sleutel voor een DataDescriptor in de JSON-weergave van de daemon. */
const DATA_DESCRIPTOR_KEY = P.DataDescriptorKey.vdxfid;
const HEX = /^(?:[0-9a-f]{2})*$/i;
const FLAG_ENCRYPTED = 1;

/** Stabiele vergelijkingsvorm voor een waarde (hex-tekst of JSON-object van de daemon). */
export function contentValueId(value) {
  return typeof value === 'string' ? value.toLowerCase() : canonicalJson(value ?? null);
}

/**
 * Transactie en hoogte waarin een waarde onder `keyId` voor het eerst
 * verscheen, uit `getidentityhistory`. Null als niet gevonden.
 */
export function firstAppearance({ history, keyId, value }) {
  const entries = Array.isArray(history) ? history : [];
  if (entries.length > MAX_HISTORY_ENTRIES) throw new Error('CHAIN_UNAVAILABLE: identity history too long');
  const wanted = contentValueId(value);
  const sorted = [...entries].sort((a, b) => Number(a.height ?? a.blockheight ?? 0) - Number(b.height ?? b.blockheight ?? 0));
  for (const entry of sorted) {
    const list = entry?.identity?.contentmultimap?.[keyId];
    if (Array.isArray(list) && list.some((item) => contentValueId(item) === wanted)) {
      const txid = entry.output?.txid ?? entry.txid ?? null;
      const height = Number(entry.height ?? entry.blockheight);
      if (typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid) && Number.isSafeInteger(height) && height > 0) {
        return { txid, height };
      }
    }
  }
  return null;
}

function bytesFromDescriptorJson(descriptor) {
  const data = descriptor?.objectdata;
  if (typeof data === 'string' && HEX.test(data) && data.length > 0) return Buffer.from(data, 'hex');
  if (data && typeof data === 'object' && typeof data.message === 'string') return Buffer.from(data.message, 'utf8');
  return null;
}

/**
 * Haalt de record-bytes uit één waarde zoals `getidentitycontent` hem geeft.
 *
 * Live gezien (9 nov, Verus Mobile + signdata met createmmr): de waarde is een
 * JSON-object `{ <DataDescriptorKey>: { flags: 13, objectdata, epk, ivk } }`,
 * dus een VERSLEUTELDE verwijzing (CrossChainDataRef) met de viewing key erbij.
 * `decryptdata` met `retrieve: true` en de txid van de update geeft dan de
 * gezouten DataDescriptor met het record zelf. `decrypt(descriptor, txid)` is
 * injecteerbaar (VerusRequests.decryptDataDescriptor in productie).
 *
 * @returns {Promise<{ kind: string, bytes: Buffer }|null>} nooit een throw voor onbekende vormen
 */
export async function resolveContentValue(value, { txid = null, decrypt = null } = {}) {
  if (typeof value === 'string') {
    const decoded = decodeContentValue(value);
    return decoded ? { kind: `hex-${decoded.kind}`, bytes: decoded.bytes } : null;
  }
  const descriptor = value && typeof value === 'object' ? value[DATA_DESCRIPTOR_KEY] : null;
  if (!descriptor || typeof descriptor !== 'object') return null;
  const flags = Number(descriptor.flags ?? 0);
  if ((flags & FLAG_ENCRYPTED) === 0) {
    const bytes = bytesFromDescriptorJson(descriptor);
    return bytes ? { kind: 'descriptor-json', bytes } : null;
  }
  if (!decrypt || !txid || typeof descriptor.ivk !== 'string') return null;
  const result = await decrypt(descriptor, txid);
  for (const item of Array.isArray(result) ? result : [result]) {
    const candidates = [item, ...(item && typeof item === 'object' ? Object.values(item) : [])];
    for (const candidate of candidates) {
      const bytes = candidate && typeof candidate === 'object' ? bytesFromDescriptorJson(candidate) : null;
      if (bytes && bytes.length <= 4096) return { kind: 'encrypted-ref', bytes };
    }
  }
  return null;
}

/**
 * Zoekt in de huidige content en de geschiedenis van een identiteit naar het
 * record met de verwachte sha256 onder onze key.
 *
 * @param {{ content: object|null, history: object[]|null, keyId: string, recordSha256: string,
 *           fallbackTxid?: string|null, decrypt?: Function|null }} input
 *   `content` is het `getidentitycontent`-resultaat (gefilterd op de key), `history` de lijst uit
 *   `getidentityhistory`. `fallbackTxid` (bv. het ontvangstbewijs) wordt gebruikt om te ontsleutelen
 *   als de geschiedenis de waarde (nog) niet toont.
 * @returns {Promise<{ found: boolean, valueCount: number, txid: string|null, height: number|null, kinds: string[] }>}
 */
export async function locatePublishedRecord({ content, history, keyId, recordSha256, fallbackTxid = null, decrypt = null }) {
  const values = content?.identity?.contentmultimap?.[keyId] ?? [];
  if (!Array.isArray(values)) throw new Error('CHAIN_UNAVAILABLE: unexpected contentmultimap shape');
  if (values.length > MAX_RECORDS_PER_KEY) throw new Error('CHAIN_UNAVAILABLE: too many records under key');
  const kinds = [];
  for (const value of values) {
    const seen = firstAppearance({ history, keyId, value });
    const resolved = await resolveContentValue(value, { txid: seen?.txid ?? fallbackTxid, decrypt });
    kinds.push(resolved?.kind ?? 'undecodable');
    if (resolved && sha256hex(resolved.bytes) === recordSha256) {
      return { found: true, valueCount: values.length, txid: seen?.txid ?? null, height: seen?.height ?? null, kinds };
    }
  }
  return { found: false, valueCount: values.length, txid: null, height: null, kinds };
}
