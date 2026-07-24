import crypto from 'node:crypto';

function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function inImmediateTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export class RepositoryConflictError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RepositoryConflictError';
    this.code = code;
  }
}

const JOURNAL_TRANSITIONS = Object.freeze({
  planned: new Set(['signed', 'failed']),
  signed: new Set(['submitted', 'uncertain', 'failed']),
  submitted: new Set(['confirmed', 'uncertain', 'failed']),
  uncertain: new Set(['submitted', 'confirmed', 'failed']),
  confirmed: new Set(),
  failed: new Set(),
});

export class ArcadeRepository {
  constructor(database) {
    this.database = database;
  }

  createSession({ token, chainId, iAddress, friendlyName, now, expiresAt }) {
    if (expiresAt <= now) throw new Error('Session expiry must be after creation');
    this.database
      .prepare(`
        INSERT INTO sessions (
          token_hash, chain_id, player_i_address, friendly_name,
          created_at_ms, expires_at_ms, revoked_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      `)
      .run(
        hashToken(token),
        chainId,
        iAddress,
        friendlyName ?? null,
        now,
        expiresAt,
      );
  }

  resolveSession(token, now) {
    const row = this.database
      .prepare(`
        SELECT chain_id, player_i_address, friendly_name, created_at_ms, expires_at_ms
        FROM sessions
        WHERE token_hash = ?
          AND revoked_at_ms IS NULL
          AND expires_at_ms > ?
      `)
      .get(hashToken(token), now);
    if (!row) return null;
    return {
      user: {
        chain: row.chain_id,
        iAddress: row.player_i_address,
        friendlyName: row.friendly_name,
      },
      createdAt: Number(row.created_at_ms),
      expiresAt: Number(row.expires_at_ms),
    };
  }

  revokeSession(token, now) {
    return (
      this.database
        .prepare(`
          UPDATE sessions
          SET revoked_at_ms = ?
          WHERE token_hash = ? AND revoked_at_ms IS NULL
        `)
        .run(now, hashToken(token)).changes === 1
    );
  }

  createRound({
    id,
    chainId,
    gameId,
    gameVersion,
    roundId,
    commitmentHash,
    privateDefinition,
    opensAt,
    closesAt,
    now,
  }) {
    return inImmediateTransaction(this.database, () => {
      this.database
        .prepare(`
          INSERT INTO rounds (
            id, chain_id, game_id, game_version, round_id, mode, status,
            commitment_hash, opens_at_ms, closes_at_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, 'daily', 'commit_pending', ?, ?, ?, ?)
        `)
        .run(
          id,
          chainId,
          gameId,
          gameVersion,
          roundId,
          commitmentHash,
          opensAt,
          closesAt,
          now,
        );
      if (privateDefinition) {
        this.database
          .prepare(`
            INSERT INTO round_private_definitions (
              round_record_id, definition_json, created_at_ms
            ) VALUES (?, ?, ?)
          `)
          .run(id, JSON.stringify(privateDefinition), now);
      }
    });
  }

  openRound({ id, commitmentTxid }) {
    if (!/^[0-9a-f]{64}$/.test(commitmentTxid)) {
      throw new Error('Commitment transaction ID must be 64 lowercase hex characters');
    }
    const updated = this.database
      .prepare(`
        UPDATE rounds
        SET status = 'open', commitment_txid = ?
        WHERE id = ? AND status = 'commit_pending' AND commitment_txid IS NULL
      `)
      .run(commitmentTxid, id);
    if (updated.changes !== 1) {
      throw new RepositoryConflictError(
        'ROUND_STATE_CONFLICT',
        'Round is missing or cannot transition to open',
      );
    }
    return this.getRound(id);
  }

  getRound(id) {
    return this.database.prepare('SELECT * FROM rounds WHERE id = ?').get(id) ?? null;
  }

  getRoundForAttempt(attempt) {
    return (
      this.database
        .prepare(`
          SELECT *
          FROM rounds
          WHERE chain_id = ?
            AND game_id = ?
            AND game_version = ?
            AND round_id = ?
            AND mode = ?
        `)
        .get(
          attempt.chain_id,
          attempt.game_id,
          attempt.game_version,
          attempt.round_id,
          attempt.mode,
        ) ?? null
    );
  }

