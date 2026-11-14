/**
 * Fase 5: de actie-bundel van een speler nagaan met alleen de chain.
 *
 * Invoer: de ronde zoals `verifyRoundIndependently` / `verifyRoundsTogether`
 * haar van Arcade@ las (commitment met versleuteladres, reveal met de salt) en,
 * als het er is, het bewezen resultaatrecord van de speler. Dan:
 *
 *  1. De waarde(n) onder `arcade.player.bundle.<ronde>` in de ID van de speler,
 *     met de transactie waarin ze verschenen.
 *  2. Verzegeld? De verwijzing mag GEEN viewing key dragen (anders was de bundel
 *     publiek leesbaar tijdens de ronde).
 *  3. Vóór de reveal? Blok van de bundel-tx < blok van de reveal-tx (blokvolgorde
 *     is een hard feit; kloktijd is hooguit informatie).
 *  4. Ontsleutelen met de sleutel uit de onthulde salt (shared/round-key.mjs).
 *  5. Van deze speler en deze ronde; ontvangstbewijs van Arcade@ geldig.
 *  6. Naspelen met de regels tegen de onthulde puzzel.
 *  7. Gelijk aan het officiële resultaat (zelfde zetten, zelfde status).
 *
 * Een verzoek kan meer dan eens goedgekeurd worden (rooktest 15 nov): er kunnen
 * dus meerdere waarden staan. De oudste telt; latere worden gemeld als dubbel.
 */
import { ActionBundleError, actionBundleKeyId, bundleMatchesRecord, parseActionBundle, replayActionBundle, verifyBundleReceipt } from './action-bundle.mjs';
import { ChainReadError, firstUpdateWithValue, isUnavailable } from './chain-reader.mjs';
import { ARCADE_OPERATOR_ID, VERDICT } from './independent-round.mjs';
import { roundKeyFromSalt } from './round-key.mjs';
import { definitionPuzzle } from './round-proof.mjs';
import { DATA_DESCRIPTOR_KEY, DecryptError, FLAG_ENCRYPTED, FLAG_IVK, readMobileRecord } from './verus-decrypt.mjs';

const MAX_VALUES = 32;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * Oordelen over een bundel.
 *  verified        alles klopt (en gelijk aan het officiële resultaat, als dat er is)
 *  late            klopt, maar pas ná de reveal op de chain gezet: bewijst geen tijdstip
 *  invalid         aantoonbaar fout (ontvangstbewijs, naspelen of resultaat klopt niet, of niet verzegeld)
 *  unreadable      er staat iets onder de key, maar de ronde-sleutel opent het niet
 *  not-found       de speler zette geen bundel in zijn ID
 *  pending         de ronde is nog niet (geldig) onthuld: nog niets te lezen
 *  not-applicable  deze ronde heeft geen versleuteladres (commitment-schema 1)
 *  unavailable     de chain was niet te lezen
 */
export const BUNDLE_VERDICT = Object.freeze({
  VERIFIED: 'verified', LATE: 'late', INVALID: 'invalid', UNREADABLE: 'unreadable', NOT_FOUND: 'not-found',
  PENDING: 'pending', NOT_APPLICABLE: 'not-applicable', UNAVAILABLE: 'unavailable',
});

/**
 * @typedef {{
 *   verdict: string, problems: string[],
 *   keyId: string | null, valuesUnderKey: number, duplicates: number,
 *   txid: string | null, height: number | null, revealHeight: number | null,
 *   sealed: boolean | null, sealedBeforeReveal: boolean | null,
 *   actions: string[] | null, receipt: 'valid' | 'invalid' | 'unavailable' | null,
 *   replay: { status: string, actionsUsed: number, finished: boolean } | null,
 *   matchesResult: 'ok' | 'mismatch' | 'absent' | 'not-checked' | null,
 * }} BundleCheck
 */

