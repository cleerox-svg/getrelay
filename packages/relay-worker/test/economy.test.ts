// Golf economy + season progression tests. Mirrors games.test.ts: runs inside
// workerd via @cloudflare/vitest-pool-workers, seeds the tables these routes
// touch (the pool doesn't auto-apply schema.sql), and mints session JWTs.
//
// The push module is mocked so the tournament settlement seam's placement push
// can be forced to throw — proving a push failure never breaks settlement while
// keeping the real pushRoutes() (index.ts mounts it) intact.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';

vi.mock('../src/push', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Throw so tests can assert settlement survives a failing push.
    pushToUser: vi.fn(async () => {
      throw new Error('push boom');
    }),
  };
});

import worker from '../src/index';
import type { Env } from '../src/env';
import { signJwt } from '../src/lib/jwt';
import {
  COSMETICS,
  SEASON_TIERS,
  SEASON_PERIOD_MS,
  DEFAULT_BY_SLOT,
  getCosmetic,
  isDefault,
  defaultFor,
  tierForXp,
  claimableTiers,
  currentSeasonId,
  seasonWindow,
  awardCoins,
  spendCoins,
  addXp,
} from '../src/economy';
import { coinAward, ordinal, runTournamentCron, tournamentSeed, tournamentHoles } from '../src/tournaments';
import { MAX_ROUND_REWARDS_PER_DAY } from '../src/games';
import { pushToUser } from '../src/push';

