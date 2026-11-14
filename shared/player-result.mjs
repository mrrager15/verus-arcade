/**
 * Spelersresultaatrecords lezen en nakijken (fase 2, v2 compact sinds 11 nov,
 * v3 voor elke game sinds fase 8). Gedeeld door server, browser en losse
 * verifier (fase 4): geen Buffer, geen node:crypto, geen SDK.
 *
 * Records *maken* (build…, serialize…) en de key via de SDK blijven in
 * server/verus/player-result.mjs, die deze functies doorgeeft.
 */
import { canonicalJson } from './canonical-json.mjs';
import { gameRules } from './games/index.mjs';
import { inclusionRoot, isCanonicalBase64, RESULT_ALGORITHM, toHex, verifyInclusionProof } from './result-set.mjs';
import { vdxfDataKey } from './vdxf-key.mjs';

export const PLAYER_RESULT_SCHEMA = 'arcade-player-result';
/** v1: volledig (samenvatting + bewezen record + broers als JSON). Blijft leesbaar. */
export const PLAYER_RESULT_VERSION = 1;
/**
 * v2 (11 nov 2026): compact. Alleen wat niet af te leiden is; de verifier bouwt
 * het bewezen resultaatrecord byte-exact opnieuw op. Nodig omdat Verus Mobile
 * deeplinks tot 2045 tekens aanvaardt (v1 ging vanaf 3 spelers per ronde over).
 */
export const PLAYER_RESULT_COMPACT_VERSION = 2;
/** v3 (fase 8): compact record voor resultaatschema 3 (elke game); `actions` in plaats van `guesses`. */
export const PLAYER_RESULT_COMPACT_V3 = 3;
export const COMPACT_VERSIONS = Object.freeze([PLAYER_RESULT_COMPACT_VERSION, PLAYER_RESULT_COMPACT_V3]);
/** Grens van Vatermark: één signdata-leaf. */
export const PLAYER_RESULT_MAX_BYTES = 2048;

const HEX64 = /^[0-9a-f]{64}$/;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{20,40}$/;
const ROUND_PARTS = /^([a-z0-9][a-z0-9-]{0,40}):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2}(?:T\d{4})?)$/;
const STATUSES = ['solved', 'unsolved', 'abandoned'];
const COMPACT_KEYS = ['schema', 'version', 'round', 'status', 'guesses', 'sig', 'index', 'count', 'proof'];
const COMPACT_KEYS_V3 = ['schema', 'version', 'round', 'status', 'actions', 'sig', 'index', 'count', 'proof'];
const MAX_GUESSES = 6;

export class PlayerResultError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PlayerResultError';
    this.code = code;
  }
}

/** @param {string} roundId */
function checkRoundIdForKey(roundId) {
  if (typeof roundId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,120}$/.test(roundId)) {
    throw new PlayerResultError('INVALID_ROUND_ID', 'Round ID is not usable in a VDXF key name');
  }
  return roundId;
}

/** Korte naam van de key voor een ronde, zonder namespace. @param {string} roundId */
export function playerResultKeyName(roundId) {
  return `arcade.player.result.${checkRoundIdForKey(roundId)}`;
}

/** Fase 2b: korte naam van de key voor de (verzegelde) attestatie van een ronde. @param {string} roundId */
export function attestationKeyName(roundId) {
  return `arcade.player.attestation.${checkRoundIdForKey(roundId)}`;
}

/**
 * Namespace-prefix uit de volledig gekwalificeerde naam van de service-ID.
 * "Arcade.VRSCTEST@" → "Arcade.VRSCTEST." — de expliciete punt voorkomt dat
 * Mobile of de SDK er stiekem een mainnet-namespace van maakt.
 * @param {string} serviceFqn
 */
export function serviceNamespace(serviceFqn) {
  if (typeof serviceFqn !== 'string' || !/^[^@\s]+@$/.test(serviceFqn)) {
    throw new PlayerResultError('INVALID_SERVICE_FQN', 'Service identity name must be fully qualified and end with @');
  }
  const bare = serviceFqn.slice(0, -1).replace(/\.$/, '');
  if (!/\.VRSCTEST$/i.test(bare)) {
    throw new PlayerResultError('UNSUPPORTED_NETWORK', 'Only a VRSCTEST service identity is supported');
  }
  return `${bare}.`;
}

