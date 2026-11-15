-- Fase 5: versleutelde actie-bundels.
--
-- 1. Een ronde onthoudt met welk commitment-schema ze gepubliceerd is: 1 (zoals
--    altijd) of 2 (met het versleuteladres van de ronde, afgeleid uit de salt).
--    Bestaande rondes zijn schema 1.
ALTER TABLE rounds ADD COLUMN commitment_schema INTEGER NOT NULL DEFAULT 1 CHECK (commitment_schema IN (1, 2));

-- 2. Een derde soort publicatie in de ID van de speler: de actie-bundel
--    ('bundle'), versleuteld naar `encrypt_to_address`. Voor resultaat en
--    attestatie blijft dat veld leeg (die zijn publiek leesbaar). SQLite kan een
--    CHECK niet wijzigen: tabel opnieuw opbouwen, gegevens behouden (zoals 009).
CREATE TABLE player_publications_v3 (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  kind TEXT NOT NULL DEFAULT 'result' CHECK (kind IN ('result', 'attestation', 'bundle')),
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
  encrypt_to_address TEXT CHECK ((kind = 'bundle') = (encrypt_to_address IS NOT NULL)),
  PRIMARY KEY (attempt_id, kind)
);

INSERT INTO player_publications_v3 (
  attempt_id, kind, content_key, content_key_fqn, record_json, record_sha256, request_id_hex, request_hex,
  wallet_uri, response_mode, status, created_height, expires_height, created_at_ms, receipt_txid, receipt_at_ms,
  published_txid, published_height, published_at_ms, last_checked_at_ms, encrypt_to_address
)
SELECT
  attempt_id, kind, content_key, content_key_fqn, record_json, record_sha256, request_id_hex, request_hex,
  wallet_uri, response_mode, status, created_height, expires_height, created_at_ms, receipt_txid, receipt_at_ms,
  published_txid, published_height, published_at_ms, last_checked_at_ms, NULL
FROM player_publications;

DROP TABLE player_publications;
ALTER TABLE player_publications_v3 RENAME TO player_publications;
CREATE INDEX player_publications_status_idx ON player_publications (status, expires_height);
