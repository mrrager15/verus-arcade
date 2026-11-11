/**
 * Fase 2b: attestaties maken en bewaren voor een afgesloten Daily.
 *
 * Volgorde (zoals de operator het doet): finalize → results bevestigd →
 * `createRoundAttestations` → (reveal mag ervoor of erna). Alleen spelers met
 * een getekende, afgeronde poging in de ronde krijgen een attestatie. De stats
 * tellen alleen getekende pogingen in rondes waarvan de result-root bevestigd
 * is (dus pogingen die écht in een gepubliceerde resultaatset zitten).
 *
 * Keten: `prev` = wortel van de vorige attestatie van dezelfde speler voor
 * hetzelfde spel. Attestaties moeten daarom in rondevolgorde gemaakt worden;
 * een overgeslagen eerdere ronde geeft ATTESTATION_GAP.
 */
import crypto from 'node:crypto';

import {
  ATTESTATION_FIELDS, ATTESTATION_VERSION, AttestationError, buildAttestation, buildDisclosurePayload, compactSealedRecord,
  computeDailyStats, decodeDisclosureLink, encodeDisclosureLink, readDisclosurePayload,
} from './attestation.mjs';
import { canonicalJson } from './canonical-json.mjs';
import { DailyServiceError } from './daily-service.mjs';
import { attestationKeyName, serviceContentKey } from './verus/player-result.mjs';
import { locatePublishedRecord } from './verus/player-result-reader.mjs';
import { TESTNET_SYSTEM_ID } from './verus/requests.mjs';

export class AttestationServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttestationServiceError';
    this.code = code;
  }
}

/** Per ronde: welke speler heeft een getekende, afgeronde poging (en is die opgelost)? */
function countedAttempts(repository, round) {
  const out = new Map();
  if (!repository.getRoundResultSet(round.id)?.resultsTxid) return out;
  const signed = new Set(repository.listRoundAttemptSignatures(round).map((s) => s.attemptId));
  for (const attempt of repository.listRoundAttempts(round)) {
    if (attempt.status !== 'completed' || !signed.has(attempt.id)) continue;
    out.set(attempt.player_i_address, { attemptId: attempt.id, signed: true, solved: Number(attempt.solved) === 1 });
  }
  return out;
}

/**
 * @param {{ repository: import('./db/repository.mjs').ArcadeRepository,
 *           signer: { serviceId: string, signMmrRoot(root: string): Promise<{ signaturedata: object, signatureheight: number }> },
 *           roundRecordId: string, now?: number }} input
 * @returns {Promise<{ round: string, created: object[], skipped: object[] }>}
 */
export async function createRoundAttestations({ repository, signer, roundRecordId, now = Date.now() }) {
  const round = repository.getRound(roundRecordId);
  if (!round) throw new AttestationServiceError('ROUND_NOT_FOUND', 'Round does not exist');
  if (now < Number(round.closes_at_ms)) throw new AttestationServiceError('ROUND_NOT_CLOSED', 'Round has not closed yet');
  if (!repository.getRoundResultSet(round.id)?.resultsTxid) {
    throw new AttestationServiceError('RESULT_ROOT_UNPUBLISHED', 'The result root of this round is not confirmed on chain yet');
  }
  // Alle rondes van dit spel die op of vóór deze ronde sloten (ook lege en gemiste), oud → nieuw.
  const rounds = repository.listRounds({ chainId: round.chain_id, limit: 100_000 })
    .filter((r) => r.game_id === round.game_id && r.game_version === round.game_version && Number(r.closes_at_ms) <= Number(round.closes_at_ms))
    .sort((a, b) => Number(a.opens_at_ms) - Number(b.opens_at_ms));
  const perRound = new Map(rounds.map((r) => [r.id, countedAttempts(repository, r)]));
  const players = [...perRound.get(round.id).keys()].sort();

  const created = [];
  const skipped = [];
  for (const player of players) {
    const existing = repository.getAttestation({ playerIAddress: player, roundRecordId: round.id });
    if (existing) { skipped.push({ player, reason: 'exists', root: existing.root }); continue; }
    const history = repository.listPlayerAttestations({ chainId: round.chain_id, gameId: round.game_id, gameVersion: round.game_version, playerIAddress: player });
    const attested = new Set(history.map((a) => a.roundRecordId));
    const gap = rounds.find((r) => r.id !== round.id && perRound.get(r.id).has(player) && !attested.has(r.id));
    if (gap) throw new AttestationServiceError('ATTESTATION_GAP', `Create the attestations of ${gap.id} first (player ${player})`);
    const previous = history.filter((a) => {
      const r = rounds.find((x) => x.id === a.roundRecordId);
      return r && Number(r.opens_at_ms) < Number(round.opens_at_ms);
    }).at(-1);
    const attempts = new Map(rounds.flatMap((r) => (perRound.get(r.id).has(player) ? [[r.round_id, perRound.get(r.id).get(player)]] : [])));
    const stats = computeDailyStats({ roundIds: rounds.map((r) => r.round_id), attempts });
    const attestation = buildAttestation({ player, roundId: round.round_id, stats, prevRoot: previous?.root ?? null });
    const { signaturedata, signatureheight } = await signer.signMmrRoot(attestation.root);
    if (signaturedata?.signaturehash !== attestation.root || signaturedata.identityid !== signer.serviceId) {
      throw new AttestationServiceError('SIGNATURE_MISMATCH', 'Signer returned a signature over something else');
    }
    const stored = repository.insertAttestation({
      playerIAddress: player, roundRecordId: round.id, attemptId: perRound.get(round.id).get(player).attemptId,
      chainId: round.chain_id, gameId: round.game_id, gameVersion: round.game_version,
      schemaVersion: ATTESTATION_VERSION, descriptor: attestation.descriptor, root: attestation.root,
      prevRoot: previous?.root ?? null, streak: stats.streak, rounds: stats.rounds, solved: stats.solved,
      signaturedata, signatureHeight: signatureheight, now,
    });
    created.push({ player, root: stored.root, prevRoot: stored.prevRoot, streak: stored.streak, rounds: stored.rounds, solved: stored.solved, signatureHeight: stored.signatureHeight });
  }
  return { round: round.id, created, skipped };
}

