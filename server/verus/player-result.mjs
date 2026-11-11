/**
 * Fase 2: het record dat een speler in zijn eigen VerusID publiceert, en de
 * VDXF-key onder de Arcade-namespace waaronder het komt te staan.
 *
 * Principe (Vatermark): data in het ID van de speler, maar onder een key die uit
 * het i-adres van de service (Arcade@) is afgeleid. Iedereen die Arcade@ kent
 * vindt de records; geen andere app kan ze per ongeluk overschrijven.
 *
 * Pure functies zonder I/O; de wallet-request zelf staat in requests.mjs.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.mjs';
import { RESULT_ALGORITHM, inclusionRoot, verifyInclusionProof } from '../result-set.mjs';
import { P, TESTNET_SYSTEM_ID } from './requests.mjs';

export const PLAYER_RESULT_SCHEMA = 'arcade-player-result';
/** v1: volledig (samenvatting + bewezen record + broers als JSON). Blijft leesbaar. */
export const PLAYER_RESULT_VERSION = 1;
/**
 * v2 (11 nov 2026): compact. Alleen wat niet af te leiden is; de verifier bouwt
 * het bewezen resultaatrecord byte-exact opnieuw op. Nodig omdat Verus Mobile
 * deeplinks tot 2045 tekens aanvaardt (v1 ging vanaf 3 spelers per ronde over).
 */
export const PLAYER_RESULT_COMPACT_VERSION = 2;
/** Grens van Vatermark: één signdata-leaf. */
export const PLAYER_RESULT_MAX_BYTES = 2048;

const HEX64 = /^[0-9a-f]{64}$/;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{20,40}$/;

export class PlayerResultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlayerResultError';
    this.code = code;
  }
}

function checkRoundIdForKey(roundId) {
  if (typeof roundId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,120}$/.test(roundId)) {
    throw new PlayerResultError('INVALID_ROUND_ID', 'Round ID is not usable in a VDXF key name');
  }
  return roundId;
}

/** Korte naam van de key voor een ronde, zonder namespace. */
export function playerResultKeyName(roundId) {
  return `arcade.player.result.${checkRoundIdForKey(roundId)}`;
}

/** Fase 2b: korte naam van de key voor de (verzegelde) attestatie van een ronde. */
export function attestationKeyName(roundId) {
  return `arcade.player.attestation.${checkRoundIdForKey(roundId)}`;
}

/**
 * Namespace-prefix uit de volledig gekwalificeerde naam van de service-ID.
 * "Arcade.VRSCTEST@" → "Arcade.VRSCTEST." — de expliciete punt voorkomt dat
 * Mobile of de SDK er stiekem een mainnet-namespace van maakt.
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
 * De content-key voor een ronde: berekend via de korte naam én via de fqn; beide
 * moeten dezelfde key geven, anders klopt de namespace niet.
 * @returns {{ name: string, fqn: string, keyId: string }}
 */
export function playerResultContentKey({ roundId, serviceId, serviceFqn }) {
  return serviceContentKey({ name: playerResultKeyName(roundId), serviceId, serviceFqn });
}

/** Zelfde controle voor elke korte key-naam onder de namespace van de service-ID. */
export function serviceContentKey({ name, serviceId, serviceFqn }) {
  if (typeof serviceId !== 'string' || !I_ADDRESS.test(serviceId)) {
    throw new PlayerResultError('INVALID_SERVICE_ID', 'Service identity i-address is invalid');
  }
  const fqn = `${serviceNamespace(serviceFqn)}::${name}`;
  const viaName = P.getDataKey(name, serviceId, TESTNET_SYSTEM_ID).id;
  const viaFqn = P.getDataKey(fqn, serviceId, TESTNET_SYSTEM_ID).id;
  if (viaName !== viaFqn) {
    throw new PlayerResultError('KEY_MISMATCH', 'Short name and fully qualified name resolve to different keys');
  }
  return { name, fqn, keyId: viaName };
}

/**
 * Bouwt het publicatierecord uit ronde, inclusiebewijs en de bevestigde
 * result-root-transactie. Het bewijs bevat het volledige resultaatrecord
 * (schema 1 of 2) zodat elke verifier de Merkle-inclusie kan nabouwen met
 * shared/ en server/result-set.mjs.
 */
