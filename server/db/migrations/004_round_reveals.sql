CREATE TABLE round_reveals (
  round_record_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  definition_json TEXT NOT NULL,
  definition_sha256 TEXT NOT NULL CHECK (length(definition_sha256) = 64),
  commitment_txid TEXT NOT NULL CHECK (length(commitment_txid) = 64),
  reveal_txid TEXT NOT NULL CHECK (length(reveal_txid) = 64),
  confirmed_at_ms INTEGER NOT NULL
);
