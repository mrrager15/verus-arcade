import crypto from 'node:crypto';

export class DailyServiceError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'DailyServiceError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function publicAttempt(attempt) {
  return {
    id: attempt.id,
    chainId: attempt.chain_id,
    gameId: attempt.game_id,
    gameVersion: attempt.game_version,
    roundId: attempt.round_id,
    mode: attempt.mode,
    status: attempt.status,
    reservedAt: Number(attempt.reserved_at_ms),
    updatedAt: Number(attempt.updated_at_ms),
  };
}

export class DailyService {
  constructor({ repository, clock = () => Date.now(), createId = () => crypto.randomUUID() }) {
    this.repository = repository;
    this.clock = clock;
    this.createId = createId;
  }

  reserveAttempt({ principal, roundId }) {
    if (!principal?.chain || !principal?.iAddress) {
      throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    }
    const round = this.repository.getRound(roundId);
    if (!round) {
      throw new DailyServiceError('ROUND_NOT_FOUND', 'Round does not exist', 404);
    }
    if (round.chain_id !== principal.chain) {
      throw new DailyServiceError(
        'ROUND_CHAIN_MISMATCH',
        'Round belongs to a different chain',
        409,
      );
    }
    const now = this.clock();
    if (
      round.status !== 'open' ||
      !round.commitment_txid ||
      now < Number(round.opens_at_ms) ||
      now >= Number(round.closes_at_ms)
    ) {
      throw new DailyServiceError(
        'ROUND_NOT_OPEN',
        'Daily round is not open with a confirmed commitment',
        409,
      );
    }
    const reservation = this.repository.reserveDailyAttempt({
      attemptId: this.createId(),
      chainId: round.chain_id,
      playerIAddress: principal.iAddress,
      gameId: round.game_id,
      gameVersion: round.game_version,
      roundId: round.round_id,
      now,
    });
    return {
      created: reservation.created,
      attempt: publicAttempt(reservation.attempt),
    };
  }

  getAttempt({ principal, attemptId }) {
    if (!principal?.chain || !principal?.iAddress) {
      throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    }
    const attempt = this.repository.getAttemptForPlayer({
      attemptId,
      chainId: principal.chain,
      playerIAddress: principal.iAddress,
    });
    if (!attempt) {
      throw new DailyServiceError('ATTEMPT_NOT_FOUND', 'Attempt does not exist', 404);
    }
    return publicAttempt(attempt);
  }
}
