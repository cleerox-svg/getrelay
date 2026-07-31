import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';
import {
  FEED_MAX_EVENTS_PER_USER_PER_DAY,
  FEED_MAX_GAME_EVENTS,
  FEED_STREAK_THRESHOLD,
  FEED_WINDOW_DAYS,
  MAX_ROUNDS,
} from './games';

const DAY_MS = 24 * 3600 * 1000;

// Why a run showed up in the feed. Ordered by how much it's worth
// saying: a first game beats a personal best beats a perfect game
// beats a streak, and only the top one that applies is reported.
export type GameFeedBadge = 'first' | 'best' | 'perfect' | 'streak';

interface FeedActor {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  mine: boolean;
}

export type FeedEvent =
  | (FeedActor & { id: string; kind: 'status'; at: number; statusMessage: string })
  | (FeedActor & {
      id: string;
      kind: 'game';
      at: number;
      game: 'fog';
      score: number;
      rounds: number;
      bestStreak: number;
      badge: GameFeedBadge;
    });

export function statusRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /feed — the Updates surface: my contacts' current statuses plus
  // their notable Fog runs, merged newest-first.
  //
  // Response carries both `statuses` (the original shape, unchanged) and
  // `events` (the merged feed). Worker and UI deploy independently, so a
  // UI that predates this change keeps reading `statuses` and a UI that
  // postdates it falls back to `statuses` when `events` is absent.
  //
  // Privacy scoping is the same rule used by /game/leaderboard: me plus
  // my contacts, minus anyone I've blocked. There is no global feed.
  app.get('/feed', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const origin = new URL(c.req.url).origin;

    const statusRows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.status_message,
              u.avatar_url, u.avatar_r2_key,
              COALESCE(u.status_updated_at, u.last_seen_at, 0) AS updated_at
       FROM users u
       WHERE (u.id = ?
              OR u.id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND u.status_message IS NOT NULL
         AND TRIM(u.status_message) != ''
         AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
       ORDER BY (u.id = ?) DESC,
                updated_at DESC,
                u.display_name ASC`,
    )
      .bind(me.id, me.id, me.id, me.id)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        status_message: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        updated_at: number;
      }>();

    const statuses = (statusRows.results ?? []).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      statusMessage: r.status_message,
      updatedAt: r.updated_at,
      mine: r.id === me.id,
    }));

    const games = await listGameEvents(c.env, me.id, origin);

    const events: FeedEvent[] = [
      ...statuses.map(
        (s): FeedEvent => ({
          // Stable per user: a status is a single current value, not a
          // log, so it occupies exactly one feed row.
          id: `status:${s.userId}`,
          kind: 'status',
          userId: s.userId,
          displayName: s.displayName,
          pin: s.pin,
          avatarUrl: s.avatarUrl,
          mine: s.mine,
          at: s.updatedAt,
          statusMessage: s.statusMessage,
        }),
      ),
      ...games,
    ].sort((a, b) => b.at - a.at);

    return c.json({ statuses, events });
  });

  return app;
}

// Notable Fog runs from me + my contacts inside the feed window.
//
// The whole thing is one query because "was this a personal best?" needs
// every earlier run by that player, not just the ones inside the window
// — so `ranked` deliberately scans the player's full history and the
// window filter is applied afterwards, in `notable`.
//
// DAY_MS is interpolated rather than bound: D1 hands JS numbers to SQLite
// as REAL, which turns the day-bucket division into float division, so
// every row lands in its own bucket and the per-day cap silently stops
// capping. It's a module constant, so there's nothing to inject.
async function listGameEvents(
  env: Env,
  meId: string,
  origin: string,
): Promise<FeedEvent[]> {
  const since = Date.now() - FEED_WINDOW_DAYS * DAY_MS;

  const rows = await env.DB.prepare(
    `WITH visible AS (
       SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key
       FROM users u
       WHERE (u.id = ?
              OR u.id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
         AND COALESCE(u.game_feed_shared, 1) = 1
     ),
     ranked AS (
       SELECT s.id, s.user_id, s.score, s.rounds, s.best_streak, s.created_at,
              MAX(s.score) OVER (
                PARTITION BY s.user_id ORDER BY s.created_at, s.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ) AS prev_best,
              ROW_NUMBER() OVER (
                PARTITION BY s.user_id ORDER BY s.created_at, s.id
              ) AS game_no
       FROM game_scores s
       WHERE s.game = 'fog' AND s.user_id IN (SELECT id FROM visible)
     ),
     notable AS (
       SELECT r.*,
              CASE
                WHEN r.game_no = 1 THEN 'first'
                WHEN r.prev_best IS NULL OR r.score > r.prev_best THEN 'best'
                WHEN r.rounds = ? AND r.best_streak = r.rounds THEN 'perfect'
                ELSE 'streak'
              END AS badge
       FROM ranked r
       WHERE r.created_at >= ?
         AND (r.game_no = 1
              OR r.prev_best IS NULL
              OR r.score > r.prev_best
              OR (r.rounds = ? AND r.best_streak = r.rounds)
              OR r.best_streak >= ?)
     ),
     capped AS (
       SELECT n.*,
              ROW_NUMBER() OVER (
                PARTITION BY n.user_id, CAST(n.created_at / ${DAY_MS} AS INTEGER)
                ORDER BY n.created_at DESC, n.id DESC
              ) AS per_day
       FROM notable n
     )
     SELECT c.id, c.user_id, c.score, c.rounds, c.best_streak, c.created_at,
            c.badge, v.display_name, v.pin, v.avatar_url, v.avatar_r2_key
     FROM capped c JOIN visible v ON v.id = c.user_id
     WHERE c.per_day <= ?
     ORDER BY c.created_at DESC
     LIMIT ?`,
  )
    .bind(
      meId,
      meId,
      meId,
      MAX_ROUNDS,
      since,
      MAX_ROUNDS,
      FEED_STREAK_THRESHOLD,
      FEED_MAX_EVENTS_PER_USER_PER_DAY,
      FEED_MAX_GAME_EVENTS,
    )
    .all<{
      id: string;
      user_id: string;
      score: number;
      rounds: number;
      best_streak: number;
      created_at: number;
      badge: GameFeedBadge;
      display_name: string;
      pin: string;
      avatar_url: string | null;
      avatar_r2_key: string | null;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: `game:${r.id}`,
    kind: 'game' as const,
    userId: r.user_id,
    displayName: r.display_name,
    pin: r.pin,
    avatarUrl: avatarUrlFor(origin, r),
    mine: r.user_id === meId,
    at: r.created_at,
    game: 'fog' as const,
    score: r.score,
    rounds: r.rounds,
    bestStreak: r.best_streak,
    badge: r.badge,
  }));
}
