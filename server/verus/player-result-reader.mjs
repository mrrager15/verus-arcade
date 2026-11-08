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

/**
 * Zoekt in de huidige content en de geschiedenis van een identiteit naar het
 * record met de verwachte sha256 onder onze key.
 *
 * @param {{ content: object|null, history: object[]|null, keyId: string, recordSha256: string }} input
 *   `content` is het `getidentitycontent`-resultaat (identity.contentmultimap gefilterd op de key),
 *   `history` de lijst uit `getidentityhistory` (`history`-veld).
 * @returns {{ found: boolean, valueCount: number, txid: string|null, height: number|null, kinds: string[] }}
 */
export function locatePublishedRecord({ content, history, keyId, recordSha256 }) {
  const values = content?.identity?.contentmultimap?.[keyId] ?? [];
  if (!Array.isArray(values)) throw new Error('CHAIN_UNAVAILABLE: unexpected contentmultimap shape');
  if (values.length > MAX_RECORDS_PER_KEY) throw new Error('CHAIN_UNAVAILABLE: too many records under key');
  const kinds = [];
  let matchHex = null;
  for (const hex of values) {
    const decoded = decodeContentValue(hex);
    kinds.push(decoded?.kind ?? 'undecodable');
    if (decoded && sha256hex(decoded.bytes) === recordSha256) { matchHex = hex; break; }
  }
  if (!matchHex) return { found: false, valueCount: values.length, txid: null, height: null, kinds };

  // Koppel aan de eerste geschiedenis-entry waarin precies deze waarde verscheen.
  const entries = Array.isArray(history) ? history : [];
  if (entries.length > MAX_HISTORY_ENTRIES) throw new Error('CHAIN_UNAVAILABLE: identity history too long');
  const sorted = [...entries].sort((a, b) => Number(a.height ?? a.blockheight ?? 0) - Number(b.height ?? b.blockheight ?? 0));
  for (const entry of sorted) {
    const list = entry?.identity?.contentmultimap?.[keyId];
    if (Array.isArray(list) && list.some((hex) => typeof hex === 'string' && hex.toLowerCase() === matchHex.toLowerCase())) {
      const txid = entry.output?.txid ?? entry.txid ?? null;
      const height = Number(entry.height ?? entry.blockheight);
      if (typeof txid === 'string' && /^[0-9a-f]{64}$/.test(txid) && Number.isSafeInteger(height) && height > 0) {
        return { found: true, valueCount: values.length, txid, height, kinds };
      }
    }
  }
  return { found: true, valueCount: values.length, txid: null, height: null, kinds };
}
