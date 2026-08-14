import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// ---- Golf economy + season progression -------------------------------------
//
// The soft-currency ("coins"), cosmetic CATALOG and SEASON/TIER layout are all
// CODE-DEFINED and kept OUT of the DB, exactly like the tournament rotation and
// the Daily Challenge derivation. The DB (migration 0013) stores only per-user
// STATE: wallet balance, an append-only currency_ledger (which doubles as the
// idempotency guard), owned/equipped cosmetics and per-season XP + claimed
// tiers. This module is the single source of truth for the catalog, the season
// math, and the idempotent wallet/XP/grant helpers the earn hooks call.

// ---- Cosmetic catalog ------------------------------------------------------

export type Slot = 'ball' | 'trail' | 'frame';
export type Rarity = 'common' | 'rare' | 'epic';

// The `visual` contract is consumed GENERICALLY by the UI + renderer — there is
// no per-id branching in the client. Each slot has a fixed visual shape:
//   ball  -> { color, metalness?, roughness? }  (metallic finish for gold, etc.)
//   trail -> { color }
//   frame -> { color, style: 'ring' | 'glow' }
export interface BallVisual {
  color: string;
  metalness?: number;
  roughness?: number;
}
export interface TrailVisual {
  color: string;
}
export interface FrameVisual {
  color: string;
  style: 'ring' | 'glow';
}
export type Visual = BallVisual | TrailVisual | FrameVisual;

export interface Cosmetic {
  id: string;
  slot: Slot;
  name: string;
  rarity: Rarity;
  price: number; // coins; the per-slot default is 0 (free / auto-owned)
  visual: Visual;
}

// Standard prices by rarity. The per-slot DEFAULT item is always 0 (implicitly
// owned by everyone and the equipped fallback).
export const RARITY_PRICE: Record<Rarity, number> = {
  common: 200,
  rare: 800,
  epic: 2000,
};

// The catalog. One default per slot (price 0), then a spread of buyable items.
export const COSMETICS: readonly Cosmetic[] = [
  // --- balls ---
  { id: 'ball_classic', slot: 'ball', name: 'Classic White', rarity: 'common', price: 0, visual: { color: '#F5F5F5', metalness: 0, roughness: 0.45 } },
  { id: 'ball_sunset', slot: 'ball', name: 'Sunset', rarity: 'common', price: 200, visual: { color: '#FF7043', metalness: 0, roughness: 0.4 } },
  { id: 'ball_sky', slot: 'ball', name: 'Sky', rarity: 'common', price: 200, visual: { color: '#4FC3F7', metalness: 0, roughness: 0.4 } },
  { id: 'ball_crimson', slot: 'ball', name: 'Crimson', rarity: 'rare', price: 800, visual: { color: '#D32F2F', metalness: 0.1, roughness: 0.35 } },
  { id: 'ball_neon', slot: 'ball', name: 'Neon', rarity: 'rare', price: 800, visual: { color: '#39FF14', metalness: 0, roughness: 0.25 } },
  { id: 'ball_gold', slot: 'ball', name: 'Gold', rarity: 'epic', price: 2000, visual: { color: '#FFD700', metalness: 1, roughness: 0.15 } },
  { id: 'ball_void', slot: 'ball', name: 'Void Black', rarity: 'epic', price: 2000, visual: { color: '#0B0B12', metalness: 0.6, roughness: 0.3 } },

  // --- trails ---
  { id: 'trail_none', slot: 'trail', name: 'None', rarity: 'common', price: 0, visual: { color: '#FFFFFF' } },
  { id: 'trail_ember', slot: 'trail', name: 'Ember', rarity: 'common', price: 200, visual: { color: '#FF6D00' } },
  { id: 'trail_aqua', slot: 'trail', name: 'Aqua', rarity: 'rare', price: 800, visual: { color: '#00E5FF' } },
  { id: 'trail_violet', slot: 'trail', name: 'Violet', rarity: 'rare', price: 800, visual: { color: '#B388FF' } },
  { id: 'trail_gold', slot: 'trail', name: 'Gold', rarity: 'epic', price: 2000, visual: { color: '#FFD700' } },

  // --- frames ---
  { id: 'frame_none', slot: 'frame', name: 'None', rarity: 'common', price: 0, visual: { color: '#000000', style: 'ring' } },
  { id: 'frame_bronze', slot: 'frame', name: 'Bronze Ring', rarity: 'common', price: 200, visual: { color: '#CD7F32', style: 'ring' } },
  { id: 'frame_silver', slot: 'frame', name: 'Silver Ring', rarity: 'rare', price: 800, visual: { color: '#C0C0C0', style: 'ring' } },
  { id: 'frame_gold', slot: 'frame', name: 'Gold Glow', rarity: 'epic', price: 2000, visual: { color: '#FFD700', style: 'glow' } },
] as const;