const testEnv = env as unknown as Env;
const DAY = 24 * 3600 * 1000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
     pin TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, status_message TEXT,
     avatar_url TEXT, avatar_r2_key TEXT, created_at INTEGER NOT NULL,
     last_seen_at INTEGER, is_admin INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     jwt_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS game_scores (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game TEXT NOT NULL DEFAULT 'fog', score INTEGER NOT NULL, rounds INTEGER NOT NULL,
     best_streak INTEGER NOT NULL DEFAULT 0, course TEXT, to_par INTEGER, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS daily_results (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     date TEXT NOT NULL, game TEXT NOT NULL, course TEXT, hole INTEGER, seed INTEGER NOT NULL,
     strokes INTEGER, to_par INTEGER, score INTEGER, created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL, UNIQUE(user_id, date)
   )`,
  `CREATE TABLE IF NOT EXISTS daily_streaks (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     current INTEGER NOT NULL DEFAULT 0, best INTEGER NOT NULL DEFAULT 0, last_date TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tournaments (
     id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'rapid', seed INTEGER NOT NULL,
     holes TEXT NOT NULL, opened_at INTEGER NOT NULL, closes_at INTEGER NOT NULL,
     settled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tournament_entries (
     id TEXT PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, score INTEGER NOT NULL,
     to_par INTEGER, strokes INTEGER, rounds_played INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tournament_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS tournament_trophies (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     trophies INTEGER NOT NULL DEFAULT 0, golds INTEGER NOT NULL DEFAULT 0,
     podiums INTEGER NOT NULL DEFAULT 0, best_rank INTEGER, events_played INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tournament_placements (
     id TEXT PRIMARY KEY, tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, rank INTEGER NOT NULL,
     trophies INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(tournament_id, user_id)
   )`,
  // ---- economy (migration 0013) ----
  `CREATE TABLE IF NOT EXISTS user_wallet (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     balance INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS currency_ledger (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, balance_after INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_currency_ledger_user_time ON currency_ledger(user_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_currency_ledger_award
     ON currency_ledger(user_id, reason, ref) WHERE ref IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS user_cosmetics (
     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     cosmetic_id TEXT NOT NULL, acquired_at INTEGER NOT NULL, UNIQUE(user_id, cosmetic_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id)`,
  `CREATE TABLE IF NOT EXISTS user_equipped (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, slot TEXT NOT NULL,
     cosmetic_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, slot)
   )`,
  `CREATE TABLE IF NOT EXISTS season_progress (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, season_id INTEGER NOT NULL,
     xp INTEGER NOT NULL DEFAULT 0, claimed TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, season_id)
   )`,
];

const USERS = {
  A: { id: 'eco-a', jti: 'ejti-a', pin: 'ECOAAA01', name: 'Ava' },
  B: { id: 'eco-b', jti: 'ejti-b', pin: 'ECOBBB02', name: 'Ben' },
  C: { id: 'eco-c', jti: 'ejti-c', pin: 'ECOCCC03', name: 'Cy' },
} as const;

const cookies: Record<keyof typeof USERS, string> = { A: '', B: '', C: '' };

async function seed() {
  for (const sql of DDL) await testEnv.DB.prepare(sql).run();
  const now = Date.now();
  for (const [key, u] of Object.entries(USERS) as [keyof typeof USERS, (typeof USERS)[keyof typeof USERS]][]) {
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO users (id, google_sub, email, pin, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(u.id, `sub-${u.id}`, `${u.id}@example.com`, u.pin, u.name, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT OR IGNORE INTO sessions (jwt_id, user_id, created_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, 0)`,
    )
      .bind(u.jti, u.id, now, now + 30 * DAY)
      .run();
    const nowSec = Math.floor(now / 1000);
    const token = await signJwt({ sub: u.id, jti: u.jti, iat: nowSec, exp: nowSec + 3600 }, 'test-secret');
    cookies[key] = `relay_session=${token}`;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://example.com${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function get(path: string, cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return request(path, { headers });
}

function post(path: string, cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

function utcDay(offset = 0): string {
  return new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
}

// Seed a wallet balance directly (bypassing the earn helpers).
async function setBalance(userId: string, balance: number): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO user_wallet (user_id, balance, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET balance = excluded.balance, updated_at = excluded.updated_at`,
  )
    .bind(userId, balance, now, now)
    .run();
}

// Seed season xp directly for the current season.
async function setSeasonXp(userId: string, xp: number, claimed: number[] = []): Promise<void> {
  const now = Date.now();
  const seasonId = currentSeasonId(now);
  await testEnv.DB.prepare(
    `INSERT INTO season_progress (user_id, season_id, xp, claimed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, season_id) DO UPDATE SET
       xp = excluded.xp, claimed = excluded.claimed, updated_at = excluded.updated_at`,
  )
    .bind(userId, seasonId, xp, JSON.stringify(claimed), now, now)
    .run();
}

async function seedClosedTournament(id: number): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO tournaments (id, kind, seed, holes, opened_at, closes_at, settled, created_at)
     VALUES (?, 'rapid', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, tournamentSeed(id), JSON.stringify(tournamentHoles(id)), now - 2000, now - 1000, now - 2000)
    .run();
}

async function seedEntry(tournamentId: number, userId: string, score: number, toPar: number, strokes: number): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO tournament_entries (id, tournament_id, user_id, score, to_par, strokes, rounds_played, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(crypto.randomUUID(), tournamentId, userId, score, toPar, strokes, now, now)
    .run();
}

beforeAll(seed);

// ---- Catalog / season derivation ------------------------------------------

describe('cosmetic catalog', () => {
  it('has exactly one default per slot, all priced 0', () => {
    for (const slot of ['ball', 'trail', 'frame'] as const) {
      const defId = DEFAULT_BY_SLOT[slot];
      const def = getCosmetic(defId);
      expect(def, `default for ${slot}`).toBeDefined();
      expect(def!.slot).toBe(slot);
      expect(def!.price).toBe(0);
      expect(isDefault(defId)).toBe(true);
      expect(defaultFor(slot)).toBe(defId);
    }
  });

  it('non-default items follow the rarity price ladder and carry a valid visual', () => {
    const RARITY = { common: 200, rare: 800, epic: 2000 } as const;
    for (const c of COSMETICS) {
      expect(['ball', 'trail', 'frame']).toContain(c.slot);
      if (isDefault(c.id)) {
        expect(c.price).toBe(0);
      } else {
        expect(c.price).toBe(RARITY[c.rarity]);
      }
      const v = c.visual as unknown as Record<string, unknown>;
      expect(typeof v.color).toBe('string');
      expect(/^#[0-9A-Fa-f]{6}$/.test(v.color as string)).toBe(true);
      if (c.slot === 'frame') expect(['ring', 'glow']).toContain(v.style);
    }
  });

  it('getCosmetic returns undefined for unknown ids', () => {
    expect(getCosmetic('nope')).toBeUndefined();
    expect(isDefault('nope')).toBe(false);
  });
});

describe('season derivation', () => {
  it('season id is deterministic and windows are consecutive', () => {
    const t = Date.UTC(2026, 7, 14, 12, 0, 0);
    const id = currentSeasonId(t);
    expect(currentSeasonId(t)).toBe(id);
    const w = seasonWindow(id);
    expect(w.startsAt).toBeLessThanOrEqual(t);
    expect(w.endsAt).toBeGreaterThan(t);
    expect(w.endsAt - w.startsAt).toBe(SEASON_PERIOD_MS);
    expect(seasonWindow(id + 1).startsAt).toBe(w.endsAt);
  });

  it('tierForXp finds the highest reached tier', () => {
    expect(tierForXp(0)).toBe(0);
    expect(tierForXp(99)).toBe(0);
    expect(tierForXp(100)).toBe(1);
    expect(tierForXp(449)).toBe(2);
    expect(tierForXp(450)).toBe(3);
    expect(tierForXp(999999)).toBe(SEASON_TIERS.length);
  });

  it('tiers have strictly increasing cumulative xp and valid rewards', () => {
    let prev = 0;
    for (const t of SEASON_TIERS) {
      expect(t.xpRequired).toBeGreaterThan(prev);
      prev = t.xpRequired;
      const hasCoins = typeof t.reward.coins === 'number';
      const hasCosmetic = typeof t.reward.cosmetic === 'string';
      expect(hasCoins || hasCosmetic).toBe(true);
      if (hasCosmetic) expect(getCosmetic(t.reward.cosmetic!)).toBeDefined();
    }
  });

  it('claimableTiers excludes already-claimed and unreached tiers', () => {
    expect(claimableTiers(0, [])).toEqual([]);
    expect(claimableTiers(450, [])).toEqual([1, 2, 3]);
    expect(claimableTiers(450, [1, 3])).toEqual([2]);
  });

  it('coinAward mirrors the rank tiers', () => {
    expect(coinAward(1, 100)).toBe(500);
    expect(coinAward(2, 100)).toBe(300);
    expect(coinAward(3, 100)).toBe(300);
    expect(coinAward(4, 100)).toBe(150);
    expect(coinAward(10, 100)).toBe(150);
    expect(coinAward(11, 100)).toBe(50);
    expect(coinAward(50, 100)).toBe(50);
    expect(coinAward(51, 100)).toBe(20);
  });

  it('ordinal formats ranks correctly', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(21)).toBe('21st');
  });
});

// ---- Wallet helpers (idempotency + spend guard) ---------------------------

describe('awardCoins / spendCoins helpers', () => {
  it('awardCoins credits once and a same-ref replay is a no-op', async () => {
    const first = await awardCoins(testEnv, USERS.A.id, 100, 'test_award', 'ref-1');
    expect(first).toEqual({ credited: true, balance: 100 });

    const replay = await awardCoins(testEnv, USERS.A.id, 100, 'test_award', 'ref-1');
    expect(replay.credited).toBe(false);
    expect(replay.balance).toBe(100); // unchanged

    // A different ref stacks on top.
    const second = await awardCoins(testEnv, USERS.A.id, 50, 'test_award', 'ref-2');
    expect(second).toEqual({ credited: true, balance: 150 });

    // Exactly two credit ledger rows, one per ref.
    const n = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'test_award'`,
    )
      .bind(USERS.A.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(2);
  });

  it('spendCoins reports insufficient / ok / duplicate and never over-debits', async () => {
    await setBalance(USERS.B.id, 500);
    // Debit-first: an under-funded spend writes NOTHING (no debit, no ledger),
    // so the ref stays free for a funded retry.
    const tooMuch = await spendCoins(testEnv, USERS.B.id, 800, 'test_spend', 's-1');
    expect(tooMuch).toBe('insufficient');
    const orphan = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'test_spend' AND ref = 's-1'`,
    )
      .bind(USERS.B.id)
      .first<{ n: number }>();
    expect(orphan?.n).toBe(0);
    const bal0 = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(bal0?.balance).toBe(500); // untouched

    const ok = await spendCoins(testEnv, USERS.B.id, 200, 'test_spend', 's-2');
    expect(ok).toBe('ok');
    const row = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(row?.balance).toBe(300);

    // A same-ref replay while the balance still covers the amount takes the
    // debit-then-refund path -> 'duplicate', net balance unchanged (charged once).
    const replay = await spendCoins(testEnv, USERS.B.id, 200, 'test_spend', 's-2');
    expect(replay).toBe('duplicate');
    const after = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(after?.balance).toBe(300); // unchanged — refund undid the replay debit

    // Exactly one committed ledger row for the ref (the replay did not add one).
    const n = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'test_spend' AND ref = 's-2'`,
    )
      .bind(USERS.B.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('spendCoins is atomic: two concurrent different-ref spends cannot go negative', async () => {
    await setBalance(USERS.A.id, 800);
    // Both try to spend the full 800 at once; the conditional debit
    // (WHERE balance >= amount) lets exactly one win.
    const [r1, r2] = await Promise.all([
      spendCoins(testEnv, USERS.A.id, 800, 'race_spend', 'r-1'),
      spendCoins(testEnv, USERS.A.id, 800, 'race_spend', 'r-2'),
    ]);
    expect([r1, r2].filter((r) => r === 'ok')).toHaveLength(1);
    expect([r1, r2].filter((r) => r === 'insufficient')).toHaveLength(1);
    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.A.id)
      .first<{ balance: number }>();
    expect(bal?.balance).toBe(0);
    expect(bal!.balance).toBeGreaterThanOrEqual(0);
  });

  it('addXp adds once per ref into the current season', async () => {
    const r1 = await addXp(testEnv, USERS.C.id, 40, 'test_xp', 'x-1');
    expect(r1.added).toBe(true);
    expect(r1.xp).toBe(40);
    const replay = await addXp(testEnv, USERS.C.id, 40, 'test_xp', 'x-1');
    expect(replay.added).toBe(false);
    expect(replay.xp).toBe(40);
    const r2 = await addXp(testEnv, USERS.C.id, 10, 'test_xp', 'x-2');
    expect(r2.xp).toBe(50);
  });
});

// ---- Endpoints -------------------------------------------------------------

describe('GET /economy/wallet', () => {
  it('requires a session cookie', async () => {
    expect((await get('/economy/wallet', null)).status).toBe(401);
  });

  it('returns balance + recent ledger, hiding xp guard rows', async () => {
    await awardCoins(testEnv, USERS.A.id, 70, 'daily_reward', 'w-day');
    await addXp(testEnv, USERS.A.id, 70, 'daily_reward', 'w-day'); // xp: guard row — must be hidden

    const res = await get('/economy/wallet', cookies.A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      balance: number;
      ledger: { delta: number; reason: string; ref: string | null; balanceAfter: number }[];
    };
    expect(body.balance).toBeGreaterThanOrEqual(70);
    expect(body.ledger.every((l) => !l.reason.startsWith('xp:'))).toBe(true);
    expect(body.ledger.some((l) => l.reason === 'daily_reward' && l.ref === 'w-day')).toBe(true);
  });
});

describe('GET /economy/cosmetics', () => {
  it('lists the catalog with visuals, implicit defaults owned, and default equips', async () => {
    const res = await get('/economy/cosmetics', cookies.C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      catalog: { id: string; slot: string; visual: unknown }[];
      owned: string[];
      equipped: { ball: string; trail: string; frame: string };
    };
    expect(body.catalog).toHaveLength(COSMETICS.length);
    expect(body.catalog[0]!.visual).toBeDefined();
    // Every default is implicitly owned even with no user_cosmetics rows.
    for (const slot of ['ball', 'trail', 'frame'] as const) {
      expect(body.owned).toContain(DEFAULT_BY_SLOT[slot]);
      expect(body.equipped[slot]).toBe(DEFAULT_BY_SLOT[slot]);
    }
  });
});

describe('POST /economy/cosmetics/purchase', () => {
  it('rejects unknown / default / already-owned / insufficient, then succeeds', async () => {
    expect((await post('/economy/cosmetics/purchase', cookies.A, { cosmeticId: 'nope' })).status).toBe(400);
    await post('/economy/cosmetics/purchase', cookies.A, { cosmeticId: 'nope' }).then(async (r) =>
      expect(await r.json()).toEqual({ error: 'unknown_cosmetic' }),
    );

    const def = await post('/economy/cosmetics/purchase', cookies.A, { cosmeticId: DEFAULT_BY_SLOT.ball });
    expect(def.status).toBe(400);
    expect(await def.json()).toEqual({ error: 'already_owned' });

    // Broke: zero balance can't afford a 200-coin common.
    await setBalance(USERS.C.id, 0);
    const broke = await post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' });
    expect(broke.status).toBe(400);
    expect(await broke.json()).toEqual({ error: 'insufficient_funds' });

    // Fund and buy.
    await setBalance(USERS.C.id, 1000);
    const buy = await post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' });
    expect(buy.status).toBe(200);
    expect(await buy.json()).toMatchObject({ ok: true, cosmeticId: 'ball_sunset', balance: 800 });

    // Now owned -> already_owned.
    const again = await post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'already_owned' });
  });

  it('is replay-safe: a prior charge with no grant still delivers the item, charged once', async () => {
    // Simulate a partial attempt that charged the ref but never granted (a crash
    // between spend and grant). The wallet is already debited for ball_crimson.
    // Start funded enough that the debit-first replay can still take the
    // debit-then-refund 'duplicate' path.
    await setBalance(USERS.B.id, 1600);
    const pre = await spendCoins(testEnv, USERS.B.id, 800, 'purchase', 'ball_crimson');
    expect(pre).toBe('ok'); // charged (balance 800), but NOT granted below

    const notOwned = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = 'ball_crimson'`,
    )
      .bind(USERS.B.id)
      .first<{ n: number }>();
    expect(notOwned?.n).toBe(0); // charged-without-item state

    // The real purchase now debits + hits the committed ledger ref (duplicate),
    // refunds that debit, and grants — no second charge.
    const buy = await post('/economy/cosmetics/purchase', cookies.B, { cosmeticId: 'ball_crimson' });
    expect(buy.status).toBe(200);
    const body = (await buy.json()) as { balance: number };
    expect(body.balance).toBe(800); // charged exactly once (1600 - 800)

    const owned = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = 'ball_crimson'`,
    )
      .bind(USERS.B.id)
      .first<{ n: number }>();
    expect(owned?.n).toBe(1); // now granted

    // Still exactly one committed purchase ledger row for the ref.
    const ledger = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'purchase' AND ref = 'ball_crimson'`,
    )
      .bind(USERS.B.id)
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });

  it('two concurrent same-item purchases while under-funded grant zero times, balance unchanged', async () => {
    // C can't afford ball_sunset (200). Two concurrent POSTs must both fail with
    // no debit, no ledger row, and no grant — closing the free-grant TOCTOU.
    await setBalance(USERS.C.id, 100);
    const [r1, r2] = await Promise.all([
      post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' }),
      post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' }),
    ]);
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
    expect(await r1.json()).toEqual({ error: 'insufficient_funds' });
    expect(await r2.json()).toEqual({ error: 'insufficient_funds' });

    const owned = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = 'ball_sunset'`,
    )
      .bind(USERS.C.id)
      .first<{ n: number }>();
    expect(owned?.n).toBe(0); // granted zero times

    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.C.id)
      .first<{ balance: number }>();
    expect(bal?.balance).toBe(100); // unchanged
  });

  it('two concurrent same-item purchases while funded charge once and grant once', async () => {
    // Fund with 2x the price. Depending on interleave the second request either
    // takes the duplicate-refund path (200) or sees the item already owned
    // (400) — both are correct; what matters is the END STATE: at least one
    // success, charged once, granted once, one committed ledger row.
    await setBalance(USERS.C.id, 400);
    const [r1, r2] = await Promise.all([
      post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' }),
      post('/economy/cosmetics/purchase', cookies.C, { cosmeticId: 'ball_sunset' }),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect([r1.status, r2.status].every((s) => s === 200 || s === 400)).toBe(true);

    const owned = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = 'ball_sunset'`,
    )
      .bind(USERS.C.id)
      .first<{ n: number }>();
    expect(owned?.n).toBe(1); // granted exactly once (UNIQUE + idempotent grant)

    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.C.id)
      .first<{ balance: number }>();
    expect(bal?.balance).toBe(200); // charged exactly once (400 - 200)

    const ledger = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'purchase' AND ref = 'ball_sunset'`,
    )
      .bind(USERS.C.id)
      .first<{ n: number }>();
    expect(ledger?.n).toBe(1); // exactly one committed purchase row
  });
});

