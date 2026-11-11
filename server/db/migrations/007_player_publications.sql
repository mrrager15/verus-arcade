-- Fase 2: de speler publiceert zijn resultaat (met Merkle-bewijs) in zijn eigen
-- VerusID onder de namespace van Arcade@, via een IdentityUpdateRequest in Verus
-- Mobile. Eén publicatie per poging. De txid uit het wallet-antwoord is een
-- ontvangstbewijs; pas na teruglezen van de chain (hash gelijk) is het 'published'.
CREATE TABLE player_publications (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
  content_key TEXT NOT NULL,                -- VDXF-key (i-adres) onder de Arcade-namespace
  content_key_fqn TEXT NOT NULL,            -- volledig gekwalificeerde naam, bv. Arcade.VRSCTEST.::arcade.player.result.<ronde>
  record_json TEXT NOT NULL,                -- canoniek JSON-record (schema arcade-player-result v1, max 2048 bytes)
  record_sha256 TEXT NOT NULL,              -- sha256 van record_json; vergeleken met wat op de chain staat
  request_id_hex TEXT NOT NULL UNIQUE,      -- 20 bytes hex; ook het i-adres van het verzoek
  request_hex TEXT NOT NULL,                -- getekend GenericRequest, byte-exact
  wallet_uri TEXT NOT NULL,                 -- deeplink / QR-inhoud
  response_mode TEXT NOT NULL CHECK (response_mode IN ('redirect', 'post')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'receipt', 'published', 'expired', 'mismatch')),
  created_height INTEGER NOT NULL,
  expires_height INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  receipt_txid TEXT,                        -- txid uit het wallet-antwoord (ontvangstbewijs)
  receipt_at_ms INTEGER,
  published_txid TEXT,                      -- transactie waarin het record op de chain verscheen
  published_height INTEGER,
  published_at_ms INTEGER,
  last_checked_at_ms INTEGER                -- laatste reconcile-controle
);

CREATE INDEX player_publications_status_idx ON player_publications (status, expires_height);
