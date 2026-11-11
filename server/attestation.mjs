/**
 * Fase 2b: attestaties. Na elke afgesloten Daily tekent Arcade@ per speler met
 * een getekende poging een kleine verklaring (streak, aantal rondes, aantal
 * opgelost, vorige attestatie) als MMR met gezouten velden. De speler kan
 * later één veld tonen zonder de andere ("selective disclosure").
 *
 * Regels (STATUS, 11 nov 2026):
 *  - alleen pogingen die de speler zelf tekende (fase 1) tellen mee;
 *  - in de ID van de speler komt alleen de verzegelde vorm (wortel, blad-hashes,
 *    handtekening); waarden en zouten blijven bij Arcade en gaan alleen naar
 *    de speler zelf, want wat Mobile in een ID zet is publiek;
 *  - een openbaarmaking toont altijd `player` en `round` mee, zodat een veld
 *    nooit voor een andere speler of ronde gebruikt kan worden.
 *
 * Dit bestand bevat alleen pure logica; tekenen (stap 4) en opslag (migratie)
 * komen apart.
 */
import crypto from 'node:crypto';

import {
  buildSaltedMmrDescriptor, bytesToHex, decodeMmrHashes, encodeMmrHashes, HASH_SHA256, mmrRoot, verifyMmrDisclosure,
} from '../shared/verus-mmr.mjs';

export const ATTESTATION_SCHEMA = 'arcade-attestation';
export const ATTESTATION_VERSION = 1;
/** Vaste volgorde van de bladeren. Een veld moet op zijn eigen plaats staan. */
export const ATTESTATION_FIELDS = Object.freeze(['player', 'round', 'streak', 'rounds', 'solved', 'prev']);
export const ALWAYS_DISCLOSED = Object.freeze(['player', 'round']);
export const NO_PREVIOUS = 'none';

const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
const DAILY_ROUND = /^([a-z0-9-]+):(\d+\.\d+\.\d+):(\d{4}-\d{2}-\d{2})$/;
const HEX32 = /^[0-9a-f]{64}$/;

export class AttestationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttestationError';
    this.code = code;
  }
}

const fail = (message) => { throw new AttestationError('INVALID_ATTESTATION', message); };
const sha256 = (bytes) => new Uint8Array(crypto.createHash('sha256').update(bytes).digest());
const utf8 = (text) => new TextEncoder().encode(text);

/** `word-grid:1.0.0:2026-11-10` → `{ game, version, date }`. */
export function parseDailyRoundId(roundId) {
  const match = DAILY_ROUND.exec(roundId ?? '');
  if (!match) fail(`Not a Daily round id: ${roundId}`);
  return { game: match[1], version: match[2], date: match[3] };
}

/**
 * Stats van één speler tot en met de laatste ronde in `roundIds`.
 * @param {{ roundIds: string[], attempts: Map<string, { signed: boolean, solved: boolean }> }} input
 *   `roundIds`: alle afgesloten Daily-rondes van dit spel (ook die de speler miste), tot en met
 *   de ronde waarvoor de attestatie is. `attempts`: de pogingen van de speler per ronde.
 * - `rounds`: aantal getekende pogingen; `solved`: daarvan opgelost;
 * - `streak`: aantal rondes op rij, terugtellend vanaf de laatste, met een getekende én
 *   opgeloste poging. Een gemiste, niet getekende of mislukte ronde breekt de reeks.
 *   Een dag zonder ronde (bv. storing bij Arcade) breekt de reeks niet: de reeks volgt
 *   de rondes, niet de kalender.
 */
export function computeDailyStats({ roundIds, attempts }) {
  if (!Array.isArray(roundIds) || roundIds.length === 0) fail('At least one round is required');
  const parsed = roundIds.map((id) => ({ id, ...parseDailyRoundId(id) }));
  const { game, version } = parsed[0];
  if (parsed.some((r) => r.game !== game || r.version !== version)) fail('Rounds of different games cannot be mixed');
  parsed.sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(parsed.map((r) => r.date)).size !== parsed.length) fail('Duplicate round');
  const counted = (id) => {
    const attempt = attempts.get(id);
    return attempt?.signed === true ? attempt : null;
  };
  let rounds = 0;
  let solved = 0;
  for (const { id } of parsed) {
    const attempt = counted(id);
    if (attempt) { rounds += 1; if (attempt.solved === true) solved += 1; }
  }
  let streak = 0;
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (counted(parsed[i].id)?.solved !== true) break;
    streak += 1;
  }
  return { roundId: parsed.at(-1).id, streak, rounds, solved };
}