export function buildPlayerResultRecord({ round, proof, resultRootTxid }) {
  if (!round?.round_id || !round.chain_id || !round.game_id || !round.game_version) {
    throw new PlayerResultError('INVALID_ROUND', 'Round record is incomplete');
  }
  if (!verifyInclusionProof(proof)) {
    throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof does not verify');
  }
  if (typeof resultRootTxid !== 'string' || !HEX64.test(resultRootTxid)) {
    throw new PlayerResultError('RESULT_ROOT_UNPUBLISHED', 'Result root transaction is not confirmed yet');
  }
  const record = proof.record;
  if (record.roundId !== round.round_id || record.chainId !== round.chain_id || record.gameId !== round.game_id || record.gameVersion !== round.game_version) {
    throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof belongs to a different round');
  }
  return {
    schema: PLAYER_RESULT_SCHEMA,
    version: PLAYER_RESULT_VERSION,
    round: round.round_id,
    chain: round.chain_id,
    game: round.game_id,
    gameVersion: round.game_version,
    player: record.playerIAddress,
    status: record.status,
    guesses: record.score.guessesUsed,
    resultRoot: proof.rootSha256,
    resultRootTxid,
    proof: {
      algorithm: proof.algorithm,
      record,
      leafIndex: proof.leafIndex,
      leafCount: proof.leafCount,
      siblings: proof.siblings,
    },
  };
}

const ROUND_PARTS = /^([a-z0-9][a-z0-9-]{0,40}):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2}(?:T\d{4})?)$/;
const STATUSES = ['solved', 'unsolved', 'abandoned'];
const COMPACT_KEYS = ['schema', 'version', 'round', 'status', 'guesses', 'sig', 'index', 'count', 'proof'];
const MAX_GUESSES = 6;

/**
 * v2: compact record uit een inclusiebewijs (alleen resultaatschema 2).
 * Velden: ronde, status, gokken ("slate,crane"), handtekening van de speler
 * (`sig`, `sigHeight`) of `sig: null`, positie (`index`, `count`) en de broers
 * als één base64-string (32 bytes elk). Weggelaten want af te leiden: speler (de
 * ID waarin het staat), spel en versie (uit de ronde-ID), netwerk, score, wortel.
 */
export function buildCompactPlayerResultRecord({ round, proof }) {
  if (!round?.round_id || !round.chain_id || !round.game_id || !round.game_version) {
    throw new PlayerResultError('INVALID_ROUND', 'Round record is incomplete');
  }
  if (!verifyInclusionProof(proof)) throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof does not verify');
  const inner = proof.record;
  if (inner.roundId !== round.round_id || inner.chainId !== round.chain_id || inner.gameId !== round.game_id || inner.gameVersion !== round.game_version) {
    throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof belongs to a different round');
  }
  if (inner.schemaVersion !== 2) throw new PlayerResultError('UNSUPPORTED_RECORD', 'Compact records need result schema 2');
  const signature = inner.playerSignature;
  const compact = {
    schema: PLAYER_RESULT_SCHEMA,
    version: PLAYER_RESULT_COMPACT_VERSION,
    round: round.round_id,
    status: inner.status,
    guesses: inner.guesses.map((g) => g.word).join(','),
    sig: signature ? signature.signature : null,
    ...(signature ? { sigHeight: signature.height } : {}),
    index: proof.leafIndex,
    count: proof.leafCount,
    proof: Buffer.concat(proof.siblings.map((x) => Buffer.from(x.sha256, 'hex'))).toString('base64'),
  };
  // Zelfcontrole: uitpakken moet exact het bewezen record en dezelfde wortel geven.
  const expanded = expandCompactPlayerResult(compact, { player: inner.playerIAddress });
  if (canonicalJson(expanded.record) !== canonicalJson(inner) || expanded.resultRoot !== proof.rootSha256) {
    throw new PlayerResultError('INVALID_PROOF', 'Compact record does not reproduce the proven result');
  }
  return compact;
}

/**
 * Pakt een v2-record uit tot het bewezen resultaatrecord en de wortel die uit
 * het bewijs volgt. `player` is de identiteit waarin het record staat.
 * @returns {{ record: object, resultRoot: string, leafIndex: number, leafCount: number }}
 */