describe('POST /economy/cosmetics/equip', () => {
  it('rejects wrong slot and not-owned, allows default fallback and owned', async () => {
    // ball_sunset is a ball, not a trail.
    const wrong = await post('/economy/cosmetics/equip', cookies.A, { slot: 'trail', cosmeticId: 'ball_sunset' });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'wrong_slot' });

    // A doesn't own ball_gold.
    const notOwned = await post('/economy/cosmetics/equip', cookies.A, { slot: 'ball', cosmeticId: 'ball_gold' });
    expect(notOwned.status).toBe(400);
    expect(await notOwned.json()).toEqual({ error: 'not_owned' });

    // Defaults are always equippable.
    const def = await post('/economy/cosmetics/equip', cookies.A, { slot: 'trail', cosmeticId: DEFAULT_BY_SLOT.trail });
    expect(def.status).toBe(200);

    // Buy then equip a real cosmetic.
    await setBalance(USERS.A.id, 1000);
    await post('/economy/cosmetics/purchase', cookies.A, { cosmeticId: 'ball_sky' });
    const equip = await post('/economy/cosmetics/equip', cookies.A, { slot: 'ball', cosmeticId: 'ball_sky' });
    expect(equip.status).toBe(200);
    const body = (await equip.json()) as { equipped: { ball: string } };
    expect(body.equipped.ball).toBe('ball_sky');
  });
});

