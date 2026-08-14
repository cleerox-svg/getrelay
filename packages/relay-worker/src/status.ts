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
  type GameId,
} from './games';

const DAY_MS = 24 * 3600 * 1000;

// Ceilings for the two newer feed sources. Challenges and records are far
// rarer than mini-game runs, so these are generous — the overall
// FEED_MAX_EVENTS clamp on the merged array is the real backstop.
const FEED_MAX_CHALLENGE_EVENTS = 30;
const FEED_MAX_RECORD_EVENTS = 30;
// Overall clamp on the merged feed (statuses + games + challenges + records).
const FEED_MAX_EVENTS = 120;

// Why a run showed up in the feed. Ordered by how much it's worth
// saying: a first game beats a personal best (or a new best-to-par golf
// round) beats a perfect game beats a streak, and only the top one that
// applies is reported.
export type GameFeedBadge = 'first' | 'best' | 'underpar' | 'perfect' | 'streak';

// Which golf best-shot record a `kind:'record'` event is about.
export type RecordMetric = 'drive' | 'closest' | 'putt';

interface FeedActor {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  mine: boolean;
}

// One side of a head-to-head challenge. toPar is the player's submitted
// to-par for the round (lower is better); null only if a caller reads a
// still-pending challenge, which the feed never surfaces.
interface FeedChallenger {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  toPar: number | null;
}

export type FeedEvent =
  | (FeedActor & { id: string; kind: 'status'; at: number; statusMessage: string })
  | (FeedActor & {
      id: string;
      kind: 'game';
      at: number;
      game: GameId;
      score: number;
      rounds: number;
      bestStreak: number;
      // Round's total strokes relative to par for golf rounds; null for the
      // arcade games (and range play) that don't record a to-par.
      toPar: number | null;
      badge: GameFeedBadge;
    })
  | {
      id: string;
      kind: 'challenge';
      at: number;
      // true when I'm one of the two participants.
      mine: boolean;
      challengeId: string;
      game: GameId;
      course: string | null;
      hole: number | null;
      challenger: FeedChallenger;
      opponent: FeedChallenger;
      // null = tie; otherwise the winning participant's userId.
      winnerId: string | null;
    }
  | (FeedActor & {
      id: string;
      kind: 'record';
      at: number;
      metric: RecordMetric;
      valueYards: number;
      hole: number | null;
    });

export function statusRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /feed — the Updates surface: my contacts' current statuses plus
  // their notable game runs (Fog, Tune, and the golf modes), completed
  // head-to-head golf challenges, and freshly-set golf records — merged
  // newest-first.
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

    const [games, challenges, records] = await Promise.all([
      listGameEvents(c.env, me.id, origin),
      listChallengeEvents(c.env, me.id, origin),
      listRecordEvents(c.env, me.id, origin),
    ]);

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
      ...challenges,
      ...records,
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, FEED_MAX_EVENTS);

    return c.json({ statuses, events });
  });

  return app;
}

// The visibility rule shared by every game/challenge/record query: me plus
// my contacts, minus anyone I've blocked, and only players who haven't
// opted out of the game feed. Meant to be dropped in as the leading CTE of
// a query and bound with (meId, meId, meId).
const VISIBLE_CTE = `visible AS (
       SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key
       FROM users u
       WHERE (u.id = ?
              OR u.id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
         AND COALESCE(u.game_feed_shared, 1) = 1
     )`;