/** Wat in de ID van de speler mag (publiek, compact): geen waarden, geen zouten. */
export function sealedAttestationRecord(attestation, round) {
  if (round?.id !== attestation.roundRecordId) throw new AttestationServiceError('ROUND_MISMATCH', 'Attestation belongs to another round');
  return compactSealedRecord({ roundId: round.round_id, descriptor: attestation.descriptor, signaturedata: attestation.signaturedata, signatureHeight: attestation.signatureHeight });
}

const WORD_GRID = { chainId: 'vrsctest', gameId: 'word-grid', gameVersion: '1.0.0' };

/**
 * Fase 2b voor de webapp: eigen attestaties tonen, een deellink maken met
 * alleen de gekozen velden, en een deellink controleren (publiek).
 */
export class AttestationService {
  constructor({ repository, verusRequests }) {
    this.repository = repository;
    this.verus = verusRequests;
  }

  #own(principal) {
    if (!principal?.iAddress) throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    return principal.iAddress;
  }

  /** Eigen attestaties, nieuwste eerst. Geen waarden van anderen, geen zouten. */
  listOwn({ principal }) {
    const player = this.#own(principal);
    return {
      fields: ATTESTATION_FIELDS,
      attestations: this.repository.listPlayerAttestations({ ...WORD_GRID, playerIAddress: player }).reverse().map((a) => ({
        roundRecordId: a.roundRecordId,
        attemptId: a.attemptId,
        // Staat de verzegelde attestatie al in de ID van de speler? (fase 2b, kind 'attestation')
        publication: this.repository.getPlayerPublication(a.attemptId, 'attestation')?.status ?? null,
        round: this.repository.getRound(a.roundRecordId)?.round_id ?? a.roundRecordId,
        streak: a.streak, rounds: a.rounds, solved: a.solved,
        root: a.root, prevRoot: a.prevRoot, signatureHeight: a.signatureHeight,
      })),
    };
  }

  /** Deellink voor één eigen attestatie met alleen `fields` (+ player en round). */
  disclosure({ principal, roundRecordId, fields }) {
    const player = this.#own(principal);
    const attestation = this.repository.getAttestation({ playerIAddress: player, roundRecordId });
    if (!attestation) throw new DailyServiceError('ATTESTATION_NOT_FOUND', 'No attestation for this round', 404);
    const round = this.repository.getRound(roundRecordId);
    try {
      const record = sealedAttestationRecord(attestation, round);
      const payload = buildDisclosurePayload({ record, descriptor: attestation.descriptor, fields });
      return { round: round.round_id, fields: payload.fields.map(([name]) => name), link: encodeDisclosureLink(payload) };
    } catch (error) {
      if (error instanceof AttestationError) throw new DailyServiceError('INVALID_DISCLOSURE', error.message, 400);
      throw error;
    }
  }

  /**
   * Controleert een deellink (publiek, zonder sessie):
   *  1. vorm, velden en wortel (zonder chain);
   *  2. handtekening van Arcade@ op de wortel, met de sleutels op tekenhoogte;
   *  3. staat precies dit verzegelde record in de ID van de speler? (informatief)
   */
  async verify({ link }) {
    let read;
    try {
      read = readDisclosurePayload(decodeDisclosureLink(link), { serviceId: this.verus.serviceId, systemId: TESTNET_SYSTEM_ID });
    } catch (error) {
      if (error instanceof AttestationError) throw new DailyServiceError('INVALID_DISCLOSURE', error.message, 400);
      throw error;
    }
    const { player, round, ...shown } = read.fields;
    let signature;
    try {
      signature = { ok: true, ...(await this.verus.verifyMmrRootSignature({ signaturedata: read.signaturedata, signatureheight: read.signatureheight })) };
    } catch (error) {
      signature = { ok: false, error: error.code ?? 'INVALID_SIGNATURE', message: error.message };
    }
    let inPlayerIdentity;
    try {
      const { state } = await this.verus.serviceState();
      const { keyId } = serviceContentKey({ name: attestationKeyName(round), serviceId: this.verus.serviceId, serviceFqn: state.current?.fullyqualifiedname });
      const { content, history } = await this.verus.readIdentityContent({ identityId: player, keyId });
      const recordSha256 = crypto.createHash('sha256').update(canonicalJson(read.record), 'utf8').digest('hex');
      const decrypt = (descriptor, txid) => this.verus.decryptDataDescriptor({ descriptor, txid }).catch(() => null);
      const located = await locatePublishedRecord({ content, history, keyId, recordSha256, decrypt });
      inPlayerIdentity = { checked: true, found: located.found, txid: located.txid ?? null, height: located.height ?? null };
    } catch (error) {
      inPlayerIdentity = { checked: false, error: error.code ?? error.name };
    }
    return {
      valid: signature.ok,
      player,
      round,
      fields: shown,
      root: read.root,
      signer: read.signaturedata.identityid,
      signatureHeight: read.signatureheight,
      signature,
      inPlayerIdentity,
    };
  }
}