/**
 * @param {{
 *   playerId: string,
 *   roundId: string,
 *   round: { verdict: string, parts: { commitment: { value: any, height: number | null }, reveal: { value: any, height: number | null } } },
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   officialRecord?: any,
 *   serviceId?: string,
 * }} input  `round`: de uitkomst van de onafhankelijke rondecontrole; `officialRecord`: het bewezen
 *           resultaatrecord van deze speler (wortel al nagekeken); `null` als de speler aantoonbaar
 *           NIET in het officiële resultaat staat; weglaten als dat niet nagekeken is.
 * @returns {Promise<BundleCheck>}
 */
export async function verifyPlayerBundleIndependently({ playerId, roundId, round, reader, officialRecord, serviceId = ARCADE_OPERATOR_ID }) {
  if (typeof playerId !== 'string' || !I_ADDRESS.test(playerId)) throw new ChainReadError('INVALID_INPUT', 'Player must be an i-address');
  /** @type {BundleCheck} */
  const result = {
    verdict: BUNDLE_VERDICT.UNAVAILABLE, problems: [], keyId: null, valuesUnderKey: 0, duplicates: 0,
    txid: null, height: null, revealHeight: null, sealed: null, sealedBeforeReveal: null,
    actions: null, receipt: null, replay: null, matchesResult: null,
  };
  const finish = (/** @type {string} */ verdict, /** @type {string} */ problem = '') => {
    result.verdict = verdict;
    if (problem) result.problems.push(problem);
    return result;
  };
  const message = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error));

  const commitment = round?.parts?.commitment;
  const reveal = round?.parts?.reveal;
  if (commitment?.value?.schemaVersion !== 2 || typeof commitment.value.roundEncryptionAddress !== 'string') return finish(BUNDLE_VERDICT.NOT_APPLICABLE);
  result.keyId = actionBundleKeyId({ roundId, serviceId });

  // 1. Wat staat er onder de key, en sinds welke transactie?
  /** @type {Array<{ value: any, entry: import('./chain-reader.mjs').HistoryEntry }>} */
  const found = [];
  try {
    const info = await reader.info();
    const content = await reader.call('getidentitycontent', [playerId, 0, info.tip, false, info.tip, result.keyId]);
    if (content?.identity?.identityaddress !== playerId) throw new ChainReadError('UNAVAILABLE', 'RPC returned another identity');
    const all = content.identity.contentmultimap?.[result.keyId];
    const unique = [...new Map((Array.isArray(all) ? all : []).slice(0, MAX_VALUES).map((v) => [JSON.stringify(v), v])).values()];
    result.valuesUnderKey = unique.length;
    if (unique.length > 0) {
      const history = await reader.identityHistory({ identityId: playerId, fromHeight: Math.max(0, (commitment.height ?? 1) - 1), toHeight: info.tip });
      for (const value of unique) {
        const entry = firstUpdateWithValue(history, result.keyId, value);
        if (entry) found.push({ value, entry });
      }
      found.sort((a, b) => a.entry.height - b.entry.height);
    }
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    return finish(BUNDLE_VERDICT.UNAVAILABLE, `player identity: ${message(error)}`);
  }
  if (found.length === 0) return finish(BUNDLE_VERDICT.NOT_FOUND);

  // Zonder geldige reveal is er geen sleutel: we weten alleen dát er iets staat.
  const first = found[0];
  result.txid = first.entry.txid;
  result.height = first.entry.height;
  result.duplicates = found.length - 1;
  if (round.verdict !== VERDICT.VERIFIED || !reveal?.value?.hiddenDefinition || !Number.isSafeInteger(reveal.height)) return finish(BUNDLE_VERDICT.PENDING);
  result.revealHeight = reveal.height;

  // 2–4. De oudste waarde die met de ronde-sleutel opent en een bundel is.
  const definition = reveal.value.hiddenDefinition;
  const { ivk } = roundKeyFromSalt(definition.salt);
  const getTransaction = async (/** @type {string} */ txid) => {
    const tx = await reader.call('getrawtransaction', [txid, 1]);
    if (tx?.txid !== undefined && tx.txid !== txid) throw new ChainReadError('UNAVAILABLE', 'RPC returned another transaction');
    return tx;
  };
  /** @type {{ bundle: ReturnType<typeof parseActionBundle>, entry: import('./chain-reader.mjs').HistoryEntry, sealed: boolean } | null} */
  let opened = null;
  let readable = 0;
  for (const { value, entry } of found) {
    const descriptor = value && typeof value === 'object' ? value[DATA_DESCRIPTOR_KEY] : null;
    const flags = Number(descriptor?.flags);
    if (!descriptor || !(flags & FLAG_ENCRYPTED)) continue;
    try {
      const record = await readMobileRecord({ value, updateTxid: entry.txid, getTransaction, ivk });
      const bundle = parseActionBundle(record.bytes);
      readable += 1;
      if (!opened) opened = { bundle, entry, sealed: !record.ivkPublished && (flags & FLAG_IVK) === 0 };
    } catch (error) {
      if (error instanceof DecryptError || error instanceof ActionBundleError) continue;
      if (!isUnavailable(error)) throw error;
      return finish(BUNDLE_VERDICT.UNAVAILABLE, `bundle transaction: ${message(error)}`);
    }
  }
  if (!opened) return finish(BUNDLE_VERDICT.UNREADABLE, 'the round key does not open what is stored under the bundle key');
  const { bundle, entry } = opened;
  result.txid = entry.txid;
  result.height = entry.height;
  result.duplicates = readable - 1;
  result.actions = bundle.actions;
  result.sealed = opened.sealed;
  result.sealedBeforeReveal = entry.height < /** @type {number} */ (reveal.height);
  if (!opened.sealed) result.problems.push('the bundle was stored with its viewing key: it was publicly readable');

  // 5. Van deze speler en ronde; ontvangstbewijs van Arcade@.
  if (bundle.player !== playerId) result.problems.push('the bundle names another player');
  if (bundle.round !== roundId) result.problems.push('the bundle names another round');
  if (bundle.ackHeight > entry.height) {
    result.receipt = 'invalid';
    result.problems.push('the receipt is dated after the bundle transaction');
  } else {
    try {
      const identityAtHeight = await reader.identity({ identityId: serviceId, height: bundle.ackHeight });
      const check = verifyBundleReceipt({ bundle, serviceId, identityAtHeight });
      result.receipt = check.valid ? 'valid' : 'invalid';
      if (!check.valid) result.problems.push(`receipt: ${check.reason}`);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      result.receipt = 'unavailable';
      return finish(BUNDLE_VERDICT.UNAVAILABLE, `operator identity: ${message(error)}`);
    }
  }

  // 6. Naspelen tegen de onthulde puzzel.
  const replay = replayActionBundle(bundle, definitionPuzzle(definition));
  if (replay.ok) result.replay = { status: replay.status, actionsUsed: replay.actionsUsed, finished: replay.finished };
  else result.problems.push(`replay: ${replay.reason}`);

  // 7. Gelijk aan het officiële resultaat.
  if (officialRecord === undefined) {
    result.matchesResult = 'not-checked';
  } else if (officialRecord === null) {
    result.matchesResult = 'absent';
    // Met een geldig ontvangstbewijs is dit een bewijs tegen de operator: hij aanvaardde de zetten maar nam ze niet op.
    if (result.receipt === 'valid') result.problems.push('Arcade@ acknowledged these actions, but the player is not in the official result');
  } else {
    const expected = officialRecord.status === 'abandoned' ? 'unsolved' : officialRecord.status;
    const same = bundleMatchesRecord(bundle, officialRecord) && replay.ok && replay.status === expected;
    result.matchesResult = same ? 'ok' : 'mismatch';
    if (!same) result.problems.push('the bundle differs from the official result');
  }

  if (result.problems.length > 0) return finish(BUNDLE_VERDICT.INVALID);
  return finish(result.sealedBeforeReveal ? BUNDLE_VERDICT.VERIFIED : BUNDLE_VERDICT.LATE);
}
