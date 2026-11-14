/**
 * Fase 2, profiel: alle Arcade-resultaten van een speler, puur uit de chain.
 *
 * We lezen de volledige contentmultimap van de spelersidentiteit en houden
 * alleen waarden over die (a) een geldig `arcade-player-result`-record zijn,
 * (b) onder precies de key staan die bij hun ronde hoort in de namespace van
 * Arcade@, en (c) voor deze speler zijn, en (d) als de officiële result-root van
 * de ronde bekend is (`resolveRoot`), precies op die wortel uitkomen. (d) is nodig
 * voor compacte v2-records: die nemen de speler over van de identiteit waarin ze
 * staan, dus een gekopieerd record geeft een andere wortel. Zo kan niemand een record van iemand
 * anders of onder een vreemde key als het zijne tonen. De database komt er
 * niet aan te pas: dit is wat elke onafhankelijke verifier ook kan doen.
 */
import { createHash } from 'node:crypto';
import { replayResultRecord } from '../replay.mjs';

import { contentValueId, firstAppearance, resolveContentValue } from './player-result-reader.mjs';
import { parsePlayerResultRecord, playerResultContentKey } from './player-result.mjs';

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * @param {{ playerId: string, content: object, history: object[]|null, serviceId: string, serviceFqn: string }} input
 * @returns {{ playerId: string, results: object[], ignored: number }}
 */
export async function collectPlayerResults({ playerId, content, history, serviceId, serviceFqn, decrypt = null, resolveRoot = null, resolvePuzzle = null }) {
  const cmm = content?.identity?.contentmultimap ?? {};
  const results = [];
  const seenValues = new Set();
  let ignored = 0;
  for (const [keyId, values] of Object.entries(cmm)) {
    if (!Array.isArray(values)) continue;
    for (const value of values.slice(0, 32)) {
      const id = `${keyId}:${contentValueId(value)}`;
      if (seenValues.has(id)) continue;
      seenValues.add(id);
      const appeared = firstAppearance({ history, keyId, value });
      const resolved = await resolveContentValue(value, { txid: appeared?.txid ?? null, decrypt });
      if (!resolved) { ignored += 1; continue; }
      let record;
      // v2-records dragen de speler niet mee: het is de identiteit waarin ze staan.
      try { record = parsePlayerResultRecord(resolved.bytes, { player: playerId }); } catch { ignored += 1; continue; }
      let expectedKey;
      try { expectedKey = playerResultContentKey({ roundId: record.round, serviceId, serviceFqn }).keyId; } catch { ignored += 1; continue; }
      if (expectedKey !== keyId || record.player !== playerId) { ignored += 1; continue; }
      let rootChecked = false;
      if (resolveRoot) {
        const official = await resolveRoot(record.round);
        if (official && official !== record.resultRoot) { ignored += 1; continue; }
        rootChecked = Boolean(official);
      }
      // Fase 8: na de reveal de zetten naspelen met de regels van de game.
      let replay = 'pending';
      if (resolvePuzzle && record.proof?.record) {
        const puzzle = await resolvePuzzle(record.round);
        if (puzzle) replay = replayResultRecord(record.proof.record, puzzle).ok ? 'ok' : 'failed';
      }
      results.push({
        round: record.round,
        game: record.game,
        gameVersion: record.gameVersion,
        status: record.status,
        guesses: record.guesses,
        resultRoot: record.resultRoot,
        resultRootTxid: record.resultRootTxid,
        rootChecked,
        replay,
        contentKey: keyId,
        recordSha256: sha256hex(resolved.bytes),
        storage: resolved.kind,
        txid: appeared?.txid ?? null,
        height: appeared?.height ?? null,
        record,
      });
    }
  }
  results.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.round.localeCompare(a.round));
  return { playerId, results, ignored };
}
