CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  player_i_address TEXT NOT NULL,
  friendly_name TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);

CREATE INDEX sessions_expiry_idx ON sessions (expires_at_ms);
CREATE INDEX sessions_player_idx ON sessions (chain_id, player_i_address);

CREATE TABLE rounds (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  game_version TEXT NOT NULL,
  round_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('daily')),
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'commit_pending', 'open', 'closed', 'revealed', 'failed')
  ),
  commitment_hash TEXT NOT NULL,
  commitment_txid TEXT,
  opens_at_ms INTEGER NOT NULL,
  closes_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (chain_id, game_id, game_version, round_id, mode),
  CHECK (closes_at_ms > opens_at_ms)
);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  player_i_address TEXT NOT NULL,
  game_id TEXT NOT NULL,
  game_version TEXT NOT NULL,
  round_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('daily')),
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'active', 'completed', 'failed', 'abandoned', 'expired')
  ),
  reserved_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  result_hash TEXT,
  UNIQUE (
    chain_id,
    player_i_address,
    game_id,
    game_version,
    round_id,
    mode
  )
);

CREATE TABLE attempt_actions (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  canonical_action TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, action_id),
  UNIQUE (attempt_id, sequence)
);

CREATE TABLE transaction_journal (
  id TEXT PRIMARY KEY,
  operation_type TEXT NOT NULL,
  operation_key TEXT NOT NULL UNIQUE,
  chain_id TEXT NOT NULL,
  identity_i_address TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('planned', 'signed', 'submitted', 'confirmed', 'failed', 'uncertain')
  ),
  txid TEXT,
  raw_transaction TEXT,
  error_code TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
