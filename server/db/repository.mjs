import crypto from 'node:crypto';

import { canonicalJson } from '../canonical-json.mjs';
import { buildResultSet, createInclusionProof } from '../result-set.mjs';
import { hiddenDefinitionHash } from '../round-proof.mjs';

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
      const existing = this.database
        .prepare('SELECT * FROM rounds WHERE id = ?')
        .get(id);
      if (existing) {
        const storedDefinition = this.getRoundPrivateDefinition(id);
        const same =
          existing.chain_id === chainId &&
          existing.game_id === gameId &&
          existing.game_version === gameVersion &&
          existing.round_id === roundId &&
          existing.commitment_hash === commitmentHash &&
          Number(existing.opens_at_ms) === opensAt &&
          Number(existing.closes_at_ms) === closesAt &&
          JSON.stringify(storedDefinition) === JSON.stringify(privateDefinition ?? null);
        if (!same) {
          throw new RepositoryConflictError(
            'ROUND_DEFINITION_CONFLICT',
            'Round ID was already used for a different definition',
          );
        }
        return { created: false, round: existing };
      }
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
      return { created: true, round: this.getRound(id) };
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

  getCurrentRound({ chainId, gameId, gameVersion, now }) {
    return (
      this.database
        .prepare(`
          SELECT *
          FROM rounds
          WHERE chain_id = ?
            AND game_id = ?
            AND game_version = ?
            AND mode = 'daily'
            AND closes_at_ms > ?
            AND status IN ('commit_pending', 'open')
          ORDER BY opens_at_ms ASC
          LIMIT 1
        `)
        .get(chainId, gameId, gameVersion, now) ?? null
    );
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

  getDailyAttemptForPlayer({
    chainId,
    playerIAddress,
    gameId,
    gameVersion,
    roundId,
  }) {
    return (
      this.database
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
        .get(chainId, playerIAddress, gameId, gameVersion, roundId) ?? null
    );
  }

  listAttemptActions(attemptId) {
    return this.database
      .prepare(`
        SELECT action_id, sequence, canonical_action, response_json, created_at_ms
        FROM attempt_actions
        WHERE attempt_id = ?
        ORDER BY sequence
      `)
      .all(attemptId)
      .map((row) => ({
        actionId: row.action_id,
        sequence: Number(row.sequence),
        action: JSON.parse(row.canonical_action),
        response: JSON.parse(row.response_json),
        createdAt: Number(row.created_at_ms),
      }));
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
    friendlyName = null,
    now,
  }) {
    if (
      friendlyName !== null &&
      (typeof friendlyName !== 'string' || friendlyName.length > 128)
    ) {
      throw new Error('Friendly name must be at most 128 characters');
    }
    return inImmediateTransaction(this.database, () => {
      const inserted = this.database
        .prepare(`
          INSERT INTO attempts (
            id, chain_id, player_i_address, game_id, game_version,
            round_id, mode, status, reserved_at_ms, updated_at_ms, friendly_name
          ) VALUES (?, ?, ?, ?, ?, ?, 'daily', 'reserved', ?, ?, ?)
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
          friendlyName,
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

  listRoundAttempts(round) {
    return this.database
      .prepare(`
        SELECT
          a.*,
          COUNT(aa.sequence) AS guesses_used,
          MAX(CASE
            WHEN json_extract(aa.response_json, '$.solved') = 1 THEN 1
            ELSE 0
          END) AS solved
        FROM attempts a
        LEFT JOIN attempt_actions aa ON aa.attempt_id = a.id
        WHERE a.chain_id = ?
          AND a.game_id = ?
          AND a.game_version = ?
          AND a.round_id = ?
          AND a.mode = 'daily'
        GROUP BY a.id
        ORDER BY a.player_i_address
      `)
      .all(
        round.chain_id,
        round.game_id,
        round.game_version,
        round.round_id,
      );
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

  finalizeRoundResults({ roundRecordId, now }) {
    return inImmediateTransaction(this.database, () => {
      const existing = this.getRoundResultSet(roundRecordId);
      if (existing) return { created: false, resultSet: existing };

      const round = this.database
        .prepare('SELECT * FROM rounds WHERE id = ?')
        .get(roundRecordId);
      if (!round) {
        throw new RepositoryConflictError('ROUND_NOT_FOUND', 'Round does not exist');
      }
      if (!['open', 'closed'].includes(round.status) || now < Number(round.closes_at_ms)) {
        throw new RepositoryConflictError(
          'ROUND_NOT_FINALIZABLE',
          'Round must be open and past its close time',
        );
      }

      this.database
        .prepare(`
          UPDATE attempts
          SET status = 'abandoned', updated_at_ms = ?
          WHERE chain_id = ?
            AND game_id = ?
            AND game_version = ?
            AND round_id = ?
            AND mode = 'daily'
            AND status IN ('reserved', 'active')
        `)
        .run(
          now,
          round.chain_id,
          round.game_id,
          round.game_version,
          round.round_id,
        );
      this.database
        .prepare(`UPDATE rounds SET status = 'closed' WHERE id = ? AND status = 'open'`)
        .run(roundRecordId);

      const attempts = this.database
        .prepare(`
          SELECT *
          FROM attempts
          WHERE chain_id = ?
            AND game_id = ?
            AND game_version = ?
            AND round_id = ?
            AND mode = 'daily'
          ORDER BY player_i_address
        `)
        .all(
          round.chain_id,
          round.game_id,
          round.game_version,
          round.round_id,
        );
      const records = attempts.map((attempt) => {
        const actions = this.database
          .prepare(`
            SELECT sequence, canonical_action, response_json
            FROM attempt_actions
            WHERE attempt_id = ?
            ORDER BY sequence
          `)
          .all(attempt.id);
        const guesses = actions.map((action) => {
          const canonicalAction = JSON.parse(action.canonical_action);
          return {
            sequence: Number(action.sequence),
            word: canonicalAction.payload?.word ?? canonicalAction.guess,
          };
        });
        const finalResponse =
          actions.length === 0
            ? null
            : JSON.parse(actions.at(-1).response_json);
        const solved = attempt.status === 'completed' && finalResponse?.solved === true;
        const status =
          attempt.status === 'completed' ? (solved ? 'solved' : 'unsolved') : 'abandoned';
        return {
          schemaVersion: 1,
          roundId: round.round_id,
          chainId: round.chain_id,
          gameId: round.game_id,
          gameVersion: round.game_version,
          playerIAddress: attempt.player_i_address,
          status,
          guesses,
          score: { solved, guessesUsed: guesses.length },
        };
      });
      const built = buildResultSet(records);
      const statusCounts = built.bundle.reduce((counts, record) => {
        counts[record.status]++;
        return counts;
      }, { solved: 0, unsolved: 0, abandoned: 0 });
      this.database
        .prepare(`
          INSERT INTO round_result_sets (
            round_record_id, algorithm, root_sha256, leaf_count, bundle_json,
            bundle_sha256, status_counts_json, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          roundRecordId,
          built.algorithm,
          built.rootSha256,
          built.leafCount,
          built.bundleJson,
          built.bundleSha256,
          JSON.stringify(statusCounts),
          now,
        );
      const insertRecord = this.database.prepare(`
        INSERT INTO round_result_records (
          round_record_id, attempt_id, leaf_index, sort_key, record_json, leaf_sha256
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const entry of built.entries) {
        const attempt = attempts.find(
          (candidate) => candidate.player_i_address === entry.record.playerIAddress,
        );
        insertRecord.run(
          roundRecordId,
          attempt.id,
          entry.leafIndex,
          entry.sortKey,
          entry.recordJson,
          entry.leafSha256,
        );
      }
      return { created: true, resultSet: this.getRoundResultSet(roundRecordId) };
    });
  }

  getRoundResultSet(roundRecordId) {
    const row = this.database
      .prepare('SELECT * FROM round_result_sets WHERE round_record_id = ?')
      .get(roundRecordId);
    if (!row) return null;
    return {
      roundRecordId: row.round_record_id,
      algorithm: row.algorithm,
      rootSha256: row.root_sha256,
      leafCount: Number(row.leaf_count),
      bundle: JSON.parse(row.bundle_json),
      bundleSha256: row.bundle_sha256,
      statusCounts: JSON.parse(row.status_counts_json),
      resultsTxid: row.results_txid,
      createdAt: Number(row.created_at_ms),
    };
  }

  confirmRoundResults({ roundRecordId, resultsTxid }) {
    if (!/^[0-9a-f]{64}$/.test(resultsTxid)) {
      throw new Error('Results transaction ID must be 64 lowercase hex characters');
    }
    const updated = this.database
      .prepare(`
        UPDATE round_result_sets
        SET results_txid = ?
        WHERE round_record_id = ?
          AND (results_txid IS NULL OR results_txid = ?)
      `)
      .run(resultsTxid, roundRecordId, resultsTxid);
    if (updated.changes !== 1) {
      throw new RepositoryConflictError(
        'RESULT_SET_STATE_CONFLICT',
        'Result set is missing or references a different transaction',
      );
    }
    return this.getRoundResultSet(roundRecordId);
  }

  getResultProof({ roundRecordId, playerIAddress }) {
    const stored = this.getRoundResultSet(roundRecordId);
    if (!stored) return null;
    const built = buildResultSet(stored.bundle);
    if (
      built.rootSha256 !== stored.rootSha256 ||
      built.bundleSha256 !== stored.bundleSha256
    ) {
      throw new Error('Stored result bundle does not match its commitment');
    }
    const index = built.entries.findIndex(
      (entry) => entry.record.playerIAddress === playerIAddress,
    );
    return index === -1 ? null : createInclusionProof(built, index);
  }

  confirmRoundReveal({ roundRecordId, revealTxid, now }) {
    if (!/^[0-9a-f]{64}$/.test(revealTxid)) {
      throw new Error('Reveal transaction ID must be 64 lowercase hex characters');
    }
    return inImmediateTransaction(this.database, () => {
      const existing = this.getRoundReveal(roundRecordId);
      if (existing) {
        if (existing.revealTxid !== revealTxid) {
          throw new RepositoryConflictError(
            'ROUND_REVEAL_CONFLICT',
            'Round reveal already references a different transaction',
          );
        }
        return { created: false, reveal: existing };
      }
      const round = this.database
        .prepare('SELECT * FROM rounds WHERE id = ?')
        .get(roundRecordId);
      const definition = this.getRoundPrivateDefinition(roundRecordId);
      if (
        !round ||
        round.status !== 'closed' ||
        !round.commitment_txid ||
        !definition ||
        hiddenDefinitionHash(definition) !== round.commitment_hash
      ) {
        throw new RepositoryConflictError(
          'ROUND_REVEAL_NOT_CONFIRMABLE',
          'Closed round, commitment receipt, and matching definition are required',
        );
      }
      this.database
        .prepare(`
          INSERT INTO round_reveals (
            round_record_id, definition_json, definition_sha256,
            commitment_txid, reveal_txid, confirmed_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          roundRecordId,
          canonicalJson(definition),
          round.commitment_hash,
          round.commitment_txid,
          revealTxid,
          now,
        );
      this.database
        .prepare(`UPDATE rounds SET status = 'revealed' WHERE id = ? AND status = 'closed'`)
        .run(roundRecordId);
      return { created: true, reveal: this.getRoundReveal(roundRecordId) };
    });
  }

  getRoundReveal(roundRecordId) {
    const row = this.database
      .prepare('SELECT * FROM round_reveals WHERE round_record_id = ?')
      .get(roundRecordId);
    return row
      ? {
          roundRecordId: row.round_record_id,
          hiddenDefinition: JSON.parse(row.definition_json),
          hiddenDefinitionSha256: row.definition_sha256,
          commitmentTxid: row.commitment_txid,
          revealTxid: row.reveal_txid,
          confirmedAt: Number(row.confirmed_at_ms),
        }
      : null;
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