function fieldValues({ player, roundId, stats, prevRoot }) {
  if (!I_ADDRESS.test(player ?? '')) fail('Player must be an i-address');
  parseDailyRoundId(roundId);
  for (const key of ['streak', 'rounds', 'solved']) {
    if (!Number.isSafeInteger(stats?.[key]) || stats[key] < 0) fail(`${key} must be a non-negative integer`);
  }
  if (stats.streak > stats.solved || stats.solved > stats.rounds) fail('Inconsistent stats');
  const prev = prevRoot ?? NO_PREVIOUS;
  if (prev !== NO_PREVIOUS && !HEX32.test(prev)) fail('prev must be a 32-byte hex root or "none"');
  return { player, round: roundId, streak: String(stats.streak), rounds: String(stats.rounds), solved: String(stats.solved), prev };
}

/**
 * Bouwt de volledige attestatie (met waarden en zouten; privé) en de verzegelde
 * vorm (zonder waarden en zouten; mag publiek).
 * @param {{ player: string, roundId: string, stats: { streak: number, rounds: number, solved: number }, prevRoot?: string|null, salts?: string[] }} input
 *   `salts` alleen voor tests; standaard 32 verse willekeurige bytes per veld.
 */
export function buildAttestation({ player, roundId, stats, prevRoot = null, salts }) {
  const values = fieldValues({ player, roundId, stats, prevRoot });
  if (salts !== undefined && (salts.length !== ATTESTATION_FIELDS.length || salts.some((s) => !HEX32.test(s)))) fail('Invalid salts');
  const entries = ATTESTATION_FIELDS.map((name, i) => ({
    data: utf8(`${name}:${values[name]}`),
    salt: salts ? Uint8Array.from(Buffer.from(salts[i], 'hex')) : new Uint8Array(crypto.randomBytes(32)),
  }));
  const descriptor = buildSaltedMmrDescriptor(entries, sha256);
  return {
    schema: ATTESTATION_SCHEMA,
    version: ATTESTATION_VERSION,
    player,
    roundId,
    values,
    root: descriptor.mmrroot.objectdata,
    descriptor,
    sealed: sealAttestation(descriptor),
  };
}

/** De publieke vorm: zonder waarden en zouten. */
export function sealAttestation(descriptor) {
  const { datadescriptors: _private, ...sealed } = descriptor;
  return structuredClone(sealed);
}

/**
 * Openbaarmaking van enkele velden. `player` en `round` gaan altijd mee.
 * @param {{ descriptor: object }} attestation
 * @param {string[]} fields
 */
export function discloseAttestation(attestation, fields) {
  const wanted = new Set([...ALWAYS_DISCLOSED, ...fields]);
  for (const name of wanted) if (!ATTESTATION_FIELDS.includes(name)) fail(`Unknown field: ${name}`);
  const disclosed = sealAttestation(attestation.descriptor);
  disclosed.datadescriptors = ATTESTATION_FIELDS.flatMap((name, i) => (wanted.has(name) ? [structuredClone(attestation.descriptor.datadescriptors[i])] : []));
  return disclosed;
}

/**
 * Leest en controleert een openbaarmaking (zonder de handtekening; die komt
 * apart, want daarvoor is de identiteit van Arcade@ op tekenhoogte nodig).
 * @returns {{ root: string, fields: Record<string, string> }}
 */
