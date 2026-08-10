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
export const GAME_IDS = ['fog', 'tune', 'golf', 'golfrange', 'golfcourse'] as const;
export type GameId = (typeof GAME_IDS)[number];

// The full 3D Course mode plays up to 18 holes, so its runs need a higher
// rounds ceiling than the arcade mini games (MAX_ROUNDS = 8).
export const MAX_COURSE_ROUNDS = 18;

// Sanity clamps for golf best-shot records (see /game/golf-records). Like
// the Fog score clamps above, these only reject values that couldn't come
// from a real shot — the longest recorded drive in pro golf is ~500yd, a
// putt over a green is a handful of yards, so anything past these ceilings
// is a bug or tampering. Distances must also be finite and non-negative.
export const MAX_DRIVE_YARDS = 1000;
export const MAX_PUTT_YARDS = 200;
// Closest-to-pin is the distance left to the hole after a shot; clamp it to
// the same generous drive ceiling.
export const MAX_CLOSEST_YARDS = 1000;
// A hole number, when supplied, has to be a small positive integer.
export const MAX_HOLE = 999;

// Course name is cosmetic metadata on a golf run; keep it short.
export const MAX_COURSE_LEN = 64;
// Sane bound for a per-run to-par figure (negative = under par). A full
// round can't realistically stray beyond this, so anything past it is a
// bug or tampering.
export const MAX_TO_PAR = 200;

function normalizeGame(v: unknown): GameId {
  return typeof v === 'string' && (GAME_IDS as readonly string[]).includes(v)
    ? (v as GameId)
    : 'fog';
}

// ---- Golf best-shot records ----------------------------------------------
//
// One row per user in golf_records, upsert-on-improve. The DB column shape
// is documented in schema.sql; here we only read/write it.

interface GolfRecordRow {
  longest_drive_yards: number | null;
  longest_drive_hole: number | null;
  longest_drive_at: number | null;
  closest_to_pin_yards: number | null;
  closest_to_pin_hole: number | null;
  closest_to_pin_at: number | null;
  longest_putt_yards: number | null;
  longest_putt_hole: number | null;
  longest_putt_at: number | null;
}

interface GolfRecordShape {
  yards: number;
  hole: number | null;
  at: number | null;
}

// Turn the flat row (or null, when the user has no records yet) into the
// nested { longestDrive, closestToPin, longestPutt } shape the UI renders.
function shapeGolfRecords(row: GolfRecordRow | null) {
  const metric = (
    yards: number | null,
    hole: number | null,
    at: number | null,
  ): GolfRecordShape | null =>
    yards == null ? null : { yards, hole: hole ?? null, at: at ?? null };
  return {
    longestDrive: metric(
      row?.longest_drive_yards ?? null,
      row?.longest_drive_hole ?? null,
      row?.longest_drive_at ?? null,
    ),
    closestToPin: metric(
      row?.closest_to_pin_yards ?? null,
      row?.closest_to_pin_hole ?? null,
      row?.closest_to_pin_at ?? null,
    ),
    longestPutt: metric(
      row?.longest_putt_yards ?? null,
      row?.longest_putt_hole ?? null,
      row?.longest_putt_at ?? null,
    ),
  };
}

async function readGolfRecords(
  db: D1Database,
  userId: string,
): Promise<GolfRecordRow | null> {
  return db
    .prepare(
      `SELECT longest_drive_yards, longest_drive_hole, longest_drive_at,
              closest_to_pin_yards, closest_to_pin_hole, closest_to_pin_at,
              longest_putt_yards, longest_putt_hole, longest_putt_at
         FROM golf_records WHERE user_id = ?`,
    )
    .bind(userId)
    .first<GolfRecordRow>();
}

// ---- Async friend challenges ----------------------------------------------
//
// A challenge pits two contacts against the same seeded golf hole/course. The
// compared metric is TO-PAR (lower is better), stored per side in
// challenger_score / opponent_score. Winner = the lower to-par once BOTH
// sides have submitted; equal to-par is a tie (winner_id null).

// Only golf modes can be challenged — the metric is to-par.
const CHALLENGE_GAME_IDS = ['golf', 'golfrange', 'golfcourse'] as const;

