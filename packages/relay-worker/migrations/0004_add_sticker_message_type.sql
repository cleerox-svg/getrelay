-- Add 'sticker' to the message_type CHECK constraint on the messages
-- table. SQLite doesn't allow ALTER'ing a CHECK constraint in place;
-- the canonical workaround (per https://sqlite.org/lang_altertable.html
-- §6 "Making Other Kinds Of Table Schema Changes") is the table-rebuild
-- dance: create a new table with the new schema, copy data, drop the
-- old, rename.
--
-- D1 specifics: do NOT use BEGIN TRANSACTION / COMMIT or
-- PRAGMA foreign_keys=ON/OFF here. D1 rejects explicit transactions
-- in user SQL — its --file import already wraps the whole file in a
-- coordinated transaction with automatic rollback on failure
-- (see the wrangler warning "your DB will return to its original
-- state and you can safely retry"). For deferring the FK from
-- message_reactions(message_id) → messages(id) across the DROP
-- TABLE messages step, use PRAGMA defer_foreign_keys = ON, which
-- works inside the implicit transaction and defers FK checks to
-- commit time. By commit time the new messages table holds the same
-- rows under the same ids, so the FK checks pass.
--
-- This file is idempotent at the workflow layer: deploy-worker.yml
-- probes sqlite_master for the literal 'sticker' in the messages CHECK
-- text and skips this migration when it's already present.
--
-- Note: production has had ALTER TABLE additions over time (media_url,
-- reply_to) that may sit in a different physical column order than
-- schema.sql declares. We use an explicit column list on the INSERT to
-- be order-safe regardless.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE messages_new (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('text','image','voice','ping','system','sticker')),
  body TEXT,
  media_r2_key TEXT,
  media_url TEXT,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);

INSERT INTO messages_new (
  id, chat_id, sender_id, sequence, message_type, body,
  media_r2_key, media_url, reply_to, created_at, edited_at, deleted_at
)
SELECT
  id, chat_id, sender_id, sequence, message_type, body,
  media_r2_key, media_url, reply_to, created_at, edited_at, deleted_at
FROM messages;

DROP TABLE messages;

ALTER TABLE messages_new RENAME TO messages;

CREATE UNIQUE INDEX idx_messages_chat_seq ON messages(chat_id, sequence);
CREATE INDEX idx_messages_reply_to ON messages(reply_to);
