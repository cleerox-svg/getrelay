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
  -- AES-256-GCM initialization vector (base64) for an encrypted body.
  -- When set, the `body` column holds base64 ciphertext (envelope
  -- encryption at rest under the chat's DEK; see chat_keys). Legacy
  -- rows leave this NULL, meaning `body` is plaintext — the read paths
  -- pass NULL-iv rows straight through. Added on the live DB by the
  -- deploy-worker.yml pragma_table_info probe; see migrations/README.md.
  body_iv TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_chat_seq ON messages(chat_id, sequence);
-- idx_messages_reply_to is created in deploy-worker.yml *after* the
-- reply_to column has been ensured (see note on idx_participants_pinned).

-- Per-chat wrapped data-encryption keys (DEKs) for envelope encryption of
-- message bodies at rest. One row per chat, minted lazily on the first
-- message. wrapped_dek is the chat's AES-256-GCM DEK encrypted (wrapped)
-- under the root KEK (from env.MESSAGE_KEK); dek_iv is the AES-GCM IV used
-- for that wrap; kek_version records which KEK version wrapped it so the
-- KEK can rotate without re-encrypting bodies (only DEKs get re-wrapped).
-- No CASCADE from chats: deleting the wrapped DEK is the crypto-shredding
-- mechanism and must be an explicit act. Idempotent — also lives in
-- migrations/0010_chat_keys.sql.
CREATE TABLE IF NOT EXISTS chat_keys (
  chat_id     TEXT PRIMARY KEY,
  wrapped_dek TEXT NOT NULL,
  dek_iv      TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

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
-- NOTE: the (user_id, game, course) index is NOT created here. `course` is a
-- probe-added column (see deploy-worker.yml), and on the live DB schema.sql
-- runs BEFORE that ALTER, so an index referencing `course` would fail with
-- "no such column: course". It is created in deploy-worker.yml after the
-- column probes, alongside the other column-dependent indexes.

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

-- Daily Challenge results for the golf game. Each UTC calendar day the server
-- derives one seeded course hole deterministically from the date (no stored
-- "challenge" row needed) and every player attempts the identical setup. This
-- table holds one row per user per day — their BEST attempt for that day. The
-- worker upserts on (user_id, date), replacing the row only when the new
-- attempt beats the stored one (fewer strokes / lower to_par / higher score).
-- Leaderboards are contact-scoped and computed on read from (date, score) — no
-- separate leaderboard table is needed. `game` is the underlying mode id (e.g.
-- 'golfcourse') so future daily modes can share the table. `seed` is the
-- server-derived shared RNG seed (INTEGER, matching game_challenges.seed).
-- `score` is derived leaderboard points (higher is better), mirroring the
-- game_scores points model; `to_par` is strokes relative to par (negative =
-- under). Both user FKs cascade so a deleted account takes its results with it.
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
-- Daily leaderboard reads: order today's rows by points (higher better) and by
-- to_par (lower better). Plus the game_scores-style per-user recency index.
CREATE INDEX IF NOT EXISTS idx_daily_results_date_score ON daily_results(date, score DESC);
CREATE INDEX IF NOT EXISTS idx_daily_results_date_topar ON daily_results(date, to_par);
CREATE INDEX IF NOT EXISTS idx_daily_results_user_time ON daily_results(user_id, created_at DESC);

-- Per-account Daily Challenge streak state. One row per user (keyed on user_id,
-- like golf_records) so the worker can upsert-on-complete with a single
--   INSERT ... ON CONFLICT(user_id) DO UPDATE ...
-- `current` is the running consecutive-day streak, `best` the highest ever
-- reached, `last_date` the last UTC day counted toward the streak (used to
-- decide continue vs. reset when a new daily is completed).
CREATE TABLE IF NOT EXISTS daily_streaks (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current INTEGER NOT NULL DEFAULT 0,   -- current consecutive-day streak
  best INTEGER NOT NULL DEFAULT 0,      -- best streak ever reached
  last_date TEXT,                       -- last UTC day counted toward the streak
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- "Rapid" golf tournaments: a short seeded 3-hole stroke-play event that
-- rotates every day or two. Everyone plays the SAME seeded holes; a player's
-- BEST score within the open window counts toward a GLOBAL leaderboard (with a
-- client-side friends filter). Joining = opting into the global board.
--
-- Like the Daily Challenge, an event's definition is DERIVED deterministically
-- from a period index (no cron needed to create events). The `tournaments` row
-- is created LAZILY on first entry so that settlement has a concrete row to
-- rank against and to mark as awarded exactly once. `id` IS that period index,
-- so a given event maps to exactly one row. `seed` is the shared RNG seed
-- (INTEGER, matching game_challenges.seed / daily_results.seed). `holes` is a
-- JSON array of {course, hole} objects (3 entries) so the exact hole set is
-- pinned at open time even if hole-derivation logic later changes. `opened_at`
-- / `closes_at` bound the entry window; settlement scans closed & unsettled
-- events (idx_tournaments_closes_at), ranks their entries, awards, and flips
-- `settled` to 1 so it never re-awards.
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
-- Settlement scans events past their close that haven't been awarded yet.
CREATE INDEX IF NOT EXISTS idx_tournaments_closes_at ON tournaments(closes_at);

-- One row per (tournament, user): that user's BEST entry for the event. The
-- worker upserts on (tournament_id, user_id), replacing the row only when the
-- new run beats the stored one (higher `score` / lower `to_par` / fewer
-- `strokes`). `score` is derived leaderboard points (higher is better),
-- mirroring the game_scores / daily_results points model; `to_par` is strokes
-- relative to par across the 3 holes (negative = under); `strokes` is the raw
-- total. `rounds_played` counts how many times the user replayed the event
-- (best-of). Both FKs cascade: deleting the event or the account drops entries.
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
-- Global leaderboard read: rank an event's entries by points (higher better),
-- with to_par as the tiebreak (lower better).
CREATE INDEX IF NOT EXISTS idx_tournament_entries_board ON tournament_entries(tournament_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_tournament_entries_topar ON tournament_entries(tournament_id, to_par);

-- Per-account cumulative trophy tally. One row per user (keyed on user_id, like
-- golf_records / daily_streaks) so the worker can upsert-on-award with a single
--   INSERT ... ON CONFLICT(user_id) DO UPDATE ...
-- `trophies` is total trophy points earned across all events, `golds` counts
-- 1st-place finishes, `podiums` counts top-3 finishes, `best_rank` is the
-- lowest (best) rank number ever achieved, `events_played` counts settled
-- events the user placed in.
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

-- Per-event award history AND settlement idempotency guard. Settlement writes
-- one row per placed user (rank + trophies awarded) inside the same pass that
-- flips tournaments.settled to 1; the UNIQUE(tournament_id, user_id) makes a
-- re-run a no-op. Keeps a permanent placement record for profile/history views
-- without re-deriving from entries. Both FKs cascade.
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

-- ---------------------------------------------------------------------------
-- Golf economy + progression: soft currency ("coins"), cosmetics, season track.
--
-- Design mirrors the tournament/daily precedents: definitions that CAN be
-- derived deterministically in code live in code, not the DB. The cosmetic
-- CATALOG (ball skins, trails, avatar frames, nameplates) is code-defined —
-- like the tournament rotation — so there is NO catalog table; the DB only
-- records what each user OWNS and has EQUIPPED. Likewise SEASON/TIER
-- definitions (which tier costs what XP, what each tier grants) are derived
-- deterministically from a period index in code; the DB stores only per-user
-- XP and which tiers were claimed.
--
-- Idempotency contract (shared with messaging-core):
--   * Every idempotent balance change writes exactly one currency_ledger row
--     keyed by (user_id, reason, ref). The partial UNIQUE index below makes a
--     replayed award a no-op, so a given earn source (tournament placement,
--     daily reward, season tier, etc.) can never be credited twice.
--   * user_wallet.balance is the running total; balance_after on the newest
--     ledger row must equal it. balance is never allowed to go negative
--     (enforced by the worker, which reads-checks-writes on spend).
-- ---------------------------------------------------------------------------

-- One row per user: their coin balance (soft currency). Created lazily on the
-- first credit/debit; kept as a running total so reads don't sum the ledger.
-- Keyed on user_id like golf_records / daily_streaks / tournament_trophies so
-- award-time is a single INSERT ... ON CONFLICT(user_id) DO UPDATE. `balance`
-- is coins and must never go negative (the worker guards spends). Cascades so a
-- deleted account drops its wallet.
CREATE TABLE IF NOT EXISTS user_wallet (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,   -- coins; never negative
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Append-only audit trail for every balance change AND the idempotency guard
-- for awards. One row per change: `delta` is signed (+earn / -spend), `reason`
-- classifies the source ('tournament_placement', 'daily_reward', 'round_reward',
-- 'season_tier', 'purchase', ...), `ref` is the source id that makes the award
-- unique (tournament id / tier number / cosmetic id; NULL only for changes that
-- carry no natural idempotency key). `balance_after` snapshots user_wallet.balance
-- as of this row. Cascades on account delete.
--
-- The partial UNIQUE index below (on rows WHERE ref IS NOT NULL) is what makes
-- idempotent earns safe: a retry of the same (user_id, reason, ref) hits the
-- constraint and is a no-op, so the wallet is credited exactly once. Callers of
-- idempotent earns MUST pass a ref; ref may be NULL only for one-off manual /
-- non-repeatable changes that intentionally opt out of the guard.
CREATE TABLE IF NOT EXISTS currency_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,               -- signed: +earn / -spend
  reason TEXT NOT NULL,                 -- e.g. tournament_placement, daily_reward, season_tier, purchase
  ref TEXT,                             -- source id (tournament id / cosmetic id / tier no); NULL opts out of the guard
  balance_after INTEGER NOT NULL,       -- user_wallet.balance snapshot after this change
  created_at INTEGER NOT NULL
);
-- Per-user history reads, newest first.
CREATE INDEX IF NOT EXISTS idx_currency_ledger_user_time ON currency_ledger(user_id, created_at DESC);
-- Idempotency guard for awards: at most one credit per (user_id, reason, ref).
-- Partial (WHERE ref IS NOT NULL) so ledger rows with a NULL ref — deliberate
-- opt-outs — aren't collapsed together. SQLite/D1 supports partial UNIQUE
-- indexes (see idx_receipts_undelivered above).
CREATE UNIQUE INDEX IF NOT EXISTS idx_currency_ledger_award
  ON currency_ledger(user_id, reason, ref) WHERE ref IS NOT NULL;

-- Owned cosmetic inventory: one row per (user, cosmetic) the user has acquired.
-- cosmetic_id references the CODE catalog (no catalog table by design), so it's
-- a free TEXT id validated in code. UNIQUE(user_id, cosmetic_id) makes a grant
-- idempotent (buy/award twice = one row). Cascades on account delete.
CREATE TABLE IF NOT EXISTS user_cosmetics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL,            -- references the code-defined catalog
  acquired_at INTEGER NOT NULL,
  UNIQUE(user_id, cosmetic_id)          -- own each cosmetic at most once
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id);

-- Currently-equipped cosmetic per slot: one row per (user, slot). `slot` is a
-- code-defined slot id ('ball', 'trail', 'frame', 'nameplate', ...) and PK
-- (user_id, slot) enforces one equipped item per slot; equipping upserts on the
-- PK. cosmetic_id should reference something the user owns in user_cosmetics
-- (enforced in code, not by FK, since the catalog is code-defined). Cascades on
-- account delete.
CREATE TABLE IF NOT EXISTS user_equipped (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                   -- e.g. ball, trail, frame, nameplate
  cosmetic_id TEXT NOT NULL,            -- the equipped cosmetic (owned in user_cosmetics)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)           -- one equipped cosmetic per slot
);

-- Per-user per-season progression for the battle-pass-style season track.
-- season_id is the DERIVED period index (like the tournament id / daily date):
-- the tier layout and rewards for a season are computed deterministically in
-- code, so the DB stores only `xp` (accumulated from play this season) and
-- `claimed`, a JSON array of tier numbers the user has already claimed. PK
-- (user_id, season_id) so each season's progress is one upsertable row; a tier
-- claim appends its number to `claimed` (guarded in code so a tier claims once)
-- and separately writes the tier's coin reward as a currency_ledger row
-- (reason='season_tier', ref=<tier no>) and/or a user_cosmetics grant.
-- Cascades on account delete.
CREATE TABLE IF NOT EXISTS season_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER NOT NULL,           -- derived period index for the season
  xp INTEGER NOT NULL DEFAULT 0,        -- XP accumulated this season
  claimed TEXT NOT NULL DEFAULT '[]',   -- JSON array of claimed tier numbers
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, season_id)      -- one progress row per user per season
);