  getRoundPrivateDefinition(id) {
    const row = this.database
      .prepare(`
        SELECT definition_json
        FROM round_private_definitions
        WHERE round_record_id = ?
      `)
      .get(id);
    return row ? JSON.parse(row.definition_json) : null;
  }

  getAttemptForPlayer({ attemptId, chainId, playerIAddress }) {
    return (
      this.database
        .prepare(`
          SELECT *
          FROM attempts
          WHERE id = ? AND chain_id = ? AND player_i_address = ?
        `)
        .get(attemptId, chainId, playerIAddress) ?? null
    );
  }

  getAttemptAction({ attemptId, actionId }) {
    const row = this.database
      .prepare(`
        SELECT action_id, sequence, action_hash, response_json
        FROM attempt_actions
        WHERE attempt_id = ? AND action_id = ?
      `)
      .get(attemptId, actionId);
    return row
      ? {
          actionId: row.action_id,
          sequence: Number(row.sequence),
          actionHash: row.action_hash,
          response: JSON.parse(row.response_json),
        }
      : null;
  }

  reserveDailyAttempt({
    attemptId,
    chainId,
    playerIAddress,
    gameId,
    gameVersion,
    roundId,
    now,
  }) {
    return inImmediateTransaction(this.database, () => {
      const inserted = this.database
        .prepare(`
          INSERT INTO attempts (
            id, chain_id, player_i_address, game_id, game_version,
            round_id, mode, status, reserved_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'daily', 'reserved', ?, ?)
          ON CONFLICT (
            chain_id, player_i_address, game_id, game_version, round_id, mode
          ) DO NOTHING
        `)
        .run(
          attemptId,
          chainId,
          playerIAddress,
          gameId,
          gameVersion,
          roundId,
          now,
          now,
        );
      const attempt = this.database
        .prepare(`
          SELECT *
          FROM attempts
          WHERE chain_id = ?
            AND player_i_address = ?
            AND game_id = ?
            AND game_version = ?
            AND round_id = ?
            AND mode = 'daily'
        `)
        .get(chainId, playerIAddress, gameId, gameVersion, roundId);
      return { created: inserted.changes === 1, attempt };
    });
  }

