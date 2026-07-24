import crypto from 'node:crypto';
import { ANSWERS } from './words.mjs';
import {
  MAX_GUESSES,
  WORD_GRID_GAME_ID,
  WORD_GRID_VERSION,
  applyGuess,
  normalizeGuess,
} from './games/word-grid/engine.mjs';
import { RepositoryConflictError } from './db/repository.mjs';

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

  getAttemptProof({ principal, attemptId }) {
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
    const round = this.repository.getRoundForAttempt(attempt);
    const resultSet = round ? this.repository.getRoundResultSet(round.id) : null;
    if (!resultSet) {
      return { status: 'pending', roundId: attempt.round_id };
    }
    const proof = this.repository.getResultProof({
      roundRecordId: round.id,
      playerIAddress: principal.iAddress,
    });
    if (!proof) {
      throw new DailyServiceError(
        'RESULT_COMPLETENESS_FAILURE',
        'Final result set does not contain this reserved attempt',
        503,
      );
    }
    return {
      status: 'finalized',
      descriptor: {
        schemaVersion: 1,
        algorithm: resultSet.algorithm,
        roundId: attempt.round_id,
        gameId: attempt.game_id,
        gameVersion: attempt.game_version,
        leafCount: resultSet.leafCount,
        rootSha256: resultSet.rootSha256,
        bundleSha256: resultSet.bundleSha256,
      },
      publication: resultSet.resultsTxid
        ? { status: 'confirmed', txid: resultSet.resultsTxid }
        : { status: 'pending', txid: null },
      proof,
    };
  }

  submitAction({ principal, attemptId, action }) {
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
    if (
      action?.type !== 'guess' ||
      typeof action.actionId !== 'string' ||
      action.actionId.length < 8 ||
      !Number.isSafeInteger(action.sequence) ||
      action.gameVersion !== attempt.game_version
    ) {
      throw new DailyServiceError('INVALID_ACTION', 'Action schema is invalid', 400);
    }
    if (
      attempt.game_id !== WORD_GRID_GAME_ID ||
      attempt.game_version !== WORD_GRID_VERSION
    ) {
      throw new DailyServiceError(
        'GAME_VERSION_UNSUPPORTED',
        'Game validator version is unavailable',
        409,
      );
    }

    let word;
    try {
      word = normalizeGuess(action.payload?.word);
    } catch (error) {
      throw new DailyServiceError('INVALID_GUESS', error.message, 400);
    }
    if (!ANSWERS.includes(word)) {
      throw new DailyServiceError(
        'GUESS_NOT_IN_DICTIONARY',
        'Guess is not in the versioned dictionary',
        400,
      );
    }
    if (action.sequence > MAX_GUESSES) {
      throw new DailyServiceError('MAX_GUESSES_EXCEEDED', 'Too many guesses', 409);
    }

    const canonicalAction = JSON.stringify({
      type: 'guess',
      payload: { word },
      gameVersion: action.gameVersion,
    });
    const actionHash = crypto
      .createHash('sha256')
      .update(canonicalAction)
      .digest('hex');
    const existing = this.repository.getAttemptAction({
      attemptId,
      actionId: action.actionId,
    });
    if (existing) {
      if (existing.sequence === action.sequence && existing.actionHash === actionHash) {
        return { replayed: true, result: existing.response };
      }
      throw new DailyServiceError(
        'ACTION_ID_CONFLICT',
        'Action ID was already used with different content',
        409,
      );
    }

    const round = this.repository.getRoundForAttempt(attempt);
    const now = this.clock();
    if (
      !round ||
      round.status !== 'open' ||
      !round.commitment_txid ||
      now < Number(round.opens_at_ms) ||
      now >= Number(round.closes_at_ms)
    ) {
      throw new DailyServiceError('ROUND_NOT_OPEN', 'Round no longer accepts actions', 409);
    }
    const definition = this.repository.getRoundPrivateDefinition(round.id);
    if (!definition?.answer) {
      throw new DailyServiceError(
        'ROUND_DEFINITION_UNAVAILABLE',
        'Private round definition is unavailable',
        503,
      );
    }

    const result = applyGuess({
      guess: word,
      answer: definition.answer,
      sequence: action.sequence,
    });
    const response = {
      pattern: result.pattern,
      solved: result.solved,
      guessesUsed: result.guessesUsed,
      guessesLeft: result.guessesLeft,
      terminal: result.terminal,
      ...(result.terminal ? { answer: definition.answer } : {}),
    };
    const resultHash = result.terminal
      ? crypto.createHash('sha256').update(JSON.stringify(response)).digest('hex')
      : null;
    try {
      const stored = this.repository.recordAttemptAction({
        attemptId,
        actionId: action.actionId,
        sequence: action.sequence,
        canonicalAction,
        actionHash,
        response,
        terminal: result.terminal,
        resultHash,
        now,
      });
      return { replayed: stored.replayed, result: stored.response };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        throw new DailyServiceError(error.code, error.message, 409);
      }
      throw error;
    }
  }
}
