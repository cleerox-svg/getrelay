-- Per-account personal-best records for the in-app golf Course game.
--
-- One row per user (keyed on user_id, like a lightweight profile row)
-- holding their current bests across three record types. Each *_yards
-- value is stored in yards. The record types have different "is this a
-- new best?" directions, so they live in separate columns:
--   longest_drive   — higher is better (MAX)
--   closest_to_pin  — LOWER is better  (MIN)
--   longest_putt    — higher is better (MAX)
-- REAL yardages allow fractional distances. Each record keeps the hole
-- it was set on (nullable) and when (ms epoch) so the UI can render
-- "set on hole 7" without a join. Single-row-per-user lets the worker
-- upsert-on-improve with a single
--   INSERT ... ON CONFLICT(user_id) DO UPDATE ... WHERE excluded beats.
--
-- Idempotent (CREATE TABLE IF NOT EXISTS). Apply via the "Seed contacts"
-- workflow:
--   gh workflow run "Seed contacts" -F file=0007_golf_records.sql

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