-- ---------------------------------------------------------------------------
-- Baseball progression: player cards (level + duplicate copies) + ranked ladder.
--
-- Scope note, because most of this milestone needs NO schema at all. New
-- cosmetic slots (bat / glove / kit / walk-up) are free — the catalog is
-- code-defined and user_equipped.slot is free-form TEXT. New game ids are free
-- — game_scores.game is TEXT. Coins / ledger / season XP are already generic.
-- The two things the existing tables genuinely cannot express are (a) an owned
-- item carrying a LEVEL and a DUPLICATE-COPY COUNT — user_cosmetics is a flat
-- one-row-per-owned-id inventory with no per-row progression state — and (b) a
-- RANKED LADDER with trophies that move up and down (tournament_trophies is a
-- cumulative per-event tally, not a rank). Those are the only reasons the four
-- tables below exist; anything that fits user_cosmetics / user_equipped /
-- currency_ledger belongs there, not here.
--
-- Same code-over-DB design as the golf economy: the CARD CATALOG, the SLOT set
-- and the LADDER TIER LAYOUT all live in code, so there is no catalog table and
-- no tier table — the DB records only per-user state.
--
-- CHECK policy for these four tables is deliberate and NOT uniform. SQLite
-- cannot add a CHECK later without a full table rebuild — on D1 that's the
-- operation behind the PR #75/#76 rollbacks — so each is a one-way door. The
-- rule: CHECK a numeric column ONLY where it has no subtract path. `level`,
-- `wins`, `losses` only ever increment, so a CHECK can only ever catch a bug.
-- SPENDABLE columns get NO CHECK — `copies` (consumed by card upgrades) and
-- `trophies` (taken away on a defeat) are guarded by the worker's
-- read-check-write, exactly as 0013 guards user_wallet.balance, because on a
-- spendable column a CHECK turns a clamping bug into a FAILED WRITE that loses
-- the match result or the pack the player just opened. `best_trophies`/`tier`
-- are written in the same statement as `trophies`, so a CHECK there fails that
-- statement too. (The pre-existing CHECKs elsewhere in this file are all
-- enum-membership on TEXT; these are the first numeric-range ones.)
-- ---------------------------------------------------------------------------

