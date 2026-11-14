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
  ALWAYS_DISCLOSED, ATTESTATION_FIELDS, ATTESTATION_SCHEMA, ATTESTATION_VERSION, DISCLOSURE_VERSION, fail, NO_PREVIOUS, parseDailyRoundId,
} from '../shared/attestation.mjs';
import { buildSaltedMmrDescriptor, decodeMmrHashes, HASH_SHA256 } from '../shared/verus-mmr.mjs';

// Het lezen van attestaties en deellinks staat sinds fase 4 in shared/attestation.mjs
// (ook voor de browser en de losse verifier); hier doorgegeven zodat bestaande imports werken.
export {
  ALWAYS_DISCLOSED, ATTESTATION_FIELDS, ATTESTATION_SCHEMA, ATTESTATION_VERSION, AttestationError, decodeDisclosureLink,
  DISCLOSURE_VERSION, expandSealedRecord, NO_PREVIOUS, parseDailyRoundId, readAttestationDisclosure, readDisclosurePayload,
} from '../shared/attestation.mjs';

const I_ADDRESS = /^i[1-9A-HJ-NP-Za-km-z]{33}$/;
const HEX32 = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => new Uint8Array(crypto.createHash('sha256').update(bytes).digest());
const utf8 = (text) => new TextEncoder().encode(text);

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

// ---- Deellink (selective disclosure voor een derde) --------------------------

function fieldValue(datadescriptor, name) {
  const text = Buffer.from(datadescriptor.objectdata, 'hex').toString('utf8');
  if (!text.startsWith(`${name}:`)) fail('Stored field out of order');
  return text.slice(name.length + 1);
}

/**
 * Inhoud van een deellink: het compacte verzegelde record (zoals in de ID van
 * de speler) en alleen de gekozen velden als [naam, waarde, zout (base64)].
 * `player` en `round` gaan altijd mee.
 */
export function buildDisclosurePayload({ record, descriptor, fields }) {
  const wanted = new Set([...ALWAYS_DISCLOSED, ...fields]);
  for (const name of wanted) if (!ATTESTATION_FIELDS.includes(name)) fail(`Unknown field: ${name}`);
  return {
    v: DISCLOSURE_VERSION,
    record,
    fields: ATTESTATION_FIELDS.flatMap((name, i) => (wanted.has(name)
      ? [[name, fieldValue(descriptor.datadescriptors[i], name), Buffer.from(descriptor.datadescriptors[i].salt, 'hex').toString('base64')]]
      : [])),
  };
}

export function encodeDisclosureLink(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