  recordAttemptAction({
    attemptId,
    actionId,
    sequence,
    canonicalAction,
    actionHash,
    response,
    terminal = false,
    resultHash = null,
    now,
  }) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('Action sequence must be a positive integer');
    }
    return inImmediateTransaction(this.database, () => {
      const attempt = this.database
        .prepare('SELECT status FROM attempts WHERE id = ?')
        .get(attemptId);
      if (!attempt) {
        throw new RepositoryConflictError(
          'ATTEMPT_NOT_FOUND',
          'Attempt does not exist',
        );
      }
      const existingAction = this.database
        .prepare(`
          SELECT action_id, sequence, action_hash, response_json
          FROM attempt_actions
          WHERE attempt_id = ? AND action_id = ?
        `)
        .get(attemptId, actionId);
      if (existingAction) {
        if (
          Number(existingAction.sequence) === sequence &&
          existingAction.action_hash === actionHash
        ) {
          return {
            replayed: true,
            response: JSON.parse(existingAction.response_json),
          };
        }
        throw new RepositoryConflictError(
          'ACTION_ID_CONFLICT',
          'Action ID was already used with different content',
        );
      }

      if (!['reserved', 'active'].includes(attempt.status)) {
        throw new RepositoryConflictError(
          'ATTEMPT_NOT_ACTIVE',
          `Attempt does not accept actions in status ${attempt.status}`,
        );
      }

      const existingSequence = this.database
        .prepare(`
          SELECT action_id, action_hash
          FROM attempt_actions
          WHERE attempt_id = ? AND sequence = ?
        `)
        .get(attemptId, sequence);
      if (existingSequence) {
        throw new RepositoryConflictError(
          'ACTION_SEQUENCE_CONFLICT',
          'Action sequence was already used',
        );
      }

      const previous = this.database
        .prepare(`
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM attempt_actions
          WHERE attempt_id = ?
        `)
        .get(attemptId);
      const expectedSequence = Number(previous.sequence) + 1;
      if (sequence !== expectedSequence) {
        throw new RepositoryConflictError(
          'ACTION_SEQUENCE_OUT_OF_ORDER',
          `Expected action sequence ${expectedSequence}`,
        );
      }

      const responseJson = JSON.stringify(response);
      this.database
        .prepare(`
          INSERT INTO attempt_actions (
            attempt_id, action_id, sequence, canonical_action,
            action_hash, response_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          attemptId,
          actionId,
          sequence,
          canonicalAction,
          actionHash,
          responseJson,
          now,
        );
      this.database
        .prepare(`
          UPDATE attempts
          SET status = ?,
              updated_at_ms = ?,
              completed_at_ms = CASE WHEN ? THEN ? ELSE completed_at_ms END,
              result_hash = CASE WHEN ? THEN ? ELSE result_hash END
          WHERE id = ?
        `)
        .run(
          terminal ? 'completed' : 'active',
          now,
          terminal ? 1 : 0,
          now,
          terminal ? 1 : 0,
          resultHash,
          attemptId,
        );
      return { replayed: false, response };
    });
  }

  planChainOperation({
    id,
    operationType,
    operationKey,
    chainId,
    identityIAddress,
    payloadHash,
    now,
  }) {
    return inImmediateTransaction(this.database, () => {
      const inserted = this.database
        .prepare(`
          INSERT INTO transaction_journal (
            id, operation_type, operation_key, chain_id, identity_i_address,
            payload_hash, state, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)
          ON CONFLICT (operation_key) DO NOTHING
        `)
        .run(
          id,
          operationType,
          operationKey,
          chainId,
          identityIAddress,
          payloadHash,
          now,
          now,
        );
      const entry = this.database
        .prepare('SELECT * FROM transaction_journal WHERE operation_key = ?')
        .get(operationKey);
      const sameIntent =
        entry.operation_type === operationType &&
        entry.chain_id === chainId &&
        entry.identity_i_address === identityIAddress &&
        entry.payload_hash === payloadHash;
      if (!sameIntent) {
        throw new RepositoryConflictError(
          'CHAIN_OPERATION_CONFLICT',
          'Operation key was already used for a different chain intent',
        );
      }
      return { created: inserted.changes === 1, entry };
    });
  }

  getChainOperation(operationKey) {
    return (
      this.database
        .prepare('SELECT * FROM transaction_journal WHERE operation_key = ?')
        .get(operationKey) ?? null
    );
  }

  transitionChainOperation({
    operationKey,
    expectedState,
    nextState,
    now,
    txid = null,
    rawTransaction = null,
    errorCode = null,
  }) {
    if (!JOURNAL_TRANSITIONS[expectedState]?.has(nextState)) {
      throw new Error(
        `Invalid journal transition ${expectedState} -> ${nextState}`,
      );
    }
    return inImmediateTransaction(this.database, () => {
      const updated = this.database
        .prepare(`
          UPDATE transaction_journal
          SET state = ?,
              txid = COALESCE(?, txid),
              raw_transaction = COALESCE(?, raw_transaction),
              error_code = ?,
              updated_at_ms = ?
          WHERE operation_key = ? AND state = ?
        `)
        .run(
          nextState,
          txid,
          rawTransaction,
          errorCode,
          now,
          operationKey,
          expectedState,
        );
      if (updated.changes !== 1) {
        const current = this.database
          .prepare(
            'SELECT state FROM transaction_journal WHERE operation_key = ?',
          )
          .get(operationKey);
        throw new RepositoryConflictError(
          current ? 'CHAIN_OPERATION_STATE_CONFLICT' : 'CHAIN_OPERATION_NOT_FOUND',
          current
            ? `Expected ${expectedState}, found ${current.state}`
            : 'Chain operation does not exist',
        );
      }
      return this.database
        .prepare('SELECT * FROM transaction_journal WHERE operation_key = ?')
        .get(operationKey);
    });
  }
}
