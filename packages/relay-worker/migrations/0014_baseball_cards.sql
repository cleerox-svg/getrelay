-- Baseball progression: player cards (level + duplicate copies) and the
-- ranked trophy ladder. Four tables, and ONLY these four.
--
-- WHY THIS FILE EXISTS AT ALL — read before adding anything here.
-- Most of the baseball progression milestone needs NO migration:
--   * New cosmetic slots (bat / glove / kit / walk-up) are free: the cosmetic
--     CATALOG lives in code (src/economy.ts) and user_equipped's PK is
--     (user_id, slot) with slot a free-form TEXT column. A new slot is a code
--     change, not a schema change.
--   * New game ids are free: game_scores.game is TEXT DEFAULT 'fog'.
--   * Coins, the ledger, season XP: user_wallet / currency_ledger /
--     season_progress already cover them for any game.
-- What user_cosmetics genuinely CANNOT carry is a card with a LEVEL and a
-- DUPLICATE-COPY COUNT (it is a flat one-row-per-owned-id inventory with no
-- per-row progression state), and there is no table anywhere for a RANKED
-- LADDER with trophies (tournament_trophies is a cumulative event tally, not a
-- rank tier that moves up and down). That is the entire justification for this
-- migration. Anything that fits the existing tables does NOT belong here.
--
--   player_cards — per-user card ownership. card_id references the CODE-defined
--     card catalog (like user_cosmetics.cosmetic_id): it is deliberately NOT a
--     FK to a catalog table, because there is no catalog table by design.
--     `level` is the card's upgrade level; `copies` is the duplicate count
--     banked toward the next level. UNIQUE(user_id, card_id) makes a grant
--     idempotent — a duplicate pull is an UPDATE of `copies`, never a 2nd row.
--
--   user_lineup — the equipped card per slot. Shaped exactly like
--     user_equipped: PK (user_id, slot) enforces one card per slot and
--     equipping is an upsert on the PK. Slots are code-defined:
--     batter / pitcher / bat / glove / coach.
--
--   ladder_state — per-user ranked ladder state: current trophies, the derived
--     rank tier, and a peak/record tally. One row per user, keyed on user_id
--     like user_wallet / tournament_trophies, so a result is a single
--     INSERT ... ON CONFLICT(user_id) DO UPDATE. The TIER LAYOUT (which trophy
--     count maps to which rank name) is derived in code; the DB stores only the
--     resolved tier index so leaderboards don't have to recompute it.
--
--   pack_grants — pack awards, structurally IDENTICAL to currency_ledger's
--     idempotency guard: (user_id, reason, ref) in a partial UNIQUE index over
--     rows WHERE ref IS NOT NULL. See the contract below.
--
-- ---------------------------------------------------------------------------
-- THE IDEMPOTENCY CONTRACT (pack_grants) — the three-column guard is load-bearing
-- ---------------------------------------------------------------------------
-- The guard is (user_id, reason, ref), NOT (user_id, ref). `reason` is where the
-- namespace goes, and this is not a stylistic copy of currency_ledger — the
-- two-column shape is actively wrong. One source event routinely awards more
-- than one thing, and those awards SHARE a ref: src/economy.ts's addXp() adds
-- season XP by reusing the currency_ledger guard with an `xp:`-prefixed REASON
-- precisely so the XP marker row doesn't collide with the coin row carrying the
-- same (user_id, ref). The identical case here is one ladder tier awarding both
-- a card pack and a coin pack under ref='ladder_tier:7'. Under a two-column
-- guard the second grant is silently swallowed: creditCoins()'s house idiom is
-- INSERT OR IGNORE, and a caller reads meta.changes < 1 as "already granted"
-- (economy.ts returns credited:false there) — no exception, no log, one pack
-- quietly missing. No amount of caller-side ref prefixing fixes it, because no
-- prefix lets a SINGLE source grant TWO pack types. Namespace the REASON
-- ('ladder_tier', 'season_tier', 'daily', 'purchase'); let ref be the plain
-- source id ('7', '12', '2026-08-18').
--
-- "A replay is a no-op" is true ONLY for a write that opts into it:
--   INSERT OR IGNORE INTO pack_grants ...                      -- meta.changes === 0 on replay
--   INSERT INTO pack_grants ... ON CONFLICT DO NOTHING          -- same
-- A BARE INSERT does NOT no-op; it throws UNIQUE constraint failed. Pick one
-- deliberately: OR IGNORE to swallow the replay, bare INSERT to hear about it.
--
-- SQLite trap when upserting against a PARTIAL index: the conflict target must
-- REPEAT the index predicate or SQLite cannot match the constraint and errors
-- with "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint":
--   ON CONFLICT(user_id, reason, ref) WHERE ref IS NOT NULL DO UPDATE SET ...
-- ---------------------------------------------------------------------------
--
-- CHECK policy (deliberate, and NOT uniform — SQLite cannot add a CHECK later
-- without a full table rebuild, which on D1 is the exact operation behind the
-- PR #75/#76 rollbacks, so each one is a one-way door decided here):
--   CHECK a column ONLY where it has no subtract path. `level`, `wins` and
--   `losses` only ever increment, so a CHECK there can only ever catch a bug.
--   Columns that are SPENT or DECREMENTED get NO CHECK — `copies` (consumed by
--   card upgrades) and `trophies` (taken away on a defeat) are guarded by the
--   worker's read-check-write, exactly as 0013 guards user_wallet.balance. On a
--   spendable column a CHECK converts a clamping bug into a FAILED WRITE that
--   loses the match result or the pack the player just opened — strictly worse
--   than the wrong number it prevents. `best_trophies`/`tier` are written in the
--   same statement as `trophies`, so a CHECK there fails that statement too.
--
-- All user FKs cascade so a deleted account takes its progression rows with it.
--
-- No new COLUMN is added to any existing table, so nothing here belongs in the
-- deploy-worker.yml pragma probe (see migrations/README.md: ALTER TABLE ADD
-- COLUMN has no IF NOT EXISTS form and is not migration-file material).
--
-- Idempotent (CREATE TABLE / INDEX IF NOT EXISTS), no explicit transactions.
-- Mirrors src/schema.sql exactly. Apply via the "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0014_baseball_cards.sql

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

CREATE TABLE IF NOT EXISTS user_lineup (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot TEXT NOT NULL,                   -- batter | pitcher | bat | glove | coach
  card_id TEXT NOT NULL,                -- the equipped card (owned in player_cards)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot)           -- one equipped card per slot
);

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
-- Ladder leaderboard reads, highest trophies first.
CREATE INDEX IF NOT EXISTS idx_ladder_state_trophies ON ladder_state(trophies DESC);

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