describe('GET /economy/season + POST /economy/season/claim', () => {
  it('surfaces xp/tier/claimable and claims a coin tier once', async () => {
    await setSeasonXp(USERS.B.id, 300, []); // reaches tier 1 (100) and 2 (250)
    await setBalance(USERS.B.id, 0);

    const view = await get('/economy/season', cookies.B);
    expect(view.status).toBe(200);
    const vbody = (await view.json()) as {
      xp: number;
      currentTier: number;
      claimed: number[];
      claimable: number[];
      tiers: { tier: number }[];
    };
    expect(vbody.xp).toBe(300);
    expect(vbody.currentTier).toBe(2);
    expect(vbody.claimable).toEqual([1, 2]);
    expect(vbody.tiers).toHaveLength(SEASON_TIERS.length);

    // Claim tier 1 (100 coins).
    const claim = await post('/economy/season/claim', cookies.B, { tier: 1 });
    expect(claim.status).toBe(200);
    const cbody = (await claim.json()) as { claimed: number[]; balance: number; claimable: number[] };
    expect(cbody.claimed).toEqual([1]);
    expect(cbody.balance).toBe(100);
    expect(cbody.claimable).toEqual([2]);

    // Re-claiming tier 1 is rejected and does not double-credit.
    const dup = await post('/economy/season/claim', cookies.B, { tier: 1 });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toEqual({ error: 'already_claimed' });
    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(bal?.balance).toBe(100);
  });

  it('rejects a locked tier and grants a cosmetic milestone tier', async () => {
    await setSeasonXp(USERS.A.id, 500, []); // reaches tier 3 (450) which grants a cosmetic
    const locked = await post('/economy/season/claim', cookies.A, { tier: 4 }); // needs 700
    expect(locked.status).toBe(400);
    expect(await locked.json()).toEqual({ error: 'tier_locked' });

    const claim = await post('/economy/season/claim', cookies.A, { tier: 3 });
    expect(claim.status).toBe(200);
    // Tier 3 grants ball_sunset — confirm the grant landed.
    const owned = await testEnv.DB.prepare(
      `SELECT 1 AS n FROM user_cosmetics WHERE user_id = ? AND cosmetic_id = 'ball_sunset'`,
    )
      .bind(USERS.A.id)
      .first<{ n: number }>();
    expect(owned?.n).toBe(1);
  });

  it('rejects an unknown tier number', async () => {
    const res = await post('/economy/season/claim', cookies.A, { tier: 999 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_tier' });
  });
});

// ---- Earn hooks ------------------------------------------------------------

describe('earn hook: round reward (/game/score)', () => {
  it('credits +10 coins + xp once per round submission', async () => {
    await setBalance(USERS.C.id, 0);
    await setSeasonXp(USERS.C.id, 0, []);

    const res = await post('/game/score', cookies.C, { score: 500, rounds: 5, bestStreak: 2, game: 'golf' });
    expect(res.status).toBe(200);

    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.C.id)
      .first<{ balance: number }>();
    expect(bal?.balance).toBe(10);

    // A second, distinct round credits again (distinct game_scores row id).
    await post('/game/score', cookies.C, { score: 600, rounds: 5, bestStreak: 3, game: 'golf' });
    const bal2 = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.C.id)
      .first<{ balance: number }>();
    expect(bal2?.balance).toBe(20);

    // No round_reward ledger row was ever double-written (all refs unique).
    const rows = await testEnv.DB.prepare(
      `SELECT ref, COUNT(*) AS n FROM currency_ledger
        WHERE user_id = ? AND reason = 'round_reward' GROUP BY ref HAVING n > 1`,
    )
      .bind(USERS.C.id)
      .all();
    expect(rows.results ?? []).toEqual([]);
  });

  it('caps round_reward coins at the daily limit (score still records past it)', async () => {
    await setBalance(USERS.A.id, 0);
    const startOfDay = Date.parse(`${utcDay(0)}T00:00:00Z`);
    // Pre-seed the cap's worth of round_reward ledger rows for today.
    for (let i = 0; i < MAX_ROUND_REWARDS_PER_DAY; i++) {
      await testEnv.DB.prepare(
        `INSERT INTO currency_ledger (id, user_id, delta, reason, ref, balance_after, created_at)
         VALUES (?, ?, 10, 'round_reward', ?, 0, ?)`,
      )
        .bind(crypto.randomUUID(), USERS.A.id, `seed-${i}`, startOfDay + i)
        .run();
    }

    const res = await post('/game/score', cookies.A, { score: 400, rounds: 5, bestStreak: 1, game: 'golf' });
    expect(res.status).toBe(200); // score still recorded

    // No NEW round_reward credit beyond the cap, and no coins minted.
    const n = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger
        WHERE user_id = ? AND reason = 'round_reward' AND created_at >= ?`,
    )
      .bind(USERS.A.id, startOfDay)
      .first<{ n: number }>();
    expect(n?.n).toBe(MAX_ROUND_REWARDS_PER_DAY);
    const bal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.A.id)
      .first<{ balance: number }>();
    expect(bal?.balance ?? 0).toBe(0);
  });

  it('an economy failure does not fail the score submission', async () => {
    // Drop the ledger table so the earn hook throws; the primary game_scores
    // write must still succeed and the endpoint must still 200 (isolated storage
    // rolls the drop back after this test).
    await testEnv.DB.prepare(`DROP TABLE currency_ledger`).run();

    const res = await post('/game/score', cookies.C, { score: 700, rounds: 5, bestStreak: 2, game: 'golf' });
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(
      `SELECT score FROM game_scores WHERE user_id = ? AND game = 'golf' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.C.id)
      .first<{ score: number }>();
    expect(row?.score).toBe(700);
  });
});

