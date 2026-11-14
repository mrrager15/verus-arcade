/**
 * Fase 4: het Arcade-profiel van een speler nagaan met alleen de chain.
 *
 *  1. De contentmultimap en geschiedenis van de spelers-ID lezen (publieke RPC).
 *  2. Elk record openen: Verus Mobile zet ze versleuteld met de viewing key erbij;
 *     `shared/verus-decrypt.mjs` doet wat `decryptdata` doet (die is op de
 *     publieke RPC geblokkeerd).
 *  3. Alleen `arcade-player-result`-records voor deze speler onder precies de key
 *     van hun ronde in de namespace van Arcade@ (`shared/vdxf-key.mjs`).
 *  4. Per ronde, van Arcade@ zelf (`verifyRoundsTogether`): de officiële
 *     result-root (moet gelijk zijn aan die uit het record) en, na een geldige
 *     reveal, de puzzel om het spel na te spelen (`shared/replay.mjs`).
 *
 * Anders dan de server verbergt dit geen record dat niet klopt: het staat erbij
 * als "mismatch" of "replay failed".
 */
import { ChainReadError, isUnavailable } from './chain-reader.mjs';
import { ARCADE_OPERATOR_ID, VERDICT, verifyRoundsTogether } from './independent-round.mjs';
import { parsePlayerResultRecord, playerResultKeyId } from './player-result.mjs';
import { replayResultRecord } from './replay.mjs';
import { definitionPuzzle } from './round-proof.mjs';
import { DATA_DESCRIPTOR_KEY, DecryptError, FLAG_ENCRYPTED, hexToBytes, readMobileRecord } from './verus-decrypt.mjs';

const MAX_VALUES_PER_KEY = 32;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
/** Testronde: ronde-ID met tijdslot (`…:2026-11-11T1524`), op een aparte test-operator. */
const TEST_ROUND = /:\d{4}-\d{2}-\d{2}T\d{4}$/;

/**
 * @typedef {{
 *   round: string, game: string, gameVersion: string, status: string, actionsUsed: number, recordVersion: number,
 *   root: 'ok' | 'mismatch' | 'unknown', officialRoot: string | null, resultRoot: string,
 *   replay: 'ok' | 'failed' | 'pending', replayReason: string | null, roundVerdict: string | null, testRound: boolean,
 *   keyId: string, txid: string | null, height: number | null,
 * }} ProfileResult
 */

/**
 * @param {{
 *   playerId: string,
 *   reader: ReturnType<typeof import('./chain-reader.mjs').createChainReader>,
 *   sha256Hex: (text: string) => Promise<string>,
 *   serviceId?: string,
 * }} input
 */
export async function verifyProfileIndependently({ playerId, reader, sha256Hex, serviceId = ARCADE_OPERATOR_ID }) {
  if (typeof playerId !== 'string' || !I_ADDRESS.test(playerId)) throw new ChainReadError('INVALID_INPUT', 'Player must be an i-address');
  const result = {
    playerId,
    /** @type {string | null} */
    name: null,
    /** @type {string} */
    verdict: 'unavailable',
    /** @type {ProfileResult[]} */
    results: [],
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
      /** @type {Uint8Array} */
      let bytes;
      try {
        if (Number(descriptor.flags) & FLAG_ENCRYPTED) {
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
      try { record = parsePlayerResultRecord(bytes, { player: playerId }); } catch { result.ignored += 1; continue; }
      let expectedKey;
      try { expectedKey = playerResultKeyId({ roundId: record.round, serviceId }); } catch { result.ignored += 1; continue; }
      if (expectedKey !== keyId || record.player !== playerId) { result.ignored += 1; continue; }
      found.push({ record, keyId, txid: entry?.txid ?? null, height: entry?.height ?? null });
    }
  }
  if (found.length === 0) return finish(result.unreadable > 0 ? 'unavailable' : 'empty');

  // 4. Officiële wortel en puzzel per ronde, van Arcade@ zelf.
  /** @type {Awaited<ReturnType<typeof verifyRoundsTogether>> | null} */
  let rounds = null;
  try {
    rounds = await verifyRoundsTogether({ roundIds: found.map((f) => f.record.round), reader, sha256Hex, operatorId: serviceId });
  } catch (error) {
    if (!isUnavailable(error)) throw error;
    result.problems.push(`Arcade@ rounds: ${message(error)}`);
  }
  for (const { record, keyId, txid, height } of found) {
    const evidence = rounds?.get(record.round) ?? null;
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
      testRound: TEST_ROUND.test(record.round) && evidence?.verdict === VERDICT.NOT_FOUND,
      keyId,
      txid,
      height,
    });
  }
  result.results.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.round.localeCompare(a.round));

  // Testrondes (ronde-ID met tijdslot) staan op een aparte test-operator, niet op Arcade@:
  // tonen, maar niet laten meetellen voor "verified".
  const counted = result.results.filter((r) => !r.testRound);
  const bad = counted.some((r) => r.root === 'mismatch' || r.replay === 'failed');
  const complete = counted.length > 0 && counted.every((r) => r.root === 'ok' && r.replay === 'ok');
  return finish(bad ? 'invalid' : complete ? 'verified' : 'partial');
}