// The default (free, implicitly owned, equipped-fallback) cosmetic per slot.
export const DEFAULT_BY_SLOT: Record<Slot, string> = {
  ball: 'ball_classic',
  trail: 'trail_none',
  frame: 'frame_none',
};

export const SLOTS: readonly Slot[] = ['ball', 'trail', 'frame'];

const COSMETIC_BY_ID = new Map(COSMETICS.map((c) => [c.id, c]));
const DEFAULT_IDS = new Set(Object.values(DEFAULT_BY_SLOT));

export function getCosmetic(id: string): Cosmetic | undefined {
  return COSMETIC_BY_ID.get(id);
}

export function isDefault(id: string): boolean {
  return DEFAULT_IDS.has(id);
}

export function defaultFor(slot: Slot): string {
  return DEFAULT_BY_SLOT[slot];
}

// ---- Season / tier layout --------------------------------------------------
//
// A season is DERIVED from a period index exactly like a tournament: the same
// index maps to the same window, and the tier layout/rewards are a code const.
// The DB only stores per-user xp + claimed tiers.

const DAY_MS = 24 * 3600 * 1000;

// A season lasts ~28 days. Tunable; everything downstream reads the period id.
export const SEASON_PERIOD_MS = 28 * DAY_MS;

// Fixed anchor for season 0 (UTC). Pinned forever — moving it renumbers every
// season, so it never derives from "now". Matches the tournament epoch.
export const SEASON_EPOCH = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z

// Whole seasons since the epoch for an epoch-ms instant — the season id.
export function currentSeasonId(now: number): number {
  return Math.floor((now - SEASON_EPOCH) / SEASON_PERIOD_MS);
}

// The [startsAt, endsAt) window bounding a season id (ms epoch).
export function seasonWindow(id: number): { startsAt: number; endsAt: number } {
  const startsAt = SEASON_EPOCH + id * SEASON_PERIOD_MS;
  return { startsAt, endsAt: startsAt + SEASON_PERIOD_MS };
}

export interface SeasonTier {
  tier: number; // 1-based
  xpRequired: number; // CUMULATIVE xp to reach this tier
  reward: { coins?: number; cosmetic?: string };
}

// 10 escalating tiers. Milestone tiers (3, 6, 9, 10) grant cosmetics; the rest
// grant escalating coins. Cumulative xpRequired so tierForXp is a simple scan.
export const SEASON_TIERS: readonly SeasonTier[] = [
  { tier: 1, xpRequired: 100, reward: { coins: 100 } },
  { tier: 2, xpRequired: 250, reward: { coins: 150 } },
  { tier: 3, xpRequired: 450, reward: { cosmetic: 'ball_sunset' } },
  { tier: 4, xpRequired: 700, reward: { coins: 200 } },
  { tier: 5, xpRequired: 1000, reward: { coins: 250 } },
  { tier: 6, xpRequired: 1400, reward: { cosmetic: 'trail_ember' } },
  { tier: 7, xpRequired: 1900, reward: { coins: 300 } },
  { tier: 8, xpRequired: 2500, reward: { coins: 400 } },
  { tier: 9, xpRequired: 3200, reward: { cosmetic: 'frame_silver' } },
  { tier: 10, xpRequired: 4000, reward: { cosmetic: 'ball_gold' } },
] as const;

export function getSeasonTier(tier: number): SeasonTier | undefined {
  return SEASON_TIERS.find((t) => t.tier === tier);
}

// The highest tier whose cumulative xpRequired is met (0 = none reached yet).
export function tierForXp(xp: number): number {
  let reached = 0;
  for (const t of SEASON_TIERS) {
    if (xp >= t.xpRequired) reached = t.tier;
    else break;
  }
  return reached;
}

