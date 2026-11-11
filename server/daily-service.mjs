import crypto from 'node:crypto';
import { WORD_GRID_GAME_ID, WORD_GRID_VERSION } from './games/word-grid/engine.mjs';
import { gameRules } from '../shared/games/index.mjs';
import { storedActionValue, usesGenericRecords } from './attempt-actions.mjs';
import { definitionPuzzle } from './round-proof.mjs';
import { RepositoryConflictError } from './db/repository.mjs';
import { rankLeaderboard } from './leaderboard.mjs';

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

function publicRound(round, now) {
  const opensAt = Number(round.opens_at_ms);
  const closesAt = Number(round.closes_at_ms);
  const available =
    round.status === 'open' &&
    Boolean(round.commitment_txid) &&
    now >= opensAt &&
    now < closesAt;
  return {
    id: round.id,
    chainId: round.chain_id,
    gameId: round.game_id,
    gameVersion: round.game_version,
    roundId: round.round_id,
    mode: round.mode,
    status: round.status,
    availability: available
      ? 'open'
      : now < opensAt
        ? 'scheduled'
        : round.status === 'commit_pending'
          ? 'commitment-pending'
          : 'closed',
    opensAt,
    closesAt,
    commitment: {
      sha256: round.commitment_hash,
      transaction: round.commitment_txid
        ? { status: 'confirmed', txid: round.commitment_txid }
        : { status: 'pending', txid: null },
    },
  };
}

export class DailyService {
  constructor({ repository, clock = () => Date.now(), createId = () => crypto.randomUUID() }) {
    this.repository = repository;
    this.clock = clock;
    this.createId = createId;
  }

