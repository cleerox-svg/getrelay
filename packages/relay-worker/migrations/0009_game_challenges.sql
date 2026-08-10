-- Async friend challenges for the golf games (Games/golf redesign).
--
-- One row per challenge. The challenger picks a game ('golf' | 'golfrange'),
-- optionally a course and a single hole, and a shared RNG seed so both sides
-- play identical conditions. The opponent plays the same setup later; the two
-- scores are compared to decide a winner. challenger_score / opponent_score
-- are NULL until each side plays; status flips 'pending' -> 'complete' once
-- resolved. winner_id is NULL for a tie or while pending. chat_id points at
-- the 1:1 chat the challenge card was posted to, so the opponent is notified
-- in-thread. Both user FKs cascade so a deleted account takes its challenges
-- with it. Indexed by (opponent_id, status) and (challenger_id, status) to
-- list a user's incoming/outgoing pending challenges cheaply.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Apply via the
-- "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0009_game_challenges.sql

CREATE TABLE IF NOT EXISTS game_challenges (
  id TEXT PRIMARY KEY,
  game TEXT NOT NULL,                 -- 'golf' | 'golfrange'
  course TEXT,                        -- course id, NULL for range
  hole INTEGER,                       -- single-hole challenge index, NULL for full round
  seed INTEGER NOT NULL,             -- shared RNG seed so both play identical conditions
  challenger_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opponent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenger_score INTEGER,          -- NULL until played
  opponent_score  INTEGER,           -- NULL until played
  winner_id TEXT,                    -- NULL = tie or pending
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'complete'
  chat_id TEXT,                      -- 1:1 chat the challenge card was posted to
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_challenges_opponent ON game_challenges(opponent_id, status);
CREATE INDEX IF NOT EXISTS idx_game_challenges_challenger ON game_challenges(challenger_id, status);
