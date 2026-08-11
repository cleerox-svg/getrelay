-- Per-chat wrapped data-encryption keys (DEKs) for envelope encryption of
-- message bodies at rest.
--
-- Relay stores message bodies as plaintext in D1. Envelope encryption at
-- rest gives each chat a random 256-bit AES-GCM DEK that encrypts its
-- message bodies; the DEK itself is stored *wrapped* (AES-GCM) under a root
-- KEK held in a Wrangler secret (MESSAGE_KEK). One row per
-- chat, minted lazily on the first message:
--   wrapped_dek — the chat's DEK encrypted under the current KEK (base64)
--   dek_iv      — the AES-GCM IV used to wrap it (base64)
--   kek_version — which KEK version wrapped it, so the KEK can rotate
--                 without re-encrypting bodies (only DEKs get re-wrapped)
-- No CASCADE from chats: deleting a chat's wrapped DEK is the crypto-
-- shredding mechanism and must be an explicit act.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Apply via the "Seed contacts"
-- workflow:
--   gh workflow run "Seed contacts" -F file=0010_chat_keys.sql

CREATE TABLE IF NOT EXISTS chat_keys (
  chat_id     TEXT PRIMARY KEY,
  wrapped_dek TEXT NOT NULL,
  dek_iv      TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
