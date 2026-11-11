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
import { ATTESTATION_VERSION, buildAttestation, computeDailyStats } from './attestation.mjs';

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

/** Wat in de ID van de speler mag (publiek): geen waarden, geen zouten. */
export function sealedAttestationRecord(attestation, round) {
  if (round?.id !== attestation.roundRecordId) throw new AttestationServiceError('ROUND_MISMATCH', 'Attestation belongs to another round');
  const { datadescriptors: _private, ...sealed } = attestation.descriptor;
  return {
    schema: 'arcade-attestation',
    version: attestation.schemaVersion,
    player: attestation.playerIAddress,
    round: round.round_id,
    chain: attestation.chainId,
    mmr: sealed,
    signature: attestation.signaturedata,
    signatureHeight: attestation.signatureHeight,
  };
}
