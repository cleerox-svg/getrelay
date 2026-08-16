// Fog mini game API tests — POST /game/score + GET /game/leaderboard.
// First test file in the repo; runs inside workerd via
// @cloudflare/vitest-pool-workers. Isolated storage means writes made
// inside a test are rolled back afterwards, while the beforeAll seed
// (tables + users + sessions + the A→B contact) persists for the file.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';

// Mock push so the challenge create/completion seams' notifications can be
// spied on and forced to throw — proving a push failure never breaks the
// create or the result submit — while keeping the real pushRoutes() intact.
vi.mock('../src/push', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    // Default: a resolving spy (real push no-ops without VAPID anyway). Tests
    // override per-call with mockImplementationOnce to fault-inject a throw.
    pushToUser: vi.fn(async () => {}),
  };
});

// Wrap the economy earn helpers in spies over their REAL implementations, so
// awards still land in the DB but a single call can be forced to throw to prove
// an economy failure never fails the result submit.
vi.mock('../src/economy', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    awardCoins: vi.fn(actual.awardCoins as (...a: unknown[]) => unknown),
    addXp: vi.fn(actual.addXp as (...a: unknown[]) => unknown),
  };
});

import worker from '../src/index';
import type { Env } from '../src/env';
import { signJwt } from '../src/lib/jwt';
import {
  MAX_POINTS_PER_ROUND,
  MAX_ROUNDS,
  DAILY_ROTATION,
  dailyChallengeFor,
  dailySeed,
  CHALLENGE_WIN_COINS,
  CHALLENGE_WIN_XP,
  CHALLENGE_TIE_COINS,
  CHALLENGE_TIE_XP,
  CHALLENGE_LOSS_XP,
  MAX_CHALLENGE_WINS_PER_DAY,
} from '../src/games';
import { pushToUser } from '../src/push';
import { awardCoins } from '../src/economy';

const pushMock = pushToUser as unknown as ReturnType<typeof vi.fn>;
const awardCoinsMock = awardCoins as unknown as ReturnType<typeof vi.fn>;
import {
  TOURNEY_ROTATION,
  TOURNEY_PERIOD_MS,
  currentPeriodIndex,
  periodWindow,
  tournamentSeed,
  tournamentHoles,
  trophyAward,
  runTournamentCron,
} from '../src/tournaments';

const testEnv = env as unknown as Env;

const DAY = 24 * 3600 * 1000;

