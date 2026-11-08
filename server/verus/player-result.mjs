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
import { verifyInclusionProof } from '../result-set.mjs';
import { P, TESTNET_SYSTEM_ID } from './requests.mjs';

export const PLAYER_RESULT_SCHEMA = 'arcade-player-result';
export const PLAYER_RESULT_VERSION = 1;
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

/** Korte naam van de key voor een ronde, zonder namespace. */
export function playerResultKeyName(roundId) {
  if (typeof roundId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.:_-]{0,120}$/.test(roundId)) {
    throw new PlayerResultError('INVALID_ROUND_ID', 'Round ID is not usable in a VDXF key name');
  }
  return `arcade.player.result.${roundId}`;
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
  if (typeof serviceId !== 'string' || !I_ADDRESS.test(serviceId)) {
    throw new PlayerResultError('INVALID_SERVICE_ID', 'Service identity i-address is invalid');
  }
  const name = playerResultKeyName(roundId);
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
export function serializePlayerResultRecord(record) {
  validatePlayerResultRecord(record);
  const json = canonicalJson(record);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > PLAYER_RESULT_MAX_BYTES) {
    throw new PlayerResultError('RECORD_TOO_LARGE', `Record is ${bytes} bytes; the limit is ${PLAYER_RESULT_MAX_BYTES}`);
  }
  return { json, bytes, sha256: createHash('sha256').update(json, 'utf8').digest('hex') };
}

/** Leest een teruggelezen record (tekst of bytes) en controleert het; gooit bij afwijking. */
export function parsePlayerResultRecord(text) {
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
  validatePlayerResultRecord(record);
  return record;
}
