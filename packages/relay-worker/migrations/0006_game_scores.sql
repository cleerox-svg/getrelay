-- Score log for the Fog mini game (foggy-window guessing game that
-- replaces the Discover tab).
--
-- One row per completed game. Leaderboards are computed on read as
-- MAX(score) per user over a time window, scoped to the viewer's
-- contacts — so no separate leaderboard table is needed. `game` is a
-- discriminator column defaulting to 'fog' so future mini games can
-- share the table without a rebuild.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Apply via the
-- "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0006_game_scores.sql

CREATE TABLE IF NOT EXISTS game_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL DEFAULT 'fog',
  score INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  best_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_scores_user_time ON game_scores(user_id, created_at DESC);