// Only the tables these routes touch — column shapes copied from
// src/schema.sql (the pool doesn't auto-apply the schema).
const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
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
     is_admin INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     jwt_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS contacts (
     owner_id TEXT NOT NULL REFERENCES users(id),
     contact_id TEXT NOT NULL REFERENCES users(id),
     alias TEXT,
     category TEXT,
     added_at INTEGER NOT NULL,
     PRIMARY KEY (owner_id, contact_id)
   )`,
  `CREATE TABLE IF NOT EXISTS user_blocks (
     blocker_id TEXT NOT NULL REFERENCES users(id),
     blocked_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     PRIMARY KEY (blocker_id, blocked_id)
   )`,
  `CREATE TABLE IF NOT EXISTS game_scores (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     game TEXT NOT NULL DEFAULT 'fog',
     score INTEGER NOT NULL,
     rounds INTEGER NOT NULL,
     best_streak INTEGER NOT NULL DEFAULT 0,
     course TEXT,
     to_par INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS golf_records (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     longest_drive_yards REAL,
     longest_drive_hole INTEGER,
     longest_drive_at INTEGER,
     closest_to_pin_yards REAL,
     closest_to_pin_hole INTEGER,
     closest_to_pin_at INTEGER,
     longest_putt_yards REAL,
     longest_putt_hole INTEGER,
     longest_putt_at INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS game_challenges (
     id TEXT PRIMARY KEY,
     game TEXT NOT NULL,
     course TEXT,
     hole INTEGER,
     seed INTEGER NOT NULL,
     challenger_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     opponent_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     challenger_score INTEGER,
     opponent_score  INTEGER,
     winner_id TEXT,
     status TEXT NOT NULL DEFAULT 'pending',
     chat_id TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS daily_results (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     date TEXT NOT NULL,
     game TEXT NOT NULL,
     course TEXT,
     hole INTEGER,
     seed INTEGER NOT NULL,
     strokes INTEGER,
     to_par INTEGER,
     score INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(user_id, date)
   )`,
  `CREATE TABLE IF NOT EXISTS daily_streaks (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     current INTEGER NOT NULL DEFAULT 0,
     best INTEGER NOT NULL DEFAULT 0,
     last_date TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tournaments (
     id INTEGER PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'rapid',
     seed INTEGER NOT NULL,
     holes TEXT NOT NULL,
     opened_at INTEGER NOT NULL,
     closes_at INTEGER NOT NULL,
     settled INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tournaments_closes_at ON tournaments(closes_at)`,
  `CREATE TABLE IF NOT EXISTS tournament_entries (
     id TEXT PRIMARY KEY,
     tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     score INTEGER NOT NULL,
     to_par INTEGER,
     strokes INTEGER,
     rounds_played INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(tournament_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tournament_entries_board ON tournament_entries(tournament_id, score DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tournament_entries_topar ON tournament_entries(tournament_id, to_par)`,
  `CREATE TABLE IF NOT EXISTS tournament_trophies (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     trophies INTEGER NOT NULL DEFAULT 0,
     golds INTEGER NOT NULL DEFAULT 0,
     podiums INTEGER NOT NULL DEFAULT 0,
     best_rank INTEGER,
     events_played INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS tournament_placements (
     id TEXT PRIMARY KEY,
     tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     rank INTEGER NOT NULL,
     trophies INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     UNIQUE(tournament_id, user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tournament_placements_user ON tournament_placements(user_id, created_at DESC)`,
  // ---- Golf economy (migration 0013) — the round/daily/tournament earn hooks
  // in games.ts + tournaments.ts write to these, so the score/daily/settlement
  // endpoints tested here need them present.
  `CREATE TABLE IF NOT EXISTS user_wallet (
     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     balance INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS currency_ledger (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     delta INTEGER NOT NULL,
     reason TEXT NOT NULL,
     ref TEXT,
     balance_after INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_currency_ledger_user_time ON currency_ledger(user_id, created_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_currency_ledger_award
     ON currency_ledger(user_id, reason, ref) WHERE ref IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS user_cosmetics (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     cosmetic_id TEXT NOT NULL,
     acquired_at INTEGER NOT NULL,
     UNIQUE(user_id, cosmetic_id)
   )`,
  `CREATE TABLE IF NOT EXISTS user_equipped (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     slot TEXT NOT NULL,
     cosmetic_id TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, slot)
   )`,
  `CREATE TABLE IF NOT EXISTS season_progress (
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     season_id INTEGER NOT NULL,
     xp INTEGER NOT NULL DEFAULT 0,
     claimed TEXT NOT NULL DEFAULT '[]',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (user_id, season_id)
   )`,
];

const USERS = {
  A: { id: 'user-a', jti: 'jti-a', pin: 'PINAAA01', name: 'Alice' },
  B: { id: 'user-b', jti: 'jti-b', pin: 'PINBBB02', name: 'Bob' },
  C: { id: 'user-c', jti: 'jti-c', pin: 'PINCCC03', name: 'Cara' },
} as const;

const cookies: Record<keyof typeof USERS, string> = { A: '', B: '', C: '' };

async function seed() {
  for (const sql of DDL) await testEnv.DB.prepare(sql).run();

  const now = Date.now();
  for (const [key, u] of Object.entries(USERS) as [keyof typeof USERS, (typeof USERS)[keyof typeof USERS]][]) {
    await testEnv.DB.prepare(
      `INSERT INTO users (id, google_sub, email, pin, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(u.id, `sub-${u.id}`, `${u.id}@example.com`, u.pin, u.name, now)
      .run();
    // Session row shaped exactly the way readAuthedUser expects:
    // matching jti, unexpired (ms epoch), not revoked.
    await testEnv.DB.prepare(
      `INSERT INTO sessions (jwt_id, user_id, created_at, expires_at, revoked)
       VALUES (?, ?, ?, ?, 0)`,
    )
      .bind(u.jti, u.id, now, now + 30 * DAY)
      .run();

    const nowSec = Math.floor(now / 1000);
    const token = await signJwt(
      { sub: u.id, jti: u.jti, iat: nowSec, exp: nowSec + 3600 },
      'test-secret',
    );
    cookies[key] = `relay_session=${token}`;
  }

  // A has B as a contact; C is a stranger to A.
  await testEnv.DB.prepare(
    `INSERT INTO contacts (owner_id, contact_id, added_at) VALUES (?, ?, ?)`,
  )
    .bind(USERS.A.id, USERS.B.id, now)
    .run();
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`https://example.com${path}`, init),
    testEnv,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

function postScore(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/score', { method: 'POST', headers, body: JSON.stringify(body) });
}

function getLeaderboard(cookie: string, period?: string): Promise<Response> {
  const qs = period ? `?period=${period}` : '';
  return request(`/game/leaderboard${qs}`, { headers: { Cookie: cookie } });
}

async function insertScore(userId: string, score: number, createdAt: number): Promise<void> {
  await insertScoreGame(userId, 'fog', score, createdAt);
}

async function insertScoreGame(
  userId: string,
  game: string,
  score: number,
  createdAt: number,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, created_at)
     VALUES (?, ?, ?, ?, 5, 2, ?)`,
  )
    .bind(crypto.randomUUID(), userId, game, score, createdAt)
    .run();
}

function getLeaderboardGame(cookie: string, game: string): Promise<Response> {
  return request(`/game/leaderboard?game=${game}`, { headers: { Cookie: cookie } });
}

// Equip a cosmetic in a slot for a user, straight into user_equipped (bypassing
// the shop endpoint) so leaderboard frame surfacing can be exercised directly.
async function equipCosmetic(
  userId: string,
  slot: string,
  cosmeticId: string,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO user_equipped (user_id, slot, cosmetic_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, slot) DO UPDATE SET
       cosmetic_id = excluded.cosmetic_id, updated_at = excluded.updated_at`,
  )
    .bind(userId, slot, cosmeticId, Date.now())
    .run();
}

function postGolfRecords(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/golf-records', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getGolfRecords(cookie: string): Promise<Response> {
  return request('/game/golf-records', { headers: { Cookie: cookie } });
}

function getGolfStats(cookie: string | null, game: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return request(`/game/golf-stats?game=${game}`, { headers });
}

// Insert a golf run with an explicit course (may be null) and to_par (may be
// null). Mirrors insertScoreGame but exercises the new columns directly.
async function insertGolf(
  userId: string,
  game: string,
  score: number,
  course: string | null,
  toPar: number | null,
  createdAt: number,
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, course, to_par, created_at)
     VALUES (?, ?, ?, ?, 5, 2, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, game, score, course, toPar, createdAt)
    .run();
}

function createChallenge(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/challenge', { method: 'POST', headers, body: JSON.stringify(body) });
}

function submitChallengeResult(
  cookie: string,
  id: string,
  body: unknown,
): Promise<Response> {
  return request(`/game/challenge/${id}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function getChallenge(cookie: string, id: string): Promise<Response> {
  return request(`/game/challenge/${id}`, { headers: { Cookie: cookie } });
}

// The caller's current wallet balance (0 when no row yet).
async function walletBalance(userId: string): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT balance FROM user_wallet WHERE user_id = ?`)
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

// Count ledger coin rows for a (user, reason, ref) — the idempotency key. Used
// to prove a completion credits exactly once.
async function ledgerCoinCount(userId: string, reason: string, ref: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS n FROM currency_ledger
      WHERE user_id = ? AND reason = ? AND ref = ? AND delta <> 0`,
  )
    .bind(userId, reason, ref)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The caller's season XP for the current season (summed across seasons is fine
// for these single-season tests). Null-safe.
async function seasonXp(userId: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COALESCE(SUM(xp), 0) AS xp FROM season_progress WHERE user_id = ?`,
  )
    .bind(userId)
    .first<{ xp: number }>();
  return row?.xp ?? 0;
}

// Seed N credited challenge coin ledger rows for a user TODAY under a given
// reason, so the per-day coin cap can be exercised without playing N challenges.
async function seedChallengeCoins(userId: string, reason: string, n: number): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    await testEnv.DB.prepare(
      `INSERT INTO currency_ledger (id, user_id, delta, reason, ref, balance_after, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
      .bind(crypto.randomUUID(), userId, CHALLENGE_WIN_COINS, reason, `seed-${reason}-${i}`, now)
      .run();
  }
}

async function seedChallengeWins(userId: string, n: number): Promise<void> {
  await seedChallengeCoins(userId, 'challenge_win', n);
}

async function seedChallengeTies(userId: string, n: number): Promise<void> {
  await seedChallengeCoins(userId, 'challenge_tie', n);
}

// Drive a challenge from creation to completion, returning its id. A submits
// `aToPar`, B submits `bToPar`.
async function playChallenge(aToPar: number, bToPar: number): Promise<string> {
  const created = await createChallenge(cookies.A, {
    opponentId: USERS.B.id,
    game: 'golfcourse',
    course: 'Augusta',
  });
  const { challenge } = (await created.json()) as ChallengeBody;
  await submitChallengeResult(cookies.A, challenge.id, { toPar: aToPar });
  await submitChallengeResult(cookies.B, challenge.id, { toPar: bToPar });
  return challenge.id;
}

type ChallengeBody = {
  challenge: {
    id: string;
    game: string;
    course: string | null;
    hole: number | null;
    seed: number;
    status: string;
    challenger: { userId: string; toPar: number | null };
    opponent: { userId: string; toPar: number | null };
    winnerId: string | null;
    mine: 'challenger' | 'opponent';
    rewardCoins: number;
    rewardCoinsAwarded: number;
  };
};

// ---- Daily Challenge helpers ----------------------------------------------

// The server's notion of today/other UTC days, mirrored so tests can seed rows
// and streak state relative to it.
function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

function getDaily(cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/daily', { headers });
}

function postDailyResult(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/daily/result', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getDailyLeaderboard(cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/daily/leaderboard', { headers });
}

// Insert a daily_results row directly (bypassing the endpoint) for a given day.
async function insertDaily(
  userId: string,
  date: string,
  toPar: number,
  score: number,
  strokes: number,
): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO daily_results
       (id, user_id, date, game, course, hole, seed, strokes, to_par, score, created_at, updated_at)
     VALUES (?, ?, ?, 'golfcourse', 'augusta', 1, 123, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), userId, date, strokes, toPar, score, now, now)
    .run();
}

// Seed the caller's streak state directly.
async function setStreak(
  userId: string,
  current: number,
  best: number,
  lastDate: string | null,
): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO daily_streaks (user_id, current, best, last_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       current = excluded.current, best = excluded.best,
       last_date = excluded.last_date, updated_at = excluded.updated_at`,
  )
    .bind(userId, current, best, lastDate, now, now)
    .run();
}

beforeAll(seed);

describe('Daily Challenge rotation', () => {
  // Hole counts per real Relay Course-mode course. augusta is 18 holes; every
  // listowel-* course has only 9. A rotation entry pointing past its course's
  // count makes that day unplayable, so guard against reintroducing one.
  const HOLE_COUNTS: Record<string, number> = {
    augusta: 18,
    'listowel-vintage': 9,
    'listowel-heritage': 9,
    'listowel-millennium': 9,
  };

  it('references only holes that exist on their course', () => {
    for (const { course, hole } of DAILY_ROTATION) {
      const count = HOLE_COUNTS[course];
      expect(count, `unknown course '${course}' in DAILY_ROTATION`).toBeDefined();
      expect(Number.isInteger(hole)).toBe(true);
      expect(hole).toBeGreaterThanOrEqual(1);
      expect(hole, `${course} hole ${hole} exceeds its ${count}-hole count`).toBeLessThanOrEqual(
        count!,
      );
    }
  });
});

describe('Daily Challenge derivation', () => {
  it('is deterministic: same date -> same seed/course/hole', () => {
    const a = dailyChallengeFor('2026-08-14');
    const b = dailyChallengeFor('2026-08-14');
    expect(a).toEqual(b);
    expect(a.game).toBe('golfcourse');
    expect(Number.isInteger(a.seed)).toBe(true);
    expect(a.seed).toBeGreaterThanOrEqual(0);
    expect(a.seed).toBeLessThanOrEqual(2 ** 31 - 1);
    // dailySeed is a pure function of the string.
    expect(dailySeed('2026-08-14')).toBe(a.seed);
  });

  it('rotates course/hole by day and differs across dates', () => {
    const d1 = dailyChallengeFor('2026-08-14');
    const d2 = dailyChallengeFor('2026-08-15');
    // Different days pull the next rotation slot (7-long rotation) and a
    // different seed.
    expect(d1.seed).not.toBe(d2.seed);
    expect({ course: d1.course, hole: d1.hole }).not.toEqual({
      course: d2.course,
      hole: d2.hole,
    });
    // Exactly one rotation length later lands on the same slot again.
    const d8 = dailyChallengeFor('2026-08-21');
    expect({ course: d1.course, hole: d1.hole }).toEqual({
      course: d8.course,
      hole: d8.hole,
    });
  });
});

describe('GET /game/daily', () => {
  it('requires a session cookie', async () => {
    const res = await getDaily(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns todays challenge, a null result and zero streak before play', async () => {
    const res = await getDaily(cookies.C);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      date: string;
      game: string;
      course: string;
      hole: number;
      seed: number;
      today: unknown;
      streak: { current: number; best: number };
    };
    const expected = dailyChallengeFor(utcDay(0));
    expect(body.date).toBe(expected.date);
    expect(body.game).toBe('golfcourse');
    expect(body.course).toBe(expected.course);
    expect(body.hole).toBe(expected.hole);
    expect(body.seed).toBe(expected.seed);
    expect(body.today).toBeNull();
    expect(body.streak).toEqual({ current: 0, best: 0 });
  });

  it('surfaces the callers result and streak once played', async () => {
    await insertDaily(USERS.A.id, utcDay(0), -3, 1030, 3);
    await setStreak(USERS.A.id, 4, 9, utcDay(0));

    const res = await getDaily(cookies.A);
    const body = (await res.json()) as {
      today: { strokes: number; toPar: number; score: number } | null;
      streak: { current: number; best: number };
    };
    expect(body.today).toEqual({ strokes: 3, toPar: -3, score: 1030 });
    expect(body.streak).toEqual({ current: 4, best: 9 });
  });
});

describe('POST /game/daily/result', () => {
  it('requires a session cookie', async () => {
    const res = await postDailyResult(null, { strokes: 3, toPar: -2 });
    expect(res.status).toBe(401);
  });

  it('rejects invalid strokes/toPar with 400', async () => {
    const bad = [
      { strokes: 3, toPar: 2.5 }, // non-integer toPar
      { strokes: 3, toPar: 9999 }, // toPar past clamp
      { strokes: 0, toPar: 0 }, // strokes below 1
      { strokes: 2.5, toPar: 0 }, // non-integer strokes
      { toPar: 0 }, // strokes missing
      { strokes: 3 }, // toPar missing
    ];
    for (const body of bad) {
      const res = await postDailyResult(cookies.A, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_result' });
    }
  });

  it('rejects a client date that is not the server today (409)', async () => {
    const res = await postDailyResult(cookies.A, {
      strokes: 3,
      toPar: -1,
      date: '2000-01-01',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'stale_date' });
  });

  it('derives score from toPar and starts a streak at 1 on the first daily', async () => {
    const res = await postDailyResult(cookies.A, { strokes: 3, toPar: -4 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      today: { strokes: number; toPar: number; score: number };
      streak: { current: number; best: number };
      improved: boolean;
    };
    // score = max(0, round(1000 - (-4)*10)) = 1040.
    expect(body.today).toEqual({ strokes: 3, toPar: -4, score: 1040 });
    expect(body.streak).toEqual({ current: 1, best: 1 });
    expect(body.improved).toBe(true);
  });

  it('keeps the BETTER attempt and never overwrites with a worse one', async () => {
    // First: a modest score.
    const first = await postDailyResult(cookies.A, { strokes: 5, toPar: 2 }); // score 980
    expect(((await first.json()) as { improved: boolean }).improved).toBe(true);

    // Worse attempt (higher to_par) must not replace the stored best.
    const worse = await postDailyResult(cookies.A, { strokes: 7, toPar: 6 }); // score 940
    const worseBody = (await worse.json()) as {
      today: { toPar: number; score: number };
      improved: boolean;
    };
    expect(worseBody.improved).toBe(false);
    expect(worseBody.today).toEqual({ strokes: 5, toPar: 2, score: 980 });

    // Better attempt (lower to_par) replaces it.
    const better = await postDailyResult(cookies.A, { strokes: 3, toPar: -1 }); // score 1010
    const betterBody = (await better.json()) as {
      today: { toPar: number; score: number };
      improved: boolean;
    };
    expect(betterBody.improved).toBe(true);
    expect(betterBody.today).toEqual({ strokes: 3, toPar: -1, score: 1010 });
  });

  it('extends the streak on a consecutive day', async () => {
    await setStreak(USERS.A.id, 3, 5, utcDay(-1)); // last counted yesterday
    const res = await postDailyResult(cookies.A, { strokes: 4, toPar: 0 });
    const body = (await res.json()) as { streak: { current: number; best: number } };
    expect(body.streak).toEqual({ current: 4, best: 5 }); // extended, best unchanged
  });

  it('bumps best when the extended streak exceeds it', async () => {
    await setStreak(USERS.A.id, 5, 5, utcDay(-1));
    const res = await postDailyResult(cookies.A, { strokes: 4, toPar: 0 });
    const body = (await res.json()) as { streak: { current: number; best: number } };
    expect(body.streak).toEqual({ current: 6, best: 6 });
  });

  it('resets the streak to 1 after a gap', async () => {
    await setStreak(USERS.A.id, 8, 8, utcDay(-3)); // last counted 3 days ago
    const res = await postDailyResult(cookies.A, { strokes: 4, toPar: 0 });
    const body = (await res.json()) as { streak: { current: number; best: number } };
    expect(body.streak).toEqual({ current: 1, best: 8 }); // reset, best preserved
  });

  it('does not double-count the streak on a same-day retry', async () => {
    await setStreak(USERS.A.id, 4, 6, utcDay(0)); // already counted today
    const res = await postDailyResult(cookies.A, { strokes: 4, toPar: 1 });
    const body = (await res.json()) as { streak: { current: number; best: number } };
    expect(body.streak).toEqual({ current: 4, best: 6 }); // unchanged on retry
  });
});

describe('GET /game/daily/leaderboard', () => {
  it('requires a session cookie', async () => {
    const res = await getDailyLeaderboard(null);
    expect(res.status).toBe(401);
  });

  it('is scoped to today, to contacts, and orders by score DESC then to_par ASC', async () => {
    const today = utcDay(0);
    await insertDaily(USERS.A.id, today, 2, 980, 5); // me
    await insertDaily(USERS.B.id, today, -3, 1030, 3); // contact, best
    await insertDaily(USERS.C.id, today, -10, 1100, 1); // stranger — hidden
    await insertDaily(USERS.A.id, utcDay(-1), -20, 1200, 1); // yesterday — excluded

    const res = await getDailyLeaderboard(cookies.A);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: {
        userId: string;
        score: number;
        toPar: number;
        strokes: number;
        mine: boolean;
        pin: string;
      }[];
    };
    expect(entries.map((e) => e.userId)).toEqual([USERS.B.id, USERS.A.id]);
    expect(entries[0]).toMatchObject({ score: 1030, toPar: -3, mine: false, pin: USERS.B.pin });
    expect(entries[1]).toMatchObject({ score: 980, toPar: 2, mine: true });
  });

  it('drops blocked users even when they are contacts', async () => {
    const today = utcDay(0);
    await insertDaily(USERS.A.id, today, 0, 1000, 4);
    await insertDaily(USERS.B.id, today, -5, 1050, 2);
    await testEnv.DB.prepare(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    )
      .bind(USERS.A.id, USERS.B.id, Date.now())
      .run();

    const res = await getDailyLeaderboard(cookies.A);
    const { entries } = (await res.json()) as { entries: { userId: string }[] };
    expect(entries.map((e) => e.userId)).toEqual([USERS.A.id]);
  });

  it('surfaces each row equipped frame; frame_none and unequipped are null', async () => {
    const today = utcDay(0);
    await insertDaily(USERS.A.id, today, 2, 980, 5); // me — no equipped row
    await insertDaily(USERS.B.id, today, -3, 1030, 3); // contact, best — equips a frame
    await equipCosmetic(USERS.B.id, 'frame', 'frame_gold');

    const res = await getDailyLeaderboard(cookies.A);
    const { entries } = (await res.json()) as {
      entries: { userId: string; frame: string | null }[];
    };
    // Order unchanged: B (1030) ahead of A (980).
    expect(entries.map((e) => e.userId)).toEqual([USERS.B.id, USERS.A.id]);
    expect(entries[0]).toMatchObject({ userId: USERS.B.id, frame: 'frame_gold' });
    expect(entries[1]).toMatchObject({ userId: USERS.A.id, frame: null });
  });
});

describe('POST /game/score', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await postScore(null, { score: 100, rounds: 3, bestStreak: 1 });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('persists a valid submission and returns the all-time best', async () => {
    const res = await postScore(cookies.A, { score: 1200, rounds: MAX_ROUNDS, bestStreak: 3 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, best: 1200 });

    const row = await testEnv.DB.prepare(
      `SELECT score, rounds, best_streak, game FROM game_scores WHERE user_id = ?`,
    )
      .bind(USERS.A.id)
      .first<{ score: number; rounds: number; best_streak: number; game: string }>();
    expect(row).toEqual({ score: 1200, rounds: MAX_ROUNDS, best_streak: 3, game: 'fog' });

    // best reflects the max across submissions, not the latest.
    const res2 = await postScore(cookies.A, { score: 900, rounds: 4, bestStreak: 2 });
    expect(await res2.json()).toEqual({ ok: true, best: 1200 });
  });

  it('rejects out-of-clamp and non-integer payloads', async () => {
    const bad = [
      { score: 999999, rounds: MAX_ROUNDS, bestStreak: 0 }, // > rounds * MAX_POINTS_PER_ROUND
      { score: 100, rounds: 0, bestStreak: 0 }, // rounds below 1
      { score: 100, rounds: 3, bestStreak: 4 }, // streak longer than the run
      { score: 12.5, rounds: 3, bestStreak: 1 }, // non-integer score
    ];
    for (const body of bad) {
      const res = await postScore(cookies.A, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_score' });
    }
    // Sanity: the boundary itself is accepted.
    const ok = await postScore(cookies.A, {
      score: MAX_ROUNDS * MAX_POINTS_PER_ROUND,
      rounds: MAX_ROUNDS,
      bestStreak: MAX_ROUNDS,
    });
    expect(ok.status).toBe(200);
  });

  // ---- Per-game bestStreak ceiling ---------------------------------------
  //
  // For fog / tune / golf a "round" IS one attempt, so a streak can never
  // exceed the rounds played. A derby round is EIGHT PITCHES
  // (derbyRules.PITCHES_PER_ROUND) and its bestStreak counts consecutive HOME
  // RUNS across pitches, so a legitimate 3-round derby can streak to 24 with
  // rounds = 3. The flat `bestStreak <= rounds` clamp 400'd nearly every
  // competently-played derby, and DerbyGame's bank() swallows the rejection.
  //
  // ⚠ THE NUMBERS BELOW ARE WRITTEN OUT (3 x 8 = 24, 8 x 8 = 64) RATHER THAN
  // DERIVED FROM THE WORKER'S CONSTANT ON PURPOSE. A test that computes its
  // expectation from the implementation constant passes for every value of it,
  // which is the exact class of hollow test this suite keeps getting bitten by.
  describe('bestStreak ceiling', () => {
    it('accepts a derby streak longer than its rounds, up to rounds x 8', async () => {
      // The real symptom: competent play streaks ~9-12 home runs over 24
      // pitches. Under the flat clamp this was a 400.
      const good = await postScore(cookies.A, {
        score: 900,
        rounds: 3,
        bestStreak: 12,
        game: 'bbderby',
      });
      expect(good.status).toBe(200);
      expect(await good.json()).toEqual({ ok: true, best: 900 });

      const row = await testEnv.DB.prepare(
        `SELECT rounds, best_streak AS bestStreak FROM game_scores
          WHERE user_id = ? AND game = 'bbderby' ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(USERS.A.id)
        .first<{ rounds: number; bestStreak: number }>();
      // The submitted streak is stored as-is, not collapsed to the rounds.
      expect(row).toEqual({ rounds: 3, bestStreak: 12 });

      // The boundary itself: a perfect 3-round derby is 24 straight home runs.
      const boundary = await postScore(cookies.A, {
        score: 6000,
        rounds: 3,
        bestStreak: 24,
        game: 'bbderby',
      });
      expect(boundary.status).toBe(200);
    });

    it('still rejects a derby streak past rounds x 8', async () => {
      // One past the ceiling: 25 home runs cannot happen in 24 pitches. The
      // clamp is still a real anti-cheat bound, not a hole.
      const res = await postScore(cookies.A, {
        score: 900,
        rounds: 3,
        bestStreak: 25,
        game: 'bbderby',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_score' });

      // A negative streak is still rejected, derby or not.
      const negative = await postScore(cookies.A, {
        score: 900,
        rounds: 3,
        bestStreak: -1,
        game: 'bbderby',
      });
      expect(negative.status).toBe(400);
      expect(await negative.json()).toEqual({ error: 'invalid_score' });
    });

    it('scales the derby ceiling with the rounds submitted', async () => {
      // The ceiling is rounds x 8, not a flat 24: at MAX_ROUNDS it is 64...
      const ok = await postScore(cookies.A, {
        score: 1000,
        rounds: MAX_ROUNDS,
        bestStreak: MAX_ROUNDS * 8,
        game: 'bbderby',
      });
      expect(ok.status).toBe(200);

      const over = await postScore(cookies.A, {
        score: 1000,
        rounds: MAX_ROUNDS,
        bestStreak: MAX_ROUNDS * 8 + 1,
        game: 'bbderby',
      });
      expect(over.status).toBe(400);

      // ...and at one round it is 8, so 9 is out of reach even though 24 is
      // fine for a 3-round session.
      const oneRound = await postScore(cookies.A, {
        score: 500,
        rounds: 1,
        bestStreak: 8,
        game: 'bbderby',
      });
      expect(oneRound.status).toBe(200);
      const oneRoundOver = await postScore(cookies.A, {
        score: 500,
        rounds: 1,
        bestStreak: 9,
        game: 'bbderby',
      });
      expect(oneRoundOver.status).toBe(400);

      // rounds itself is unchanged: the derby gets no MAX_ROUNDS escape hatch.
      const tooManyRounds = await postScore(cookies.A, {
        score: 500,
        rounds: MAX_ROUNDS + 1,
        bestStreak: 1,
        game: 'bbderby',
      });
      expect(tooManyRounds.status).toBe(400);
    });

    it('leaves every non-derby game on bestStreak <= rounds', async () => {
      // The widened ceiling must NOT leak into the other games. Each one is
      // checked twice: streak == rounds accepted (so the 400 below is about
      // the streak clamp and nothing else), streak == rounds + 1 rejected.
      // A derby-sized streak (12) is rejected for all of them too.
      const others = ['fog', 'tune', 'golf', 'golfrange', 'golfcourse'] as const;
      for (const game of others) {
        // golfcourse derives its score from toPar and requires one; the others
        // ignore toPar entirely, so sending it is harmless.
        const base = { score: 900, game, toPar: -2 };

        const atLimit = await postScore(cookies.A, { ...base, rounds: 3, bestStreak: 3 });
        expect(atLimit.status, `${game} streak == rounds`).toBe(200);

        const overByOne = await postScore(cookies.A, { ...base, rounds: 3, bestStreak: 4 });
        expect(overByOne.status, `${game} streak == rounds + 1`).toBe(400);
        expect(await overByOne.json()).toEqual({ error: 'invalid_score' });

        const derbySized = await postScore(cookies.A, { ...base, rounds: 3, bestStreak: 12 });
        expect(derbySized.status, `${game} derby-sized streak`).toBe(400);
        expect(await derbySized.json()).toEqual({ error: 'invalid_score' });
      }
    });

    it('does not widen the ceiling for an unknown game id (it falls back to fog)', async () => {
      // normalizeGame() maps anything unrecognised to 'fog', so a spoofed id
      // cannot buy the derby's ceiling.
      const res = await postScore(cookies.A, {
        score: 900,
        rounds: 3,
        bestStreak: 12,
        game: 'bbderby-but-not-really',
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_score' });
    });
  });

  it('records a score under the requested game and reports that game\'s best', async () => {
    // A tune submission lands with game='tune'...
    const res = await postScore(cookies.A, {
      score: 500,
      rounds: 4,
      bestStreak: 2,
      game: 'tune',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, best: 500 });

    const row = await testEnv.DB.prepare(
      `SELECT score, game FROM game_scores WHERE user_id = ? AND game = 'tune'`,
    )
      .bind(USERS.A.id)
      .first<{ score: number; game: string }>();
    expect(row).toEqual({ score: 500, game: 'tune' });

    // ...and its "best" is scoped to that game, ignoring a higher fog run.
    await insertScore(USERS.A.id, 1800, Date.now());
    const res2 = await postScore(cookies.A, {
      score: 700,
      rounds: 4,
      bestStreak: 2,
      game: 'tune',
    });
    expect(await res2.json()).toEqual({ ok: true, best: 700 });
  });

  it('defaults an omitted game to fog', async () => {
    const res = await postScore(cookies.A, { score: 300, rounds: 3, bestStreak: 1 });
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(
      `SELECT game FROM game_scores WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.A.id)
      .first<{ game: string }>();
    expect(row?.game).toBe('fog');
  });

  it('persists course (trimmed) and a negative to_par when supplied', async () => {
    const res = await postScore(cookies.A, {
      score: 900,
      rounds: 4,
      bestStreak: 2,
      game: 'golf',
      course: '  Pebble Beach  ',
      toPar: -3,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, best: 900 });

    const row = await testEnv.DB.prepare(
      `SELECT course, to_par AS toPar FROM game_scores
        WHERE user_id = ? AND game = 'golf' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.A.id)
      .first<{ course: string | null; toPar: number | null }>();
    expect(row).toEqual({ course: 'Pebble Beach', toPar: -3 });
  });

  it('stores null course/to_par when absent, never a 400', async () => {
    const res = await postScore(cookies.A, {
      score: 500,
      rounds: 3,
      bestStreak: 1,
      game: 'golf',
    });
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(
      `SELECT course, to_par AS toPar FROM game_scores
        WHERE user_id = ? AND game = 'golf' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.A.id)
      .first<{ course: string | null; toPar: number | null }>();
    expect(row).toEqual({ course: null, toPar: null });
  });

  it('coerces a bogus course to null without failing the request', async () => {
    const res = await postScore(cookies.A, {
      score: 400,
      rounds: 3,
      bestStreak: 1,
      game: 'golf',
      course: 12345, // not a string
    });
    expect(res.status).toBe(200);
    const row = await testEnv.DB.prepare(
      `SELECT course FROM game_scores
        WHERE user_id = ? AND game = 'golf' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.A.id)
      .first<{ course: string | null }>();
    expect(row?.course).toBeNull();
  });

  it('rejects a present-but-invalid to_par with invalid_score', async () => {
    const bad = [
      { score: 400, rounds: 3, bestStreak: 1, game: 'golf', toPar: 2.5 }, // non-integer
      { score: 400, rounds: 3, bestStreak: 1, game: 'golf', toPar: 9999 }, // past clamp
    ];
    for (const body of bad) {
      const res = await postScore(cookies.A, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_score' });
    }
  });

  it('golfcourse: derives score from toPar, ignoring any client score', async () => {
    // 18-hole round at −5; client-sent score is bogus and must be ignored.
    const res = await postScore(cookies.A, {
      score: 999999,
      rounds: 18,
      bestStreak: 4,
      game: 'golfcourse',
      course: 'St Andrews',
      toPar: -5,
    });
    expect(res.status).toBe(200);
    // score = max(0, round(1000 - (-5)*10)) = 1050.
    expect(await res.json()).toEqual({ ok: true, best: 1050 });

    const row = await testEnv.DB.prepare(
      `SELECT score, rounds, course, to_par AS toPar FROM game_scores
        WHERE user_id = ? AND game = 'golfcourse' ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(USERS.A.id)
      .first<{ score: number; rounds: number; course: string | null; toPar: number | null }>();
    expect(row).toEqual({ score: 1050, rounds: 18, course: 'St Andrews', toPar: -5 });
  });

  it('golfcourse: allows rounds up to 18 but still rejects 19', async () => {
    const ok = await postScore(cookies.A, {
      rounds: 18,
      bestStreak: 0,
      game: 'golfcourse',
      toPar: 0,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, best: 1000 }); // scratch = 1000

    const tooMany = await postScore(cookies.A, {
      rounds: 19,
      bestStreak: 0,
      game: 'golfcourse',
      toPar: 0,
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: 'invalid_score' });
  });

  it('golfcourse: requires toPar to be present', async () => {
    const res = await postScore(cookies.A, {
      rounds: 18,
      bestStreak: 0,
      game: 'golfcourse',
      course: 'Torrey Pines',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_score' });
  });

  it('non-golfcourse games still cap rounds at MAX_ROUNDS', async () => {
    const res = await postScore(cookies.A, {
      score: 100,
      rounds: MAX_ROUNDS + 1,
      bestStreak: 0,
      game: 'golf',
      toPar: 1,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_score' });
  });
});

describe('GET /game/golf-stats', () => {
  it('requires a session cookie', async () => {
    const res = await getGolfStats(null, 'golf');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns an empty profile before any golf run', async () => {
    const res = await getGolfStats(cookies.C, 'golf');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      game: 'golf',
      gamesPlayed: 0,
      best: null,
      average: null,
      bestStreak: null,
      lastPlayed: null,
      handicap: null,
      perCourse: [],
      recent: [],
    });
  });

  it('aggregates the callers own golf runs, bucketing a null course', async () => {
    const now = Date.now();
    // Two runs at Augusta (with to_par), one uncategorized (null course, no
    // to_par). A contact's run must NOT leak into the caller's profile.
    await insertGolf(USERS.A.id, 'golf', 800, 'Augusta', -2, now - 3000);
    await insertGolf(USERS.A.id, 'golf', 1200, 'Augusta', 4, now - 2000);
    await insertGolf(USERS.A.id, 'golf', 600, null, null, now - 1000);
    await insertGolf(USERS.B.id, 'golf', 5000, 'Augusta', -10, now); // contact — excluded

    const res = await getGolfStats(cookies.A, 'golf');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      game: string;
      gamesPlayed: number;
      best: number | null;
      average: number | null;
      lastPlayed: number | null;
      handicap: number | null;
      perCourse: {
        course: string | null;
        games: number;
        bestScore: number;
        avgScore: number;
        bestToPar: number | null;
        avgToPar: number | null;
      }[];
      recent: { course: string | null; score: number; toPar: number | null }[];
    };

    expect(body.gamesPlayed).toBe(3);
    expect(body.best).toBe(1200);
    expect(body.average).toBeCloseTo(866.7, 1);
    expect(body.lastPlayed).toBe(now - 1000);
    // Handicap = avg to_par over scored rounds: (-2 + 4) / 2 = 1.
    expect(body.handicap).toBe(1);

    // perCourse ordered by games DESC: Augusta (2) then the null bucket (1).
    expect(body.perCourse).toHaveLength(2);
    const [augusta, uncategorized] = body.perCourse as [
      (typeof body.perCourse)[number],
      (typeof body.perCourse)[number],
    ];
    expect(augusta).toMatchObject({
      course: 'Augusta',
      games: 2,
      bestScore: 1200,
      bestToPar: -2, // MIN(to_par): lower is better
    });
    expect(augusta.avgToPar).toBeCloseTo(1, 1);
    expect(uncategorized).toMatchObject({
      course: null,
      games: 1,
      bestScore: 600,
      bestToPar: null, // no to_par rows in this bucket
      avgToPar: null,
    });

    // recent is newest-first and includes the null-course/null-toPar run.
    expect(body.recent.map((r) => r.course)).toEqual([null, 'Augusta', 'Augusta']);
    expect(body.recent[0]).toMatchObject({ course: null, score: 600, toPar: null });
  });

  it('surfaces golfcourse rounds (derived score) in the golfcourse profile', async () => {
    const post = await postScore(cookies.A, {
      rounds: 18,
      bestStreak: 3,
      game: 'golfcourse',
      course: 'St Andrews',
      toPar: -4, // -> score 1040
    });
    expect(post.status).toBe(200);

    const res = await getGolfStats(cookies.A, 'golfcourse');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      game: string;
      gamesPlayed: number;
      best: number | null;
      perCourse: { course: string | null; games: number; bestScore: number; bestToPar: number | null }[];
    };
    expect(body.game).toBe('golfcourse');
    expect(body.gamesPlayed).toBe(1);
    expect(body.best).toBe(1040);
    expect(body.perCourse).toHaveLength(1);
    expect(body.perCourse[0]).toMatchObject({
      course: 'St Andrews',
      games: 1,
      bestScore: 1040,
      bestToPar: -4,
    });
  });
});

describe('GET /game/leaderboard', () => {
  it('includes me and my contacts, excludes strangers', async () => {
    const now = Date.now();
    await insertScore(USERS.A.id, 800, now);
    await insertScore(USERS.B.id, 1500, now);
    await insertScore(USERS.B.id, 400, now);
    await insertScore(USERS.C.id, 9000, now); // stranger to A — hidden

    const res = await getLeaderboard(cookies.A);
    expect(res.status).toBe(200);
    const { entries } = (await res.json()) as {
      entries: { userId: string; best: number; games: number; mine: boolean; pin: string }[];
    };
    expect(entries.map((e) => e.userId)).toEqual([USERS.B.id, USERS.A.id]);
    expect(entries[0]).toMatchObject({ best: 1500, games: 2, mine: false, pin: USERS.B.pin });
    expect(entries[1]).toMatchObject({ best: 800, games: 1, mine: true });
  });

  it('drops blocked users even when they are contacts', async () => {
    const now = Date.now();
    await insertScore(USERS.A.id, 800, now);
    await insertScore(USERS.B.id, 1500, now);
    await testEnv.DB.prepare(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    )
      .bind(USERS.A.id, USERS.B.id, now)
      .run();

    const res = await getLeaderboard(cookies.A);
    const { entries } = (await res.json()) as { entries: { userId: string }[] };
    expect(entries.map((e) => e.userId)).toEqual([USERS.A.id]);
  });

  it('weekly window excludes old scores; period=all includes them', async () => {
    await insertScore(USERS.A.id, 700, Date.now() - 8 * DAY);

    const weekly = await getLeaderboard(cookies.A); // default period
    const weeklyBody = (await weekly.json()) as { entries: unknown[] };
    expect(weeklyBody.entries).toEqual([]);

    const all = await getLeaderboard(cookies.A, 'all');
    const allBody = (await all.json()) as { entries: { userId: string; best: number }[] };
    expect(allBody.entries).toHaveLength(1);
    expect(allBody.entries[0]).toMatchObject({ userId: USERS.A.id, best: 700 });
  });

  it('scopes the board to the requested game — fog and tune do not cross', async () => {
    const now = Date.now();
    await insertScoreGame(USERS.A.id, 'fog', 800, now);
    await insertScoreGame(USERS.A.id, 'tune', 1200, now);
    await insertScoreGame(USERS.B.id, 'tune', 300, now);

    // Default (no ?game) is fog: only the fog run shows, tune is hidden.
    const fog = await getLeaderboard(cookies.A);
    const fogBody = (await fog.json()) as { entries: { userId: string; best: number }[] };
    expect(fogBody.entries).toHaveLength(1);
    expect(fogBody.entries[0]).toMatchObject({ userId: USERS.A.id, best: 800 });

    // ?game=tune surfaces the tune scores (A + contact B), not the fog one.
    const tune = await getLeaderboardGame(cookies.A, 'tune');
    const tuneBody = (await tune.json()) as { entries: { userId: string; best: number }[] };
    expect(tuneBody.entries.map((e) => [e.userId, e.best])).toEqual([
      [USERS.A.id, 1200],
      [USERS.B.id, 300],
    ]);
  });

  it('surfaces each row equipped frame; frame_none and unequipped are null', async () => {
    const now = Date.now();
    await insertScore(USERS.A.id, 800, now); // A: explicitly equips frame_none
    await insertScore(USERS.B.id, 1500, now); // B: equips a real frame
    await equipCosmetic(USERS.A.id, 'frame', 'frame_none');
    await equipCosmetic(USERS.B.id, 'frame', 'frame_gold');
    // A also equips a non-frame slot to prove the slot filter is exact.
    await equipCosmetic(USERS.A.id, 'ball', 'ball_classic');

    const res = await getLeaderboard(cookies.A);
    const { entries } = (await res.json()) as {
      entries: { userId: string; frame: string | null }[];
    };
    // Order unchanged: B (1500) ahead of A (800).
    expect(entries.map((e) => e.userId)).toEqual([USERS.B.id, USERS.A.id]);
    // B surfaces the real frame id; A's frame_none normalizes to null.
    expect(entries[0]).toMatchObject({ userId: USERS.B.id, frame: 'frame_gold' });
    expect(entries[1]).toMatchObject({ userId: USERS.A.id, frame: null });
  });

  it('reports frame null for a player with no user_equipped row', async () => {
    await insertScore(USERS.A.id, 800, Date.now());
    const res = await getLeaderboard(cookies.A);
    const { entries } = (await res.json()) as { entries: { userId: string; frame: string | null }[] };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: USERS.A.id, frame: null });
  });
});

describe('golf-records', () => {
  it('rejects both endpoints without a session cookie', async () => {
    const post = await postGolfRecords(null, { longestDriveYards: 250 });
    expect(post.status).toBe(401);
    const get = await request('/game/golf-records');
    expect(get.status).toBe(401);
  });

  it('returns null metrics before any submission', async () => {
    const res = await getGolfRecords(cookies.C);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      records: { longestDrive: null, closestToPin: null, longestPutt: null },
    });
  });

  it('upserts on improve in both directions, ignoring worse shots', async () => {
    // First submission sets every metric — all newly improved.
    const first = await postGolfRecords(cookies.A, {
      longestDriveYards: 250,
      longestDriveHole: 3,
      closestToPinYards: 12,
      closestToPinHole: 3,
      longestPuttYards: 8,
      longestPuttHole: 7,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      improved: { longestDrive: boolean; closestToPin: boolean; longestPutt: boolean };
      records: {
        longestDrive: { yards: number; hole: number } | null;
        closestToPin: { yards: number; hole: number } | null;
        longestPutt: { yards: number; hole: number } | null;
      };
    };
    expect(firstBody.improved).toEqual({
      longestDrive: true,
      closestToPin: true,
      longestPutt: true,
    });
    expect(firstBody.records.longestDrive).toMatchObject({ yards: 250, hole: 3 });
    expect(firstBody.records.closestToPin).toMatchObject({ yards: 12, hole: 3 });
    expect(firstBody.records.longestPutt).toMatchObject({ yards: 8, hole: 7 });

    // A longer drive wins; a *longer* (worse) closest-to-pin loses; a
    // shorter putt loses. Only the drive improves.
    const second = await postGolfRecords(cookies.A, {
      longestDriveYards: 300,
      closestToPinYards: 40,
      longestPuttYards: 2,
    });
    const secondBody = (await second.json()) as typeof firstBody;
    expect(secondBody.improved).toEqual({
      longestDrive: true,
      closestToPin: false,
      longestPutt: false,
    });
    expect(secondBody.records.longestDrive?.yards).toBe(300);
    expect(secondBody.records.closestToPin?.yards).toBe(12); // unchanged
    expect(secondBody.records.longestPutt?.yards).toBe(8); // unchanged

    // A *closer* pin (smaller) now wins.
    const third = await postGolfRecords(cookies.A, { closestToPinYards: 5, closestToPinHole: 9 });
    const thirdBody = (await third.json()) as typeof firstBody;
    expect(thirdBody.improved.closestToPin).toBe(true);
    expect(thirdBody.records.closestToPin).toMatchObject({ yards: 5, hole: 9 });

    // GET reflects the persisted bests.
    const get = await getGolfRecords(cookies.A);
    const getBody = (await get.json()) as { records: typeof firstBody.records };
    expect(getBody.records.longestDrive?.yards).toBe(300);
    expect(getBody.records.closestToPin?.yards).toBe(5);
    expect(getBody.records.longestPutt?.yards).toBe(8);
  });

  it('rejects bogus distances (negative / NaN / absurd)', async () => {
    const bad = [
      { longestDriveYards: -5 },
      { longestDriveYards: 5000 }, // past the drive clamp
      { longestPuttYards: 500 }, // past the putt clamp
      { closestToPinYards: -1 },
      { longestDriveYards: 'far' },
      { longestDriveYards: 250, longestDriveHole: 0 }, // hole below 1
      { longestDriveYards: 250, longestDriveHole: 2.5 }, // non-integer hole
    ];
    for (const body of bad) {
      const res = await postGolfRecords(cookies.B, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_records' });
    }
  });
});

describe('game challenges', () => {
  it('requires a session cookie', async () => {
    const res = await createChallenge(null, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'St Andrews',
    });
    expect(res.status).toBe(401);
  });

  it('creates a pending challenge against a contact with a seed', async () => {
    const res = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'St Andrews',
      hole: 4,
    });
    expect(res.status).toBe(200);
    const { challenge } = (await res.json()) as ChallengeBody;
    expect(challenge.game).toBe('golfcourse');
    expect(challenge.course).toBe('St Andrews');
    expect(challenge.hole).toBe(4);
    expect(challenge.status).toBe('pending');
    expect(challenge.challenger.userId).toBe(USERS.A.id);
    expect(challenge.opponent.userId).toBe(USERS.B.id);
    expect(challenge.challenger.toPar).toBeNull();
    expect(challenge.opponent.toPar).toBeNull();
    expect(challenge.winnerId).toBeNull();
    expect(challenge.mine).toBe('challenger');
    // seed is an integer in 0..2^31-1.
    expect(Number.isInteger(challenge.seed)).toBe(true);
    expect(challenge.seed).toBeGreaterThanOrEqual(0);
    expect(challenge.seed).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('rejects a non-contact opponent (403) and a stranger self-challenge', async () => {
    // C is a stranger to A.
    const res = await createChallenge(cookies.A, {
      opponentId: USERS.C.id,
      game: 'golfcourse',
      course: 'St Andrews',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_a_contact' });
  });

  it('rejects a blocked opponent (403), either direction', async () => {
    const now = Date.now();
    // B has blocked A; A still lists B as a contact.
    await testEnv.DB.prepare(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    )
      .bind(USERS.B.id, USERS.A.id, now)
      .run();
    const res = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'St Andrews',
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'blocked' });
  });

  it('rejects a non-golf game (400)', async () => {
    const res = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'fog',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_game' });
  });

  // Regression guard: 'bbderby' is a valid GAME_IDS entry (it has a
  // leaderboard) but must NOT be challengeable while the challenge metric is
  // still golf's to-par — see the note on CHALLENGE_GAME_IDS. Unlike 'fog'
  // above, this id round-trips normalizeGame(), so it is the case that
  // actually exercises the CHALLENGE_GAME_IDS membership check.
  it('rejects a leaderboard-only game id that is not challengeable (400)', async () => {
    const res = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'bbderby',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_game' });
  });

  it('settles the winner by lower to-par once both submit', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Pebble Beach',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    const id = challenge.id;

    // Challenger (A) posts -3; still pending until the opponent submits.
    const first = await submitChallengeResult(cookies.A, id, { toPar: -3 });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as ChallengeBody;
    expect(firstBody.challenge.status).toBe('pending');
    expect(firstBody.challenge.challenger.toPar).toBe(-3);
    expect(firstBody.challenge.opponent.toPar).toBeNull();
    expect(firstBody.challenge.winnerId).toBeNull();

    // A re-submit is ignored — the first submission sticks.
    const resubmit = await submitChallengeResult(cookies.A, id, { toPar: 10 });
    const resubmitBody = (await resubmit.json()) as ChallengeBody;
    expect(resubmitBody.challenge.challenger.toPar).toBe(-3);

    // Opponent (B) posts +1 -> both in, A wins (lower to-par), complete.
    const second = await submitChallengeResult(cookies.B, id, { toPar: 1 });
    const secondBody = (await second.json()) as ChallengeBody;
    expect(secondBody.challenge.status).toBe('complete');
    expect(secondBody.challenge.opponent.toPar).toBe(1);
    expect(secondBody.challenge.winnerId).toBe(USERS.A.id);
    expect(secondBody.challenge.mine).toBe('opponent'); // B's perspective
  });

  it('records a tie (winnerId null) on equal to-par', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    const id = challenge.id;

    await submitChallengeResult(cookies.A, id, { toPar: 2 });
    const done = await submitChallengeResult(cookies.B, id, { toPar: 2 });
    const doneBody = (await done.json()) as ChallengeBody;
    expect(doneBody.challenge.status).toBe('complete');
    expect(doneBody.challenge.winnerId).toBeNull();
  });

  it('clamps an out-of-range to-par (400)', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    for (const toPar of [201, -201, 2.5]) {
      const res = await submitChallengeResult(cookies.A, challenge.id, { toPar });
      expect(res.status).toBe(400);
    }
  });

  it('is participant-only for GET and result (404 for a non-participant)', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    const id = challenge.id;

    // Participants can read it.
    expect((await getChallenge(cookies.A, id)).status).toBe(200);
    expect((await getChallenge(cookies.B, id)).status).toBe(200);

    // C is neither challenger nor opponent -> 404 on both read and result.
    const cGet = await getChallenge(cookies.C, id);
    expect(cGet.status).toBe(404);
    const cResult = await submitChallengeResult(cookies.C, id, { toPar: 0 });
    expect(cResult.status).toBe(404);

    // A missing id is a 404 too.
    expect((await getChallenge(cookies.A, 'nope')).status).toBe(404);
  });

  it('exposes rewardCoins on the shaped challenge', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    expect(challenge.rewardCoins).toBe(CHALLENGE_WIN_COINS);

    // Still present (and constant) once complete, so the UI can pair it with
    // winnerId to show whether the viewer won and what they earned.
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -1 });
    const done = await submitChallengeResult(cookies.B, challenge.id, { toPar: 3 });
    const doneBody = (await done.json()) as ChallengeBody;
    expect(doneBody.challenge.rewardCoins).toBe(CHALLENGE_WIN_COINS);
  });
});

describe('challenge rewards + notifications', () => {
  it('pushes the opponent on create (best-effort)', async () => {
    pushMock.mockClear();
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    expect(created.status).toBe(200);
    const { challenge } = (await created.json()) as ChallengeBody;

    expect(pushMock).toHaveBeenCalledTimes(1);
    const [, userId, payload] = pushMock.mock.calls[0]!;
    expect(userId).toBe(USERS.B.id);
    expect(payload).toMatchObject({ tag: `chal-${challenge.id}`, url: '/games/golf' });
    expect((payload as { body: string }).body).toContain(USERS.A.name);
  });

  it('a failing push on create does not fail the create', async () => {
    pushMock.mockImplementationOnce(async () => {
      throw new Error('push boom');
    });
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    expect(created.status).toBe(200);
    const { challenge } = (await created.json()) as ChallengeBody;
    expect(challenge.status).toBe('pending');
  });

  it('credits the winner coins + XP exactly once and gives the loser XP', async () => {
    const id = await playChallenge(-5, 0); // A wins (lower to-par)

    expect(await walletBalance(USERS.A.id)).toBe(CHALLENGE_WIN_COINS);
    expect(await seasonXp(USERS.A.id)).toBe(CHALLENGE_WIN_XP);
    expect(await ledgerCoinCount(USERS.A.id, 'challenge_win', id)).toBe(1);

    // Loser: consolation XP, no coins.
    expect(await walletBalance(USERS.B.id)).toBe(0);
    expect(await seasonXp(USERS.B.id)).toBe(CHALLENGE_LOSS_XP);

    // rewardCoinsAwarded reflects what each viewer actually got: 30 for the
    // winner, 0 for the loser.
    const aView = (await (await getChallenge(cookies.A, id)).json()) as ChallengeBody;
    const bView = (await (await getChallenge(cookies.B, id)).json()) as ChallengeBody;
    expect(aView.challenge.rewardCoinsAwarded).toBe(CHALLENGE_WIN_COINS);
    expect(aView.challenge.rewardCoins).toBe(CHALLENGE_WIN_COINS); // nominal stake unchanged
    expect(bView.challenge.rewardCoinsAwarded).toBe(0);

    // A redundant re-submit after completion must not re-award (ref-guarded +
    // the transition gate): balance and the single ledger row are unchanged.
    const re = await submitChallengeResult(cookies.B, id, { toPar: 9 });
    expect(re.status).toBe(200);
    expect(await walletBalance(USERS.A.id)).toBe(CHALLENGE_WIN_COINS);
    expect(await ledgerCoinCount(USERS.A.id, 'challenge_win', id)).toBe(1);
  });

  it('pushes both players on completion with the outcome', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -2 });

    // Only the SECOND (completing) submit fans out the outcome pushes.
    pushMock.mockClear();
    await submitChallengeResult(cookies.B, challenge.id, { toPar: 4 });
    expect(pushMock).toHaveBeenCalledTimes(2);

    const byUser = new Map(
      pushMock.mock.calls.map((call) => [call[1] as string, call[2] as { body: string }]),
    );
    expect(byUser.get(USERS.A.id)!.body).toContain(`+${CHALLENGE_WIN_COINS} coins`);
    expect(byUser.get(USERS.B.id)!.body).toContain('lost');
  });

  it('stops minting win coins past the daily cap but still completes + credits XP', async () => {
    await seedChallengeWins(USERS.A.id, MAX_CHALLENGE_WINS_PER_DAY);

    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -5 });
    pushMock.mockClear();
    const done = await submitChallengeResult(cookies.B, challenge.id, { toPar: 2 });
    const doneBody = (await done.json()) as ChallengeBody;

    // The result still settles.
    expect(doneBody.challenge.status).toBe('complete');
    expect(doneBody.challenge.winnerId).toBe(USERS.A.id);

    // No coin row for THIS challenge (capped) but XP still credited.
    expect(await ledgerCoinCount(USERS.A.id, 'challenge_win', challenge.id)).toBe(0);
    expect(await seasonXp(USERS.A.id)).toBe(CHALLENGE_WIN_XP);

    // The winner's push reflects the win WITHOUT the coins line.
    const winnerPush = pushMock.mock.calls.find((call) => call[1] === USERS.A.id)!;
    expect((winnerPush[2] as { body: string }).body).toContain('won');
    expect((winnerPush[2] as { body: string }).body).not.toContain('coins');

    // From the WINNER's view, rewardCoinsAwarded shows the TRUE credited amount
    // (0, capped), even though the nominal stake (rewardCoins) still reads 30.
    const aView = (await (await getChallenge(cookies.A, challenge.id)).json()) as ChallengeBody;
    expect(aView.challenge.rewardCoinsAwarded).toBe(0);
    expect(aView.challenge.rewardCoins).toBe(CHALLENGE_WIN_COINS);
  });

  it('a tie credits both players coins + XP', async () => {
    const id = await playChallenge(2, 2); // equal -> tie

    const done = await getChallenge(cookies.A, id);
    const doneBody = (await done.json()) as ChallengeBody;
    expect(doneBody.challenge.winnerId).toBeNull();
    expect(doneBody.challenge.rewardCoinsAwarded).toBe(CHALLENGE_TIE_COINS);

    expect(await walletBalance(USERS.A.id)).toBe(CHALLENGE_TIE_COINS);
    expect(await walletBalance(USERS.B.id)).toBe(CHALLENGE_TIE_COINS);
    expect(await seasonXp(USERS.A.id)).toBe(CHALLENGE_TIE_XP);
    expect(await seasonXp(USERS.B.id)).toBe(CHALLENGE_TIE_XP);
    expect(await ledgerCoinCount(USERS.A.id, 'challenge_tie', id)).toBe(1);
    expect(await ledgerCoinCount(USERS.B.id, 'challenge_tie', id)).toBe(1);
  });

  it('caps tie coins by the same daily limit, still completing + crediting XP', async () => {
    // Fill A's daily coin allowance with tie rows; a further tie must mint no
    // coins for A while the result still settles and XP still credits. B (under
    // the cap) still gets tie coins.
    await seedChallengeTies(USERS.A.id, MAX_CHALLENGE_WINS_PER_DAY);

    const id = await playChallenge(1, 1); // equal -> tie
    const view = (await (await getChallenge(cookies.A, id)).json()) as ChallengeBody;

    expect(view.challenge.status).toBe('complete');
    expect(view.challenge.winnerId).toBeNull();

    // A: no coin row for THIS challenge (capped), but XP credited.
    expect(await ledgerCoinCount(USERS.A.id, 'challenge_tie', id)).toBe(0);
    expect(await seasonXp(USERS.A.id)).toBe(CHALLENGE_TIE_XP);
    expect(view.challenge.rewardCoinsAwarded).toBe(0);

    // B: under the cap -> tie coins credited as normal.
    expect(await ledgerCoinCount(USERS.B.id, 'challenge_tie', id)).toBe(1);
    expect(await walletBalance(USERS.B.id)).toBe(CHALLENGE_TIE_COINS);
  });

  it('an award throw on completion still fires the outcome pushes', async () => {
    // Award and push are isolated: a failing award must NOT suppress the
    // win/loss notifications (which the completion gate would otherwise deny).
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -2 });

    pushMock.mockClear();
    awardCoinsMock.mockImplementationOnce(async () => {
      throw new Error('economy boom');
    });
    const done = await submitChallengeResult(cookies.B, challenge.id, { toPar: 4 });
    expect(done.status).toBe(200);

    // Both players are still notified despite the award fault.
    expect(pushMock).toHaveBeenCalledTimes(2);
    const notified = pushMock.mock.calls.map((call) => call[1] as string);
    expect(notified).toContain(USERS.A.id);
    expect(notified).toContain(USERS.B.id);

    // The award failed, so no coins landed AND the winner's push does not claim
    // a credit that never happened.
    expect(await walletBalance(USERS.A.id)).toBe(0);
    const winnerPush = pushMock.mock.calls.find((call) => call[1] === USERS.A.id)!;
    expect((winnerPush[2] as { body: string }).body).not.toContain('coins');
  });

  it('an economy throw on completion does not fail the result submit', async () => {
    awardCoinsMock.mockImplementationOnce(async () => {
      throw new Error('economy boom');
    });
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -3 });
    const done = await submitChallengeResult(cookies.B, challenge.id, { toPar: 1 });

    // The result still persists as complete despite the economy fault.
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as ChallengeBody;
    expect(doneBody.challenge.status).toBe('complete');
    expect(doneBody.challenge.winnerId).toBe(USERS.A.id);
  });

  it('a push throw on completion does not fail the result submit', async () => {
    const created = await createChallenge(cookies.A, {
      opponentId: USERS.B.id,
      game: 'golfcourse',
      course: 'Augusta',
    });
    const { challenge } = (await created.json()) as ChallengeBody;
    await submitChallengeResult(cookies.A, challenge.id, { toPar: -1 });
    pushMock.mockImplementationOnce(async () => {
      throw new Error('push boom');
    });
    const done = await submitChallengeResult(cookies.B, challenge.id, { toPar: 5 });
    expect(done.status).toBe(200);
    expect(((await done.json()) as ChallengeBody).challenge.status).toBe('complete');

    // The award still landed even though a push threw.
    expect(await walletBalance(USERS.A.id)).toBe(CHALLENGE_WIN_COINS);
  });
});

