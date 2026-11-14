/**
 * Fase 2: het record dat een speler in zijn eigen VerusID publiceert, en de
 * VDXF-key onder de Arcade-namespace waaronder het komt te staan.
 *
 * Principe (Vatermark): data in het ID van de speler, maar onder een key die uit
 * het i-adres van de service (Arcade@) is afgeleid. Iedereen die Arcade@ kent
 * vindt de records; geen andere app kan ze per ongeluk overschrijven.
 *
 * Het lezen en nakijken van records staat sinds fase 4 in shared/player-result.mjs
 * (ook voor de browser en de losse verifier) en wordt hier doorgegeven. Hier
 * blijven: records maken en de key via de SDK (dubbel gecontroleerd).
 *
 * Pure functies zonder I/O; de wallet-request zelf staat in requests.mjs.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../canonical-json.mjs';
import { verifyInclusionProof } from '../result-set.mjs';
import {
  COMPACT_VERSIONS, expandCompactPlayerResult, PLAYER_RESULT_COMPACT_V3, PLAYER_RESULT_COMPACT_VERSION, PLAYER_RESULT_MAX_BYTES,
  PLAYER_RESULT_SCHEMA, PLAYER_RESULT_VERSION, PlayerResultError, playerResultKeyName, serviceNamespace, validatePlayerResultRecord,
} from '../../shared/player-result.mjs';
import { P, TESTNET_SYSTEM_ID } from './requests.mjs';

export {
  attestationKeyName, expandCompactPlayerResult, parsePlayerResultRecord, PLAYER_RESULT_COMPACT_V3, PLAYER_RESULT_COMPACT_VERSION,
  PLAYER_RESULT_MAX_BYTES, PLAYER_RESULT_SCHEMA, PLAYER_RESULT_VERSION, PlayerResultError, playerResultKeyId, playerResultKeyName,
  serviceNamespace, validatePlayerResultRecord,
} from '../../shared/player-result.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{20,40}$/;

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
 * shared/result-set.mjs.
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

/**
 * v2: compact record uit een inclusiebewijs (resultaatschema 2; v3 voor schema 3).
 * Velden: ronde, status, gokken ("slate,crane") of zetten, handtekening van de speler
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
  if (inner.schemaVersion !== 2 && inner.schemaVersion !== 3) throw new PlayerResultError('UNSUPPORTED_RECORD', 'Compact records need result schema 2 or 3');
  const signature = inner.playerSignature;
  const v3 = inner.schemaVersion === 3;
  const compact = {
    schema: PLAYER_RESULT_SCHEMA,
    version: v3 ? PLAYER_RESULT_COMPACT_V3 : PLAYER_RESULT_COMPACT_VERSION,
    round: round.round_id,
    status: inner.status,
    ...(v3 ? { actions: inner.actions.map((a) => a.value).join(',') } : { guesses: inner.guesses.map((g) => g.word).join(',') }),
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

/** Canonieke JSON (JCS-volgorde) + grootte-controle. */
export function serializePlayerResultRecord(record, { player } = {}) {
  if (COMPACT_VERSIONS.includes(record?.version)) expandCompactPlayerResult(record, { player });
  else validatePlayerResultRecord(record);
  const json = canonicalJson(record);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > PLAYER_RESULT_MAX_BYTES) {
    throw new PlayerResultError('RECORD_TOO_LARGE', `Record is ${bytes} bytes; the limit is ${PLAYER_RESULT_MAX_BYTES}`);
  }
  return { json, bytes, sha256: createHash('sha256').update(json, 'utf8').digest('hex') };
}
