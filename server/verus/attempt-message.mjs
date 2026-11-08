/**
 * Het bericht dat een speler tekent voor zijn afgeronde poging (fase 1).
 *
 * Vast profiel, vier regels, zodat een handtekening nooit voor iets anders
 * hergebruikt kan worden en een verifier het zonder context kan herkennen:
 *
 *   Verus Arcade attempt v1
 *   round:word-grid:1.0.0:2026-10-20
 *   player:i4hktkkrvYoUfLZpXWQU5hagpnJuFSaNLp
 *   actions:sha256:<64 hex>
 *
 * De actions-hash is sha256 van de canonieke JSON van de gokken, exact zoals
 * ze in het resultaatrecord staan: [{ "sequence": 1, "word": "CRANE" }, ...].
 * Zo bindt de handtekening de speler aan precies die invoer, en kan een
 * verifier met record + handtekening controleren dat de speler die invoer
 * heeft goedgekeurd.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../canonical-json.mjs';

export const ATTEMPT_MESSAGE_TITLE = 'Verus Arcade attempt v1';

const ROUND_ID = /^[a-z0-9][a-z0-9-]{0,40}:\d+\.\d+\.\d+:\d{4}-\d{2}-\d{2}$/;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PROFILE = new RegExp(
  `^${ATTEMPT_MESSAGE_TITLE.replace(/ /g, ' ')}\\n`
  + 'round:([a-z0-9][a-z0-9-]{0,40}:\\d+\\.\\d+\\.\\d+:\\d{4}-\\d{2}-\\d{2})\\n'
  + 'player:(i[1-9A-HJ-NP-Za-km-z]{33})\\n'
  + 'actions:sha256:([0-9a-f]{64})$',
);

/** sha256 (hex) van de canonieke JSON van de gokken. */
export function actionsSha256(guesses) {
  if (!Array.isArray(guesses)) throw new Error('guesses must be an array');
  const normalized = guesses.map((g, index) => {
    if (!Number.isSafeInteger(g?.sequence) || g.sequence < 1 || typeof g?.word !== 'string' || !g.word) {
      throw new Error(`invalid guess at index ${index}`);
    }
    return { sequence: g.sequence, word: g.word };
  });
  for (let i = 1; i < normalized.length; i++) {
    if (normalized[i].sequence <= normalized[i - 1].sequence) throw new Error('guess sequences must be strictly increasing');
  }
  return crypto.createHash('sha256').update(canonicalJson(normalized), 'utf8').digest('hex');
}

/** Bouwt het te tekenen bericht. Gooit bij ongeldige onderdelen. */
export function buildAttemptMessage({ roundId, playerIAddress, actionsSha256: hash }) {
  if (typeof roundId !== 'string' || !ROUND_ID.test(roundId)) throw new Error('invalid roundId');
  if (typeof playerIAddress !== 'string' || !I_ADDRESS.test(playerIAddress)) throw new Error('invalid playerIAddress');
  if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error('invalid actions hash');
  return `${ATTEMPT_MESSAGE_TITLE}\nround:${roundId}\nplayer:${playerIAddress}\nactions:sha256:${hash}`;
}

/** Parseert en valideert een bericht; geeft null als het niet aan het profiel voldoet. */
export function parseAttemptMessage(message) {
  if (typeof message !== 'string' || message.length > 400) return null;
  const match = PROFILE.exec(message);
  if (!match) return null;
  return { roundId: match[1], playerIAddress: match[2], actionsSha256: match[3] };
}

/** Controleert dat een bericht exact bij een poging hoort. */
export function attemptMessageMatches(message, { roundId, playerIAddress, guesses }) {
  const parsed = parseAttemptMessage(message);
  return !!parsed
    && parsed.roundId === roundId
    && parsed.playerIAddress === playerIAddress
    && parsed.actionsSha256 === actionsSha256(guesses);
}
