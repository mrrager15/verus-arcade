CREATE TABLE round_private_definitions (
  round_record_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
  definition_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
);