// A challenge score (to-par) is clamped to this magnitude both ways.
const MAX_CHALLENGE_TO_PAR = 200;

interface ChallengeRow {
  id: string;
  game: string;
  course: string | null;
  hole: number | null;
  seed: number;
  status: string;
  winner_id: string | null;
  challenger_id: string;
  opponent_id: string;
  challenger_score: number | null;
  opponent_score: number | null;
  created_at: number;
  challenger_name: string;
  challenger_avatar_url: string | null;
  challenger_avatar_r2_key: string | null;
  opponent_name: string;
  opponent_avatar_url: string | null;
  opponent_avatar_r2_key: string | null;
}

// Read a challenge by id, joining users on both sides, and shape it for the
// caller. `mine` is 'challenger'/'opponent' when meId is a participant, else
// null (callers gate participant-only access on that). Returns null when the
// row doesn't exist.
async function readChallengeShaped(
  db: D1Database,
  origin: string,
  id: string,
  meId: string,
) {
  const r = await db
    .prepare(
      `SELECT c.id, c.game, c.course, c.hole, c.seed, c.status, c.winner_id,
              c.challenger_id, c.opponent_id, c.challenger_score, c.opponent_score,
              c.created_at,
              cu.display_name  AS challenger_name,
              cu.avatar_url    AS challenger_avatar_url,
              cu.avatar_r2_key AS challenger_avatar_r2_key,
              ou.display_name  AS opponent_name,
              ou.avatar_url    AS opponent_avatar_url,
              ou.avatar_r2_key AS opponent_avatar_r2_key
         FROM game_challenges c
         JOIN users cu ON cu.id = c.challenger_id
         JOIN users ou ON ou.id = c.opponent_id
        WHERE c.id = ?`,
    )
    .bind(id)
    .first<ChallengeRow>();
  if (!r) return null;

  const mine =
    meId === r.challenger_id
      ? 'challenger'
      : meId === r.opponent_id
        ? 'opponent'
        : null;

  return {
    id: r.id,
    game: r.game,
    course: r.course ?? null,
    hole: r.hole ?? null,
    seed: r.seed,
    status: r.status,
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
    mine,
    createdAt: r.created_at,
  };
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
      .json<{
        score?: unknown;
        rounds?: unknown;
        bestStreak?: unknown;
        game?: unknown;
        course?: unknown;
        toPar?: unknown;
      }>()
      .catch(() => null);
    const rounds = body?.rounds;
    const bestStreak = body?.bestStreak;
    const game = normalizeGame(body?.game);

    // The full 3D Course mode plays up to 18 holes; the arcade mini games
    // stay capped at MAX_ROUNDS (8).
    const maxRounds = game === 'golfcourse' ? MAX_COURSE_ROUNDS : MAX_ROUNDS;

    // rounds + bestStreak are validated the same for every game: rounds
    // 1..maxRounds, bestStreak 0..rounds (you can't streak more rounds than
    // you played).
    const roundsAndStreakValid =
      Number.isInteger(rounds) &&
      Number.isInteger(bestStreak) &&
      (rounds as number) >= 1 &&
      (rounds as number) <= maxRounds &&
      (bestStreak as number) >= 0 &&
      (bestStreak as number) <= (rounds as number);
    if (!roundsAndStreakValid) return c.json({ error: 'invalid_score' }, 400);

    // toPar is optional for the mini games but, when supplied, is held to the
    // same strictness as the score clamps: an integer within
    // [-MAX_TO_PAR, MAX_TO_PAR]. Absent -> null; present-but-invalid -> 400.
    let toPar: number | null = null;
    if (body?.toPar !== undefined && body?.toPar !== null) {
      if (
        !Number.isInteger(body.toPar) ||
        (body.toPar as number) < -MAX_TO_PAR ||
        (body.toPar as number) > MAX_TO_PAR
      ) {
        return c.json({ error: 'invalid_score' }, 400);
      }
      toPar = body.toPar as number;
    }

    // Score: for arcade games the client sends it and we clamp
    // 0..rounds*MAX_POINTS_PER_ROUND. For golfcourse the client score is
    // meaningless (a full round is scored by strokes), so we IGNORE it and
    // derive a leaderboard-friendly points value from to-par instead:
    //   score = max(0, round(1000 - toPar*10))
    // scratch (0) = 1000, each shot under par adds 10 (−5 => 1050), each shot
    // over subtracts 10 (+5 => 950). Higher is better, always ≥ 0, and
    // monotonic in to-par so the existing MAX(score) leaderboard/best logic
    // ranks rounds correctly. golfcourse therefore REQUIRES a valid toPar.
    let score: number;
    if (game === 'golfcourse') {
      if (toPar === null) return c.json({ error: 'invalid_score' }, 400);
      score = Math.max(0, Math.round(1000 - toPar * 10));
    } else {
      const raw = body?.score;
      if (
        !Number.isInteger(raw) ||
        (raw as number) < 0 ||
        (raw as number) > (rounds as number) * MAX_POINTS_PER_ROUND
      ) {
        return c.json({ error: 'invalid_score' }, 400);
      }
      score = raw as number;
    }

    // course is cosmetic: a bad value is silently coerced to null, never a
    // 400. Trim and cap the length; anything not a usable string is dropped.
    // (golfcourse rounds should carry one, but we stay null-tolerant.)
    let course: string | null = null;
    if (typeof body?.course === 'string') {
      const trimmed = body.course.trim();
      if (trimmed.length > 0 && trimmed.length <= MAX_COURSE_LEN) course = trimmed;
    }

    await c.env.DB.prepare(
      `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, course, to_par, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        me.id,
        game,
        score,
        rounds,
        bestStreak,
        course,
        toPar,
        Date.now(),
      )
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

  // GET /game/golf-stats?game=golf|golfrange — the caller's PERSONAL golf
  // profile: aggregate stats over their own runs plus per-course breakdowns
  // and a recent-rounds list. Unlike /game/leaderboard this is not
  // contact-scoped — every query is filtered to `user_id = me AND game = ?`,
  // so it never leaks anyone else's play. `game` defaults to fog via
  // normalizeGame, but the golf ids are the intended callers.
  app.get('/game/golf-stats', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const game = normalizeGame(c.req.query('game'));

    // Overall aggregates in one pass.
    const summary = await c.env.DB.prepare(
      `SELECT COUNT(*) AS gamesPlayed,
              MAX(score) AS best,
              ROUND(AVG(score), 1) AS average,
              MAX(best_streak) AS bestStreak,
              MAX(created_at) AS lastPlayed
         FROM game_scores WHERE user_id = ? AND game = ?`,
    )
      .bind(me.id, game)
      .first<{
        gamesPlayed: number;
        best: number | null;
        average: number | null;
        bestStreak: number | null;
        lastPlayed: number | null;
      }>();

    // Per-course breakdown. A null course is its own valid bucket
    // (mini-golf / uncategorized), so we GROUP BY course including null. The
    // to_par aggregates are naturally computed only over non-null to_par rows
    // (SQLite MIN/AVG skip NULLs), yielding null when a course has no to_par.
    const perCourseRows = await c.env.DB.prepare(
      `SELECT course,
              COUNT(*) AS games,
              MAX(score) AS bestScore,
              ROUND(AVG(score), 1) AS avgScore,
              MIN(to_par) AS bestToPar,
              ROUND(AVG(to_par), 1) AS avgToPar
         FROM game_scores WHERE user_id = ? AND game = ?
        GROUP BY course
        ORDER BY games DESC`,
    )
      .bind(me.id, game)
      .all<{
        course: string | null;
        games: number;
        bestScore: number;
        avgScore: number;
        bestToPar: number | null;
        avgToPar: number | null;
      }>();

    // Most recent rounds, newest first.
    const recentRows = await c.env.DB.prepare(
      `SELECT course, score, rounds, to_par AS toPar, created_at AS createdAt
         FROM game_scores WHERE user_id = ? AND game = ?
        ORDER BY created_at DESC
        LIMIT 10`,
    )
      .bind(me.id, game)
      .all<{
        course: string | null;
        score: number;
        rounds: number;
        toPar: number | null;
        createdAt: number;
      }>();

    // Handicap: an APPROXIMATION, not an official golf handicap. We simply
    // average the to_par of the caller's most recent up-to-20 rounds that
    // recorded a to_par. Lower (more under par) is better; null when there
    // are no scored-to-par rounds yet.
    const handicapRow = await c.env.DB.prepare(
      `SELECT ROUND(AVG(to_par), 1) AS handicap FROM (
         SELECT to_par FROM game_scores
          WHERE user_id = ? AND game = ? AND to_par IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 20
       )`,
    )
      .bind(me.id, game)
      .first<{ handicap: number | null }>();

    return c.json({
      game,
      gamesPlayed: summary?.gamesPlayed ?? 0,
      best: summary?.best ?? null,
      average: summary?.average ?? null,
      bestStreak: summary?.bestStreak ?? null,
      lastPlayed: summary?.lastPlayed ?? null,
      handicap: handicapRow?.handicap ?? null,
      perCourse: (perCourseRows.results ?? []).map((r) => ({
        course: r.course ?? null,
        games: r.games,
        bestScore: r.bestScore,
        avgScore: r.avgScore,
        bestToPar: r.bestToPar ?? null,
        avgToPar: r.avgToPar ?? null,
      })),
      recent: (recentRows.results ?? []).map((r) => ({
        course: r.course ?? null,
        score: r.score,
        rounds: r.rounds,
        toPar: r.toPar ?? null,
        createdAt: r.createdAt,
      })),
    });
  });

  // GET /game/golf-records — the caller's personal best-shot records, shaped
  // for the recap UI. Returns nulls for metrics never set yet.
  app.get('/game/golf-records', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const row = await readGolfRecords(c.env.DB, me.id);
    return c.json({ records: shapeGolfRecords(row) });
  });

  // POST /game/golf-records — submit end-of-hole candidate records. Body is
  // { longestDriveYards?, longestDriveHole?, closestToPinYards?,
  //   closestToPinHole?, longestPuttYards?, longestPuttHole? } — all optional,
  // only present metrics are considered. Each metric is upserted on-improve
  // in its natural direction (drive/putt: bigger wins; closest-to-pin:
  // smaller wins). Returns which metrics newly improved plus the current
  // records (read-after-write).
  app.post('/game/golf-records', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid_records' }, 400);
    }

    // Parse a distance: absent -> undefined (skip), present-but-bogus ->
    // 'invalid' (400). allowZero lets closest-to-pin be 0 (holed / gimme).
    const parseYards = (
      v: unknown,
      max: number,
      allowZero: boolean,
    ): number | undefined | 'invalid' => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'invalid';
      if (v > max) return 'invalid';
      if (allowZero ? v < 0 : v <= 0) return 'invalid';
      return v;
    };

    // Parse an optional hole number: absent -> null; present must be a small
    // positive integer.
    const parseHole = (v: unknown): number | null | 'invalid' => {
      if (v === undefined || v === null) return null;
      if (!Number.isInteger(v)) return 'invalid';
      const n = v as number;
      if (n < 1 || n > MAX_HOLE) return 'invalid';
      return n;
    };

    const driveYards = parseYards(body.longestDriveYards, MAX_DRIVE_YARDS, false);
    const closestYards = parseYards(body.closestToPinYards, MAX_CLOSEST_YARDS, true);
    const puttYards = parseYards(body.longestPuttYards, MAX_PUTT_YARDS, false);
    const driveHole = parseHole(body.longestDriveHole);
    const closestHole = parseHole(body.closestToPinHole);
    const puttHole = parseHole(body.longestPuttHole);

    if (
      driveYards === 'invalid' ||
      closestYards === 'invalid' ||
      puttYards === 'invalid' ||
      driveHole === 'invalid' ||
      closestHole === 'invalid' ||
      puttHole === 'invalid'
    ) {
      return c.json({ error: 'invalid_records' }, 400);
    }

    const now = Date.now();
    // Decide improvement against the current row so we can report it back;
    // the conditional upserts below re-check the same guard in SQL, which
    // also settles any concurrent submission.
    const prev = await readGolfRecords(c.env.DB, me.id);
    const improved = {
      longestDrive:
        driveYards !== undefined &&
        (prev?.longest_drive_yards == null || driveYards > prev.longest_drive_yards),
      closestToPin:
        closestYards !== undefined &&
        (prev?.closest_to_pin_yards == null || closestYards < prev.closest_to_pin_yards),
      longestPutt:
        puttYards !== undefined &&
        (prev?.longest_putt_yards == null || puttYards > prev.longest_putt_yards),
    };

    // longest_drive (MAX): update only when strictly greater or unset.
    if (driveYards !== undefined) {
      await c.env.DB.prepare(
        `INSERT INTO golf_records
           (user_id, longest_drive_yards, longest_drive_hole, longest_drive_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           longest_drive_yards = excluded.longest_drive_yards,
           longest_drive_hole  = excluded.longest_drive_hole,
           longest_drive_at    = excluded.longest_drive_at,
           updated_at          = excluded.updated_at
         WHERE golf_records.longest_drive_yards IS NULL
            OR excluded.longest_drive_yards > golf_records.longest_drive_yards`,
      )
        .bind(me.id, driveYards, driveHole, now, now, now)
        .run();
    }

    // closest_to_pin (MIN): update only when strictly less or unset.
    if (closestYards !== undefined) {
      await c.env.DB.prepare(
        `INSERT INTO golf_records
           (user_id, closest_to_pin_yards, closest_to_pin_hole, closest_to_pin_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           closest_to_pin_yards = excluded.closest_to_pin_yards,
           closest_to_pin_hole  = excluded.closest_to_pin_hole,
           closest_to_pin_at    = excluded.closest_to_pin_at,
           updated_at           = excluded.updated_at
         WHERE golf_records.closest_to_pin_yards IS NULL
            OR excluded.closest_to_pin_yards < golf_records.closest_to_pin_yards`,
      )
        .bind(me.id, closestYards, closestHole, now, now, now)
        .run();
    }

    // longest_putt (MAX): update only when strictly greater or unset.
    if (puttYards !== undefined) {
      await c.env.DB.prepare(
        `INSERT INTO golf_records
           (user_id, longest_putt_yards, longest_putt_hole, longest_putt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           longest_putt_yards = excluded.longest_putt_yards,
           longest_putt_hole  = excluded.longest_putt_hole,
           longest_putt_at    = excluded.longest_putt_at,
           updated_at         = excluded.updated_at
         WHERE golf_records.longest_putt_yards IS NULL
            OR excluded.longest_putt_yards > golf_records.longest_putt_yards`,
      )
        .bind(me.id, puttYards, puttHole, now, now, now)
        .run();
    }

    const row = await readGolfRecords(c.env.DB, me.id);
    return c.json({ improved, records: shapeGolfRecords(row) });
  });

  // POST /game/challenge — open an async golf challenge against a contact.
  // Body: { opponentId, game, course, hole? }. The opponent must be one of the
  // caller's contacts and not blocked in either direction (mirrors the
  // leaderboard's contact/block scoping). Returns the shaped challenge.
  app.post('/game/challenge', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<{ opponentId?: unknown; game?: unknown; course?: unknown; hole?: unknown }>()
      .catch(() => null);

    const opponentId = typeof body?.opponentId === 'string' ? body.opponentId : '';
    if (!opponentId) return c.json({ error: 'invalid_opponent' }, 400);

    // Only golf modes carry a to-par metric, so only they can be challenged.
    const game = normalizeGame(body?.game);
    if (!(CHALLENGE_GAME_IDS as readonly string[]).includes(game)) {
      return c.json({ error: 'invalid_game' }, 400);
    }

    // course is cosmetic metadata; null-tolerant, capped like a golf run.
    let course: string | null = null;
    if (typeof body?.course === 'string') {
      const trimmed = body.course.trim();
      if (trimmed.length > MAX_COURSE_LEN) return c.json({ error: 'invalid_course' }, 400);
      if (trimmed.length > 0) course = trimmed;
    }

    // hole is optional; when present it must be a non-negative integer.
    let hole: number | null = null;
    if (body?.hole !== undefined && body?.hole !== null) {
      if (!Number.isInteger(body.hole) || (body.hole as number) < 0) {
        return c.json({ error: 'invalid_hole' }, 400);
      }
      hole = body.hole as number;
    }

    // Contact + block scoping in one pass: the opponent must be a contact of
    // the caller and neither party may have blocked the other. This also
    // rejects self-challenges (you are not your own contact).
    const scope = await c.env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM contacts WHERE owner_id = ? AND contact_id = ?) AS is_contact,
         EXISTS(SELECT 1 FROM user_blocks
                 WHERE (blocker_id = ? AND blocked_id = ?)
                    OR (blocker_id = ? AND blocked_id = ?)) AS is_blocked`,
    )
      .bind(me.id, opponentId, me.id, opponentId, opponentId, me.id)
      .first<{ is_contact: number; is_blocked: number }>();

    if (!scope || scope.is_contact !== 1) return c.json({ error: 'not_a_contact' }, 403);
    if (scope.is_blocked === 1) return c.json({ error: 'blocked' }, 403);

    // Shared RNG seed so both players face identical conditions. Uint32 max is
    // 4294967295, so /2 floored yields 0..2^31-1.
    const seed = Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2);
    const id = crypto.randomUUID();
    const now = Date.now();

    await c.env.DB.prepare(
      `INSERT INTO game_challenges
         (id, game, course, hole, seed, challenger_id, opponent_id,
          challenger_score, opponent_score, winner_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'pending', ?, ?)`,
    )
      .bind(id, game, course, hole, seed, me.id, opponentId, now, now)
      .run();

    const origin = new URL(c.req.url).origin;
    const challenge = await readChallengeShaped(c.env.DB, origin, id, me.id);
    return c.json({ challenge });
  });

  // POST /game/challenge/:id/result — submit the caller's to-par. Body:
  // { toPar } (integer, clamped to +/-200 else 400). Only a participant may
  // submit (else 404). The first submission per side wins — re-submits are
  // ignored. Once both sides are in, the winner (lower to-par; equal -> tie)
  // is settled and the challenge marked complete.
  app.post('/game/challenge/:id/result', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const id = c.req.param('id');
    const body = await c.req.json<{ toPar?: unknown }>().catch(() => null);
    if (
      !Number.isInteger(body?.toPar) ||
      (body!.toPar as number) < -MAX_CHALLENGE_TO_PAR ||
      (body!.toPar as number) > MAX_CHALLENGE_TO_PAR
    ) {
      return c.json({ error: 'invalid_to_par' }, 400);
    }
    const toPar = body!.toPar as number;

    const row = await c.env.DB.prepare(
      `SELECT challenger_id, opponent_id, challenger_score, opponent_score
         FROM game_challenges WHERE id = ?`,
    )
      .bind(id)
      .first<{
        challenger_id: string;
        opponent_id: string;
        challenger_score: number | null;
        opponent_score: number | null;
      }>();

    const isChallenger = row?.challenger_id === me.id;
    const isOpponent = row?.opponent_id === me.id;
    if (!row || (!isChallenger && !isOpponent)) return c.json({ error: 'not_found' }, 404);

    // Keep the first submission per side; a re-submit leaves it untouched.
    const challengerScore = isChallenger
      ? row.challenger_score ?? toPar
      : row.challenger_score;
    const opponentScore = isOpponent
      ? row.opponent_score ?? toPar
      : row.opponent_score;

    const bothIn = challengerScore !== null && opponentScore !== null;
    let winnerId: string | null = null;
    if (bothIn) {
      if (challengerScore! < opponentScore!) winnerId = row.challenger_id;
      else if (opponentScore! < challengerScore!) winnerId = row.opponent_id;
      // equal -> tie -> winnerId stays null
    }
    const status = bothIn ? 'complete' : 'pending';

    await c.env.DB.prepare(
      `UPDATE game_challenges
          SET challenger_score = ?, opponent_score = ?, winner_id = ?, status = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(challengerScore, opponentScore, winnerId, status, Date.now(), id)
      .run();

    const origin = new URL(c.req.url).origin;
    const challenge = await readChallengeShaped(c.env.DB, origin, id, me.id);
    return c.json({ challenge });
  });

  // GET /game/challenge/:id — participant-only view of a challenge (else 404).
  app.get('/game/challenge/:id', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const origin = new URL(c.req.url).origin;
    const challenge = await readChallengeShaped(c.env.DB, origin, c.req.param('id'), me.id);
    if (!challenge || challenge.mine === null) return c.json({ error: 'not_found' }, 404);
    return c.json({ challenge });
  });

  return app;
}
