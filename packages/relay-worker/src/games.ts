import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';
import { addXp, awardCoins } from './economy';
import { pushToUser } from './push';
import {
  currentPeriodIndex,
  periodWindow,
  tournamentHoles,
  tournamentSeed,
} from './tournaments';

// Server-side clamps for the Fog mini game. Anti-cheat is intentionally
// lightweight — it's a casual game, we just refuse values that couldn't
// possibly come from a real run (the client scores at most
// MAX_POINTS_PER_ROUND per round over at most MAX_ROUNDS rounds).
export const MAX_ROUNDS = 8;
export const MAX_POINTS_PER_ROUND = 2000;

// The Home Run Derby's OWN per-round points ceiling, for exactly the reason
// MAX_COURSE_ROUNDS below is the Course's own rounds ceiling: one game's format
// outgrew a clamp that is otherwise right for every arcade mini game, and the
// answer is a per-game number rather than a raised shared one. Raising
// MAX_POINTS_PER_ROUND itself would have doubled the accepted ceiling for fog,
// tune, golf and golfrange as well — four games that come nowhere near it and
// whose anti-cheat bound would have been weakened for nothing.
//
// WHY the derby needs it: a derby round is 8 pitches and a home run inside a
// run of consecutive home runs pays a CHAIN MULTIPLIER (up to x2). The old
// 2000/round put the per-pitch ceiling at 250 against a ~190-point barrelled
// home run, i.e. 1.32x of headroom — not enough for a multiplier to express
// anything before the clamp ate it. 4000 puts the per-pitch ceiling at 500.
//
// ⚠ THIS IS A WIDENING, AND THE DEPLOY ORDER MATTERS. The worker and the UI
// deploy independently. A wider ceiling accepts everything the old client sent,
// so worker-then-UI is safe in both windows; UI-then-worker is NOT — a chained
// session would exceed rounds x 2000, and `DerbyGame.bank()` swallows the 400
// with `.catch(() => undefined)`, so the score would vanish with no UI signal.
// Deploy the worker first.
//
// ⚠ AND IT MIRRORS `DERBY_POINTS_PER_ROUND` IN
// `packages/relay-ui/src/lib/baseball/tuning.ts`, which mirrors it back and
// asserts the equality by reading THIS FILE's source text
// (`tuning.test.ts`). The two must be changed together.
export const DERBY_POINTS_PER_ROUND = 4000;

// Economy anti-farm: a client can submit arbitrarily many arcade rounds, so the
// per-round coin/XP reward is capped to this many credited rounds per UTC day.
// Rounds past the cap still record their score — they just stop minting coins.
export const MAX_ROUND_REWARDS_PER_DAY = 20;

// Games that share the game_scores table (and its leaderboard). The
// column defaults to 'fog', so an omitted/unknown value maps back to fog
// and every existing client keeps working.
export const GAME_IDS = ['fog', 'tune', 'golf', 'golfrange', 'golfcourse', 'bbderby'] as const;
export type GameId = (typeof GAME_IDS)[number];

// The full 3D Course mode plays up to 18 holes, so its runs need a higher
// rounds ceiling than the arcade mini games (MAX_ROUNDS = 8).
export const MAX_COURSE_ROUNDS = 18;

// Pitches in one Home Run Derby round. The derby is the one game whose
// `rounds` unit is NOT one attempt: a round is this many pitches, and its
// `bestStreak` counts consecutive HOME RUNS across pitches. So a legitimate
// 3-round derby can streak to 24 while submitting rounds = 3, which the flat
// `bestStreak <= rounds` rule below used to reject with a 400 for nearly every
// competently-played session.
//
// ⚠ THIS MIRRORS `PITCHES_PER_ROUND` IN
// `packages/relay-ui/src/lib/baseball/derbyRules.ts`, WHICH IS THE SOURCE OF
// TRUTH. The worker must not import from the UI package, so the number is
// duplicated here and THE TWO MUST BE CHANGED TOGETHER: raise the UI's alone
// and real runs start 400ing again; raise this alone and the anti-cheat bound
// is wider than anything the format can actually produce.
export const DERBY_PITCHES_PER_ROUND = 8;

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

