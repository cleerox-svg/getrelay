import type { Env } from './env';
import { addXp, awardCoins } from './economy';
import { pushToUser } from './push';

// ---- Rapid Tournaments -----------------------------------------------------
//
// Global, seeded 3-hole stroke-play events. Like the Daily Challenge, an
// event is DERIVED from a period index (no cron creates it) — the same index
// always maps to the same seed / holes / window. A `tournaments` row is
// materialised LAZILY on the first result so settlement has a concrete row to
// rank and mark awarded. This module is the single source of truth for the
// derivation (shared by the endpoints in games.ts and the settlement pass).

// A "rapid" event rotates every 2 days. Tunable — everything downstream reads
// the period index, so changing this only changes how often events roll over.
export const TOURNEY_PERIOD_MS = 48 * 3600 * 1000; // 48h

// Fixed anchor for period 0 (UTC). Stable forever — moving it would renumber
// every event, so it is pinned here and never derived from "now".
export const TOURNEY_EPOCH = Date.UTC(2024, 0, 1); // 2024-01-01T00:00:00Z

// Rotation of { course, hole } the event derivation draws its 3 holes from,
// selected by a seed-derived offset (so holes may span courses). Course ids are
// the real Relay Course-mode ids (see relay-ui GOLF_COURSES). Hole counts
// DIFFER per course: augusta has 18 holes (1..18), each listowel-* course has
// only 9 (1..9) — every entry below must be within its own course's count.
// A rotation entry pointing past its course's hole count makes an event
// unplayable, which is exactly the bug that bit the Daily Challenge, so the
// tournaments test guards this with a hardcoded {augusta:18, listowel-*:9}
// check. UI agent: confirm these ids/holes still match the client course
// registry.
export const TOURNEY_ROTATION: readonly { course: string; hole: number }[] = [
  { course: 'augusta', hole: 1 },
  { course: 'listowel-vintage', hole: 2 },
  { course: 'augusta', hole: 7 },
  { course: 'listowel-heritage', hole: 4 },
  { course: 'augusta', hole: 11 },
  { course: 'listowel-millennium', hole: 6 },
  { course: 'augusta', hole: 13 },
  { course: 'listowel-vintage', hole: 8 },
  { course: 'augusta', hole: 16 },
  { course: 'listowel-heritage', hole: 9 },
  { course: 'augusta', hole: 18 },
  { course: 'listowel-millennium', hole: 3 },
] as const;

export interface TourneyHole {
  course: string;
  hole: number;
}

// Whole periods since the epoch for an epoch-ms instant. This is the event id
// (tournaments.id INTEGER PK). Stable and monotonic across time.
export function currentPeriodIndex(now: number): number {
  return Math.floor((now - TOURNEY_EPOCH) / TOURNEY_PERIOD_MS);
}

// The open/close window bounding a period index (ms epoch). Half-open:
// [openedAt, closesAt).
export function periodWindow(idx: number): { openedAt: number; closesAt: number } {
  const openedAt = TOURNEY_EPOCH + idx * TOURNEY_PERIOD_MS;
  return { openedAt, closesAt: openedAt + TOURNEY_PERIOD_MS };
}

// Deterministic 32-bit hash of the period index -> stable non-negative seed.
// FNV-1a over the decimal digits of the index, folded to 0..2^31-1 so it
// matches game_challenges.seed / daily_results.seed range. Mirrors dailySeed.
export function tournamentSeed(idx: number): number {
  const s = String(idx);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 0x80000000;
}

// The 3 holes played for a period index — three consecutive rotation entries
// starting at a seed-derived offset. Deterministic, and because the rotation
// alternates courses the trio spans multiple courses.
export function tournamentHoles(idx: number): TourneyHole[] {
  const len = TOURNEY_ROTATION.length;
  const start = tournamentSeed(idx) % len;
  return [0, 1, 2].map((i) => {
    const rot = TOURNEY_ROTATION[(start + i) % len]!;
    return { course: rot.course, hole: rot.hole };
  });
}

// Trophy points awarded for a finishing rank. `fieldSize` is passed for future
// field-relative tuning, but the tiers are rank-absolute for now:
//   1st = 100, 2-3 = 60, 4-10 = 30, 11-50 = 10, else = 5.
export function trophyAward(rank: number, _fieldSize: number): number {
  if (rank <= 1) return 100;
  if (rank <= 3) return 60;
  if (rank <= 10) return 30;
  if (rank <= 50) return 10;
  return 5;
}

// Coins awarded for a finishing rank, mirroring trophyAward's tiers but scaled
// for the economy: 1st = 500, 2-3 = 300, 4-10 = 150, 11-50 = 50, else = 20.
// `fieldSize` is accepted for future field-relative tuning (rank-absolute now).
export function coinAward(rank: number, _fieldSize: number): number {
  if (rank <= 1) return 500;
  if (rank <= 3) return 300;
  if (rank <= 10) return 150;
  if (rank <= 50) return 50;
  return 20;
}

