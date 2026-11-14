-- Fase 8: manifesten van games (regels-hash + handtekening van de ontwikkelaar).
-- Eén rij per game-versie. Status: pending (tekenverzoek uitgegeven) → signed
-- (handtekening gecontroleerd). Publicatie op Arcade@ loopt via het
-- bestaande journaal (chain_operations, operation_type 'game-manifest').
CREATE TABLE game_manifests (
  slug TEXT NOT NULL,
  game_version TEXT NOT NULL,
  developer TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'signed')),
  manifest_json TEXT NOT NULL,
  message TEXT NOT NULL,
  request_id_hex TEXT UNIQUE,
  request_hex TEXT,
  wallet_uri TEXT,
  expires_height INTEGER,
  signed_json TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (slug, game_version)
);