// The equipped avatar-frame cosmetic id for a leaderboard row. The economy's
// `frame_none` sentinel (and a missing user_equipped row) both mean "no frame",
// so we collapse them to null — the UI treats null as no frame and resolves any
// non-null id against its client-side cosmetic catalog.
function normalizeFrame(frame: string | null | undefined): string | null {
  return frame == null || frame === 'frame_none' ? null : frame;
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
//
// 'bbderby' is DELIBERATELY ABSENT, not an oversight. It is a member of
// GAME_IDS (the leaderboard is metric-agnostic and handles it fine), but the
// challenge machinery below is hardwired to golf's metric in three places, so
// admitting the derby here ships a broken flow rather than an incomplete one:
//   1. the create handler pushes a hard-coded "Golf challenge" notification
//      pointing at /games/golf, so the opponent is mislabelled and deep-linked
//      to the wrong game;
//   2. the winner is the LOWER submitted score, but a derby is
//      higher-is-better, so it would crown the worse player;
//   3. the result endpoint takes a field named `toPar` clamped to
//      +/-MAX_CHALLENGE_TO_PAR, and a derby session scores into the thousands,
//      so every real submission is a hard 400.
// Re-adding it requires generalising the metric FIRST — either a negated-score
// convention on submit, or a per-game comparator plus a per-game magnitude
// clamp — along with a per-game push title/url. That redesign is owned by
// messaging-core, not by whoever notices the id is missing.
const CHALLENGE_GAME_IDS = ['golf', 'golfrange', 'golfcourse'] as const;

// A challenge score (to-par) is clamped to this magnitude both ways.
const MAX_CHALLENGE_TO_PAR = 200;

// ---- Challenge economy ----------------------------------------------------
//
// Completing a head-to-head challenge pays out once, at the moment BOTH sides
// are in and the winner/tie is settled. Amounts are code-defined (like the
// round/daily/tournament earns) and every credit is ref-guarded by the
// challenge id, so the completion seam is idempotent even if re-entered.
export const CHALLENGE_WIN_COINS = 30;
export const CHALLENGE_WIN_XP = 20;
export const CHALLENGE_TIE_COINS = 10;
// A small consolation + tie XP so both players make season progress.
export const CHALLENGE_TIE_XP = 5;
export const CHALLENGE_LOSS_XP = 5;
// Anti-collusion: cap how many challenge WINS credit coins to one user per UTC
// day. Wins past the cap still settle the result and record the tally — they
// just stop minting coins (mirrors MAX_ROUND_REWARDS_PER_DAY).
export const MAX_CHALLENGE_WINS_PER_DAY = 10;

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

  // The coins the VIEWER actually received for this challenge (0 if they lost,
  // tied-but-capped, or won-but-capped). Only meaningful once complete, so we
  // skip the ledger lookup while pending. Lets the card show the TRUE amount
  // even when a win was capped to 0 — `rewardCoins` (nominal stake) can't.
  let rewardCoinsAwarded = 0;
  if (r.status === 'complete') {
    const led = await db
      .prepare(
        `SELECT COALESCE(SUM(delta), 0) AS coins FROM currency_ledger
          WHERE user_id = ? AND ref = ?
            AND reason IN ('challenge_win', 'challenge_tie')`,
      )
      .bind(meId, id)
      .first<{ coins: number }>();
    rewardCoinsAwarded = led?.coins ?? 0;
  }

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
    // The nominal winner STAKE — surfaced so the UI can show "winner earns 30
    // coins" on the pending stake line. Additive/backward-tolerant field.
    rewardCoins: CHALLENGE_WIN_COINS,
    // The coins the viewer (mine) ACTUALLY received for this challenge (0 unless
    // they won/tied AND were under the daily coin cap). 0 while pending. Lets the
    // card show the true amount when a win is capped to 0.
    rewardCoinsAwarded,
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

// ---- Daily Challenge -------------------------------------------------------
//
// One seeded golf hole per UTC day, shared by everyone. The challenge is
// DERIVED from the date (no stored challenge row): the same date always maps to
// the same seed / course / hole. Results upsert to the caller's BEST for the
// day; a per-user streak advances at most once per consecutive day played.

// Rotation of { course, hole } the daily cycles through, indexed by
// days-since-epoch modulo its length. Course ids are the real Relay Course-mode
// ids (see relay-ui GOLF_COURSES). Hole counts DIFFER per course: augusta has
// 18 holes (1..18), each listowel-* course has only 9 (1..9) — every hole below
// must be within its own course's count (guarded by a games.test.ts test). UI
// agent: confirm these ids/holes still match the client course registry.
export const DAILY_ROTATION: readonly { course: string; hole: number }[] = [
  { course: 'augusta', hole: 12 },
  { course: 'listowel-vintage', hole: 7 },
  { course: 'augusta', hole: 16 },
  { course: 'listowel-heritage', hole: 3 },
  { course: 'listowel-millennium', hole: 9 },
  { course: 'augusta', hole: 18 },
  { course: 'listowel-vintage', hole: 5 },
] as const;

// The daily plays a single golf hole; it shares the golfcourse points model.
const DAILY_GAME: GameId = 'golfcourse';

// Strokes on the day's hole, when supplied, is a small positive integer. There
// is no existing strokes clamp, so we bound it by MAX_TO_PAR's magnitude — big
// enough for any real single-hole score, small enough to reject tampering.
export const MAX_DAILY_STROKES = MAX_TO_PAR;

const DAY_MS = 24 * 3600 * 1000;

// Deterministic 32-bit hash of a 'YYYY-MM-DD' string -> stable non-negative
// seed. FNV-1a over the date bytes, folded to 0..2^31-1 so it matches the
// game_challenges.seed range. Same date in -> same seed out, always.
export function dailySeed(date: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 0x80000000;
}

// The UTC calendar day ('YYYY-MM-DD') for an epoch-ms instant.
function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Whole UTC days since the Unix epoch for a 'YYYY-MM-DD' — the rotation index
// source (stable and monotonic across days).
function daysSinceEpoch(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

// Derive the whole challenge (course/hole/seed/game) from a UTC date. Pure and
// deterministic — the single source of truth for both endpoints and the UI.
export function dailyChallengeFor(date: string) {
  const len = DAILY_ROTATION.length;
  const idx = ((daysSinceEpoch(date) % len) + len) % len;
  const rot = DAILY_ROTATION[idx]!;
  return {
    date,
    game: DAILY_GAME,
    course: rot.course,
    hole: rot.hole,
    seed: dailySeed(date),
  };
}

// The golfcourse leaderboard points model, reused verbatim for the daily:
//   score = max(0, round(1000 - toPar*10))  (higher is better, monotone in toPar).
function dailyScoreFromToPar(toPar: number): number {
  return Math.max(0, Math.round(1000 - toPar * 10));
}

// The caller's live rank in a tournament: 1 + the number of entries strictly
// AHEAD of them. "Ahead" mirrors the settlement ordering EXACTLY
// (score DESC, to_par ASC, strokes ASC, created_at ASC) so the rank shown live
// equals the placement they'll actually settle to. Any divergence would let
// the UI promise a podium the settlement then denies.
async function tournamentRank(
  db: D1Database,
  tournamentId: number,
  e: { score: number; toPar: number | null; strokes: number | null; createdAt: number },
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM tournament_entries
        WHERE tournament_id = ?
          AND ( score > ?
             OR (score = ? AND to_par < ?)
             OR (score = ? AND to_par = ? AND strokes < ?)
             OR (score = ? AND to_par = ? AND strokes = ? AND created_at < ?) )`,
    )
    .bind(
      tournamentId,
      e.score,
      e.score,
      e.toPar,
      e.score,
      e.toPar,
      e.strokes,
      e.score,
      e.toPar,
      e.strokes,
      e.createdAt,
    )
    .first<{ n: number }>();
  return (row?.n ?? 0) + 1;
}

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

    // The streak ceiling is per-game for the same reason maxRounds is. For fog,
    // tune and every golf mode a "round" IS one attempt, so you can't streak
    // more rounds than you played and the bound stays `bestStreak <= rounds`.
    // The derby's round is DERBY_PITCHES_PER_ROUND pitches and its streak
    // counts consecutive home runs across them, so its bound is
    // `rounds * pitches-per-round` — 24 for a 3-round session. It is still a
    // real bound: 25 in a 3-round derby is a 400, exactly as before.
    const maxStreak =
      game === 'bbderby'
        ? (rounds as number) * DERBY_PITCHES_PER_ROUND
        : (rounds as number);

    // The points ceiling is per-game for the same reason the two above are: the
    // derby pays a chain multiplier on consecutive home runs and its round
    // ceiling is DERBY_POINTS_PER_ROUND. Everything else keeps
    // MAX_POINTS_PER_ROUND, so this widening has no blast radius outside the
    // derby. Read BEFORE `rounds` is proven an integer, so it is only ever used
    // inside the score clamp below, which runs after `roundsAndStreakValid`.
    const maxPointsPerRound =
      game === 'bbderby' ? DERBY_POINTS_PER_ROUND : MAX_POINTS_PER_ROUND;

    // rounds 1..maxRounds, bestStreak 0..maxStreak. `rounds` is proven an
    // integer by the first conjunct before either bound is read, so a
    // non-numeric `rounds` can never launder itself through maxStreak.
    const roundsAndStreakValid =
      Number.isInteger(rounds) &&
      Number.isInteger(bestStreak) &&
      (rounds as number) >= 1 &&
      (rounds as number) <= maxRounds &&
      (bestStreak as number) >= 0 &&
      (bestStreak as number) <= maxStreak;
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
    // 0..rounds*maxPointsPerRound. For golfcourse the client score is
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
        (raw as number) > (rounds as number) * maxPointsPerRound
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

    const gameScoreId = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO game_scores (id, user_id, game, score, rounds, best_streak, course, to_par, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        gameScoreId,
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

    // Economy earn: a completed round credits a small flat coin + XP reward.
    // ref = the game_scores row id, so each distinct round credits exactly once
    // (a replay of the SAME row is a no-op). Capped per UTC day to stop a client
    // farming coins by spamming rounds. The whole block is best-effort: an
    // economy failure must never fail the already-persisted score submission.
    try {
      const startOfDay = Date.parse(`${utcDate(Date.now())}T00:00:00Z`);
      const credited = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM currency_ledger
          WHERE user_id = ? AND reason = 'round_reward' AND created_at >= ?`,
      )
        .bind(me.id, startOfDay)
        .first<{ n: number }>();
      if ((credited?.n ?? 0) < MAX_ROUND_REWARDS_PER_DAY) {
        await awardCoins(c.env, me.id, 10, 'round_reward', gameScoreId);
        await addXp(c.env, me.id, 10, 'round_reward', gameScoreId);
      }
    } catch (err) {
      console.error('round_reward economy hook failed:', err);
    }

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
              ufr.cosmetic_id AS frame,
              MAX(s.score) AS best, COUNT(*) AS games, MAX(s.created_at) AS last_played
       FROM game_scores s JOIN users u ON u.id = s.user_id
       LEFT JOIN user_equipped ufr ON ufr.user_id = u.id AND ufr.slot = 'frame'
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
        frame: string | null;
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
      frame: normalizeFrame(r.frame),
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

    // Notify the opponent that they've been challenged. Best-effort: a push
    // failure must never fail the already-persisted challenge. The authed user
    // carries only an id, so fetch their display name for the notification.
    try {
      const challenger = await c.env.DB.prepare(
        `SELECT display_name FROM users WHERE id = ?`,
      )
        .bind(me.id)
        .first<{ display_name: string }>();
      const challengerName = challenger?.display_name ?? 'Someone';
      await pushToUser(c.env, opponentId, {
        title: 'Golf challenge',
        body: `${challengerName} challenged you to golf`,
        tag: `chal-${id}`,
        url: '/games/golf',
      });
    } catch (err) {
      console.error('challenge create push failed:', err);
    }

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

    // Was the challenge ALREADY complete before this submission? If both sides
    // were in already, this is a re-submit of an already-settled challenge, so
    // the completion seam (reward + notify) must NOT re-run — the transition to
    // complete happens exactly once.
    const wasCompleteBefore =
      row.challenger_score !== null && row.opponent_score !== null;

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

    // Completion seam: this submission just brought the SECOND score in, so the
    // challenge transitioned pending -> complete exactly here. Reward the
    // outcome and notify BOTH players. All economy/push work is best-effort —
    // the result is already persisted above, so a throw here can NEVER fail the
    // submit. Every coin/XP credit is ref-guarded by the challenge id, so even a
    // re-entry can't double-award; the wasCompleteBefore gate additionally keeps
    // the push (which is not ref-guarded) from re-firing on a re-submit.
    if (bothIn && !wasCompleteBefore) {
      const challengerId = row.challenger_id;
      const opponentId = row.opponent_id;

      // Per-user daily coin cap covering BOTH the win AND tie payouts, so the
      // TOTAL challenge coins one user can mint per UTC day is bounded no matter
      // the outcome. Capping only decisive wins would leave a collusion hole:
      // two accounts could repeatedly TIE and each collect tie coins forever.
      // Past the cap the result still settles + XP still credits — only coins
      // stop minting (mirrors MAX_ROUND_REWARDS_PER_DAY).
      const startOfDay = Date.parse(`${utcDate(Date.now())}T00:00:00Z`);
      const underDailyCoinCap = async (userId: string): Promise<boolean> => {
        const capRow = await c.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM currency_ledger
            WHERE user_id = ?
              AND reason IN ('challenge_win', 'challenge_tie')
              AND created_at >= ?`,
        )
          .bind(userId, startOfDay)
          .first<{ n: number }>();
        return (capRow?.n ?? 0) < MAX_CHALLENGE_WINS_PER_DAY;
      };

      if (winnerId) {
        // Decisive result: winner + loser.
        const loserId = winnerId === challengerId ? opponentId : challengerId;

        // Awards — best-effort and ISOLATED from the notifications below, so a
        // transient award failure can never suppress the outcome pushes (which
        // the wasCompleteBefore gate would otherwise deny forever). coinsCredited
        // flips true only once the coins ACTUALLY land, so the push never claims
        // a credit that didn't happen.
        let coinsCredited = false;
        try {
          if (await underDailyCoinCap(winnerId)) {
            await awardCoins(c.env, winnerId, CHALLENGE_WIN_COINS, 'challenge_win', id);
            coinsCredited = true;
          }
          await addXp(c.env, winnerId, CHALLENGE_WIN_XP, 'challenge_win', id);
          // Consolation XP for the loser (no coins).
          await addXp(c.env, loserId, CHALLENGE_LOSS_XP, 'challenge_played', id);
        } catch (err) {
          console.error('challenge win award failed:', err);
        }

        // Notifications — independent of the award outcome; each caught alone.
        try {
          await pushToUser(c.env, winnerId, {
            title: 'Golf challenge',
            body: coinsCredited
              ? `You won your golf challenge — +${CHALLENGE_WIN_COINS} coins`
              : 'You won your golf challenge',
            tag: `chal-${id}`,
            url: '/games/golf',
          });
        } catch (err) {
          console.error('challenge win push failed:', err);
        }
        try {
          await pushToUser(c.env, loserId, {
            title: 'Golf challenge',
            body: 'You lost your golf challenge',
            tag: `chal-${id}`,
            url: '/games/golf',
          });
        } catch (err) {
          console.error('challenge loss push failed:', err);
        }
      } else {
        // Tie: both players earn the tie payout, each subject to the SAME daily
        // coin cap (checked per user). Distinct users share the (reason, ref),
        // so the (user, reason, ref) guard keeps each idempotent. Track which
        // users actually got coins so their push tells the truth.
        const tieCoinsFor: Record<string, number> = {};
        try {
          for (const uid of [challengerId, opponentId]) {
            if (await underDailyCoinCap(uid)) {
              await awardCoins(c.env, uid, CHALLENGE_TIE_COINS, 'challenge_tie', id);
              tieCoinsFor[uid] = CHALLENGE_TIE_COINS;
            } else {
              tieCoinsFor[uid] = 0;
            }
            await addXp(c.env, uid, CHALLENGE_TIE_XP, 'challenge_tie', id);
          }
        } catch (err) {
          console.error('challenge tie award failed:', err);
        }

        for (const uid of [challengerId, opponentId]) {
          try {
            await pushToUser(c.env, uid, {
              title: 'Golf challenge',
              body:
                (tieCoinsFor[uid] ?? 0) > 0
                  ? `Your golf challenge tied — +${CHALLENGE_TIE_COINS} coins`
                  : 'Your golf challenge tied',
              tag: `chal-${id}`,
              url: '/games/golf',
            });
          } catch (err) {
            console.error('challenge tie push failed:', err);
          }
        }
      }
    }

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

  // GET /game/daily — today's Daily Challenge plus the caller's status. The
  // challenge is derived from the UTC date (deterministic; no stored row), and
  // we return the caller's best result for today (null if unplayed) and their
  // streak (defaulting to zeros before their first daily).
  app.get('/game/daily', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const today = utcDate(Date.now());
    const challenge = dailyChallengeFor(today);

    const result = await c.env.DB.prepare(
      `SELECT strokes, to_par AS toPar, score
         FROM daily_results WHERE user_id = ? AND date = ?`,
    )
      .bind(me.id, today)
      .first<{ strokes: number | null; toPar: number | null; score: number | null }>();

    const streak = await c.env.DB.prepare(
      `SELECT current, best FROM daily_streaks WHERE user_id = ?`,
    )
      .bind(me.id)
      .first<{ current: number; best: number }>();

    return c.json({
      date: challenge.date,
      game: challenge.game,
      course: challenge.course,
      hole: challenge.hole,
      seed: challenge.seed,
      today: result
        ? { strokes: result.strokes, toPar: result.toPar, score: result.score }
        : null,
      streak: { current: streak?.current ?? 0, best: streak?.best ?? 0 },
    });
  });

  // POST /game/daily/result — submit today's attempt. Body: { strokes, toPar }
  // (and optionally date, which must equal the SERVER's today). toPar and
  // strokes are clamped; the leaderboard points are derived with the golfcourse
  // formula. We upsert the day's row keeping the BETTER attempt (higher score),
  // then advance the streak at most once per day. Returns the persisted best
  // for today, the updated streak, and whether this attempt improved it.
  app.post('/game/daily/result', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<{ strokes?: unknown; toPar?: unknown; date?: unknown }>()
      .catch(() => null);

    // toPar: required integer within the golfcourse clamp.
    if (
      !Number.isInteger(body?.toPar) ||
      (body!.toPar as number) < -MAX_TO_PAR ||
      (body!.toPar as number) > MAX_TO_PAR
    ) {
      return c.json({ error: 'invalid_result' }, 400);
    }
    const toPar = body!.toPar as number;

    // strokes: required small positive integer.
    if (
      !Number.isInteger(body?.strokes) ||
      (body!.strokes as number) < 1 ||
      (body!.strokes as number) > MAX_DAILY_STROKES
    ) {
      return c.json({ error: 'invalid_result' }, 400);
    }
    const strokes = body!.strokes as number;

    const now = Date.now();
    const today = utcDate(now);

    // The server's today is the single source of truth. If the client echoes a
    // date it must match, else the attempt is for a stale day — reject it.
    if (body?.date !== undefined && body?.date !== today) {
      return c.json({ error: 'stale_date' }, 409);
    }

    const challenge = dailyChallengeFor(today);
    const score = dailyScoreFromToPar(toPar);

    // Read the prior attempt so we can report whether this one improved it; the
    // conditional upsert below re-checks the guard in SQL (settles concurrency).
    const prior = await c.env.DB.prepare(
      `SELECT score FROM daily_results WHERE user_id = ? AND date = ?`,
    )
      .bind(me.id, today)
      .first<{ score: number | null }>();
    const improved = !prior || score > (prior.score ?? -Infinity);

    // Upsert the day's row, keeping the better attempt. Higher score is better,
    // and score is monotone in to_par, so score alone orders the attempts.
    await c.env.DB.prepare(
      `INSERT INTO daily_results
         (id, user_id, date, game, course, hole, seed, strokes, to_par, score, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, date) DO UPDATE SET
         strokes    = excluded.strokes,
         to_par     = excluded.to_par,
         score      = excluded.score,
         updated_at = excluded.updated_at
       WHERE excluded.score > daily_results.score`,
    )
      .bind(
        crypto.randomUUID(),
        me.id,
        today,
        challenge.game,
        challenge.course,
        challenge.hole,
        challenge.seed,
        strokes,
        toPar,
        score,
        now,
        now,
      )
      .run();

    // Streak recompute — advance at most once per UTC day. If the streak was
    // already counted today (a retry) leave `current` as is; if it was last
    // counted yesterday extend it; otherwise (first-ever or a gap) restart at 1.
    const yesterday = utcDate(now - DAY_MS);
    const streakRow = await c.env.DB.prepare(
      `SELECT current, best, last_date FROM daily_streaks WHERE user_id = ?`,
    )
      .bind(me.id)
      .first<{ current: number; best: number; last_date: string | null }>();

    let current: number;
    if (streakRow?.last_date === today) {
      current = streakRow.current; // already counted today — retry, leave as is
    } else if (streakRow?.last_date === yesterday) {
      current = streakRow.current + 1; // consecutive day — extend
    } else {
      current = 1; // first daily ever, or a gap — restart
    }
    const best = Math.max(streakRow?.best ?? 0, current);

    await c.env.DB.prepare(
      `INSERT INTO daily_streaks (user_id, current, best, last_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         current    = excluded.current,
         best       = excluded.best,
         last_date  = excluded.last_date,
         updated_at = excluded.updated_at`,
    )
      .bind(me.id, current, best, today, now, now)
      .run();

    // Economy earn: completing the day's challenge credits coins + XP once per
    // UTC day. ref = today's date, so a same-day retry is a no-op (ledger
    // idempotency guard). Placed AFTER the streak recompute and wrapped so an
    // economy failure can neither skip the streak nor fail the primary submit.
    try {
      await awardCoins(c.env, me.id, 50, 'daily_reward', today);
      await addXp(c.env, me.id, 50, 'daily_reward', today);
    } catch (err) {
      console.error('daily_reward economy hook failed:', err);
    }

    // Read-after-write so `today` reflects the persisted best (not necessarily
    // this attempt, when a prior one was better). A row is guaranteed here: we
    // just inserted (or kept a prior) one for (me, today).
    const final = await c.env.DB.prepare(
      `SELECT strokes, to_par AS toPar, score
         FROM daily_results WHERE user_id = ? AND date = ?`,
    )
      .bind(me.id, today)
      .first<{ strokes: number; toPar: number; score: number }>();

    return c.json({
      today: final
        ? { strokes: final.strokes, toPar: final.toPar, score: final.score }
        : { strokes, toPar, score },
      streak: { current, best },
      improved,
    });
  });

  // GET /game/daily/leaderboard — today's board, contact-scoped and
  // block-filtered exactly like /game/leaderboard, ordered by points (higher
  // better) then to_par (lower better). One row per player per day, so no
  // GROUP BY is needed. Top 25, each row carrying a `mine` flag.
  app.get('/game/daily/leaderboard', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const today = utcDate(Date.now());

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key,
              ufr.cosmetic_id AS frame,
              d.score AS score, d.to_par AS to_par, d.strokes AS strokes,
              d.updated_at AS last_played
       FROM daily_results d JOIN users u ON u.id = d.user_id
       LEFT JOIN user_equipped ufr ON ufr.user_id = u.id AND ufr.slot = 'frame'
       WHERE d.date = ?
         AND (d.user_id = ? OR d.user_id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND d.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
       ORDER BY d.score DESC, d.to_par ASC, last_played ASC
       LIMIT 25`,
    )
      .bind(today, me.id, me.id, me.id)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        frame: string | null;
        score: number | null;
        to_par: number | null;
        strokes: number | null;
        last_played: number;
      }>();

    const origin = new URL(c.req.url).origin;
    const entries = (rows.results ?? []).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      frame: normalizeFrame(r.frame),
      score: r.score,
      toPar: r.to_par,
      strokes: r.strokes,
      mine: r.id === me.id,
    }));
    return c.json({ entries });
  });

  // ---- Rapid Tournaments --------------------------------------------------
  //
  // Global seeded 3-hole stroke-play events that rotate every 2 days. The
  // event definition (seed / holes / window) is DERIVED from the period index
  // in tournaments.ts — no row exists until the first result materialises it
  // lazily. Ranking is score DESC, to_par ASC; settlement (cron) awards
  // trophies. See src/tournaments.ts + migration 0012.

  // GET /game/tournament — the current event, derived without needing a row,
  // plus the caller's entry (with live rank) and the total field size.
  app.get('/game/tournament', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const now = Date.now();
    const id = currentPeriodIndex(now);
    const { openedAt, closesAt } = periodWindow(id);
    const holes = tournamentHoles(id);

    // The caller's best run for this event (null before they've played).
    const entryRow = await c.env.DB.prepare(
      `SELECT score, to_par AS toPar, strokes, created_at AS createdAt
         FROM tournament_entries WHERE tournament_id = ? AND user_id = ?`,
    )
      .bind(id, me.id)
      .first<{
        score: number;
        toPar: number | null;
        strokes: number | null;
        createdAt: number;
      }>();

    const entrantsRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();
    const entrants = entrantsRow?.n ?? 0;

    let entry: {
      score: number;
      toPar: number | null;
      strokes: number | null;
      rank: number | null;
    } | null = null;
    if (entryRow) {
      entry = {
        score: entryRow.score,
        toPar: entryRow.toPar,
        strokes: entryRow.strokes,
        rank: await tournamentRank(c.env.DB, id, entryRow),
      };
    }

    return c.json({
      id,
      seed: tournamentSeed(id),
      holes,
      openedAt,
      closesAt,
      msLeft: Math.max(0, closesAt - now),
      entrants,
      entry,
    });
  });

  // POST /game/tournament/result — submit a 3-hole round total. Body:
  // { toPar, strokes }. Rejected 409 once the current event has closed. Lazily
  // materialises the tournaments row, then upserts the caller's entry keeping
  // the BETTER run (higher score, then lower to_par, then fewer strokes) while
  // always counting the replay in rounds_played.
  app.post('/game/tournament/result', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req
      .json<{ toPar?: unknown; strokes?: unknown }>()
      .catch(() => null);

    // toPar: required integer within the golfcourse clamp.
    if (
      !Number.isInteger(body?.toPar) ||
      (body!.toPar as number) < -MAX_TO_PAR ||
      (body!.toPar as number) > MAX_TO_PAR
    ) {
      return c.json({ error: 'invalid_result' }, 400);
    }
    const toPar = body!.toPar as number;

    // strokes: required small positive integer (1..200).
    if (
      !Number.isInteger(body?.strokes) ||
      (body!.strokes as number) < 1 ||
      (body!.strokes as number) > MAX_DAILY_STROKES
    ) {
      return c.json({ error: 'invalid_result' }, 400);
    }
    const strokes = body!.strokes as number;

    const now = Date.now();
    const id = currentPeriodIndex(now);
    const { openedAt, closesAt } = periodWindow(id);

    // Submissions to a closed event are rejected. The window bounding the
    // current period is derived (openedAt..closesAt); when a row already
    // exists we trust ITS pinned closes_at (identical in production, since it
    // was set to the derived value at open time). A settled event is closed by
    // definition.
    const existing = await c.env.DB.prepare(
      `SELECT closes_at AS closesAt, settled FROM tournaments WHERE id = ?`,
    )
      .bind(id)
      .first<{ closesAt: number; settled: number }>();
    const effectiveClosesAt = existing?.closesAt ?? closesAt;
    if (now >= effectiveClosesAt || existing?.settled === 1) {
      return c.json({ error: 'tournament_closed' }, 409);
    }

    const score = dailyScoreFromToPar(toPar);

    // Lazily create the event row (no-op if a prior submission already did).
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO tournaments
         (id, kind, seed, holes, opened_at, closes_at, settled, created_at)
       VALUES (?, 'rapid', ?, ?, ?, ?, 0, ?)`,
    )
      .bind(
        id,
        tournamentSeed(id),
        JSON.stringify(tournamentHoles(id)),
        openedAt,
        closesAt,
        now,
      )
      .run();

    // Close the settle-after-post race: a concurrent cron tick could have
    // settled the event between the pre-check above and this point. Re-read
    // `settled` now that the row is guaranteed to exist; if it's already
    // awarded, refuse the entry so it can't land after placements were written
    // and silently miss a trophy. (A sub-statement boundary race may remain,
    // but it can't corrupt placements.)
    const settledNow = await c.env.DB.prepare(
      `SELECT settled FROM tournaments WHERE id = ?`,
    )
      .bind(id)
      .first<{ settled: number }>();
    if (settledNow?.settled === 1) {
      return c.json({ error: 'tournament_closed' }, 409);
    }

    // Report whether this run beat the caller's stored best; the conditional
    // upsert below re-checks the same ordering in SQL (settles concurrency).
    const prior = await c.env.DB.prepare(
      `SELECT score, to_par AS toPar, strokes
         FROM tournament_entries WHERE tournament_id = ? AND user_id = ?`,
    )
      .bind(id, me.id)
      .first<{ score: number; toPar: number | null; strokes: number | null }>();
    const improved =
      !prior ||
      score > prior.score ||
      (score === prior.score && toPar < (prior.toPar ?? Infinity)) ||
      (score === prior.score &&
        toPar === (prior.toPar ?? Infinity) &&
        strokes < (prior.strokes ?? Infinity));

    // Keep the better run per column; rounds_played always increments. The
    // guard mirrors the board ordering: higher score, then lower to_par, then
    // fewer strokes.
    await c.env.DB.prepare(
      `INSERT INTO tournament_entries
         (id, tournament_id, user_id, score, to_par, strokes, rounds_played, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(tournament_id, user_id) DO UPDATE SET
         score   = CASE WHEN <better> THEN excluded.score   ELSE tournament_entries.score   END,
         to_par  = CASE WHEN <better> THEN excluded.to_par  ELSE tournament_entries.to_par  END,
         strokes = CASE WHEN <better> THEN excluded.strokes ELSE tournament_entries.strokes END,
         rounds_played = tournament_entries.rounds_played + 1,
         updated_at    = excluded.updated_at`.replace(
        /<better>/g,
        `(excluded.score > tournament_entries.score
           OR (excluded.score = tournament_entries.score
               AND excluded.to_par < tournament_entries.to_par)
           OR (excluded.score = tournament_entries.score
               AND excluded.to_par = tournament_entries.to_par
               AND excluded.strokes < tournament_entries.strokes))`,
      ),
    )
      .bind(crypto.randomUUID(), id, me.id, score, toPar, strokes, now, now)
      .run();

    // Read-after-write: the persisted best may be a prior, better run. A row
    // is guaranteed here — we just upserted one.
    const entryRow = await c.env.DB.prepare(
      `SELECT score, to_par AS toPar, strokes, created_at AS createdAt
         FROM tournament_entries WHERE tournament_id = ? AND user_id = ?`,
    )
      .bind(id, me.id)
      .first<{
        score: number;
        toPar: number | null;
        strokes: number | null;
        createdAt: number;
      }>();

    const rank = entryRow ? await tournamentRank(c.env.DB, id, entryRow) : 1;

    const entrantsRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM tournament_entries WHERE tournament_id = ?`,
    )
      .bind(id)
      .first<{ n: number }>();

    return c.json({
      entry: {
        score: entryRow?.score ?? score,
        toPar: entryRow?.toPar ?? toPar,
        strokes: entryRow?.strokes ?? strokes,
        rank,
      },
      entrants: entrantsRow?.n ?? 0,
      improved,
    });
  });

  // GET /game/tournament/leaderboard?scope=global|friends — top 25 for the
  // current event, ordered score DESC, to_par ASC. Both scopes drop blocked
  // users; `friends` additionally restricts to the caller + their contacts,
  // `global` (default) shows everyone.
  app.get('/game/tournament/leaderboard', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const friends = c.req.query('scope') === 'friends';
    const id = currentPeriodIndex(Date.now());

    // Contact-scope clause is present only for the friends board; the block
    // filter applies to both.
    const scopeClause = friends
      ? `AND (t.user_id = ? OR t.user_id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))`
      : '';
    const binds: unknown[] = [id];
    if (friends) binds.push(me.id, me.id);
    binds.push(me.id); // block filter

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key,
              ufr.cosmetic_id AS frame,
              t.score AS score, t.to_par AS to_par, t.strokes AS strokes
         FROM tournament_entries t JOIN users u ON u.id = t.user_id
         LEFT JOIN user_equipped ufr ON ufr.user_id = u.id AND ufr.slot = 'frame'
        WHERE t.tournament_id = ?
          ${scopeClause}
          AND t.user_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
        ORDER BY t.score DESC, t.to_par ASC, t.strokes ASC, t.created_at ASC
        LIMIT 25`,
    )
      .bind(...binds)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        frame: string | null;
        score: number;
        to_par: number | null;
        strokes: number | null;
      }>();

    const origin = new URL(c.req.url).origin;
    const entries = (rows.results ?? []).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      frame: normalizeFrame(r.frame),
      score: r.score,
      toPar: r.to_par,
      strokes: r.strokes,
      mine: r.id === me.id,
    }));
    return c.json({ entries });
  });

  // GET /game/tournament/me — the caller's cumulative trophy tally (default
  // zeros) plus their recent placements, for the profile page.
  app.get('/game/tournament/me', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const tally = await c.env.DB.prepare(
      `SELECT trophies, golds, podiums, best_rank AS bestRank, events_played AS eventsPlayed
         FROM tournament_trophies WHERE user_id = ?`,
    )
      .bind(me.id)
      .first<{
        trophies: number;
        golds: number;
        podiums: number;
        bestRank: number | null;
        eventsPlayed: number;
      }>();

    const placementRows = await c.env.DB.prepare(
      `SELECT p.tournament_id AS tournamentId, p.rank, p.trophies,
              p.created_at AS createdAt, tt.closes_at AS closesAt
         FROM tournament_placements p
         JOIN tournaments tt ON tt.id = p.tournament_id
        WHERE p.user_id = ?
        ORDER BY p.created_at DESC
        LIMIT 20`,
    )
      .bind(me.id)
      .all<{
        tournamentId: number;
        rank: number;
        trophies: number;
        createdAt: number;
        closesAt: number;
      }>();

    return c.json({
      trophies: {
        trophies: tally?.trophies ?? 0,
        golds: tally?.golds ?? 0,
        podiums: tally?.podiums ?? 0,
        bestRank: tally?.bestRank ?? null,
        eventsPlayed: tally?.eventsPlayed ?? 0,
      },
      placements: (placementRows.results ?? []).map((r) => ({
        tournamentId: r.tournamentId,
        rank: r.rank,
        trophies: r.trophies,
        closesAt: r.closesAt,
        createdAt: r.createdAt,
      })),
    });
  });

  return app;
}