-- Per-user card ownership. card_id references the CODE-defined card catalog
-- (exactly like user_cosmetics.cosmetic_id) — deliberately NOT a FK, since
-- there is no catalog table by design. `level` is the card's upgrade level and
-- `copies` is the duplicate count banked toward the next level; that pair is
-- what user_cosmetics cannot carry. UNIQUE(user_id, card_id) makes a grant
-- idempotent: pulling a card you already own is an UPDATE that bumps `copies`,
-- never a second row. Cascades on account delete.
--
-- No separate by-user index: the UNIQUE(user_id, card_id) constraint's implicit
-- index has user_id as its leftmost column, so `WHERE user_id = ?` (the card
-- collection read) is already served by it. A standalone index on (user_id)
-- would be a redundant prefix and pure write amplification.
CREATE TABLE IF NOT EXISTS player_cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL,                -- code-defined catalog id; NOT a FK
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),  -- monotonic: no subtract path
  copies INTEGER NOT NULL DEFAULT 0,    -- duplicates banked toward next level; SPENT on upgrade, so no CHECK
  acquired_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(user_id, card_id)              -- one row per card; dupes bump `copies`
);

-- The equipped card per lineup slot: one row per (user, slot). Shaped exactly
-- like user_equipped — `slot` is a code-defined slot id ('batter', 'pitcher',
-- 'bat', 'glove', 'coach') and PK (user_id, slot) enforces one card per slot,
-- so equipping upserts on the PK. card_id should reference something the user
-- owns in player_cards (enforced in code, not by FK, since the catalog is
-- code-defined). The PK's implicit index is leftmost-on-user_id, so the
-- whole-lineup read `WHERE user_id = ?` is served by it. Cascades on delete.
CREATE TABLE IF NOT EXISTS user_lineup (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                   -- batter | pitcher | bat | glove | coach
  card_id TEXT NOT NULL,                -- the equipped card (owned in player_cards)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)           -- one equipped card per slot
);

