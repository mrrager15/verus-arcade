-- Fase 2b: een publicatie in de ID van de speler heeft een soort: het
-- resultaatrecord (fase 2, 'result') of de verzegelde attestatie (fase 2b,
-- 'attestation'). Hooguit één van elke soort per poging. SQLite kan een
-- primaire sleutel niet wijzigen: tabel opnieuw opbouwen, gegevens behouden.
CREATE TABLE player_publications_v2 (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL DEFAULT 'result' CHECK (kind IN ('result', 'attestation')),
  content_key TEXT NOT NULL,
  content_key_fqn TEXT NOT NULL,
  record_json TEXT NOT NULL,
  record_sha256 TEXT NOT NULL,
  request_id_hex TEXT NOT NULL UNIQUE,
  request_hex TEXT NOT NULL,
  wallet_uri TEXT NOT NULL,
  response_mode TEXT NOT NULL CHECK (response_mode IN ('redirect', 'post')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'receipt', 'published', 'expired', 'mismatch')),
  created_height INTEGER NOT NULL,
  expires_height INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  receipt_txid TEXT,
  receipt_at_ms INTEGER,
  published_txid TEXT,
  published_height INTEGER,
  published_at_ms INTEGER,
  last_checked_at_ms INTEGER,
  PRIMARY KEY (attempt_id, kind)
);

INSERT INTO player_publications_v2 (
  attempt_id, kind, content_key, content_key_fqn, record_json, record_sha256, request_id_hex, request_hex,
  wallet_uri, response_mode, status, created_height, expires_height, created_at_ms, receipt_txid, receipt_at_ms,
  published_txid, published_height, published_at_ms, last_checked_at_ms
)
SELECT
  attempt_id, 'result', content_key, content_key_fqn, record_json, record_sha256, request_id_hex, request_hex,
  wallet_uri, response_mode, status, created_height, expires_height, created_at_ms, receipt_txid, receipt_at_ms,
  published_txid, published_height, published_at_ms, last_checked_at_ms
FROM player_publications;

DROP TABLE player_publications;
ALTER TABLE player_publications_v2 RENAME TO player_publications;
CREATE INDEX player_publications_status_idx ON player_publications (status, expires_height);
