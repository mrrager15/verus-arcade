-- Fase 2b: attestaties. Na een afgesloten Daily (result-root bevestigd) tekent
-- Arcade@ per speler met een getekende poging een MMR met gezouten velden
-- (player, round, streak, rounds, solved, prev). descriptor_json bevat de
-- waarden en zouten en is PRIVÉ: alleen de speler zelf krijgt er velden uit.
-- De verzegelde vorm (wortel, blad-hashes, handtekening) mag publiek.
CREATE TABLE attestations (
  player_i_address TEXT NOT NULL,
  round_record_id TEXT NOT NULL REFERENCES rounds(id),
  attempt_id TEXT NOT NULL UNIQUE REFERENCES attempts(id),
  chain_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  game_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  descriptor_json TEXT NOT NULL,            -- volledige mmrdescriptor met waarden en zouten (privé)
  root TEXT NOT NULL UNIQUE CHECK (length(root) = 64),
  prev_root TEXT CHECK (prev_root IS NULL OR length(prev_root) = 64),
  streak INTEGER NOT NULL CHECK (streak >= 0),
  rounds INTEGER NOT NULL CHECK (rounds >= 0),
  solved INTEGER NOT NULL CHECK (solved >= 0),
  signature_json TEXT NOT NULL,             -- signaturedata van Arcade@ over de wortel (zoals signdata)
  signature_height INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (player_i_address, round_record_id),
  CHECK (streak <= solved AND solved <= rounds)
);

CREATE INDEX attestations_chain_idx ON attestations (chain_id, game_id, game_version, player_i_address);