-- Per-user ranked ladder state. One row per user, keyed on user_id like
-- user_wallet / tournament_trophies, so recording a result is a single
-- INSERT ... ON CONFLICT(user_id) DO UPDATE. `trophies` is the current count
-- (moves both directions, never below zero — the worker clamps); `tier` is the
-- resolved rank tier index, derived in code from `trophies` and stored so
-- leaderboard reads don't recompute it; `best_trophies` is the peak ever held.
-- Cascades on account delete.
CREATE TABLE IF NOT EXISTS ladder_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  trophies INTEGER NOT NULL DEFAULT 0,      -- current count; DECREMENTS on a loss, so no CHECK (worker clamps)
  tier INTEGER NOT NULL DEFAULT 0,          -- resolved rank tier index (layout in code)
  best_trophies INTEGER NOT NULL DEFAULT 0, -- peak trophies ever held
  wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),      -- monotonic
  losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),  -- monotonic
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Ladder leaderboard reads, highest trophies first. The per-user read is served
-- by the user_id PRIMARY KEY.
CREATE INDEX IF NOT EXISTS idx_ladder_state_trophies ON ladder_state(trophies DESC);

-- Pack awards. `pack_id` is a code-defined pack type. `contents` is the JSON
-- array of rolled card ids and is written AT GRANT TIME, not on open, so the
-- row is self-consistent from birth and the roll is auditable; `opened_at` is
-- purely the reveal flag (NULL until revealed, so unopened packs are just
-- `WHERE opened_at IS NULL`). Rolling at grant also means a CATALOG CHANGE
-- BETWEEN GRANT AND OPEN CANNOT ALTER WHAT THE PLAYER WAS PROMISED, and it
-- removes the double-encoding where "opened with an empty roll" is
-- indistinguishable from a half-landed write. UX is unchanged — a pack rolled
-- at grant still reveals on open. `updated_at` exists because these rows (alone
-- among the four tables here) mutate after insert.
--
-- The idempotency guard is (user_id, reason, ref) — structurally IDENTICAL to
-- idx_currency_ledger_award, and the third column is load-bearing rather than
-- decorative. One source event routinely awards more than one thing under the
-- SAME ref: economy.ts's addXp() reuses the ledger guard with an `xp:`-prefixed
-- REASON exactly so its marker row doesn't collide with the coin row sharing
-- that (user_id, ref). The same case here is one ladder tier granting both a
-- card pack and a coin pack at ref='7'. A two-column (user_id, ref) guard would
-- silently swallow the second: the house idiom is INSERT OR IGNORE, and callers
-- read meta.changes < 1 as "already granted" — no throw, no log, one pack
-- missing. So namespace the REASON ('ladder_tier', 'season_tier', 'daily',
-- 'purchase') and let ref be the plain source id.
--
-- "Replay is a no-op" holds only for writes that opt in (INSERT OR IGNORE, or
-- ON CONFLICT DO NOTHING); a bare INSERT throws UNIQUE constraint failed. And
-- upserting against this PARTIAL index requires repeating its predicate in the
-- conflict target — `ON CONFLICT(user_id, reason, ref) WHERE ref IS NOT NULL`
-- — or SQLite errors "does not match any PRIMARY KEY or UNIQUE constraint".
-- ref may be NULL only for grants deliberately opting out of the guard.
-- Cascades on account delete.
CREATE TABLE IF NOT EXISTS pack_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,                -- code-defined pack type
  reason TEXT NOT NULL,                 -- award source class: ladder_tier, season_tier, daily, purchase
  ref TEXT,                             -- source id within that reason; NULL opts out of the guard
  contents TEXT NOT NULL DEFAULT '[]',  -- JSON array of rolled card ids; ROLLED AT GRANT, not on open
  opened_at INTEGER,                    -- NULL until revealed; reveal flag only, contents already set
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL           -- rows mutate after insert (open), unlike the other three
);
-- Per-user pack history / unopened-pack reads, newest first.
CREATE INDEX IF NOT EXISTS idx_pack_grants_user_time ON pack_grants(user_id, created_at DESC);
-- Idempotency guard, structurally identical to idx_currency_ledger_award: at
-- most one grant per (user_id, reason, ref). Partial (WHERE ref IS NOT NULL) so
-- opted-out grants with a NULL ref aren't collapsed together.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_grants_award
  ON pack_grants(user_id, reason, ref) WHERE ref IS NOT NULL;
