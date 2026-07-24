CREATE TABLE round_result_sets (
  round_record_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE RESTRICT,
  algorithm TEXT NOT NULL,
  root_sha256 TEXT NOT NULL CHECK (length(root_sha256) = 64),
  leaf_count INTEGER NOT NULL CHECK (leaf_count >= 0),
  bundle_json TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL CHECK (length(bundle_sha256) = 64),
  status_counts_json TEXT NOT NULL,
  results_txid TEXT CHECK (results_txid IS NULL OR length(results_txid) = 64),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE round_result_records (
  round_record_id TEXT NOT NULL REFERENCES round_result_sets(round_record_id)
    ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE RESTRICT,
  leaf_index INTEGER NOT NULL CHECK (leaf_index >= 0),
  sort_key TEXT NOT NULL,
  record_json TEXT NOT NULL,
  leaf_sha256 TEXT NOT NULL CHECK (length(leaf_sha256) = 64),
  PRIMARY KEY (round_record_id, attempt_id),
  UNIQUE (round_record_id, leaf_index),
  UNIQUE (round_record_id, sort_key)
);
