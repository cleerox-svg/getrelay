-- Golf economy + progression: soft currency ("coins"), cosmetics, season track.
-- Five tables, all keeping code-derived definitions OUT of the DB (like the
-- tournament rotation / Daily Challenge): the cosmetic CATALOG and the
-- SEASON/TIER layout live in code, so the DB records only per-user state.
--
--   user_wallet — one row per user: their coin balance (soft currency). Keyed
--     on user_id like golf_records / tournament_trophies so credits are a single
--     INSERT ... ON CONFLICT(user_id) DO UPDATE. balance is a running total and
--     must never go negative (the worker guards spends).
--
--   currency_ledger — append-only audit AND idempotency guard for every balance
--     change. delta is signed (+earn / -spend); reason classifies the source
--     ('tournament_placement', 'daily_reward', 'round_reward', 'season_tier',
--     'purchase'); ref is the source id (tournament id / cosmetic id / tier no)
--     that makes an award unique; balance_after snapshots user_wallet.balance.
--     The partial UNIQUE index on (user_id, reason, ref) WHERE ref IS NOT NULL
--     makes idempotent earns safe: a replay is a no-op, crediting the wallet
--     exactly once. Callers of idempotent earns MUST pass a ref; ref is NULL
--     only for deliberate opt-outs.
--
--   user_cosmetics — owned inventory: one row per (user, cosmetic).
--     cosmetic_id references the code catalog (no catalog table).
--     UNIQUE(user_id, cosmetic_id) makes a grant idempotent.
--
--   user_equipped — currently-equipped cosmetic per slot. PK (user_id, slot)
--     enforces one item per slot; equipping upserts on the PK.
--
--   season_progress — per-user per-season progression. season_id is the derived
--     period index; the DB stores only xp and claimed (JSON array of claimed
--     tier numbers). PK (user_id, season_id). A tier claim appends its number to
--     claimed and separately writes a currency_ledger row (reason='season_tier',
--     ref=<tier no>) and/or a user_cosmetics grant.
--
-- All user FKs cascade so a deleted account takes its economy rows with it.
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS), no explicit transactions.
-- Mirrors src/schema.sql exactly. SQLite/D1 supports partial UNIQUE indexes
-- (schema.sql already ships idx_receipts_undelivered ... WHERE ... IS NULL).
-- Apply via the "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0013_golf_economy.sql

CREATE TABLE IF NOT EXISTS user_wallet (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance INTEGER NOT NULL DEFAULT 0,   -- coins; never negative
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS currency_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,               -- signed: +earn / -spend
  reason TEXT NOT NULL,                 -- e.g. tournament_placement, daily_reward, season_tier, purchase
  ref TEXT,                             -- source id (tournament id / cosmetic id / tier no); NULL opts out of the guard
  balance_after INTEGER NOT NULL,       -- user_wallet.balance snapshot after this change
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_currency_ledger_user_time ON currency_ledger(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_currency_ledger_award
  ON currency_ledger(user_id, reason, ref) WHERE ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_cosmetics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id TEXT NOT NULL,            -- references the code-defined catalog
  acquired_at INTEGER NOT NULL,
  UNIQUE(user_id, cosmetic_id)          -- own each cosmetic at most once
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id);

CREATE TABLE IF NOT EXISTS user_equipped (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                   -- e.g. ball, trail, frame, nameplate
  cosmetic_id TEXT NOT NULL,            -- the equipped cosmetic (owned in user_cosmetics)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)           -- one equipped cosmetic per slot
);

CREATE TABLE IF NOT EXISTS season_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  season_id INTEGER NOT NULL,           -- derived period index for the season
  xp INTEGER NOT NULL DEFAULT 0,        -- XP accumulated this season
  claimed TEXT NOT NULL DEFAULT '[]',   -- JSON array of claimed tier numbers
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, season_id)      -- one progress row per user per season
);