// Tiers that are reached (xp >= threshold) but NOT yet in `claimed`.
export function claimableTiers(xp: number, claimed: readonly number[]): number[] {
  const done = new Set(claimed);
  return SEASON_TIERS.filter((t) => xp >= t.xpRequired && !done.has(t.tier)).map(
    (t) => t.tier,
  );
}

// ---- Wallet / economy helpers (idempotent, ref-guarded) --------------------

async function readBalance(env: Env, userId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

async function readSeasonXp(env: Env, userId: string, seasonId: number): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT xp FROM season_progress WHERE user_id = ? AND season_id = ?`,
  )
    .bind(userId, seasonId)
    .first<{ xp: number }>();
  return row?.xp ?? 0;
}

export interface AwardResult {
  credited: boolean; // false when the (user,reason,ref) award was already recorded
  balance: number; // balance AFTER this call
}

// Idempotent coin credit. Writes ONE currency_ledger row keyed by
// (user_id, reason, ref); the partial UNIQUE index makes a replay a no-op —
// only when the ledger insert ACTUALLY happened (meta.changes === 1) do we bump
// user_wallet. Mirrors the tournament settlement's changes===1 idempotency
// style. `ref` should be non-null for idempotent earns (the index only guards
// non-null refs).
export async function awardCoins(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  ref: string,
): Promise<AwardResult> {
  const now = Date.now();

  // Insert the ref-guarded ledger row FIRST (balance_after stamped below from
  // the real post-credit balance). If the unique index rejects it the award was
  // already recorded — no-op, wallet untouched.
  const ledgerId = crypto.randomUUID();
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO currency_ledger
       (id, user_id, delta, reason, ref, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  )
    .bind(ledgerId, userId, amount, reason, ref, now)
    .run();

  if ((ins.meta?.changes ?? 0) < 1) {
    return { credited: false, balance: await readBalance(env, userId) };
  }

  // Atomic credit. excluded.balance = amount: a fresh wallet starts at `amount`,
  // an existing one is bumped by `amount`. RETURNING gives the true post-balance
  // even under concurrency, which we stamp into the ledger row.
  const credited = await env.DB.prepare(
    `INSERT INTO user_wallet (user_id, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       balance    = user_wallet.balance + excluded.balance,
       updated_at = excluded.updated_at
     RETURNING balance`,
  )
    .bind(userId, amount, now, now)
    .first<{ balance: number }>();

  const balance = credited?.balance ?? amount;
  await env.DB.prepare(`UPDATE currency_ledger SET balance_after = ? WHERE id = ?`)
    .bind(balance, ledgerId)
    .run();

  return { credited: true, balance };
}

// The outcome of a spend attempt:
//   'ok'           — debited exactly `amount`, wrote the ledger row.
//   'insufficient' — balance couldn't cover it; nothing changed.
//   'duplicate'    — this exact (user,reason,ref) spend was already recorded.
export type SpendResult = 'ok' | 'insufficient' | 'duplicate';

// Guarded, ATOMIC spend. The debit is a single conditional UPDATE
// (... WHERE balance >= ?), so two concurrent spends can never both succeed
// against the same balance and drive it negative.
//
// Order is DEBIT-FIRST, then ledger, so a `'duplicate'` can only ever mean a
// real, permanently-committed prior charge (never a transient in-flight row):
//   1. Conditional atomic debit with RETURNING. No row -> 'insufficient'
//      (nothing was inserted, so an under-funded concurrent request leaves no
//      ledger row and no basis for a free grant, ever).
//   2. INSERT OR IGNORE the ref-guarded ledger row with the true balance_after.
//      If it's a duplicate (changes=0) this is a replay of an ALREADY-committed
//      spend, so REFUND the debit we just made and return 'duplicate'.
//   3. Else 'ok'.
export async function spendCoins(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  ref: string,
): Promise<SpendResult> {
  const now = Date.now();

  // 1. Debit first — atomic and conditional on sufficient balance.
  const debited = await env.DB.prepare(
    `UPDATE user_wallet
        SET balance = balance - ?, updated_at = ?
      WHERE user_id = ? AND balance >= ?
      RETURNING balance`,
  )
    .bind(amount, now, userId, amount)
    .first<{ balance: number }>();

  // Couldn't cover the spend (or no wallet row yet). Nothing was written.
  if (!debited) return 'insufficient';

  // 2. Record the ref-guarded ledger row with the true post-debit balance.
  const ins = await env.DB.prepare(
    `INSERT OR IGNORE INTO currency_ledger
       (id, user_id, delta, reason, ref, balance_after, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, -amount, reason, ref, debited.balance, now)
    .run();

  if ((ins.meta?.changes ?? 0) < 1) {
    // A committed ledger row for this ref already exists — this call is a replay
    // of an already-charged spend. Refund the debit we just made so the wallet
    // is charged exactly once for the ref.
    await env.DB.prepare(
      `UPDATE user_wallet SET balance = balance + ?, updated_at = ? WHERE user_id = ?`,
    )
      .bind(amount, now, userId)
      .run();
    return 'duplicate';
  }

  return 'ok';
}

export interface XpResult {
  added: boolean;
  xp: number; // season xp AFTER this call
  seasonId: number;
}

// Idempotent XP add into the CURRENT season's season_progress row. XP has no
// dedicated guard table, so it reuses the currency_ledger idempotency index
// with a `xp:`-prefixed reason (a delta=0 marker row) — this keeps the XP guard
// separate from the paired coin row (same reason/ref) rather than colliding
// with it. The wallet ledger view filters `xp:%` rows out.
export async function addXp(
  env: Env,
  userId: string,
  amount: number,
  reason: string,
  ref: string,
): Promise<XpResult> {
  const now = Date.now();
  const seasonId = currentSeasonId(now);

  // The guard row is a hidden `xp:%` marker (delta 0, balance_after 0 — it is
  // filtered out of every ledger view, so its balance snapshot is irrelevant).
  const guard = await env.DB.prepare(
    `INSERT OR IGNORE INTO currency_ledger
       (id, user_id, delta, reason, ref, balance_after, created_at)
     VALUES (?, ?, 0, ?, ?, 0, ?)`,
  )
    .bind(crypto.randomUUID(), userId, `xp:${reason}`, ref, now)
    .run();

  if ((guard.meta?.changes ?? 0) < 1) {
    return { added: false, xp: await readSeasonXp(env, userId, seasonId), seasonId };
  }

  const row = await env.DB.prepare(
    `INSERT INTO season_progress (user_id, season_id, xp, claimed, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?)
     ON CONFLICT(user_id, season_id) DO UPDATE SET
       xp         = season_progress.xp + excluded.xp,
       updated_at = excluded.updated_at
     RETURNING xp`,
  )
    .bind(userId, seasonId, amount, now, now)
    .first<{ xp: number }>();

  return { added: true, xp: row?.xp ?? amount, seasonId };
}

// Idempotent grant: INSERT OR IGNORE into user_cosmetics (UNIQUE(user,cosmetic)
// makes a re-grant a no-op).
export async function grantCosmetic(
  env: Env,
  userId: string,
  cosmeticId: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO user_cosmetics (id, user_id, cosmetic_id, acquired_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, cosmeticId, Date.now())
    .run();
}

// The caller's owned cosmetic ids, INCLUDING the implicit per-slot defaults
// (which every user owns for free and can always equip).
async function readOwnedIds(env: Env, userId: string): Promise<Set<string>> {
  const rows = await env.DB.prepare(
    `SELECT cosmetic_id FROM user_cosmetics WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ cosmetic_id: string }>();
  const owned = new Set<string>(DEFAULT_IDS);
  for (const r of rows.results ?? []) owned.add(r.cosmetic_id);
  return owned;
}

// The caller's equipped map, one entry per slot, falling back to the slot
// default when nothing is equipped there.
async function readEquipped(env: Env, userId: string): Promise<Record<Slot, string>> {
  const rows = await env.DB.prepare(
    `SELECT slot, cosmetic_id FROM user_equipped WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ slot: string; cosmetic_id: string }>();
  const equipped: Record<Slot, string> = {
    ball: defaultFor('ball'),
    trail: defaultFor('trail'),
    frame: defaultFor('frame'),
  };
  for (const r of rows.results ?? []) {
    if ((SLOTS as readonly string[]).includes(r.slot)) {
      equipped[r.slot as Slot] = r.cosmetic_id;
    }
  }
  return equipped;
}

async function readSeasonRow(
  env: Env,
  userId: string,
  seasonId: number,
): Promise<{ xp: number; claimed: number[] }> {
  const row = await env.DB.prepare(
    `SELECT xp, claimed FROM season_progress WHERE user_id = ? AND season_id = ?`,
  )
    .bind(userId, seasonId)
    .first<{ xp: number; claimed: string }>();
  if (!row) return { xp: 0, claimed: [] };
  let claimed: number[] = [];
  try {
    const parsed = JSON.parse(row.claimed);
    if (Array.isArray(parsed)) {
      // Dedup + sort: a concurrent same-tier claim can append a duplicate via
      // json_insert, so collapse them here (also keeps claimable phantom-free).
      claimed = [...new Set(parsed.filter((n) => Number.isInteger(n)) as number[])].sort(
        (a, b) => a - b,
      );
    }
  } catch {
    claimed = [];
  }
  return { xp: row.xp, claimed };
}

// ---- Endpoints -------------------------------------------------------------

export function economyRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /economy/wallet — balance + the 20 most recent ledger entries. The
  // internal `xp:%` guard rows (delta=0 XP idempotency markers) are hidden.
  app.get('/economy/wallet', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const balance = await readBalance(c.env, me.id);
    const rows = await c.env.DB.prepare(
      `SELECT delta, reason, ref, balance_after AS balanceAfter, created_at AS createdAt
         FROM currency_ledger
        WHERE user_id = ? AND reason NOT LIKE 'xp:%'
        ORDER BY created_at DESC
        LIMIT 20`,
    )
      .bind(me.id)
      .all<{
        delta: number;
        reason: string;
        ref: string | null;
        balanceAfter: number;
        createdAt: number;
      }>();

    return c.json({
      balance,
      ledger: (rows.results ?? []).map((r) => ({
        delta: r.delta,
        reason: r.reason,
        ref: r.ref ?? null,
        balanceAfter: r.balanceAfter,
        createdAt: r.createdAt,
      })),
    });
  });

  // GET /economy/cosmetics — the full catalog (with visuals), the caller's
  // owned ids (including the implicit defaults) and their equipped map.
  app.get('/economy/cosmetics', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const [owned, equipped] = await Promise.all([
      readOwnedIds(c.env, me.id),
      readEquipped(c.env, me.id),
    ]);

    return c.json({
      catalog: COSMETICS.map((cm) => ({
        id: cm.id,
        slot: cm.slot,
        name: cm.name,
        rarity: cm.rarity,
        price: cm.price,
        visual: cm.visual,
      })),
      owned: [...owned],
      equipped,
    });
  });

  // POST /economy/cosmetics/purchase { cosmeticId } — buy a cosmetic with
  // coins. Defaults are free/auto-owned, so buying one is already_owned.
  app.post('/economy/cosmetics/purchase', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ cosmeticId?: unknown }>().catch(() => null);
    const cosmeticId = typeof body?.cosmeticId === 'string' ? body.cosmeticId : '';
    const cosmetic = getCosmetic(cosmeticId);
    if (!cosmetic) return c.json({ error: 'unknown_cosmetic' }, 400);

    // Defaults are implicitly owned by everyone — nothing to buy.
    if (isDefault(cosmeticId)) return c.json({ error: 'already_owned' }, 400);

    const owned = await readOwnedIds(c.env, me.id);
    if (owned.has(cosmeticId)) return c.json({ error: 'already_owned' }, 400);

    const paid = await spendCoins(c.env, me.id, cosmetic.price, 'purchase', cosmeticId);
    if (paid === 'insufficient') return c.json({ error: 'insufficient_funds' }, 400);

    // 'ok' (just charged) OR 'duplicate' (a prior attempt already charged this
    // ref but — since we passed the owned check above — never granted): in both
    // cases ensure the item is granted. grantCosmetic is idempotent, so this is
    // replay-safe and can never leave the user charged-without-item.
    await grantCosmetic(c.env, me.id, cosmeticId);
    const balance = await readBalance(c.env, me.id);
    return c.json({ ok: true, cosmeticId, balance });
  });

  // POST /economy/cosmetics/equip { slot, cosmeticId } — equip an owned (or
  // default) cosmetic into its slot. Returns the updated equipped map.
  app.post('/economy/cosmetics/equip', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<{ slot?: unknown; cosmeticId?: unknown }>()
      .catch(() => null);
    const slot = typeof body?.slot === 'string' ? body.slot : '';
    const cosmeticId = typeof body?.cosmeticId === 'string' ? body.cosmeticId : '';

    const cosmetic = getCosmetic(cosmeticId);
    if (!cosmetic) return c.json({ error: 'unknown_cosmetic' }, 400);
    if (cosmetic.slot !== slot) return c.json({ error: 'wrong_slot' }, 400);

    const owned = await readOwnedIds(c.env, me.id);
    if (!owned.has(cosmeticId)) return c.json({ error: 'not_owned' }, 400);

    await c.env.DB.prepare(
      `INSERT INTO user_equipped (user_id, slot, cosmetic_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, slot) DO UPDATE SET
         cosmetic_id = excluded.cosmetic_id,
         updated_at  = excluded.updated_at`,
    )
      .bind(me.id, cosmetic.slot, cosmeticId, Date.now())
      .run();

    const equipped = await readEquipped(c.env, me.id);
    return c.json({ ok: true, equipped });
  });

  // GET /economy/season — the current season, the caller's xp/tier, the full
  // tier layout, and which tiers are claimed / claimable.
  app.get('/economy/season', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const now = Date.now();
    const seasonId = currentSeasonId(now);
    const { endsAt } = seasonWindow(seasonId);
    const { xp, claimed } = await readSeasonRow(c.env, me.id, seasonId);

    return c.json({
      seasonId,
      endsAt,
      xp,
      currentTier: tierForXp(xp),
      tiers: SEASON_TIERS.map((t) => ({
        tier: t.tier,
        xpRequired: t.xpRequired,
        reward: t.reward,
      })),
      claimed,
      claimable: claimableTiers(xp, claimed),
    });
  });

  // POST /economy/season/claim { tier } — claim a reached, unclaimed tier's
  // reward (coins and/or a cosmetic). Idempotent: the ledger ref guards the
  // coins and `claimed` guards the re-claim.
  app.post('/economy/season/claim', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ tier?: unknown }>().catch(() => null);
    const tierNo = Number.isInteger(body?.tier) ? (body!.tier as number) : NaN;
    const tier = getSeasonTier(tierNo);
    if (!tier) return c.json({ error: 'unknown_tier' }, 400);

    const now = Date.now();
    const seasonId = currentSeasonId(now);
    const { xp, claimed } = await readSeasonRow(c.env, me.id, seasonId);

    if (xp < tier.xpRequired) return c.json({ error: 'tier_locked' }, 400);
    if (claimed.includes(tier.tier)) return c.json({ error: 'already_claimed' }, 400);

    // Grant the reward. Coins are ref-guarded per (season, tier); a cosmetic
    // grant is INSERT-OR-IGNORE. Both are safe to have run in a prior partial
    // attempt.
    if (tier.reward.coins) {
      await awardCoins(c.env, me.id, tier.reward.coins, 'season_tier', `${seasonId}:${tier.tier}`);
    }
    if (tier.reward.cosmetic) {
      await grantCosmetic(c.env, me.id, tier.reward.cosmetic);
    }

    // Append the tier ATOMICALLY in SQL (json_insert onto the live array)
    // rather than read-modify-writing a snapshot, so a concurrent different-tier
    // claim can't clobber the other's append. The row is guaranteed to exist
    // here (reaching a tier's xp threshold means addXp created it), so the
    // ON CONFLICT branch is what runs; the VALUES branch is a defensive no-op.
    await c.env.DB.prepare(
      `INSERT INTO season_progress (user_id, season_id, xp, claimed, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?, ?)
       ON CONFLICT(user_id, season_id) DO UPDATE SET
         claimed    = json_insert(season_progress.claimed, '$[#]', ?),
         updated_at = excluded.updated_at`,
    )
      .bind(me.id, seasonId, JSON.stringify([tier.tier]), now, now, tier.tier)
      .run();

    // Re-read for the accurate post-claim array (readSeasonRow dedups).
    const after = await readSeasonRow(c.env, me.id, seasonId);
    const balance = await readBalance(c.env, me.id);
    return c.json({
      ok: true,
      tier: tier.tier,
      reward: tier.reward,
      claimed: after.claimed,
      claimable: claimableTiers(after.xp, after.claimed),
      balance,
    });
  });

  return app;
}
