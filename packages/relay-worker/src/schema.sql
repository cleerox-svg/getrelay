-- Relay v2 D1 schema.
-- Apply locally:  pnpm db:apply:local
-- Apply remote:   pnpm db:apply:remote
--
-- Schema verification rule: before writing any SQL that references columns,
-- run `PRAGMA table_info(<table>)` first. Never SELECT non-existent columns.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pin TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status_message TEXT,
  avatar_url TEXT,
  avatar_r2_key TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  is_admin INTEGER NOT NULL DEFAULT 0,
  -- Master kill switch. When 0, sports push is completely off no matter
  -- what the per-event toggles below say.
  sports_notifications INTEGER NOT NULL DEFAULT 1,
  -- Per-event toggles. Default ON; can be set independently.
  sports_notify_start INTEGER NOT NULL DEFAULT 1,
  sports_notify_score INTEGER NOT NULL DEFAULT 1,
  sports_notify_final INTEGER NOT NULL DEFAULT 1,
  -- When 0, this user's Fog results never appear as /feed events — not
  -- for their contacts and not for themselves. Scores are still recorded
  -- and still rank on the leaderboard; this only governs the feed.
  game_feed_shared INTEGER NOT NULL DEFAULT 1,
  -- When status_message was last changed (ms epoch). last_seen_at tracks
  -- presence, not authorship, so it can't order a chronological feed:
  -- a months-old status on an online user would sort above a fresh one.
  -- NULL on rows written before this column existed; readers fall back
  -- to last_seen_at.
  status_updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_pin ON users(pin);
CREATE INDEX IF NOT EXISTS idx_users_google_sub ON users(google_sub);

-- Each row = one (user, team) follow. team_key is the league's native
-- identifier: NHL uses team abbrev ("MTL"), MLB uses numeric team id
-- as a string ("141"). Letting MLB use its numeric id keeps the schedule
-- API integration straightforward.
CREATE TABLE IF NOT EXISTS user_sports_subs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league TEXT NOT NULL CHECK(league IN ('NHL','MLB')),
  team_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, league, team_key)
);
CREATE INDEX IF NOT EXISTS idx_uss_team ON user_sports_subs(league, team_key);

CREATE TABLE IF NOT EXISTS sessions (
  jwt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS contacts (
  owner_id TEXT NOT NULL REFERENCES users(id),
  contact_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT,
  category TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_id);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('1to1','group')),
  subject TEXT,
  -- Group avatar. Both nullable: a fresh group has neither, the
  -- client renders the hashed-letter GroupAvatar fallback in that
  -- case. avatar_r2_key is the canonical store (uploaded image
  -- lives in the AVATARS bucket under ga-<uuid>.<ext>); avatar_url
  -- is reserved for any future external-url variant (eg cropped
  -- preset) and is currently unused.
  avatar_url TEXT,
  avatar_r2_key TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_participants (
  chat_id   TEXT NOT NULL REFERENCES chats(id),
  user_id   TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  muted     INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_participants_user ON chat_participants(user_id);
-- idx_participants_pinned is created in deploy-worker.yml *after* the
-- pinned_at column has been ensured. It can't live here because on
-- existing databases the CREATE TABLE IF NOT EXISTS above is a no-op,
-- which means pinned_at isn't yet a real column at schema-apply time
-- and the index creation would fail.

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('text','image','voice','ping','system')),
  body TEXT,
  media_r2_key TEXT,
  -- External media URL (e.g. Tenor for GIFs). Used in lieu of
  -- media_r2_key when the content isn't hosted on our own R2 bucket.
  media_url TEXT,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, sequence);
-- idx_messages_reply_to is created in deploy-worker.yml *after* the
-- reply_to column has been ensured (see note on idx_participants_pinned).

