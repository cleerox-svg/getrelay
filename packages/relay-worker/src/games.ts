import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';

// Server-side clamps for the Fog mini game. Anti-cheat is intentionally
// lightweight — it's a casual game, we just refuse values that couldn't
// possibly come from a real run (the client scores at most
// MAX_POINTS_PER_ROUND per round over at most MAX_ROUNDS rounds).
export const MAX_ROUNDS = 8;
export const MAX_POINTS_PER_ROUND = 2000;

// Games that share the game_scores table (and its leaderboard). The
// column defaults to 'fog', so an omitted/unknown value maps back to fog
// and every existing client keeps working.
export const GAME_IDS = ['fog', 'tune', 'golf', 'golfrange'] as const;
export type GameId = (typeof GAME_IDS)[number];

function normalizeGame(v: unknown): GameId {
  return typeof v === 'string' && (GAME_IDS as readonly string[]).includes(v)
    ? (v as GameId)
    : 'fog';
}

// ---- Feed surfacing rules -------------------------------------------------
//
// Only *notable* runs reach the Updates feed. Fog games are short, so
// posting every finished run would bury contact statuses under one
// person's session. A run shows up when it's their first ever, a new
// personal best, a perfect game, or a long streak — see statusRoutes().

// A run counts as a streak event at this many correct guesses in a row.
export const FEED_STREAK_THRESHOLD = 6;
// How far back the feed looks for game events.
export const FEED_WINDOW_DAYS = 7;
// Per-player daily cap, newest kept, so one big session can't flood the
// feed even when every run of it is technically notable.
export const FEED_MAX_EVENTS_PER_USER_PER_DAY = 3;
// Overall ceiling on game events in one /feed response.
export const FEED_MAX_GAME_EVENTS = 60;

export function gamesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // POST /game/score — record one completed Fog run. Body:
  // { score, rounds, bestStreak }. Everything must be an integer inside
  // the clamps above; anything else is a 400. Returns the caller's
  // all-time best so the client can show "new personal best!".
  app.post('/game/score', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<{ score?: unknown; rounds?: unknown; bestStreak?: unknown; game?: unknown }>()
      .catch(() => null);
    const score = body?.score;
    const rounds = body?.rounds;
    const bestStreak = body?.bestStreak;
    const game = normalizeGame(body?.game);

    // Clamps: rounds 1..MAX_ROUNDS, score 0..rounds*MAX_POINTS_PER_ROUND,
    // bestStreak 0..rounds (you can't streak more rounds than you played).
    const valid =
      Number.isInteger(score) &&
      Number.isInteger(rounds) &&
      Number.isInteger(bestStreak) &&
      (rounds as number) >= 1 &&
      (rounds as number) <= MAX_ROUNDS &&
      (score as number) >= 0 &&
      (score as number) <= (rounds as number) * MAX_POINTS_PER_ROUND &&
      (bestStreak as number) >= 0 &&
      (bestStreak as number) <= (rounds as number);
    if (!valid) return c.json({ error: 'invalid_score' }, 400);

    await c.env.DB.prepare(
      `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), me.id, game, score, rounds, bestStreak, Date.now())
      .run();

    const row = await c.env.DB.prepare(
      `SELECT MAX(score) AS best FROM game_scores WHERE user_id = ? AND game = ?`,
    )
      .bind(me.id, game)
      .first<{ best: number | null }>();

    return c.json({ ok: true, best: row?.best ?? score });
  });

  // GET /game/leaderboard?period=weekly|all — best score per player.
  // Privacy scoping mirrors the status /feed: you only ever see yourself
  // plus your own contacts, and anyone you've blocked is dropped even if
  // they're still in your contact list. There is no global leaderboard.
  app.get('/game/leaderboard', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    // Anything other than the exact string 'all' means weekly.
    const period = c.req.query('period') === 'all' ? 'all' : 'weekly';
    const since = period === 'all' ? 0 : Date.now() - 7 * 24 * 3600 * 1000;
    const game = normalizeGame(c.req.query('game'));

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key,
              MAX(s.score) AS best, COUNT(*) AS games, MAX(s.created_at) AS last_played
       FROM game_scores s JOIN users u ON u.id = s.user_id
       WHERE s.game = ?
         AND (s.user_id = ? OR s.user_id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND s.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
         AND s.created_at >= ?
       GROUP BY s.user_id
       ORDER BY best DESC, last_played ASC
       LIMIT 25`,
    )
      .bind(game, me.id, me.id, me.id, since)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        best: number;
        games: number;
        last_played: number;
      }>();

    const origin = new URL(c.req.url).origin;
    const entries = (rows.results ?? []).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      best: r.best,
      games: r.games,
      mine: r.id === me.id,
    }));
    return c.json({ entries });
  });

  return app;
}