// ---- Rapid Tournaments ----------------------------------------------------

function getTournament(cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/tournament', { headers });
}

function postTournamentResult(cookie: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return request('/game/tournament/result', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function getTournamentLeaderboard(cookie: string, scope?: string): Promise<Response> {
  const qs = scope ? `?scope=${scope}` : '';
  return request(`/game/tournament/leaderboard${qs}`, { headers: { Cookie: cookie } });
}

function getTournamentMe(cookie: string): Promise<Response> {
  return request('/game/tournament/me', { headers: { Cookie: cookie } });
}

// Directly seed a closed, unsettled event + its entries so the settlement
// pass (runTournamentCron) has something concrete to rank. `id` is a
// synthetic period index chosen well clear of the live one.
async function seedClosedTournament(id: number): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO tournaments (id, kind, seed, holes, opened_at, closes_at, settled, created_at)
     VALUES (?, 'rapid', ?, ?, ?, ?, 0, ?)`,
  )
    .bind(id, tournamentSeed(id), JSON.stringify(tournamentHoles(id)), now - 2000, now - 1000, now - 2000)
    .run();
}

async function seedEntry(
  tournamentId: number,
  userId: string,
  score: number,
  toPar: number,
  strokes: number,
): Promise<void> {
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO tournament_entries
       (id, tournament_id, user_id, score, to_par, strokes, rounds_played, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  )
    .bind(crypto.randomUUID(), tournamentId, userId, score, toPar, strokes, now, now)
    .run();
}

describe('Tournament derivation', () => {
  const HOLE_COUNTS: Record<string, number> = {
    augusta: 18,
    'listowel-vintage': 9,
    'listowel-heritage': 9,
    'listowel-millennium': 9,
  };

  it('rotation references only holes that exist on their course', () => {
    for (const { course, hole } of TOURNEY_ROTATION) {
      const count = HOLE_COUNTS[course];
      expect(count, `unknown course '${course}' in TOURNEY_ROTATION`).toBeDefined();
      expect(Number.isInteger(hole)).toBe(true);
      expect(hole).toBeGreaterThanOrEqual(1);
      expect(hole, `${course} hole ${hole} exceeds its ${count}-hole count`).toBeLessThanOrEqual(
        count!,
      );
    }
  });

  it('period index + window are deterministic and consecutive', () => {
    const t = Date.UTC(2026, 7, 14, 12, 0, 0);
    const idx = currentPeriodIndex(t);
    expect(currentPeriodIndex(t)).toBe(idx);
    const w = periodWindow(idx);
    expect(w.openedAt).toBeLessThanOrEqual(t);
    expect(w.closesAt).toBeGreaterThan(t);
    expect(w.closesAt - w.openedAt).toBe(TOURNEY_PERIOD_MS);
    // The next period opens exactly where this one closes.
    expect(periodWindow(idx + 1).openedAt).toBe(w.closesAt);
  });

  it('derives a stable seed + 3 valid holes per index', () => {
    const idx = 123;
    expect(tournamentSeed(idx)).toBe(tournamentSeed(idx));
    expect(tournamentSeed(idx)).toBeGreaterThanOrEqual(0);
    expect(tournamentSeed(idx)).toBeLessThanOrEqual(2 ** 31 - 1);
    const holes = tournamentHoles(idx);
    expect(holes).toHaveLength(3);
    for (const h of holes) {
      const count = HOLE_COUNTS[h.course];
      expect(count).toBeDefined();
      expect(h.hole).toBeGreaterThanOrEqual(1);
      expect(h.hole).toBeLessThanOrEqual(count!);
    }
    // Pure function of the index.
    expect(tournamentHoles(idx)).toEqual(holes);
  });

  it('trophyAward follows the tier table', () => {
    expect(trophyAward(1, 100)).toBe(100);
    expect(trophyAward(2, 100)).toBe(60);
    expect(trophyAward(3, 100)).toBe(60);
    expect(trophyAward(4, 100)).toBe(30);
    expect(trophyAward(10, 100)).toBe(30);
    expect(trophyAward(11, 100)).toBe(10);
    expect(trophyAward(50, 100)).toBe(10);
    expect(trophyAward(51, 100)).toBe(5);
  });
});

describe('GET /game/tournament', () => {
  it('requires a session cookie', async () => {
    expect((await getTournament(null)).status).toBe(401);
  });

  it('derives the current event with no entry before playing', async () => {
    const res = await getTournament(cookies.A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: number;
      seed: number;
      holes: { course: string; hole: number }[];
      openedAt: number;
      closesAt: number;
      msLeft: number;
      entrants: number;
      entry: unknown;
    };
    const idx = currentPeriodIndex(Date.now());
    expect(body.id).toBe(idx);
    expect(body.seed).toBe(tournamentSeed(idx));
    expect(body.holes).toEqual(tournamentHoles(idx));
    expect(body.closesAt).toBeGreaterThan(body.openedAt);
    expect(body.msLeft).toBeGreaterThan(0);
    expect(body.entry).toBeNull();
  });

  it('returns the caller entry with a live rank once played', async () => {
    // B posts a worse round, A a better one -> A ranks 1, B ranks 2.
    await postTournamentResult(cookies.B, { toPar: 5, strokes: 20 });
    await postTournamentResult(cookies.A, { toPar: -2, strokes: 13 });

    const aBody = (await (await getTournament(cookies.A)).json()) as {
      entrants: number;
      entry: { score: number; toPar: number; strokes: number; rank: number };
    };
    expect(aBody.entrants).toBe(2);
    expect(aBody.entry.rank).toBe(1);
    expect(aBody.entry.toPar).toBe(-2);

    const bBody = (await (await getTournament(cookies.B)).json()) as {
      entry: { rank: number };
    };
    expect(bBody.entry.rank).toBe(2);
  });

  it('breaks equal score/to_par ties by strokes, consistently with the board', async () => {
    // Equal to_par -> equal derived score; the lower-strokes run must rank
    // ahead everywhere (live rank AND leaderboard order), matching the
    // tiebreak settlement uses so the displayed standing == the awarded one.
    await postTournamentResult(cookies.A, { toPar: -2, strokes: 12 });
    await postTournamentResult(cookies.B, { toPar: -2, strokes: 14 });

    const aRank = (
      (await (await getTournament(cookies.A)).json()) as { entry: { rank: number } }
    ).entry.rank;
    const bRank = (
      (await (await getTournament(cookies.B)).json()) as { entry: { rank: number } }
    ).entry.rank;
    expect(aRank).toBe(1);
    expect(bRank).toBe(2);

    const board = (await (await getTournamentLeaderboard(cookies.A)).json()) as {
      entries: { userId: string }[];
    };
    expect(board.entries[0]!.userId).toBe(USERS.A.id);
    expect(board.entries[1]!.userId).toBe(USERS.B.id);
  });
});

describe('POST /game/tournament/result', () => {
  it('requires a session cookie', async () => {
    expect((await postTournamentResult(null, { toPar: 0, strokes: 12 })).status).toBe(401);
  });

  it('rejects an out-of-clamp toPar or strokes', async () => {
    expect((await postTournamentResult(cookies.A, { toPar: 999, strokes: 12 })).status).toBe(400);
    expect((await postTournamentResult(cookies.A, { toPar: 0, strokes: 0 })).status).toBe(400);
    expect((await postTournamentResult(cookies.A, { toPar: 1.5, strokes: 12 })).status).toBe(400);
  });

  it('keeps the better run and counts rounds_played', async () => {
    // First a strong run, then a weaker one: the entry must stay on the strong
    // run, improved=false on the second, and rounds_played increments.
    const first = await postTournamentResult(cookies.A, { toPar: -4, strokes: 11 });
    const firstBody = (await first.json()) as {
      entry: { score: number; toPar: number; rank: number };
      improved: boolean;
    };
    expect(firstBody.improved).toBe(true);
    expect(firstBody.entry.toPar).toBe(-4);

    const second = await postTournamentResult(cookies.A, { toPar: 6, strokes: 21 });
    const secondBody = (await second.json()) as {
      entry: { toPar: number };
      improved: boolean;
    };
    expect(secondBody.improved).toBe(false);
    // Persisted best is still the -4 run, not the weaker resubmit.
    expect(secondBody.entry.toPar).toBe(-4);

    const idx = currentPeriodIndex(Date.now());
    const row = await testEnv.DB.prepare(
      `SELECT rounds_played, to_par FROM tournament_entries WHERE tournament_id = ? AND user_id = ?`,
    )
      .bind(idx, USERS.A.id)
      .first<{ rounds_played: number; to_par: number }>();
    expect(row?.rounds_played).toBe(2);
    expect(row?.to_par).toBe(-4);
  });

  it('rejects submissions to a closed event with 409', async () => {
    // A first submission materialises the current event's row (control: 200).
    const ok = await postTournamentResult(cookies.A, { toPar: 0, strokes: 12 });
    expect(ok.status).toBe(200);

    // Force the pinned window into the past — the endpoint trusts the row's
    // closes_at once a row exists, so the next submission is rejected.
    const idx = currentPeriodIndex(Date.now());
    await testEnv.DB.prepare(`UPDATE tournaments SET closes_at = ? WHERE id = ?`)
      .bind(Date.now() - 1000, idx)
      .run();
    const closed = await postTournamentResult(cookies.B, { toPar: 0, strokes: 12 });
    expect(closed.status).toBe(409);

    // A settled event is likewise closed.
    await testEnv.DB.prepare(`UPDATE tournaments SET closes_at = ?, settled = 1 WHERE id = ?`)
      .bind(Date.now() + 60_000, idx)
      .run();
    const settled = await postTournamentResult(cookies.B, { toPar: 0, strokes: 12 });
    expect(settled.status).toBe(409);
  });
});

describe('GET /game/tournament/leaderboard', () => {
  it('friends scope hides strangers; global shows them', async () => {
    // A (self) + B (contact of A) + C (stranger) all post.
    await postTournamentResult(cookies.A, { toPar: -1, strokes: 14 });
    await postTournamentResult(cookies.B, { toPar: 2, strokes: 17 });
    await postTournamentResult(cookies.C, { toPar: -3, strokes: 12 });

    const friends = (await (await getTournamentLeaderboard(cookies.A, 'friends')).json()) as {
      entries: { userId: string }[];
    };
    const friendIds = friends.entries.map((e) => e.userId);
    expect(friendIds).toContain(USERS.A.id);
    expect(friendIds).toContain(USERS.B.id);
    expect(friendIds).not.toContain(USERS.C.id);

    const global = (await (await getTournamentLeaderboard(cookies.A)).json()) as {
      entries: { userId: string; toPar: number }[];
    };
    const globalIds = global.entries.map((e) => e.userId);
    expect(globalIds).toContain(USERS.C.id);
    // Ordered score DESC, to_par ASC -> C (-3) first.
    expect(global.entries[0]!.userId).toBe(USERS.C.id);
  });

  it('drops blocked users from the global board', async () => {
    await postTournamentResult(cookies.A, { toPar: 0, strokes: 12 });
    await postTournamentResult(cookies.C, { toPar: -5, strokes: 10 });
    // A blocks C.
    await testEnv.DB.prepare(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    )
      .bind(USERS.A.id, USERS.C.id, Date.now())
      .run();

    const global = (await (await getTournamentLeaderboard(cookies.A)).json()) as {
      entries: { userId: string }[];
    };
    expect(global.entries.map((e) => e.userId)).not.toContain(USERS.C.id);
  });

  it('surfaces each row equipped frame; frame_none and unequipped are null', async () => {
    await postTournamentResult(cookies.A, { toPar: -1, strokes: 14 }); // best — real frame
    await postTournamentResult(cookies.B, { toPar: 2, strokes: 17 }); // frame_none -> null
    await postTournamentResult(cookies.C, { toPar: 5, strokes: 20 }); // no equipped row
    await equipCosmetic(USERS.A.id, 'frame', 'frame_gold');
    await equipCosmetic(USERS.B.id, 'frame', 'frame_none');

    const global = (await (await getTournamentLeaderboard(cookies.A)).json()) as {
      entries: { userId: string; frame: string | null }[];
    };
    const byId = new Map(global.entries.map((e) => [e.userId, e.frame]));
    expect(byId.get(USERS.A.id)).toBe('frame_gold');
    expect(byId.get(USERS.B.id)).toBe(null);
    expect(byId.get(USERS.C.id)).toBe(null);
    // Ordering unchanged: A (-1) ahead of B (2) ahead of C (5).
    expect(global.entries.map((e) => e.userId)).toEqual([
      USERS.A.id,
      USERS.B.id,
      USERS.C.id,
    ]);
  });
});

describe('Tournament settlement (runTournamentCron)', () => {
  it('ranks entries, awards tiered trophies, and bumps tallies', async () => {
    const id = 990001;
    await seedClosedTournament(id);
    // A best, B second, C third.
    await seedEntry(id, USERS.A.id, 1040, -4, 11);
    await seedEntry(id, USERS.B.id, 1000, 0, 15);
    await seedEntry(id, USERS.C.id, 960, 4, 19);

    await runTournamentCron(testEnv);

    // Event marked settled.
    const t = await testEnv.DB.prepare(`SELECT settled FROM tournaments WHERE id = ?`)
      .bind(id)
      .first<{ settled: number }>();
    expect(t?.settled).toBe(1);

    // Placements: ranks 1..3 with tier awards (1st=100, 2nd/3rd=60).
    const places = await testEnv.DB.prepare(
      `SELECT user_id, rank, trophies FROM tournament_placements WHERE tournament_id = ? ORDER BY rank`,
    )
      .bind(id)
      .all<{ user_id: string; rank: number; trophies: number }>();
    expect(places.results).toEqual([
      { user_id: USERS.A.id, rank: 1, trophies: 100 },
      { user_id: USERS.B.id, rank: 2, trophies: 60 },
      { user_id: USERS.C.id, rank: 3, trophies: 60 },
    ]);

    // Winner's tally: gold + podium + best_rank 1.
    const aTally = await testEnv.DB.prepare(
      `SELECT trophies, golds, podiums, best_rank, events_played FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(USERS.A.id)
      .first<{
        trophies: number;
        golds: number;
        podiums: number;
        best_rank: number;
        events_played: number;
      }>();
    expect(aTally).toEqual({
      trophies: 100,
      golds: 1,
      podiums: 1,
      best_rank: 1,
      events_played: 1,
    });

    // Second place: no gold, a podium, best_rank 2.
    const bTally = await testEnv.DB.prepare(
      `SELECT golds, podiums, best_rank FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(USERS.B.id)
      .first<{ golds: number; podiums: number; best_rank: number }>();
    expect(bTally).toEqual({ golds: 0, podiums: 1, best_rank: 2 });
  });

  it('is idempotent: running twice yields identical tallies', async () => {
    const id = 990002;
    await seedClosedTournament(id);
    await seedEntry(id, USERS.A.id, 1030, -3, 12);
    await seedEntry(id, USERS.B.id, 990, 1, 16);

    await runTournamentCron(testEnv);
    const after1 = await testEnv.DB.prepare(
      `SELECT user_id, trophies, golds, podiums, best_rank, events_played
         FROM tournament_trophies ORDER BY user_id`,
    ).all();
    const places1 = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_placements WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();

    // Re-run: settled events are skipped, and the placements UNIQUE guards any
    // partial retry -> no double counting.
    await runTournamentCron(testEnv);
    const after2 = await testEnv.DB.prepare(
      `SELECT user_id, trophies, golds, podiums, best_rank, events_played
         FROM tournament_trophies ORDER BY user_id`,
    ).all();
    const places2 = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_placements WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();

    expect(after2.results).toEqual(after1.results);
    expect(places2?.n).toBe(places1?.n);
  });

  it('does not double-award when a partial settlement is resumed', async () => {
    // Simulate a settlement interrupted after A's placement + trophy bump were
    // written but before `settled` flipped: A already has a placement row and a
    // populated tally, the event is still settled=0. Re-running the cron must
    // NOT re-bump A (the meta.changes===1 guard) while still awarding B.
    const id = 990004;
    await seedClosedTournament(id);
    await seedEntry(id, USERS.A.id, 1040, -4, 11); // rank 1
    await seedEntry(id, USERS.B.id, 1000, 0, 15); // rank 2

    const now = Date.now();
    await testEnv.DB.prepare(
      `INSERT INTO tournament_placements (id, tournament_id, user_id, rank, trophies, created_at)
       VALUES (?, ?, ?, 1, 100, ?)`,
    )
      .bind(crypto.randomUUID(), id, USERS.A.id, now)
      .run();
    await testEnv.DB.prepare(
      `INSERT INTO tournament_trophies
         (user_id, trophies, golds, podiums, best_rank, events_played, created_at, updated_at)
       VALUES (?, 100, 1, 1, 1, 1, ?, ?)`,
    )
      .bind(USERS.A.id, now, now)
      .run();

    await runTournamentCron(testEnv);

    // A unchanged — the existing placement made the INSERT OR IGNORE a no-op,
    // so the trophy bump was skipped (no 200 total).
    const aTally = await testEnv.DB.prepare(
      `SELECT trophies, golds, podiums, best_rank, events_played FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(USERS.A.id)
      .first<{
        trophies: number;
        golds: number;
        podiums: number;
        best_rank: number;
        events_played: number;
      }>();
    expect(aTally).toEqual({
      trophies: 100,
      golds: 1,
      podiums: 1,
      best_rank: 1,
      events_played: 1,
    });

    // B — the finisher whose placement had NOT been written — is awarded now.
    const bTally = await testEnv.DB.prepare(
      `SELECT trophies, podiums, best_rank, events_played FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(USERS.B.id)
      .first<{ trophies: number; podiums: number; best_rank: number; events_played: number }>();
    expect(bTally).toEqual({ trophies: 60, podiums: 1, best_rank: 2, events_played: 1 });

    // Exactly one placement per finisher, and the event is now settled.
    const places = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_placements WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(places?.n).toBe(2);
    const t = await testEnv.DB.prepare(`SELECT settled FROM tournaments WHERE id = ?`)
      .bind(id)
      .first<{ settled: number }>();
    expect(t?.settled).toBe(1);
  });

  it('reflects settled placements in GET /game/tournament/me', async () => {
    const id = 990003;
    await seedClosedTournament(id);
    await seedEntry(id, USERS.A.id, 1020, -2, 13);
    await runTournamentCron(testEnv);

    const body = (await (await getTournamentMe(cookies.A)).json()) as {
      trophies: {
        trophies: number;
        golds: number;
        podiums: number;
        bestRank: number | null;
        eventsPlayed: number;
      };
      placements: { tournamentId: number; rank: number; trophies: number; closesAt: number }[];
    };
    expect(body.trophies.golds).toBe(1);
    expect(body.trophies.bestRank).toBe(1);
    const mine = body.placements.find((p) => p.tournamentId === id);
    expect(mine).toBeDefined();
    expect(mine!.rank).toBe(1);
    expect(mine!.trophies).toBe(100);
  });

  it('GET /game/tournament/me defaults to zeros before any event', async () => {
    const body = (await (await getTournamentMe(cookies.C)).json()) as {
      trophies: { trophies: number; golds: number; eventsPlayed: number };
      placements: unknown[];
    };
    expect(body.trophies).toMatchObject({ trophies: 0, golds: 0, eventsPlayed: 0 });
    expect(body.placements).toEqual([]);
  });
});
