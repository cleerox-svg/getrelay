-- Native (FCM) push tokens for Capacitor Android/iOS installs.
--
-- The Android app is a Capacitor WebView, which doesn't expose the Web
-- Push API (PushManager). Those installs register a Firebase Cloud
-- Messaging device token instead; the worker delivers the same message /
-- sports payloads to these tokens via the FCM HTTP v1 API. One row per
-- device token; a user can have several (phone, tablet, …).
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS). Apply via the
-- "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0005_native_push_tokens.sql

CREATE TABLE IF NOT EXISTS native_push_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL DEFAULT 'android',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_native_push_user ON native_push_tokens(user_id);
