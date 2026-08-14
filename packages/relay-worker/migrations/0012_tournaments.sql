-- "Rapid" golf tournaments: global seeded 3-hole stroke-play events with
-- trophies. Four tables:
--
--   tournaments — one row per event, keyed on the deterministic period index
--     (`id`). Everyone plays the SAME seeded holes; the event definition is
--     DERIVED from the period index (like the Daily Challenge, no cron to
--     create events), but a row is materialised LAZILY on first entry so
--     settlement has something concrete to rank + mark as awarded once. `seed`
--     is the shared RNG seed (INTEGER, matching game_challenges.seed). `holes`
--     is a JSON array of {course, hole} (3 entries), pinned at open time.
--     `opened_at`/`closes_at` bound the window; `settled` flips to 1 once
--     awarded. Indexed by closes_at for the settlement scan (closed + unsettled).
--
--   tournament_entries — one row per (tournament, user): that user's BEST run
--     for the event. Upsert on (tournament_id, user_id), replacing only when the
--     new run beats the stored one (higher score / lower to_par / fewer
--     strokes). `score` is derived leaderboard points (higher is better),
--     mirroring game_scores / daily_results; `to_par` is strokes relative to par
--     (neg = under); `strokes` the raw total; `rounds_played` counts replays.
--     Indexed (tournament_id, score DESC) for the global board and
--     (tournament_id, to_par) as the tiebreak.
--
--   tournament_trophies — per-user cumulative tally (one row per user, keyed on
--     user_id like golf_records / daily_streaks) so award-time is an upsert.
--     `trophies` total points, `golds` 1st places, `podiums` top-3 finishes,
--     `best_rank` lowest/best rank ever, `events_played` settled events placed in.
--
--   tournament_placements — per-event award history AND settlement idempotency
--     guard. One row per placed user (rank + trophies awarded), written in the
--     same pass that sets tournaments.settled = 1; UNIQUE(tournament_id, user_id)
--     makes a re-run a no-op.
--
-- All user/tournament FKs cascade so a deleted account or event takes its rows.
--
-- Settlement flow (worker): for each tournament past closes_at with settled = 0,
-- rank tournament_entries by score DESC (to_par asc tiebreak), INSERT a
-- tournament_placements row per finisher, bump each finisher's
-- tournament_trophies (trophies/golds/podiums/best_rank/events_played), then set
-- tournaments.settled = 1. The placements UNIQUE + settled flag make it safe to
-- re-run.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Apply via the "Seed
-- contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0012_tournaments.sql

CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,             -- deterministic period index (the event id)
  kind TEXT NOT NULL DEFAULT 'rapid', -- event family; 'rapid' for now
  seed INTEGER NOT NULL,             -- shared RNG seed (matches game_challenges.seed)
  holes TEXT NOT NULL,               -- JSON array of {course, hole}, 3 entries
  opened_at INTEGER NOT NULL,         -- window open (ms epoch)
  closes_at INTEGER NOT NULL,         -- window close (ms epoch)
  settled INTEGER NOT NULL DEFAULT 0, -- 1 once placements + trophies awarded
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tournaments_closes_at ON tournaments(closes_at);

CREATE TABLE IF NOT EXISTS tournament_entries (
  id TEXT PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,            -- leaderboard points (higher is better)
  to_par INTEGER,                    -- strokes relative to par (neg = under)
  strokes INTEGER,                   -- raw total strokes across the 3 holes
  rounds_played INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tournament_id, user_id)     -- one best row per user per event
);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_board ON tournament_entries(tournament_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_topar ON tournament_entries(tournament_id, to_par);

CREATE TABLE IF NOT EXISTS tournament_trophies (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trophies INTEGER NOT NULL DEFAULT 0,       -- total trophy points
  golds INTEGER NOT NULL DEFAULT 0,          -- 1st-place finishes
  podiums INTEGER NOT NULL DEFAULT 0,        -- top-3 finishes
  best_rank INTEGER,                         -- lowest/best rank number ever
  events_played INTEGER NOT NULL DEFAULT 0,  -- settled events placed in
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tournament_placements (
  id TEXT PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank INTEGER NOT NULL,             -- 1-based finishing rank in the event
  trophies INTEGER NOT NULL,         -- trophy points awarded for this placement
  created_at INTEGER NOT NULL,
  UNIQUE(tournament_id, user_id)     -- one placement per user per event
);
CREATE INDEX IF NOT EXISTS idx_tournament_placements_user ON tournament_placements(user_id, created_at DESC);
