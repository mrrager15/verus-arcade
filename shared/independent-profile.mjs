/**
 * Fase 4: het Arcade-profiel van een speler nagaan met alleen de chain.
 *
 *  1. De contentmultimap en geschiedenis van de spelers-ID lezen (publieke RPC).
 *  2. Elk record openen: Verus Mobile zet ze versleuteld met de viewing key erbij;
 *     `shared/verus-decrypt.mjs` doet wat `decryptdata` doet (die is op de
 *     publieke RPC geblokkeerd).
 *  3. Alleen `arcade-player-result`-records voor deze speler onder precies de key
 *     van hun ronde in de namespace van Arcade@ (`shared/vdxf-key.mjs`).
 *  4. Per ronde, van de operator zelf (`verifyRoundsTogether`): de officiële
 *     result-root (moet gelijk zijn aan die uit het record) en, na een geldige
 *     reveal, de puzzel om het spel na te spelen (`shared/replay.mjs`).
 *  5. Fase 5: verzegelde actie-bundels. Een waarde zonder viewing key kan een
 *     bundel zijn; de ronde volgt uit de key (`shared/bundle-discovery.mjs`), ook
 *     als de speler van die ronde geen resultaat in zijn ID zette. Per bundel het
 *     oordeel van `shared/independent-bundle.mjs`, vergeleken met het bewezen
 *     resultaat als dat er is.
 *
 * Testrondes (ronde-ID met tijdslot) staan op een aparte test-operator-ID: ze
 * worden daar nagekeken en getoond, maar tellen niet mee voor het oordeel.
 *
 * Anders dan de server verbergt dit geen record dat niet klopt: het staat erbij
 * als "mismatch" of "replay failed".
 */
import { ActionBundleError, actionBundleKeyId, parseActionBundle } from './action-bundle.mjs';
import { createBundleRoundFinder } from './bundle-discovery.mjs';
import { ChainReadError, isUnavailable } from './chain-reader.mjs';
import { BUNDLE_VERDICT, verifyPlayerBundleIndependently } from './independent-bundle.mjs';
import { ARCADE_OPERATOR_ID, TEST_OPERATOR_ID, VERDICT, isTestRound, verifyRoundsTogether } from './independent-round.mjs';
import { parsePlayerResultRecord, playerResultKeyId } from './player-result.mjs';
import { replayResultRecord } from './replay.mjs';
import { definitionPuzzle } from './round-proof.mjs';
import { DATA_DESCRIPTOR_KEY, DecryptError, FLAG_ENCRYPTED, FLAG_IVK, hexToBytes, readMobileRecord } from './verus-decrypt.mjs';

const MAX_VALUES_PER_KEY = 32;
/** Meer bundels dan dit per profiel kijken we in één beurt niet na (elk kost enkele RPC-aanroepen). */
const MAX_BUNDLES = 24;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;

/**
 * @typedef {import('./independent-bundle.mjs').BundleCheck} BundleCheck
 * @typedef {{
 *   round: string, game: string, gameVersion: string, status: string, actionsUsed: number, recordVersion: number,
 *   root: 'ok' | 'mismatch' | 'unknown', officialRoot: string | null, resultRoot: string,
 *   replay: 'ok' | 'failed' | 'pending', replayReason: string | null, roundVerdict: string | null, testRound: boolean,
 *   keyId: string, txid: string | null, height: number | null,
 *   bundle: BundleCheck | null,
 * }} ProfileResult
 * @typedef {{ round: string, keyId: string, testRound: boolean, roundVerdict: string | null, check: BundleCheck }} SealedOnly
 */

/**
 * @param {{
 *   playerId: string,
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   serviceId?: string,
 *   testOperatorId?: string,
 * }} input
 */
