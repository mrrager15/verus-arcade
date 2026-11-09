/**
 * Fase 2, profiel: alle Arcade-resultaten van een speler, puur uit de chain.
 *
 * We lezen de volledige contentmultimap van de spelersidentiteit en houden
 * alleen waarden over die (a) een geldig `arcade-player-result`-record zijn,
 * (b) onder precies de key staan die bij hun ronde hoort in de namespace van
 * Arcade@, en (c) voor deze speler zijn. Zo kan niemand een record van iemand
 * anders of onder een vreemde key als het zijne tonen. De database komt er
 * niet aan te pas: dit is wat elke onafhankelijke verifier ook kan doen.
 */
import { createHash } from 'node:crypto';

import { contentValueId, firstAppearance, resolveContentValue } from './player-result-reader.mjs';
import { parsePlayerResultRecord, playerResultContentKey } from './player-result.mjs';

const sha256hex = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * @param {{ playerId: string, content: object, history: object[]|null, serviceId: string, serviceFqn: string }} input
 * @returns {{ playerId: string, results: object[], ignored: number }}
 */
export async function collectPlayerResults({ playerId, content, history, serviceId, serviceFqn, decrypt = null }) {
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
      try { record = parsePlayerResultRecord(resolved.bytes); } catch { ignored += 1; continue; }
      let expectedKey;
      try { expectedKey = playerResultContentKey({ roundId: record.round, serviceId, serviceFqn }).keyId; } catch { ignored += 1; continue; }
      if (expectedKey !== keyId || record.player !== playerId) { ignored += 1; continue; }
      results.push({
        round: record.round,
        game: record.game,
        gameVersion: record.gameVersion,
        status: record.status,
        guesses: record.guesses,
        resultRoot: record.resultRoot,
        resultRootTxid: record.resultRootTxid,
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
