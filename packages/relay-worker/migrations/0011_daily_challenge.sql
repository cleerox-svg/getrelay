-- Daily Challenge for the golf game: results + streak state.
--
-- Each UTC calendar day the server derives one seeded course hole
-- deterministically from the date (no stored "challenge" row needed) and every
-- player attempts the identical setup. Two tables:
--
--   daily_results — one row per user per day, holding their BEST attempt. The
--     worker upserts on (user_id, date), replacing the row only when the new
--     attempt beats the stored one (fewer strokes / lower to_par / higher
--     score). Contact-scoped leaderboards are computed on read from
--     (date, score) — no separate leaderboard table. `game` is the underlying
--     mode id (e.g. 'golfcourse') so future daily modes share the table.
--     `seed` is the server-derived shared RNG seed (INTEGER, matching
--     game_challenges.seed). `score` is derived leaderboard points (higher is
--     better), mirroring game_scores; `to_par` is strokes relative to par.
--     Indexed by (date, score DESC) and (date, to_par) for leaderboard reads,
--     plus (user_id, created_at DESC) mirroring idx_game_scores_user_time.
--
--   daily_streaks — one row per user (keyed on user_id, like golf_records) so
--     the worker can upsert-on-complete. `current` is the running
--     consecutive-day streak, `best` the highest ever, `last_date` the last UTC
--     day counted (to decide continue vs. reset on the next completion).
--
-- Both user FKs cascade so a deleted account takes its rows with it.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Apply via the "Seed
-- contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0011_daily_challenge.sql

CREATE TABLE IF NOT EXISTS daily_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,                 -- UTC calendar day 'YYYY-MM-DD'
  game TEXT NOT NULL,                 -- underlying mode id, e.g. 'golfcourse'
  course TEXT,                        -- course id, NULL if not course-based
  hole INTEGER,                       -- single-hole index for the day
  seed INTEGER NOT NULL,             -- server-derived shared RNG seed
  strokes INTEGER,                   -- strokes on the best attempt
  to_par INTEGER,                    -- strokes relative to par (neg = under)
  score INTEGER,                     -- leaderboard points (higher is better)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, date)             -- one row per user per day; upserts to best
);
CREATE INDEX IF NOT EXISTS idx_daily_results_date_score ON daily_results(date, score DESC);
CREATE INDEX IF NOT EXISTS idx_daily_results_date_topar ON daily_results(date, to_par);
CREATE INDEX IF NOT EXISTS idx_daily_results_user_time ON daily_results(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current INTEGER NOT NULL DEFAULT 0,   -- current consecutive-day streak
  best INTEGER NOT NULL DEFAULT 0,      -- best streak ever reached
  last_date TEXT,                       -- last UTC day counted toward the streak
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