export function expandCompactPlayerResult(compact, { player }) {
  const bad = (message) => { throw new PlayerResultError('INVALID_RECORD', message); };
  const keys = compact && typeof compact === 'object' && !Array.isArray(compact) ? Object.keys(compact) : [];
  const expected = compact?.sig === null ? COMPACT_KEYS : [...COMPACT_KEYS, 'sigHeight'];
  if (keys.length !== expected.length || expected.some((k) => !keys.includes(k))) bad('Player result record does not match schema v2');
  if (compact.schema !== PLAYER_RESULT_SCHEMA || compact.version !== PLAYER_RESULT_COMPACT_VERSION) bad('Not a v2 player result record');
  if (!I_ADDRESS.test(player ?? '')) bad('A v2 record needs the identity it is stored in');
  const parts = ROUND_PARTS.exec(compact.round ?? '');
  if (!parts) bad('Invalid round');
  if (!STATUSES.includes(compact.status)) bad('Invalid status');
  const words = compact.guesses === '' ? [] : String(compact.guesses).split(',');
  if (words.length > MAX_GUESSES || words.some((w) => !/^[a-z]{5}$/.test(w))) bad('Invalid guesses');
  let signature = null;
  if (compact.sig !== null) {
    const raw = typeof compact.sig === 'string' ? Buffer.from(compact.sig, 'base64') : Buffer.alloc(0);
    if (raw.length !== 73 || raw.toString('base64') !== compact.sig || !Number.isSafeInteger(compact.sigHeight) || compact.sigHeight < 1) bad('Invalid player signature');
    signature = { height: compact.sigHeight, signature: compact.sig };
  }
  if (!Number.isSafeInteger(compact.index) || !Number.isSafeInteger(compact.count)) bad('Invalid position');
  const path = typeof compact.proof === 'string' ? Buffer.from(compact.proof, 'base64') : null;
  if (!path || path.toString('base64') !== compact.proof || path.length % 32 !== 0) bad('Invalid proof encoding');
  const record = {
    schemaVersion: 2,
    roundId: compact.round,
    chainId: 'vrsctest',
    gameId: parts[1],
    gameVersion: parts[2],
    playerIAddress: player,
    status: compact.status,
    guesses: words.map((word, i) => ({ sequence: i + 1, word })),
    score: { solved: compact.status === 'solved', guessesUsed: words.length },
    playerSignature: signature,
  };
  let index = compact.index;
  const siblings = [];
  for (let offset = 0; offset < path.length; offset += 32) {
    siblings.push({ position: index % 2 === 1 ? 'left' : 'right', sha256: path.subarray(offset, offset + 32).toString('hex') });
    index = Math.floor(index / 2);
  }
  const resultRoot = inclusionRoot({ algorithm: RESULT_ALGORITHM, record, leafIndex: compact.index, leafCount: compact.count, siblings });
  if (!resultRoot) throw new PlayerResultError('INVALID_PROOF', 'Inclusion proof does not verify');
  return { record, resultRoot, leafIndex: compact.index, leafCount: compact.count };
}

/** Controleert een (teruggelezen) record: vorm, bewijs, en samenhang tussen de velden. */
export function validatePlayerResultRecord(record) {
  const keys = ['schema', 'version', 'round', 'chain', 'game', 'gameVersion', 'player', 'status', 'guesses', 'resultRoot', 'resultRootTxid', 'proof'];
  if (
    !record || typeof record !== 'object' || Array.isArray(record) ||
    Object.keys(record).length !== keys.length || keys.some((k) => !(k in record)) ||
    record.schema !== PLAYER_RESULT_SCHEMA || record.version !== PLAYER_RESULT_VERSION ||
    typeof record.round !== 'string' || record.chain !== 'vrsctest' ||
    typeof record.game !== 'string' || typeof record.gameVersion !== 'string' ||
    !I_ADDRESS.test(record.player ?? '') ||
    !['solved', 'unsolved', 'abandoned'].includes(record.status) ||
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

/** Canonieke JSON (JCS-volgorde) + grootte-controle. */
export function serializePlayerResultRecord(record, { player } = {}) {
  if (record?.version === PLAYER_RESULT_COMPACT_VERSION) expandCompactPlayerResult(record, { player });
  else validatePlayerResultRecord(record);
  const json = canonicalJson(record);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > PLAYER_RESULT_MAX_BYTES) {
    throw new PlayerResultError('RECORD_TOO_LARGE', `Record is ${bytes} bytes; the limit is ${PLAYER_RESULT_MAX_BYTES}`);
  }
  return { json, bytes, sha256: createHash('sha256').update(json, 'utf8').digest('hex') };
}

/** Leest een teruggelezen record (tekst of bytes) en controleert het; gooit bij afwijking. */
export function parsePlayerResultRecord(text, { player } = {}) {
  const json = Buffer.isBuffer(text) ? text.toString('utf8') : String(text);
  if (Buffer.byteLength(json, 'utf8') > PLAYER_RESULT_MAX_BYTES) {
    throw new PlayerResultError('RECORD_TOO_LARGE', 'Published record exceeds the size limit');
  }
  let record;
  try {
    record = JSON.parse(json);
  } catch {
    throw new PlayerResultError('INVALID_RECORD', 'Published record is not JSON');
  }
  if (record?.version !== PLAYER_RESULT_COMPACT_VERSION) {
    validatePlayerResultRecord(record);
    return record;
  }
  // v2: dezelfde samenvattende velden als v1, afgeleid uit het uitgepakte record.
  const expanded = expandCompactPlayerResult(record, { player });
  return {
    schema: PLAYER_RESULT_SCHEMA,
    version: PLAYER_RESULT_COMPACT_VERSION,
    round: expanded.record.roundId,
    chain: expanded.record.chainId,
    game: expanded.record.gameId,
    gameVersion: expanded.record.gameVersion,
    player: expanded.record.playerIAddress,
    status: expanded.record.status,
    guesses: expanded.record.score.guessesUsed,
    resultRoot: expanded.resultRoot,
    resultRootTxid: null,
    proof: { algorithm: RESULT_ALGORITHM, record: expanded.record, leafIndex: expanded.leafIndex, leafCount: expanded.leafCount },
    compact: record,
  };
}