export async function verifyProfileIndependently({ playerId, reader, sha256Hex, serviceId = ARCADE_OPERATOR_ID, testOperatorId = TEST_OPERATOR_ID }) {
  if (typeof playerId !== 'string' || !I_ADDRESS.test(playerId)) throw new ChainReadError('INVALID_INPUT', 'Player must be an i-address');
  const result = {
    playerId,
    /** @type {string | null} */
    name: null,
    /** @type {string} */
    verdict: 'unavailable',
    /** @type {ProfileResult[]} */
    results: [],
    /** Fase 5: bundels van rondes waarvan de speler geen resultaat in zijn ID zette. @type {SealedOnly[]} */
    sealedOnly: [],
    ignored: 0,
    unreadable: 0,
    /** @type {string[]} */
    problems: [],
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
  const message = (/** @type {unknown} */ error) => (error instanceof Error ? error.message : String(error));

  // 1. De spelers-ID: alle content en de geschiedenis.
  let content;
  let history;
  try {
    const info = await reader.info();
    result.source.tip = info.tip;
    result.source.version = info.version;
    content = await reader.call('getidentitycontent', [playerId, 0, info.tip, false, info.tip]);
    if (content?.identity?.identityaddress !== playerId) throw new ChainReadError('UNAVAILABLE', 'RPC returned another identity');
    history = await reader.identityHistory({ identityId: playerId, fromHeight: 0, toHeight: info.tip });
  } catch (error) {
    if (error instanceof ChainReadError && error.code === 'WRONG_CHAIN') return finish('wrong-chain');
    if (!isUnavailable(error)) throw error;
    result.problems.push(`player identity: ${message(error)}`);
    return finish('unavailable');
  }
  result.name = typeof content.fullyqualifiedname === 'string' ? content.fullyqualifiedname : null;

  // 2–3. Records openen en de Arcade-resultaten eruit halen.
  /** @type {Array<{ record: any, keyId: string, txid: string | null, height: number | null }>} */
  const found = [];
  /** Verzegelde waarden (geen viewing key): key → hoogte van de eerste update. @type {Map<string, number>} */
  const sealedKeys = new Map();
  /** Ronde → key van haar bundel in deze ID. @type {Map<string, string>} */
  const bundleRounds = new Map();
  const getTransaction = async (/** @type {string} */ txid) => {
    const tx = await reader.call('getrawtransaction', [txid, 1]);
    if (tx?.txid !== undefined && tx.txid !== txid) throw new ChainReadError('UNAVAILABLE', 'RPC returned another transaction');
    return tx;
  };
  const cmm = content.identity.contentmultimap ?? {};
  for (const [keyId, values] of Object.entries(cmm)) {
    if (!Array.isArray(values)) continue;
    const seen = new Set();
    for (const value of values.slice(0, MAX_VALUES_PER_KEY)) {
      const id = JSON.stringify(value);
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = history.find((e) => Array.isArray(e.contentmultimap?.[keyId]) && e.contentmultimap[keyId].some((v) => JSON.stringify(v) === id)) ?? null;
      const descriptor = value && typeof value === 'object' ? value[DATA_DESCRIPTOR_KEY] : null;
      if (!descriptor || typeof descriptor !== 'object') { result.ignored += 1; continue; }
      const flags = Number(descriptor.flags);
      // Fase 5: versleuteld zonder viewing key erbij = verzegeld. Dat kan een actie-bundel zijn;
      // welke ronde, volgt verderop uit de key. Lezen kan pas met de sleutel van die ronde.
      if ((flags & FLAG_ENCRYPTED) && !(flags & FLAG_IVK)) {
        if (!entry) { result.ignored += 1; continue; }
        sealedKeys.set(keyId, Math.min(sealedKeys.get(keyId) ?? Infinity, entry.height));
        continue;
      }
      /** @type {Uint8Array} */
      let bytes;
      try {
        if (flags & FLAG_ENCRYPTED) {
          if (!entry) { result.ignored += 1; continue; }
          bytes = (await readMobileRecord({ value, updateTxid: entry.txid, getTransaction })).bytes;
        } else if (typeof descriptor.objectdata === 'string') {
          bytes = hexToBytes(descriptor.objectdata);
        } else { result.ignored += 1; continue; }
      } catch (error) {
        if (error instanceof DecryptError) { result.ignored += 1; continue; }
        if (!isUnavailable(error)) throw error;
        result.unreadable += 1;
        result.problems.push(`record under ${keyId}: ${message(error)}`);
        continue;
      }
      let record;
      try { record = parsePlayerResultRecord(bytes, { player: playerId }); } catch {
        // Een bundel die publiek leesbaar is opgeslagen (met viewing key): de bundelcontrole keurt hem af, maar toont hem wel.
        try {
          const bundle = parseActionBundle(bytes);
          if (bundle.player === playerId && actionBundleKeyId({ roundId: bundle.round, serviceId }) === keyId) { bundleRounds.set(bundle.round, keyId); continue; }
        } catch (error) {
          if (!(error instanceof ActionBundleError)) throw error;
        }
        result.ignored += 1;
        continue;
      }
      let expectedKey;
      try { expectedKey = playerResultKeyId({ roundId: record.round, serviceId }); } catch { result.ignored += 1; continue; }
      if (expectedKey !== keyId || record.player !== playerId) { result.ignored += 1; continue; }
      found.push({ record, keyId, txid: entry?.txid ?? null, height: entry?.height ?? null });
    }
  }

  // 3b. Fase 5: bij elke verzegelde waarde de ronde zoeken. Eerst de rondes die we al kennen
  //     (er staat een resultaat van in de ID), dan via het tijdstip van het blok.
  for (const { record } of found) {
    let keyId;
    try { keyId = actionBundleKeyId({ roundId: record.round, serviceId }); } catch { continue; }
    if (sealedKeys.delete(keyId)) bundleRounds.set(record.round, keyId);
  }
  if (sealedKeys.size > 0) {
    const finder = createBundleRoundFinder({ serviceId });
    for (const [keyId, height] of sealedKeys) {
      try {
        const roundId = finder.find({ keyId, blockTimeMs: (await reader.blockTime(height)) * 1000 });
        if (roundId) bundleRounds.set(roundId, keyId);
        else result.ignored += 1;
      } catch (error) {
        if (!isUnavailable(error)) throw error;
        result.unreadable += 1;
        result.problems.push(`sealed value under ${keyId}: ${message(error)}`);
      }
    }
  }
  if (found.length === 0 && bundleRounds.size === 0) return finish(result.unreadable > 0 ? 'unavailable' : 'empty');

  // 4. Officiële wortel en puzzel per ronde, van de operator zelf: Arcade@, of de test-operator voor testrondes.
  /** @type {Map<string, { verdict: string, parts: any, problems: string[] }>} */
  const rounds = new Map();
  const roundIds = [...new Set([...found.map((f) => f.record.round), ...bundleRounds.keys()])];
  for (const [label, operatorId, ids] of /** @type {Array<[string, string, string[]]>} */ ([
    ['Arcade@ rounds', serviceId, roundIds.filter((id) => !isTestRound(id))],
    ['test rounds', testOperatorId, roundIds.filter((id) => isTestRound(id))],
  ])) {
    if (ids.length === 0) continue;
    try {
      for (const [id, evidence] of await verifyRoundsTogether({ roundIds: ids, reader, sha256Hex, operatorId })) rounds.set(id, evidence);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      result.problems.push(`${label}: ${message(error)}`);
    }
  }
  for (const { record, keyId, txid, height } of found) {
    const evidence = rounds.get(record.round) ?? null;
    const resultsPart = evidence?.parts.results;
    const officialRoot = evidence && evidence.verdict !== VERDICT.INVALID && resultsPart?.status === 'confirmed' ? resultsPart.value.rootSha256 : null;
    /** @type {'ok' | 'failed' | 'pending'} */
    let replay = 'pending';
    /** @type {string | null} */
    let replayReason = null;
    if (evidence?.verdict === VERDICT.VERIFIED && record.proof?.record) {
      try {
        const outcome = replayResultRecord(record.proof.record, definitionPuzzle(evidence.parts.reveal.value.hiddenDefinition));
        replay = outcome.ok ? 'ok' : 'failed';
        replayReason = outcome.ok ? null : outcome.reason;
      } catch (error) {
        replay = 'failed';
        replayReason = message(error);
      }
    }
    result.results.push({
      round: record.round,
      game: record.game,
      gameVersion: record.gameVersion,
      status: record.status,
      actionsUsed: record.actionsUsed ?? record.guesses,
      recordVersion: record.version,
      root: officialRoot === null ? 'unknown' : officialRoot === record.resultRoot ? 'ok' : 'mismatch',
      officialRoot,
      resultRoot: record.resultRoot,
      replay,
      replayReason,
      roundVerdict: evidence?.verdict ?? null,
      testRound: isTestRound(record.round),
      keyId,
      txid,
      height,
      bundle: null,
    });
  }

  // 5. Fase 5: per bundel het onafhankelijke oordeel, vergeleken met het bewezen resultaat als dat er is.
  let checked = 0;
  for (const [roundId, keyId] of bundleRounds) {
    const evidence = rounds.get(roundId) ?? null;
    const own = result.results.find((r) => r.round === roundId) ?? null;
    if (!evidence) continue; // de operator was niet te lezen: staat al bij de problemen
    if (checked >= MAX_BUNDLES) { result.problems.push('more sealed bundles than this check reads in one go'); break; }
    checked += 1;
    const proven = own?.root === 'ok' ? found.find((f) => f.record.round === roundId)?.record.proof?.record : undefined;
    /** @type {BundleCheck} */
    let check;
    try {
      check = await verifyPlayerBundleIndependently({ playerId, roundId, round: evidence, reader, serviceId, ...(proven ? { officialRecord: proven } : {}) });
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      result.problems.push(`bundle of ${roundId}: ${message(error)}`);
      continue;
    }
    // De key paste bij een ronde-ID, maar die ronde kent geen bundels: het was iets anders.
    if (check.verdict === BUNDLE_VERDICT.NOT_APPLICABLE || check.verdict === BUNDLE_VERDICT.NOT_FOUND) { result.ignored += 1; continue; }
    if (own) own.bundle = check;
    else result.sealedOnly.push({ round: roundId, keyId, testRound: isTestRound(roundId), roundVerdict: evidence.verdict, check });
  }

  const order = (/** @type {{ height: number | null, round: string }} */ a, /** @type {{ height: number | null, round: string }} */ b) =>
    (b.height ?? 0) - (a.height ?? 0) || b.round.localeCompare(a.round);
  result.results.sort(order);
  result.sealedOnly.sort((a, b) => order({ height: a.check.height, round: a.round }, { height: b.check.height, round: b.round }));

  // Testrondes tellen niet mee voor "verified". Een bundel die te laat kwam is niet fout
  // (hij bewijst alleen geen tijdstip); een bundel die nog niet te lezen is, maakt het oordeel onvolledig.
  const counted = result.results.filter((r) => !r.testRound);
  const bundles = [...counted.map((r) => r.bundle), ...result.sealedOnly.filter((s) => !s.testRound).map((s) => s.check)].filter((b) => b !== null);
  const settled = (/** @type {BundleCheck} */ b) => b.verdict === BUNDLE_VERDICT.VERIFIED || b.verdict === BUNDLE_VERDICT.LATE;
  const bad = counted.some((r) => r.root === 'mismatch' || r.replay === 'failed') || bundles.some((b) => b.verdict === BUNDLE_VERDICT.INVALID);
  const complete = counted.length + bundles.length > 0 && counted.every((r) => r.root === 'ok' && r.replay === 'ok') && bundles.every(settled);
  return finish(bad ? 'invalid' : complete ? 'verified' : 'partial');
}