describe('earn hook: daily reward (/game/daily/result)', () => {
  it('credits +50 coins once per day, not on a same-day retry', async () => {
    await setBalance(USERS.B.id, 0);
    const today = utcDay(0);

    const first = await post('/game/daily/result', cookies.B, { strokes: 3, toPar: -2 });
    expect(first.status).toBe(200);
    const bal1 = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(bal1?.balance).toBe(50);

    // Same-day retry (even a better attempt) must NOT re-credit — ref = date.
    const retry = await post('/game/daily/result', cookies.B, { strokes: 2, toPar: -5 });
    expect(retry.status).toBe(200);
    const bal2 = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(bal2?.balance).toBe(50);

    // Exactly one daily_reward ledger row for today.
    const n = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM currency_ledger WHERE user_id = ? AND reason = 'daily_reward' AND ref = ?`,
    )
      .bind(USERS.B.id, today)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('an economy failure does not fail the daily submit nor skip the streak', async () => {
    // The award now sits AFTER the streak recompute and is wrapped; dropping the
    // ledger table makes it throw, but the daily_results row, the streak, and
    // the 200 response must all still land.
    await testEnv.DB.prepare(`DROP TABLE currency_ledger`).run();

    const res = await post('/game/daily/result', cookies.C, { strokes: 3, toPar: -2 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { streak: { current: number }; today: { score: number } };
    expect(body.streak.current).toBe(1); // streak advanced despite the economy throw
    expect(body.today.score).toBeGreaterThan(0);

    const streak = await testEnv.DB.prepare(
      `SELECT current FROM daily_streaks WHERE user_id = ?`,
    )
      .bind(USERS.C.id)
      .first<{ current: number }>();
    expect(streak?.current).toBe(1);
  });
});

describe('earn hook: tournament placement (settlement)', () => {
  it('credits placement coins + xp once, and a failing push does not break settlement', async () => {
    (pushToUser as unknown as ReturnType<typeof vi.fn>).mockClear();
    const id = 880001;
    await seedClosedTournament(id);
    await seedEntry(id, USERS.A.id, 1040, -4, 11); // rank 1 -> 500
    await seedEntry(id, USERS.B.id, 1000, 0, 15); // rank 2 -> 300
    await setBalance(USERS.A.id, 0);
    await setBalance(USERS.B.id, 0);

    // The mocked pushToUser throws; settlement must still complete + award.
    await runTournamentCron(testEnv);

    const t = await testEnv.DB.prepare(`SELECT settled FROM tournaments WHERE id = ?`)
      .bind(id)
      .first<{ settled: number }>();
    expect(t?.settled).toBe(1);

    const aBal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.A.id)
      .first<{ balance: number }>();
    expect(aBal?.balance).toBe(500);
    const bBal = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.B.id)
      .first<{ balance: number }>();
    expect(bBal?.balance).toBe(300);

    // The placement push was attempted per finisher.
    expect((pushToUser as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

    // Re-running the cron does not double-credit (settled event skipped).
    await runTournamentCron(testEnv);
    const aBal2 = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
      .bind(USERS.A.id)
      .first<{ balance: number }>();
    expect(aBal2?.balance).toBe(500);
  });

  it('an award failure still settles the event and tallies trophies', async () => {
    const id = 880002;
    await seedClosedTournament(id);
    await seedEntry(id, USERS.A.id, 1040, -4, 11); // rank 1
    await seedEntry(id, USERS.B.id, 1000, 0, 15); // rank 2

    // Drop the ledger table so awardCoins throws at the top of the award block.
    // The trophy insert + settled=1 below MUST still complete, otherwise the
    // finisher is lost forever on retry (INSERT OR IGNORE skips them).
    await testEnv.DB.prepare(`DROP TABLE currency_ledger`).run();

    await runTournamentCron(testEnv);

    const t = await testEnv.DB.prepare(`SELECT settled FROM tournaments WHERE id = ?`)
      .bind(id)
      .first<{ settled: number }>();
    expect(t?.settled).toBe(1);

    const places = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_placements WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(places?.n).toBe(2);

    const aTally = await testEnv.DB.prepare(
      `SELECT golds, best_rank FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(USERS.A.id)
      .first<{ golds: number; best_rank: number }>();
    expect(aTally).toMatchObject({ golds: 1, best_rank: 1 });
  });
});
