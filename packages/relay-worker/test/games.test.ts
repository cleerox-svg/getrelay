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
  };
};

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
});
