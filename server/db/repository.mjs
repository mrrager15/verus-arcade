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
}