/**
 * De content-key (i-adres) van het resultaat van een ronde in de namespace van
 * de service-ID, zonder SDK (shared/vdxf-key.mjs; gelijk aan getDataKey).
 * @param {{ roundId: string, serviceId: string }} input
 */
export function playerResultKeyId({ roundId, serviceId }) {
  if (typeof serviceId !== 'string' || !I_ADDRESS.test(serviceId)) {
    throw new PlayerResultError('INVALID_SERVICE_ID', 'Service identity i-address is invalid');
  }
  return vdxfDataKey(playerResultKeyName(roundId), serviceId);
}

/** Canonieke base64 ontleden; null als het dat niet is. @param {unknown} text */
function base64Bytes(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null;
  let binary;
  try { binary = atob(text); } catch { return null; }
  if (btoa(binary) !== text) return null;
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Pakt een v2/v3-record uit tot het bewezen resultaatrecord en de wortel die uit
 * het bewijs volgt. `player` is de identiteit waarin het record staat.
 * @param {any} compact
 * @param {{ player: string }} context
 * @returns {{ record: any, resultRoot: string, leafIndex: number, leafCount: number }}
 */
export function expandCompactPlayerResult(compact, { player }) {
  const bad = (/** @type {string} */ message) => { throw new PlayerResultError('INVALID_RECORD', message); };
  const keys = compact && typeof compact === 'object' && !Array.isArray(compact) ? Object.keys(compact) : [];
  const v3 = compact?.version === PLAYER_RESULT_COMPACT_V3;
  const base = v3 ? COMPACT_KEYS_V3 : COMPACT_KEYS;
  const expected = compact?.sig === null ? base : [...base, 'sigHeight'];
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) bad(`Player result record does not match schema v${v3 ? 3 : 2}`);
  if (compact.schema !== PLAYER_RESULT_SCHEMA || !COMPACT_VERSIONS.includes(compact.version)) bad('Not a compact player result record');
  if (!I_ADDRESS.test(player ?? '')) bad('A compact record needs the identity it is stored in');
  const parts = /** @type {RegExpExecArray} */ (ROUND_PARTS.exec(compact.round ?? ''));
  if (!parts) bad('Invalid round');
  if (!STATUSES.includes(compact.status)) bad('Invalid status');
  /** @type {string[]} */
  let words = [];
  /** @type {string[]} */
  let values = [];
  if (v3) {
    /** @type {any} */
    let rules;
    try { rules = gameRules(parts[1], parts[2]); } catch (error) { bad(error instanceof Error ? error.message : String(error)); }
    values = compact.actions === '' ? [] : String(compact.actions).split(',');
    if (values.length > rules.meta.maxActions) bad('Too many actions');
    for (const value of values) {
      let canonical = null;
      try { canonical = rules.normalizeAction(value); } catch { /* ongeldig */ }
      if (canonical !== value) bad('Invalid actions');
    }
  } else {
    words = compact.guesses === '' ? [] : String(compact.guesses).split(',');
    if (words.length > MAX_GUESSES || words.some((w) => !/^[a-z]{5}$/.test(w))) bad('Invalid guesses');
  }
  let signature = null;
  if (compact.sig !== null) {
    if (!isCanonicalBase64(compact.sig, 73) || !Number.isSafeInteger(compact.sigHeight) || compact.sigHeight < 1) bad('Invalid player signature');
    signature = { height: compact.sigHeight, signature: compact.sig };
  }
  if (!Number.isSafeInteger(compact.index) || !Number.isSafeInteger(compact.count)) bad('Invalid position');
  const path = base64Bytes(compact.proof);
  if (!path || path.length % 32 !== 0) return bad('Invalid proof encoding');
  const common = { roundId: compact.round, chainId: 'vrsctest', gameId: parts[1], gameVersion: parts[2], playerIAddress: player, status: compact.status };
  const record = v3
    ? {
        schemaVersion: 3, ...common,
        actions: values.map((value, i) => ({ sequence: i + 1, value })),
        score: { solved: compact.status === 'solved', actionsUsed: values.length },
        playerSignature: signature,
      }
    : {
        schemaVersion: 2, ...common,
        guesses: words.map((word, i) => ({ sequence: i + 1, word })),
        score: { solved: compact.status === 'solved', guessesUsed: words.length },
        playerSignature: signature,
      };
  let index = compact.index;
  const siblings = [];
  for (let offset = 0; offset < path.length; offset += 32) {
    siblings.push({ position: index % 2 === 1 ? 'left' : 'right', sha256: toHex(path.subarray(offset, offset + 32)) });
    index = Math.floor(index / 2);
  }
  const resultRoot = inclusionRoot({ algorithm: RESULT_ALGORITHM, record, leafIndex: compact.index, leafCount: compact.count, siblings });
  if (!resultRoot) throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof does not verify');
  return { record, resultRoot, leafIndex: compact.index, leafCount: compact.count };
}