-- One row per (message, user, emoji). PK keeps a single user from
-- reacting with the same emoji twice; toggling delete + re-insert.
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  emoji      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS receipts (
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  delivered_at INTEGER,
  read_at INTEGER,
  PRIMARY KEY (message_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_recipient ON receipts(recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_receipts_undelivered ON receipts(recipient_id, delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS outbound_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('delivered','read','message_preview','presence','ping','invite')),
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbound_user_pending ON outbound_events(user_id, consumed, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Native (FCM) push tokens for Capacitor Android/iOS installs, which can't
-- use Web Push. One row per device token; a user can have several.
CREATE TABLE IF NOT EXISTS native_push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL DEFAULT 'android',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_push_user ON native_push_tokens(user_id);

CREATE TABLE IF NOT EXISTS status_posts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_user_time ON status_posts(user_id, created_at DESC);

-- Small key/value table used by the sports cron to remember the
-- last-seen game state per (league, date). Keeps notification de-dup
-- self-contained — no new table per game.
CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A blocks B: hides B from A's contact list / chats / status feed and
-- causes the message gateway to drop new direct messages from B → A.
-- One-directional by design — the blocked party doesn't know they
-- were blocked.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON user_blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_blocks(blocked_id);

-- One row per completed Fog game (the foggy-window guessing game on the
-- old Discover tab). Leaderboards are computed as MAX(score) per user
-- over a time window, scoped to the viewer's contacts — no separate
-- leaderboard table needed.
CREATE TABLE IF NOT EXISTS game_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game TEXT NOT NULL DEFAULT 'fog',
  score INTEGER NOT NULL,
  rounds INTEGER NOT NULL,
  best_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  -- Course id string (e.g. 'augusta', 'listowel-vintage') for the golf
  -- Course game, enabling per-course leaderboards. NULL for range/practice
  -- and non-course games (e.g. Fog). Added on the live DB by the
  -- deploy-worker.yml pragma_table_info probe; see migrations/README.md.
  course TEXT,
  -- Round total strokes relative to par for golf Course and Mini-Golf
  -- rounds (negative = under par, positive = over). Powers per-course
  -- "avg to par" and handicap stats. NULL for driving range / non-golf
  -- games. Added on the live DB by the deploy-worker.yml pragma_table_info
  -- probe; see migrations/README.md.
  to_par INTEGER
);
CREATE INDEX IF NOT EXISTS idx_game_scores_user_time ON game_scores(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_game_scores_user_game_course ON game_scores(user_id, game, course);

-- Per-account personal-best records for the in-app golf Course game.
-- One row per user (keyed on user_id, like a profile) holding their
-- current bests across three record types. Each *_yards value is stored
-- in yards. The three records have different "is this a new best?"
-- directions, so they live in separate columns rather than rows:
--   longest_drive   — higher is better (MAX)
--   closest_to_pin  — LOWER is better  (MIN)
--   longest_putt    — higher is better (MAX)
-- Values are REAL to allow fractional yardages. Each record keeps the
-- hole it was set on (nullable) and when (ms epoch), so the UI can show
-- "set on hole 7" without a join. Columns are NULL until a first record
-- of that type is posted; the worker upserts a column only when the new
-- value beats the stored one. Single-row-per-user makes that a simple
-- INSERT ... ON CONFLICT(user_id) DO UPDATE ... WHERE excluded beats.
CREATE TABLE IF NOT EXISTS golf_records (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- longest tee/drive shot in yards (higher is better)
  longest_drive_yards REAL,
  longest_drive_hole INTEGER,
  longest_drive_at INTEGER,
  -- closest an approach shot finished to the pin in yards (LOWER is better)
  closest_to_pin_yards REAL,
  closest_to_pin_hole INTEGER,
  closest_to_pin_at INTEGER,
  -- longest holed putt in yards (higher is better)
  longest_putt_yards REAL,
  longest_putt_hole INTEGER,
  longest_putt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Async friend challenges for the golf games. One row per challenge: the
-- challenger picks a game/course/hole and a shared RNG seed, the opponent
-- plays the identical conditions later, and scores are compared to decide a
-- winner. Both scores are NULL until each side plays; status flips to
-- 'complete' once resolved. A challenge card is posted to the 1:1 chat
-- (chat_id) so the opponent gets notified in-thread.
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
