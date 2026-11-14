/**
 * Fase 4: een gedeelde attestatie (deellink) nagaan met alleen de chain.
 *
 *  1. De link lezen: de getoonde velden moeten bij de verzegelde wortel horen
 *     (zonder chain, `shared/attestation.mjs`).
 *  2. `Arcade@` ophalen zoals hij was op de tekenhoogte (via de RPC: alleen de
 *     publieke sleutels).
 *  3. De handtekening over de wortel in de browser zelf controleren
 *     (`shared/verus-signature.mjs`), dus zonder de RPC te moeten geloven op dat punt.
 *
 *  4. Ter informatie: staat precies dit verzegelde record in de VerusID van de
 *     speler? Verus Mobile slaat het daar versleuteld op en de publieke RPC
 *     blokkeert `decryptdata`; we ontsleutelen het zelf (`shared/verus-decrypt.mjs`).
 *
 * Oordeel: verified · invalid (link klopt niet of handtekening niet van Arcade@)
 * · unavailable (chain niet te lezen: géén oordeel) · wrong-chain.
 */
import { AttestationError, decodeDisclosureLink, readDisclosurePayload } from './attestation.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { ChainReadError, firstUpdateWithValue, isUnavailable, VRSCTEST_CHAIN_ID } from './chain-reader.mjs';
import { ARCADE_OPERATOR_ID } from './independent-round.mjs';
import { attestationKeyName } from './player-result.mjs';
import { vdxfDataKey } from './vdxf-key.mjs';
import { DecryptError, readMobileRecord } from './verus-decrypt.mjs';
import { SignatureCheckError, verifyIdentitySignature } from './verus-signature.mjs';

/**
 * @param {{
 *   link: string,
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   serviceId?: string,
 * }} input
 */
export async function verifyAttestationLinkIndependently({ link, reader, serviceId = ARCADE_OPERATOR_ID }) {
  const result = {
    /** @type {string} */
    verdict: 'unavailable',
    /** @type {string | null} */
    problem: null,
    /** @type {string | null} */
    player: null,
    /** @type {string | null} */
    round: null,
    /** @type {Record<string, string>} */
    fields: {},
    /** @type {string | null} */
    root: null,
    signer: serviceId,
    /** @type {number | null} */
    signatureHeight: null,
    /** @type {{ status: string, reason: string | null, primaryAddresses: string[] }} */
    signature: { status: 'unavailable', reason: null, primaryAddresses: [] },
    /**
     * Staat precies dit verzegelde record in de VerusID van de speler? Informatief, geen oordeel.
     * @type {{ status: 'found' | 'absent' | 'unavailable' | 'not-checked', txid: string | null, height: number | null }}
     */
    inPlayerIdentity: { status: 'not-checked', txid: null, height: null },
    /** @type {{ url: string, tip: number | null, version: string | null, calls: number, elapsedMs: number }} */
    source: { url: reader.url, tip: null, version: null, calls: 0, elapsedMs: 0 },
  };
  const finish = (/** @type {string} */ verdict) => {
    result.verdict = verdict;
    const stats = reader.stats();
    result.source.calls = stats.calls;
    result.source.elapsedMs = stats.elapsedMs;
    return result;
  };

  // 1. De link zelf (geen chain nodig).
  let read;
  try {
    read = readDisclosurePayload(decodeDisclosureLink(link), { serviceId, systemId: VRSCTEST_CHAIN_ID });
  } catch (error) {
    if (!(error instanceof AttestationError)) throw error;
    result.problem = `link: ${error.message}`;
    result.signature.status = 'not-checked';
    return finish('invalid');
  }
  const { player, round, ...shown } = read.fields;
  Object.assign(result, { player, round, fields: shown, root: read.root, signatureHeight: read.signatureheight });

  // 2. Arcade@ op tekenhoogte.
  let identityAtHeight;
  try {
    const info = await reader.info();
    result.source.tip = info.tip;
    result.source.version = info.version;
    if (read.signatureheight > info.tip) {
      result.problem = 'signature height is above the chain tip of this RPC';
      return finish('unavailable');
    }
    identityAtHeight = await reader.identity({ identityId: serviceId, height: read.signatureheight });
  } catch (error) {
    if (error instanceof ChainReadError && error.code === 'WRONG_CHAIN') return finish('wrong-chain');
    if (!isUnavailable(error)) throw error;
    result.problem = `chain: ${error instanceof Error ? error.message : String(error)}`;
    return finish('unavailable');
  }
  result.signature.primaryAddresses = [...(identityAtHeight.identity?.primaryaddresses ?? [])];

  // 3. De handtekening, in de browser zelf.
  try {
    const check = verifyIdentitySignature({ signaturedata: read.signaturedata, signatureheight: read.signatureheight, identityAtHeight });
    result.signature.status = check.valid ? 'valid' : 'invalid';
    result.signature.reason = check.reason;
    if (!check.valid) {
      result.problem = `signature: ${check.reason}`;
      return finish('invalid');
    }
  } catch (error) {
    if (!(error instanceof SignatureCheckError)) throw error;
    result.signature.status = 'invalid';
    result.signature.reason = error.message;
    result.problem = `signature: ${error.message}`;
    return finish('invalid');
  }

  // 4. Informatief: staat precies dit verzegelde record in de ID van de speler? Verus Mobile
  //    zet het daar versleuteld; we ontsleutelen het zelf (de publieke RPC kent geen decryptdata).
  result.inPlayerIdentity = await findInPlayerIdentity({ reader, player, round, record: read.record, serviceId, tip: /** @type {number} */ (result.source.tip) });
  return finish('verified');
}

/**
 * @param {{ reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>, player: string, round: string, record: any, serviceId: string, tip: number }} input
 * @returns {Promise<{ status: 'found' | 'absent' | 'unavailable' | 'not-checked', txid: string | null, height: number | null }>}
 */
async function findInPlayerIdentity({ reader, player, round, record, serviceId, tip }) {
  const none = { txid: null, height: null };
  try {
    const keyId = vdxfDataKey(attestationKeyName(round), serviceId);
    const { values } = await reader.identityContent({ identityId: player, keyId, fromHeight: 0, toHeight: tip });
    if (values.length === 0) return { status: 'absent', ...none };
    const history = await reader.identityHistory({ identityId: player, fromHeight: 0, toHeight: tip });
    const expected = canonicalJson(record);
    const getTransaction = (/** @type {string} */ txid) => reader.call('getrawtransaction', [txid, 1]);
    for (const value of values) {
      const entry = firstUpdateWithValue(history, keyId, value);
      if (!entry) continue;
      try {
        const opened = await readMobileRecord({ value, updateTxid: entry.txid, getTransaction });
        if (new TextDecoder().decode(opened.bytes) === expected) return { status: 'found', txid: entry.txid, height: entry.height };
      } catch (error) {
        if (!(error instanceof DecryptError)) throw error;
      }
    }
    return { status: 'absent', ...none };
  } catch (error) {
    if (isUnavailable(error)) return { status: 'unavailable', ...none };
    throw error;
  }
}
