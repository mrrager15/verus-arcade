-- Fase 1: de speler tekent zijn afgeronde poging met zijn VerusID via Verus Mobile.
-- Eén handtekeningverzoek per poging. De native handtekening (73 bytes, base64)
-- en de tekenhoogte komen in het canonieke resultaatrecord (schemaVersion 2).
CREATE TABLE attempt_signatures (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  request_id_hex TEXT NOT NULL UNIQUE,      -- 20 bytes hex; ook het i-adres van het verzoek
  request_hex TEXT NOT NULL,                -- getekend GenericRequest, byte-exact
  request_hash_hex TEXT NOT NULL,           -- sha256 van de rauwe request-data (binding)
  message TEXT NOT NULL,                    -- het getekende bericht (profiel v1)
  wallet_uri TEXT NOT NULL,                 -- deeplink / QR-inhoud
  response_mode TEXT NOT NULL CHECK (response_mode IN ('redirect', 'post')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'expired')),
  created_height INTEGER NOT NULL,
  expires_height INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  signed_at_ms INTEGER,
  signer_i_address TEXT,                    -- i-adres dat tekende (moet de speler zijn)
  signing_height INTEGER,                   -- hoogte uit de native handtekening
  native_signature TEXT                     -- base64 van signatureAsVch (73 bytes)
);

CREATE INDEX attempt_signatures_status_idx ON attempt_signatures (status, expires_height);