export function readAttestationDisclosure(descriptor) {
  let checked;
  try {
    checked = verifyMmrDisclosure(descriptor, { sha256 });
  } catch (error) {
    fail(error.message);
  }
  if (checked.leafCount !== ATTESTATION_FIELDS.length) fail('Not an Arcade attestation (field count)');
  const fields = {};
  for (const { index, data } of checked.disclosed) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    const colon = text.indexOf(':');
    const name = text.slice(0, colon);
    if (colon < 1 || ATTESTATION_FIELDS[index] !== name) fail('Field is not in its own position');
    if (name in fields) fail('Field disclosed twice');
    fields[name] = text.slice(colon + 1);
  }
  for (const name of ALWAYS_DISCLOSED) if (!(name in fields)) fail(`Disclosure must include ${name}`);
  if (!I_ADDRESS.test(fields.player)) fail('Invalid player');
  parseDailyRoundId(fields.round);
  for (const key of ['streak', 'rounds', 'solved']) if (key in fields && !/^(0|[1-9]\d*)$/.test(fields[key])) fail(`Invalid ${key}`);
  if ('prev' in fields && fields.prev !== NO_PREVIOUS && !HEX32.test(fields.prev)) fail('Invalid prev');
  return { root: checked.root, fields };
}

/**
 * Compacte publieke vorm voor de ID van de speler (Verus Mobile aanvaardt
 * deeplinks tot 2045 tekens). Alleen wat niet af te leiden is: ronde, de zes
 * gezouten blad-hashes, de handtekening en de tekenhoogte. Afleidbaar en dus
 * weggelaten: de wortel (uit de bladeren), de ondertekenaar (de eigenaar van
 * de namespace, Arcade@), het netwerk (VRSCTEST) en de vaste hashtypes.
 */
export function compactSealedRecord({ roundId, descriptor, signaturedata, signatureHeight }) {
  parseDailyRoundId(roundId);
  const sd = signaturedata ?? {};
  if (Number(sd.version) !== 1 || Number(sd.hashtype) !== HASH_SHA256 || Number(sd.signaturetype) !== 1 || sd.signaturehash !== descriptor.mmrroot.objectdata) {
    fail('Unexpected signature shape');
  }
  const leaves = decodeMmrHashes(descriptor.mmrhashes.objectdata);
  if (leaves.length !== ATTESTATION_FIELDS.length) fail('Not an Arcade attestation (field count)');
  if (!Number.isSafeInteger(signatureHeight) || signatureHeight < 1) fail('Invalid signature height');
  return {
    schema: ATTESTATION_SCHEMA,
    version: ATTESTATION_VERSION,
    round: roundId,
    leaves: Buffer.concat(leaves).toString('base64'),
    signature: sd.signature,
    height: signatureHeight,
  };
}

/**
 * Omgekeerde: bouwt uit het compacte record de verzegelde `mmrdescriptor` en de
 * `signaturedata` zoals `signdata` ze geeft, klaar voor `verifysignature` of de SDK.
 * @param {{ serviceId: string, systemId: string }} context ondertekenaar en netwerk
 */
export function expandSealedRecord(record, { serviceId, systemId }) {
  if (record?.schema !== ATTESTATION_SCHEMA || record.version !== ATTESTATION_VERSION) fail('Not an Arcade attestation record');
  parseDailyRoundId(record.round);
  if (typeof record.leaves !== 'string' || typeof record.signature !== 'string' || !Number.isSafeInteger(record.height)) fail('Incomplete attestation record');
  const raw = Buffer.from(record.leaves, 'base64');
  if (raw.toString('base64') !== record.leaves || raw.length !== ATTESTATION_FIELDS.length * 32) fail('Invalid leaves');
  const leaves = Array.from({ length: ATTESTATION_FIELDS.length }, (_, i) => new Uint8Array(raw.subarray(i * 32, (i + 1) * 32)));
  const root = bytesToHex(mmrRoot(leaves, (l, r) => sha256(Buffer.concat([l, r]))));
  return {
    mmrdescriptor: {
      version: 1, objecthashtype: HASH_SHA256, mmrhashtype: HASH_SHA256,
      mmrroot: { version: 1, flags: 0, objectdata: root },
      mmrhashes: { version: 1, flags: 0, objectdata: encodeMmrHashes(leaves) },
    },
    signaturedata: { version: 1, systemid: systemId, hashtype: HASH_SHA256, signaturehash: root, identityid: serviceId, signaturetype: 1, signature: record.signature },
    signatureheight: record.height,
  };
}