/** Controleert een (teruggelezen) v1-record: vorm, bewijs, en samenhang tussen de velden. @param {any} record */
export function validatePlayerResultRecord(record) {
  const keys = ['schema', 'version', 'round', 'chain', 'game', 'gameVersion', 'player', 'status', 'guesses', 'resultRoot', 'resultRootTxid', 'proof'];
  if (
    !record || typeof record !== 'object' || Array.isArray(record) ||
    Object.keys(record).length !== keys.length || keys.some((k) => !(k in record)) ||
    record.schema !== PLAYER_RESULT_SCHEMA || record.version !== PLAYER_RESULT_VERSION ||
    typeof record.round !== 'string' || record.chain !== 'vrsctest' ||
    typeof record.game !== 'string' || typeof record.gameVersion !== 'string' ||
    !I_ADDRESS.test(record.player ?? '') ||
    !STATUSES.includes(record.status) ||
    !Number.isSafeInteger(record.guesses) || record.guesses < 0 ||
    !HEX64.test(record.resultRoot ?? '') || !HEX64.test(record.resultRootTxid ?? '') ||
    !record.proof || typeof record.proof !== 'object' || Object.keys(record.proof).length !== 5
  ) {
    throw new PlayerResultError('INVALID_RECORD', 'Player result record does not match schema v1');
  }
  const proof = { ...record.proof, rootSha256: record.resultRoot };
  if (!verifyInclusionProof(proof)) throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof does not verify');
  const inner = record.proof.record;
  if (
    inner.roundId !== record.round || inner.chainId !== record.chain || inner.gameId !== record.game ||
    inner.gameVersion !== record.gameVersion || inner.playerIAddress !== record.player ||
    inner.status !== record.status || inner.score.guessesUsed !== record.guesses
  ) {
    throw new PlayerResultError('INVALID_RECORD', 'Record summary does not match the proven result record');
  }
  return true;
}

/**
 * Leest een teruggelezen record (tekst of bytes) en controleert het; gooit bij afwijking.
 * @param {string | Uint8Array} text
 * @param {{ player?: string }} [context]
 */
export function parsePlayerResultRecord(text, { player } = {}) {
  const json = text instanceof Uint8Array ? new TextDecoder().decode(text) : String(text);
  if (new TextEncoder().encode(json).length > PLAYER_RESULT_MAX_BYTES) {
    throw new PlayerResultError('RECORD_TOO_LARGE', 'Published record exceeds the size limit');
  }
  let record;
  try {
    record = JSON.parse(json);
  } catch {
    throw new PlayerResultError('INVALID_RECORD', 'Published record is not JSON');
  }
  if (!COMPACT_VERSIONS.includes(record?.version)) {
    validatePlayerResultRecord(record);
    return record;
  }
  // v2/v3: dezelfde samenvattende velden als v1, afgeleid uit het uitgepakte record.
  const expanded = expandCompactPlayerResult(record, { player: /** @type {string} */ (player) });
  return {
    schema: PLAYER_RESULT_SCHEMA,
    version: record.version,
    round: expanded.record.roundId,
    chain: expanded.record.chainId,
    game: expanded.record.gameId,
    gameVersion: expanded.record.gameVersion,
    player: expanded.record.playerIAddress,
    status: expanded.record.status,
    guesses: expanded.record.score.guessesUsed ?? expanded.record.score.actionsUsed,
    actionsUsed: expanded.record.score.guessesUsed ?? expanded.record.score.actionsUsed,
    resultRoot: expanded.resultRoot,
    resultRootTxid: null,
    proof: { algorithm: RESULT_ALGORITHM, record: expanded.record, leafIndex: expanded.leafIndex, leafCount: expanded.leafCount },
    compact: record,
  };
}

/** Canonieke JSON van een record (voor sha256 en grootte). @param {any} record */
export const playerResultJson = (record) => canonicalJson(record);
