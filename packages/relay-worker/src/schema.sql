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
  sports_notify_final INTEGER NOT NULL DEFAULT 1
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