// English ordinal for a rank ("1st", "2nd", "3rd", "11th", ...). Used in the
// placement push copy.
export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

interface EntryRow {
  user_id: string;
  score: number;
  to_par: number | null;
  strokes: number | null;
}

// Settlement pass — called every minute by the worker's scheduled handler.
// For each closed, unsettled tournament: rank its entries (score DESC, to_par
// ASC tiebreak), write one tournament_placements row per finisher, bump each
// finisher's cumulative tournament_trophies, then flip tournaments.settled = 1.
//
// Idempotent on two levels: the `settled` flag means a settled event is never
// re-scanned, and — should a run be interrupted after some placements are
// written but before settled flips — the placements UNIQUE(tournament_id,
// user_id) turns the INSERT into a no-op and we only bump trophies for the
// placement that was ACTUALLY inserted this pass (meta.changes === 1). Running
// the whole pass twice therefore yields identical tallies.
export async function runTournamentCron(env: Env): Promise<void> {
  const now = Date.now();
  const due = await env.DB.prepare(
    `SELECT id FROM tournaments WHERE closes_at < ? AND settled = 0`,
  )
    .bind(now)
    .all<{ id: number }>();

  for (const t of due.results ?? []) {
    try {
      await settleTournament(env, t.id, now);
    } catch (err) {
      // One event's failure must not block the others — leave it unsettled so
      // the next tick retries it.
      console.error(`tournament ${t.id} settlement failed:`, err);
    }
  }
}

async function settleTournament(env: Env, tournamentId: number, now: number): Promise<void> {
  const entries = await env.DB.prepare(
    `SELECT user_id, score, to_par, strokes
       FROM tournament_entries
      WHERE tournament_id = ?
      ORDER BY score DESC, to_par ASC, strokes ASC, created_at ASC`,
  )
    .bind(tournamentId)
    .all<EntryRow>();

  const rows = entries.results ?? [];
  const fieldSize = rows.length;

  for (let i = 0; i < rows.length; i++) {
    const e = rows[i]!;
    const rank = i + 1;
    const award = trophyAward(rank, fieldSize);

    // INSERT OR IGNORE is the idempotency guard: a re-run (or interrupted
    // retry) finds the placement already present and changes nothing.
    const placed = await env.DB.prepare(
      `INSERT OR IGNORE INTO tournament_placements
         (id, tournament_id, user_id, rank, trophies, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(crypto.randomUUID(), tournamentId, e.user_id, rank, award, now)
      .run();

    // Only bump the cumulative tally when THIS pass actually created the
    // placement — otherwise a retry would double-count trophies.
    if ((placed.meta?.changes ?? 0) < 1) continue;

    // Economy earn + placement push. This seam runs EXACTLY once per finisher
    // (guarded by the placement INSERT above), and the awards are additionally
    // ref-guarded by (user, reason, tournamentId) — double safety. The WHOLE
    // block is wrapped: an award or push failure must NOT abort settlement,
    // otherwise `settled` never flips and the retry's INSERT OR IGNORE skips
    // this finisher forever — losing BOTH their coins and their trophy tally.
    // So the trophy insert + settled=1 below always complete; a failed award is
    // ref-guarded and will re-credit on a later manual replay if needed.
    const coins = coinAward(rank, fieldSize);
    try {
      await awardCoins(env, e.user_id, coins, 'tournament_placement', String(tournamentId));
      await addXp(env, e.user_id, coins, 'tournament_placement', String(tournamentId));
      // Fans out to Web Push + FCM (no-ops if unconfigured).
      await pushToUser(env, e.user_id, {
        title: 'Rapid Tournament',
        body: `You placed ${ordinal(rank)} — +${coins} coins`,
        tag: `tourney-${tournamentId}`,
        url: '/games/golf/tournaments',
      });
    } catch (err) {
      console.error(`tournament ${tournamentId} placement award/push failed for ${e.user_id}:`, err);
    }

    await env.DB.prepare(
      `INSERT INTO tournament_trophies
         (user_id, trophies, golds, podiums, best_rank, events_played, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         trophies      = tournament_trophies.trophies + excluded.trophies,
         golds         = tournament_trophies.golds + excluded.golds,
         podiums       = tournament_trophies.podiums + excluded.podiums,
         best_rank     = CASE
                           WHEN tournament_trophies.best_rank IS NULL
                             OR excluded.best_rank < tournament_trophies.best_rank
                           THEN excluded.best_rank
                           ELSE tournament_trophies.best_rank
                         END,
         events_played = tournament_trophies.events_played + excluded.events_played,
         updated_at    = excluded.updated_at`,
    )
      .bind(e.user_id, award, rank === 1 ? 1 : 0, rank <= 3 ? 1 : 0, rank, now, now)
      .run();
  }

  await env.DB.prepare(`UPDATE tournaments SET settled = 1 WHERE id = ?`)
    .bind(tournamentId)
    .run();
}
