// GET /feed tests — the merged Updates surface (contact statuses + notable
// Fog runs). Runs inside workerd via @cloudflare/vitest-pool-workers, same
// setup as games.test.ts: isolated storage rolls back per-test writes while
// the beforeAll seed persists for the file.
import { beforeAll, describe, expect, it } from 'vitest';
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';
import { signJwt } from '../src/lib/jwt';
import {
  FEED_MAX_EVENTS_PER_USER_PER_DAY,
  FEED_STREAK_THRESHOLD,
  FEED_WINDOW_DAYS,
  MAX_ROUNDS,
} from '../src/games';

const testEnv = env as unknown as Env;

const DAY = 24 * 3600 * 1000;

// Column shapes copied from src/schema.sql (the pool doesn't auto-apply
// the schema). users carries the two columns this feature adds.
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
     is_admin INTEGER NOT NULL DEFAULT 0,
     sports_notifications INTEGER NOT NULL DEFAULT 1,
     sports_notify_start INTEGER NOT NULL DEFAULT 1,
     sports_notify_score INTEGER NOT NULL DEFAULT 1,
     sports_notify_final INTEGER NOT NULL DEFAULT 1,
     game_feed_shared INTEGER NOT NULL DEFAULT 1,
     status_updated_at INTEGER
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
  for (const [key, u] of Object.entries(USERS) as [
    keyof typeof USERS,
    (typeof USERS)[keyof typeof USERS],
  ][]) {
    await testEnv.DB.prepare(
      `INSERT INTO users (id, google_sub, email, pin, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(u.id, `sub-${u.id}`, `${u.id}@example.com`, u.pin, u.name, now)
      .run();
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
  const res = await worker.fetch(new Request(`https://example.com${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface FeedEventJson {
  id: string;
  kind: 'status' | 'game';
  userId: string;
  at: number;
  mine: boolean;
  statusMessage?: string;
  score?: number;
  rounds?: number;
  bestStreak?: number;
  badge?: string;
}

async function getFeed(cookie: string): Promise<FeedEventJson[]> {
  const res = await request('/feed', { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { events: FeedEventJson[] };
  return body.events;
}

// rounds/bestStreak default to an unremarkable run so a test only opts
// into the badge it's actually exercising.
async function insertScore(
  userId: string,
  score: number,
  createdAt: number,
  opts: { rounds?: number; bestStreak?: number } = {},
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, created_at)
     VALUES (?, ?, 'fog', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      userId,
      score,
      opts.rounds ?? 5,
      opts.bestStreak ?? 2,
      createdAt,
    )
    .run();
}

async function setStatus(userId: string, text: string, at: number): Promise<void> {
  await testEnv.DB.prepare(
    `UPDATE users SET status_message = ?, status_updated_at = ? WHERE id = ?`,
  )
    .bind(text, at, userId)
    .run();
}

beforeAll(seed);

describe('GET /feed', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await request('/feed');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('still returns the legacy statuses array for older clients', async () => {
    await setStatus(USERS.A.id, 'on my way', Date.now());
    const res = await request('/feed', { headers: { Cookie: cookies.A } });
    const body = (await res.json()) as {
      statuses: { userId: string; statusMessage: string }[];
    };
    expect(body.statuses).toEqual([
      expect.objectContaining({ userId: USERS.A.id, statusMessage: 'on my way' }),
    ]);
  });

  it('merges statuses and game events newest-first', async () => {
    const now = Date.now();
    await setStatus(USERS.A.id, 'older status', now - 3 * 3600 * 1000);
    await setStatus(USERS.B.id, 'newest status', now - 60 * 1000);
    await insertScore(USERS.B.id, 900, now - 2 * 3600 * 1000); // first game

    const events = await getFeed(cookies.A);
    expect(events.map((e) => e.kind)).toEqual(['status', 'game', 'status']);
    expect(events.map((e) => e.userId)).toEqual([USERS.B.id, USERS.B.id, USERS.A.id]);
    expect(events[2]?.mine).toBe(true);
  });

  it('labels a first game, a personal best, a perfect game, and a streak', async () => {
    // A day apart each, so the per-day cap (exercised separately below)
    // can't trim the oldest of the four out of this assertion.
    const now = Date.now();
    await insertScore(USERS.B.id, 500, now - 4 * DAY); // first ever
    await insertScore(USERS.B.id, 900, now - 3 * DAY); // beats 500
    await insertScore(USERS.B.id, 600, now - 2 * DAY, {
      rounds: MAX_ROUNDS,
      bestStreak: MAX_ROUNDS,
    }); // perfect but not a best
    await insertScore(USERS.B.id, 400, now - 1 * DAY, {
      rounds: MAX_ROUNDS,
      bestStreak: FEED_STREAK_THRESHOLD,
    }); // streak only

    const badges = (await getFeed(cookies.A))
      .filter((e) => e.kind === 'game')
      .map((e) => e.badge);
    // Newest first.
    expect(badges).toEqual(['streak', 'perfect', 'best', 'first']);
  });

  it('omits unremarkable runs', async () => {
    const now = Date.now();
    await insertScore(USERS.B.id, 900, now - 5000); // first ever, surfaces
    await insertScore(USERS.B.id, 100, now - 4000); // worse, short streak
    await insertScore(USERS.B.id, 200, now - 3000);

    const games = (await getFeed(cookies.A)).filter((e) => e.kind === 'game');
    expect(games).toHaveLength(1);
    expect(games[0]?.badge).toBe('first');
  });

  it('measures a personal best against runs older than the feed window', async () => {
    const now = Date.now();
    // A big score outside the window still counts as the bar to beat, so
    // the recent lower score is not a "best" and never reaches the feed.
    await insertScore(USERS.B.id, 5000, now - (FEED_WINDOW_DAYS + 3) * DAY);
    await insertScore(USERS.B.id, 400, now - 1000);

    const games = (await getFeed(cookies.A)).filter((e) => e.kind === 'game');
    expect(games).toEqual([]);
  });

  it('caps how many runs one player can post in a day', async () => {
    const now = Date.now();
    // Every one of these is a personal best, so only the cap limits them.
    const total = FEED_MAX_EVENTS_PER_USER_PER_DAY + 3;
    for (let i = 0; i < total; i++) {
      await insertScore(USERS.B.id, 100 * (i + 1), now - (total - i) * 1000);
    }

    const games = (await getFeed(cookies.A)).filter((e) => e.kind === 'game');
    expect(games).toHaveLength(FEED_MAX_EVENTS_PER_USER_PER_DAY);
    // Newest kept: the highest scores are the most recent inserts.
    expect(games[0]?.score).toBe(100 * total);
  });

  it('hides strangers and blocked contacts', async () => {
    const now = Date.now();
    await setStatus(USERS.C.id, 'stranger status', now);
    await insertScore(USERS.C.id, 9000, now);
    await insertScore(USERS.B.id, 1500, now);
    await testEnv.DB.prepare(
      `INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)`,
    )
      .bind(USERS.A.id, USERS.B.id, now)
      .run();

    const events = await getFeed(cookies.A);
    expect(events.map((e) => e.userId)).not.toContain(USERS.C.id);
    expect(events.map((e) => e.userId)).not.toContain(USERS.B.id);
  });

  it('drops game events for a user who opted out, but keeps their status', async () => {
    const now = Date.now();
    await setStatus(USERS.B.id, 'still visible', now);
    await insertScore(USERS.B.id, 1500, now);
    await testEnv.DB.prepare(`UPDATE users SET game_feed_shared = 0 WHERE id = ?`)
      .bind(USERS.B.id)
      .run();

    const events = await getFeed(cookies.A);
    expect(events.filter((e) => e.kind === 'game')).toEqual([]);
    expect(events.filter((e) => e.kind === 'status').map((e) => e.userId)).toContain(
      USERS.B.id,
    );
  });

  it('hides my own runs from me once I opt out', async () => {
    const now = Date.now();
    await insertScore(USERS.A.id, 1500, now);
    expect((await getFeed(cookies.A)).filter((e) => e.kind === 'game')).toHaveLength(1);

    await testEnv.DB.prepare(`UPDATE users SET game_feed_shared = 0 WHERE id = ?`)
      .bind(USERS.A.id)
      .run();
    expect((await getFeed(cookies.A)).filter((e) => e.kind === 'game')).toEqual([]);
  });

  it('excludes game events older than the feed window', async () => {
    await insertScore(USERS.B.id, 1500, Date.now() - (FEED_WINDOW_DAYS + 1) * DAY);
    const games = (await getFeed(cookies.A)).filter((e) => e.kind === 'game');
    expect(games).toEqual([]);
  });
});

describe('PATCH /me gameFeedShared', () => {
  it('round-trips through GET /me', async () => {
    const res = await request('/me', {
      method: 'PATCH',
      headers: { Cookie: cookies.A, 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameFeedShared: false }),
    });
    expect(res.status).toBe(200);

    const meRes = await request('/me', { headers: { Cookie: cookies.A } });
    const me = (await meRes.json()) as { gameFeedShared: boolean };
    expect(me.gameFeedShared).toBe(false);
  });

  it('only re-stamps status_updated_at when the text actually changes', async () => {
    const patch = (body: unknown) =>
      request('/me', {
        method: 'PATCH',
        headers: { Cookie: cookies.A, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const stamp = async (): Promise<number | null> => {
      const row = await testEnv.DB.prepare(
        `SELECT status_updated_at AS t FROM users WHERE id = ?`,
      )
        .bind(USERS.A.id)
        .first<{ t: number | null }>();
      return row?.t ?? null;
    };

    await patch({ statusMessage: 'first' });
    const t1 = await stamp();
    expect(t1).toBeGreaterThan(0);

    // Re-saving the same status (what Profile's Save button does when you
    // only edited your display name) must not re-float it in the feed.
    await patch({ displayName: 'Alice II', statusMessage: 'first' });
    expect(await stamp()).toBe(t1);

    await patch({ statusMessage: 'second' });
    expect(await stamp()).not.toBe(t1);
  });
});