  getCurrentRound() {
    const now = this.clock();
    const round = this.repository.getCurrentRound({
      chainId: 'vrsctest',
      gameId: WORD_GRID_GAME_ID,
      gameVersion: WORD_GRID_VERSION,
      now,
    });
    return round ? publicRound(round, now) : null;
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
      friendlyName: principal.friendlyName ?? null,
      now,
    });
    return {
      created: reservation.created,
      attempt: publicAttempt(reservation.attempt),
    };
  }

  getLeaderboard({ roundId }) {
    const round = this.repository.getRound(roundId);
    if (!round) {
      throw new DailyServiceError('ROUND_NOT_FOUND', 'Round does not exist', 404);
    }
    const resultSet = this.repository.getRoundResultSet(round.id);
    const attempts = this.repository.listRoundAttempts(round);
    const presentation = new Map(
      attempts.map((attempt) => [
        attempt.player_i_address,
        attempt.friendly_name ?? null,
      ]),
    );
    const source = resultSet
      ? resultSet.bundle.map((record) => ({
          playerIAddress: record.playerIAddress,
          friendlyName: presentation.get(record.playerIAddress) ?? null,
          status: record.status,
          guessesUsed: record.score.guessesUsed ?? record.score.actionsUsed,
        }))
      : attempts.map((attempt) => ({
          playerIAddress: attempt.player_i_address,
          friendlyName: attempt.friendly_name ?? null,
          status:
            attempt.status === 'completed'
              ? Number(attempt.solved) === 1
                ? 'solved'
                : 'unsolved'
              : ['abandoned', 'failed', 'expired'].includes(attempt.status)
                ? 'abandoned'
                : 'in_progress',
          guessesUsed: Number(attempt.guesses_used),
        }));
    return {
      roundId: round.round_id,
      state: resultSet
        ? resultSet.resultsTxid
          ? 'chain-verified'
          : 'finalized'
        : 'live',
      resultRoot: resultSet?.rootSha256 ?? null,
      entries: rankLeaderboard(source),
    };
  }

  getRoundProof({ roundId }) {
    const round = this.repository.getRound(roundId);
    if (!round) {
      throw new DailyServiceError('ROUND_NOT_FOUND', 'Round does not exist', 404);
    }
    const definition = this.repository.getRoundPrivateDefinition(round.id);
    const reveal = this.repository.getRoundReveal(round.id);
    const resultSet = this.repository.getRoundResultSet(round.id);
    const commitment = {
      schemaVersion: 1,
      roundId: round.round_id,
      chainId: round.chain_id,
      gameId: round.game_id,
      gameVersion: round.game_version,
      date: definition?.date ?? null,
      opensAt: definition?.opensAt ?? new Date(Number(round.opens_at_ms)).toISOString(),
      closesAt:
        definition?.closesAt ?? new Date(Number(round.closes_at_ms)).toISOString(),
      hiddenDefinitionSha256: round.commitment_hash,
      transaction: round.commitment_txid
        ? { status: 'confirmed', txid: round.commitment_txid }
        : { status: 'pending', txid: null },
    };
    return {
      roundStatus: round.status,
      commitment,
      reveal: reveal
        ? {
            schemaVersion: 1,
            hiddenDefinition: reveal.hiddenDefinition,
            commitmentTxid: reveal.commitmentTxid,
            transaction: { status: 'confirmed', txid: reveal.revealTxid },
          }
        : null,
      results: resultSet
        ? {
            schemaVersion: 1,
            algorithm: resultSet.algorithm,
            roundId: round.round_id,
            chainId: round.chain_id,
            gameId: round.game_id,
            gameVersion: round.game_version,
            leafCount: resultSet.leafCount,
            rootSha256: resultSet.rootSha256,
            bundleSha256: resultSet.bundleSha256,
            transaction: resultSet.resultsTxid
              ? { status: 'confirmed', txid: resultSet.resultsTxid }
              : { status: 'pending', txid: null },
          }
        : null,
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
    const actions = this.repository.listAttemptActions(attempt.id);
    return {
      ...publicAttempt(attempt),
      // Word Grid (schema 1) houdt `word`/`pattern`; elke game (fase 8) krijgt `value`/`feedback`.
      actions: actions.map((entry) => ({
        actionId: entry.actionId,
        sequence: entry.sequence,
        value: storedActionValue(entry.action),
        ...(entry.action.type === 'guess'
          ? { word: entry.action.payload.word, pattern: entry.response.pattern }
          : { feedback: entry.response.feedback }),
      })),
      terminalResult:
        attempt.status === 'completed' && actions.length > 0
          ? actions.at(-1).response
          : null,
    };
  }

  getRoundAttempt({ principal, roundId }) {
    if (!principal?.chain || !principal?.iAddress) {
      throw new DailyServiceError('NOT_AUTHENTICATED', 'Authentication required', 401);
    }
    const round = this.repository.getRound(roundId);
    if (!round || round.chain_id !== principal.chain) return null;
    const attempt = this.repository.getDailyAttemptForPlayer({
      chainId: principal.chain,
      playerIAddress: principal.iAddress,
      gameId: round.game_id,
      gameVersion: round.game_version,
      roundId: round.round_id,
    });
    return attempt
      ? this.getAttempt({ principal, attemptId: attempt.id })
      : null;
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
      !['guess', 'action'].includes(action?.type) ||
      typeof action.actionId !== 'string' ||
      action.actionId.length < 8 ||
      !Number.isSafeInteger(action.sequence) ||
      action.gameVersion !== attempt.game_version
    ) {
      throw new DailyServiceError('INVALID_ACTION', 'Action schema is invalid', 400);
    }
    let rules;
    try {
      rules = gameRules(attempt.game_id, attempt.game_version);
    } catch {
      throw new DailyServiceError(
        'GAME_VERSION_UNSUPPORTED',
        'Game validator version is unavailable',
        409,
      );
    }

    // Fase 8: rondes met definitieschema 1 (Word Grid sinds v1) bewaren zetten en
    // antwoorden in de oude vorm; schema 2 (elke game) in de generieke vorm.
    const round = this.repository.getRoundForAttempt(attempt);
    const definition = round ? this.repository.getRoundPrivateDefinition(round.id) : null;
    const generic = usesGenericRecords(definition);
    const raw = action.type === 'guess' ? action.payload?.word : (action.payload?.value ?? action.payload?.word);
    let value;
    try {
      value = rules.normalizeAction(raw);
    } catch (error) {
      throw new DailyServiceError(generic ? 'INVALID_ACTION' : 'INVALID_GUESS', error.message, 400);
    }
    if (action.sequence > rules.meta.maxActions) {
      throw new DailyServiceError('MAX_GUESSES_EXCEEDED', 'Too many actions', 409);
    }

    const canonicalAction = generic
      ? JSON.stringify({ type: 'action', payload: { value }, gameVersion: action.gameVersion })
      : JSON.stringify({ type: 'guess', payload: { word: value }, gameVersion: action.gameVersion });
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
    let puzzle;
    try {
      // Schema 2: volledig gecontroleerd; schema 1 (Word Grid): het antwoord volstaat.
      puzzle = generic ? definitionPuzzle(definition) : rules.validatePuzzle({ answer: definition?.answer });
    } catch {
      throw new DailyServiceError(
        'ROUND_DEFINITION_UNAVAILABLE',
        'Private round definition is unavailable',
        503,
      );
    }

    // De toestand opbouwen door de eerdere zetten na te spelen met de regels van de game.
    let state = rules.newState(puzzle);
    for (const prior of this.repository.listAttemptActions(attempt.id)) {
      state = rules.applyAction(state, storedActionValue(prior.action)).state;
    }
    if (rules.isTerminal(state)) {
      throw new DailyServiceError('ATTEMPT_NOT_ACTIVE', 'This attempt is already finished', 409);
    }
    let applied;
    try {
      applied = rules.applyAction(state, value);
    } catch (error) {
      // Een zet die de regels weigeren (bv. een getal dat er niet is) telt niet als poging.
      throw new DailyServiceError(generic ? 'INVALID_ACTION' : 'INVALID_GUESS', error.message, 400);
    }
    const terminal = rules.isTerminal(applied.state);
    const score = rules.score(applied.state);
    const solved = score.status === 'solved';
    const actionsLeft = Math.max(0, rules.meta.maxActions - score.actionsUsed);
    const response = generic
      ? {
          feedback: applied.feedback,
          solved,
          actionsUsed: score.actionsUsed,
          actionsLeft,
          terminal,
          ...(terminal ? { reveal: rules.revealOnEnd(puzzle) } : {}),
        }
      : {
          pattern: applied.feedback.pattern,
          solved,
          guessesUsed: score.actionsUsed,
          guessesLeft: actionsLeft,
          terminal,
          ...(terminal ? { answer: puzzle.answer } : {}),
        };
    const resultHash = terminal
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
        terminal,
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
