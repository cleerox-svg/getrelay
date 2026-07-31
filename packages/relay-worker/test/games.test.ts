// Fog mini game API tests — POST /game/score + GET /game/leaderboard.
// First test file in the repo; runs inside workerd via
// @cloudflare/vitest-pool-workers. Isolated storage means writes made
// inside a test are rolled back afterwards, while the beforeAll seed
// (tables + users + sessions + the A→B contact) persists for the file.
import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';
import { signJwt } from '../src/lib/jwt';
import { MAX_POINTS_PER_ROUND, MAX_ROUNDS } from '../src/games';

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
     created_at INTEGER NOT NULL
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
  await testEnv.DB.prepare(
    `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, created_at)
     VALUES (?, ?, 'fog', ?, 5, 2, ?)`,
  )
    .bind(crypto.randomUUID(), userId, score, createdAt)
    .run();
}

beforeAll(seed);

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
});