// Notable game runs from me + my contacts inside the feed window, across
// every game that shares game_scores (fog, tune, golf, golfrange,
// golfcourse). Personal-best/first windows are partitioned per (user, game)
// so each game has its own history.
//
// The whole thing is one query because "was this a personal best?" needs
// every earlier run by that player in that game, not just the ones inside
// the window — so `ranked` deliberately scans full history and the window
// filter is applied afterwards, in `notable`.
//
// Badge rules by game:
//   first    (game_no = 1)                     — all games
//   best     (score beats the prior best)      — all games (golfcourse
//            derives score from to-par, so best-score == best-to-par there)
//   underpar (under par, or a new best-to-par) — golf rounds with a to_par
//   perfect  (all rounds, streak == rounds)    — arcade (fog/tune) only
//   streak   (best_streak >= threshold)        — arcade (fog/tune) only
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
    `WITH ${VISIBLE_CTE},
     ranked AS (
       SELECT s.id, s.user_id, s.game, s.score, s.rounds, s.best_streak,
              s.to_par, s.created_at,
              MAX(s.score) OVER (
                PARTITION BY s.user_id, s.game ORDER BY s.created_at, s.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ) AS prev_best,
              MIN(s.to_par) OVER (
                PARTITION BY s.user_id, s.game ORDER BY s.created_at, s.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ) AS prev_best_topar,
              ROW_NUMBER() OVER (
                PARTITION BY s.user_id, s.game ORDER BY s.created_at, s.id
              ) AS game_no
       FROM game_scores s
       WHERE s.user_id IN (SELECT id FROM visible)
     ),
     notable AS (
       SELECT r.*,
              CASE
                WHEN r.game_no = 1 THEN 'first'
                WHEN r.prev_best IS NULL OR r.score > r.prev_best THEN 'best'
                WHEN r.to_par IS NOT NULL
                     AND (r.to_par < 0 OR r.to_par < r.prev_best_topar) THEN 'underpar'
                WHEN r.game IN ('fog', 'tune')
                     AND r.rounds = ? AND r.best_streak = r.rounds THEN 'perfect'
                ELSE 'streak'
              END AS badge
       FROM ranked r
       WHERE r.created_at >= ?
         AND (r.game_no = 1
              OR r.prev_best IS NULL
              OR r.score > r.prev_best
              OR (r.to_par IS NOT NULL
                  AND (r.to_par < 0 OR r.to_par < r.prev_best_topar))
              OR (r.game IN ('fog', 'tune') AND r.rounds = ? AND r.best_streak = r.rounds)
              OR (r.game IN ('fog', 'tune') AND r.best_streak >= ?))
     ),
     capped AS (
       SELECT n.*,
              ROW_NUMBER() OVER (
                PARTITION BY n.user_id, CAST(n.created_at / ${DAY_MS} AS INTEGER)
                ORDER BY n.created_at DESC, n.id DESC
              ) AS per_day
       FROM notable n
     )
     SELECT c.id, c.user_id, c.game, c.score, c.rounds, c.best_streak,
            c.to_par, c.created_at, c.badge,
            v.display_name, v.pin, v.avatar_url, v.avatar_r2_key
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
      game: string;
      score: number;
      rounds: number;
      best_streak: number;
      to_par: number | null;
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
    game: r.game as GameId,
    score: r.score,
    rounds: r.rounds,
    bestStreak: r.best_streak,
    toPar: r.to_par ?? null,
    badge: r.badge,
  }));
}

// Completed head-to-head golf challenges where BOTH participants are visible
// to me, newest (most recently completed) first.
//
// Privacy: a challenge's creation-time check only validates the
// challenger<->opponent relationship, never the viewer's, so the feed must
// re-scope at read time. Requiring both the challenger and the opponent to be
// in `visible` enforces contacts-only, block exclusion, AND the per-user
// game_feed_shared opt-out for BOTH sides — otherwise a stranger's identity
// and score would leak through the side that happens to be my contact.
//
// One `IN` (challenger) still hits its index (idx_game_challenges_challenger /
// _opponent on (participant_id, status)); the other is a post-filter. No UNION
// is needed, so there is nothing to dedup.
async function listChallengeEvents(
  env: Env,
  meId: string,
  origin: string,
): Promise<FeedEvent[]> {
  const since = Date.now() - FEED_WINDOW_DAYS * DAY_MS;

  const rows = await env.DB.prepare(
    `WITH ${VISIBLE_CTE},
     completed AS (
       SELECT c.id, c.game, c.course, c.hole, c.winner_id, c.updated_at,
              c.challenger_id, c.opponent_id, c.challenger_score, c.opponent_score
       FROM game_challenges c
       WHERE c.status = 'complete'
         AND c.challenger_id IN (SELECT id FROM visible)
         AND c.opponent_id   IN (SELECT id FROM visible)
     )
     SELECT co.id, co.game, co.course, co.hole, co.winner_id, co.updated_at,
            co.challenger_id, co.opponent_id, co.challenger_score, co.opponent_score,
            cu.display_name  AS challenger_name,
            cu.avatar_url    AS challenger_avatar_url,
            cu.avatar_r2_key AS challenger_avatar_r2_key,
            ou.display_name  AS opponent_name,
            ou.avatar_url    AS opponent_avatar_url,
            ou.avatar_r2_key AS opponent_avatar_r2_key
     FROM completed co
     JOIN users cu ON cu.id = co.challenger_id
     JOIN users ou ON ou.id = co.opponent_id
     WHERE co.updated_at >= ?
     ORDER BY co.updated_at DESC
     LIMIT ?`,
  )
    .bind(meId, meId, meId, since, FEED_MAX_CHALLENGE_EVENTS)
    .all<{
      id: string;
      game: string;
      course: string | null;
      hole: number | null;
      winner_id: string | null;
      updated_at: number;
      challenger_id: string;
      opponent_id: string;
      challenger_score: number | null;
      opponent_score: number | null;
      challenger_name: string;
      challenger_avatar_url: string | null;
      challenger_avatar_r2_key: string | null;
      opponent_name: string;
      opponent_avatar_url: string | null;
      opponent_avatar_r2_key: string | null;
    }>();

  return (rows.results ?? []).map((r) => ({
    id: `challenge:${r.id}`,
    kind: 'challenge' as const,
    at: r.updated_at,
    mine: r.challenger_id === meId || r.opponent_id === meId,
    challengeId: r.id,
    game: r.game as GameId,
    course: r.course ?? null,
    hole: r.hole ?? null,
    challenger: {
      userId: r.challenger_id,
      displayName: r.challenger_name,
      avatarUrl: avatarUrlFor(origin, {
        avatar_r2_key: r.challenger_avatar_r2_key,
        avatar_url: r.challenger_avatar_url,
      }),
      toPar: r.challenger_score ?? null,
    },
    opponent: {
      userId: r.opponent_id,
      displayName: r.opponent_name,
      avatarUrl: avatarUrlFor(origin, {
        avatar_r2_key: r.opponent_avatar_r2_key,
        avatar_url: r.opponent_avatar_url,
      }),
      toPar: r.opponent_score ?? null,
    },
    winnerId: r.winner_id ?? null,
  }));
}

// Golf best-shot records (longest drive / closest to pin / longest putt) set
// or improved inside the feed window, from me + my contacts. golf_records
// holds one row per user with only the current value per metric, so each
// notable metric (its *_at is within the window) becomes one event.
async function listRecordEvents(
  env: Env,
  meId: string,
  origin: string,
): Promise<FeedEvent[]> {
  const since = Date.now() - FEED_WINDOW_DAYS * DAY_MS;

  const rows = await env.DB.prepare(
    `WITH ${VISIBLE_CTE}
     SELECT g.user_id,
            g.longest_drive_yards, g.longest_drive_hole, g.longest_drive_at,
            g.closest_to_pin_yards, g.closest_to_pin_hole, g.closest_to_pin_at,
            g.longest_putt_yards, g.longest_putt_hole, g.longest_putt_at,
            v.display_name, v.pin, v.avatar_url, v.avatar_r2_key
     FROM golf_records g JOIN visible v ON v.id = g.user_id
     WHERE g.longest_drive_at  >= ?
        OR g.closest_to_pin_at >= ?
        OR g.longest_putt_at   >= ?
     LIMIT ?`,
  )
    .bind(meId, meId, meId, since, since, since, FEED_MAX_RECORD_EVENTS)
    .all<{
      user_id: string;
      longest_drive_yards: number | null;
      longest_drive_hole: number | null;
      longest_drive_at: number | null;
      closest_to_pin_yards: number | null;
      closest_to_pin_hole: number | null;
      closest_to_pin_at: number | null;
      longest_putt_yards: number | null;
      longest_putt_hole: number | null;
      longest_putt_at: number | null;
      display_name: string;
      pin: string;
      avatar_url: string | null;
      avatar_r2_key: string | null;
    }>();

  const events: FeedEvent[] = [];
  for (const r of rows.results ?? []) {
    const actor = {
      userId: r.user_id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      mine: r.user_id === meId,
    };
    const metrics: {
      metric: RecordMetric;
      yards: number | null;
      hole: number | null;
      at: number | null;
    }[] = [
      {
        metric: 'drive',
        yards: r.longest_drive_yards,
        hole: r.longest_drive_hole,
        at: r.longest_drive_at,
      },
      {
        metric: 'closest',
        yards: r.closest_to_pin_yards,
        hole: r.closest_to_pin_hole,
        at: r.closest_to_pin_at,
      },
      {
        metric: 'putt',
        yards: r.longest_putt_yards,
        hole: r.longest_putt_hole,
        at: r.longest_putt_at,
      },
    ];
    for (const m of metrics) {
      if (m.yards == null || m.at == null || m.at < since) continue;
      events.push({
        id: `record:${r.user_id}:${m.metric}`,
        kind: 'record',
        ...actor,
        at: m.at,
        metric: m.metric,
        valueYards: m.yards,
        hole: m.hole ?? null,
      });
    }
  }
  return events;
}
