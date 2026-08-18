// Unsent LEADERBOARD and CHALLENGE submits — a persisted retry queue.
//
// WHY THIS EXISTS. Four golf submit paths were written as
// `api.submitGameScore(...).catch(() => undefined)` and one as
// `Promise.allSettled([...]).then(refetch).catch(() => undefined)`. Every one of
// them turns a rejected POST into silence:
//
//   • `ChallengeCard` — `Promise.allSettled` NEVER REJECTS, so a rejected
//     `submitChallengeResult` flowed straight into the `.then()`, the card
//     refetched and re-rendered the player's score as `—`, i.e. as though the
//     round had never been played. Nothing was persisted, so the round was gone:
//     no retry, no local record, no message.
//   • `GolfScreen`'s mini-golf / range results effects and `postCourseRound` —
//     the local personal best survived (`recordGolfGame`/`recordRangeGame` write
//     first) but the BOARD entry did not, and the exactly-once ref meant it was
//     never retried on that mount. A full 18-hole Course round is the most
//     expensive thing a player can lose.
//   • `GolfGame` / `RangeGame`'s unmount "abandon safety net" — same, and that
//     path may not `setState` at all (the whole route may be unmounting), so it
//     cannot show an error or hold a retry in component state.
//
// So the result is WRITTEN TO localStorage before the POST goes out and removed
// only once the POST has RESOLVED. A failure leaves the entry on disk and the
// next `GolfScreen` mount flushes it. That is the same idiom, and deliberately
// so, as `pendingResult.ts` — which this module draws its ids from.
//
// ⚠ WHY NOT JUST USE `pendingResult.ts`. Three of its shape decisions are load
// -bearing for the daily/tournament flow and WRONG here:
//
//   1. ONE SLOT PER KIND vs a QUEUE. A daily/tournament attempt SUPERSEDES the
//      previous one — one entry per period, a replay replaces it — so
//      `writePending` overwrites. Board and challenge submits do not supersede:
//      an abandoned mini-golf run, a range run, a full Course round and a
//      challenge result can all be unsent at once and each is a distinct row.
//      A single slot would silently drop all but the last, which is the bug.
//   2. `tag` IS A PERIOD IDENTITY, AND THE STALE POLICY IS INVERTED. `readPending`
//      rejects an untagged record and `dropStalePending` DELETES one whose tag
//      no longer matches, because `/game/daily` files against whatever period is
//      current — yesterday's hole posted as today's is worse than absent. Neither
//      endpoint here is period-scoped: the challenge id is IN the URL, and a game
//      score is a standalone board row. There is no tag to carry, and an old
//      entry must be RETRIED, not deleted.
//   3. THE PAYLOAD. `PendingScore` is exactly `{strokes,toPar}`, the body both
//      period endpoints take, and `submitPendingResult`'s
//      `post: (score: PendingScore) => …` cannot express `submitGameScore`'s
//      `{score,rounds,bestStreak,game,course?,toPar?}` or a challenge result's
//      `(challengeId, toPar)`.
//
// What IS shared: the id counter (`nextPendingId`), so an id names exactly one
// attempt across BOTH mechanisms, and the same claim semantics — one request per
// id, the second caller gets the first promise, clear on success, RELEASE THE
// CLAIM ON FAILURE so a retry (or the next mount) can try again. There is no
// persisted "in flight" flag: a claim that outlived the page would strand an
// entry forever, and a reload is exactly when an interrupted request should be
// retried.
//
// DETERMINISM. Ids come from the persisted counter, never `Date.now()` /
// `Math.random()`. Entries carry no timestamp for the same reason.
//
// ⚠ Unlike `pendingResult.ts` this module imports `api` directly rather than
// taking a `post` callback. It has to: the FLUSH is what makes a failure
// recoverable, and only this module knows how to turn a queued entry back into
// the right request. A caller-supplied `post` would mean the flush could not
// exist.

import { api } from '../api';
import { nextPendingId } from './pendingResult';

/** The `submitGameScore` body, tracked off the client so it cannot drift. */
export type GameScoreBody = Parameters<typeof api.submitGameScore>[0];

/** One unsent submit. `id` is a stable name for this attempt (see the header). */
export type PendingScoreEntry =
  | { id: number; kind: 'game'; body: GameScoreBody }
  | { id: number; kind: 'challenge'; challengeId: string; toPar: number };

const KEY = 'relay.golfPendingScores';

/**
 * Hard cap on the queue. A device that has been offline for a week must not grow
 * localStorage without bound; past this the OLDEST entry goes, because the
 * oldest is the one most likely to be permanently unsendable (a deleted
 * challenge, a revoked account) while the newest is the round just played.
 */
const MAX_QUEUE = 24;

function isEntry(v: unknown): v is PendingScoreEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Partial<PendingScoreEntry> & { body?: unknown };
  if (typeof e.id !== 'number') return false;
  if (e.kind === 'game') return !!e.body && typeof e.body === 'object';
  if (e.kind === 'challenge') {
    const c = e as Extract<PendingScoreEntry, { kind: 'challenge' }>;
    return typeof c.challengeId === 'string' && typeof c.toPar === 'number';
  }
  return false;
}

/** Every queued entry, oldest first. A corrupt slot reads as empty. */
export function readPendingScores(): PendingScoreEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function writeQueue(q: PendingScoreEntry[]): void {
  try {
    if (q.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(q));
  } catch {
    /* private mode — the entry lives for this mount only, same as writePending */
  }
}

/**
 * Persist a submit that has NOT gone out yet and return it with its fresh id.
 * Call this BEFORE the POST, so the result survives the POST failing.
 */
export function enqueuePendingScore(
  e:
    | { kind: 'game'; body: GameScoreBody }
    | { kind: 'challenge'; challengeId: string; toPar: number },
): PendingScoreEntry {
  const entry = { ...e, id: nextPendingId() } as PendingScoreEntry;
  const q = readPendingScores();
  q.push(entry);
  writeQueue(q.slice(-MAX_QUEUE));
  return entry;
}

/** Forget one entry by id. Only that id — a late POST can't wipe a newer one. */
export function dropPendingScore(id: number): void {
  const q = readPendingScores();
  const next = q.filter((e) => e.id !== id);
  if (next.length !== q.length) writeQueue(next);
}

/** The queued entries for one challenge, so its card can retry exactly those. */
export function pendingScoresFor(challengeId: string): PendingScoreEntry[] {
  return readPendingScores().filter(
    (e) => e.kind === 'challenge' && e.challengeId === challengeId,
  );
}

/**
 * In-flight POSTs by entry id. Module scope on purpose: that is what makes the
 * once-only guarantee outlive a component's mount. An entry read back off
 * localStorage is a DIFFERENT object but the SAME id, so a per-mount identity
 * ref could never provide this.
 */
const inFlight = new Map<number, Promise<unknown>>();

function postFor(e: PendingScoreEntry): Promise<unknown> {
  return e.kind === 'game'
    ? api.submitGameScore(e.body)
    : api.submitChallengeResult(e.challengeId, e.toPar);
}

/**
 * POST `e` at most once. A second call for the same attempt while the first is
 * still in flight gets the FIRST promise back — one request, both callers see
 * the real response. Drops the stored entry on success; on failure the entry
 * STAYS and the claim is released, so a Retry or the next flush picks it up.
 *
 * ⚠ This REJECTS when the POST rejects. Callers must treat that as a failure —
 * that is the whole point of the change this file exists for.
 */
export function submitPendingScore<T = unknown>(e: PendingScoreEntry): Promise<T> {
  const live = inFlight.get(e.id);
  if (live) return live as Promise<T>;

  const p = postFor(e).then((res) => {
    dropPendingScore(e.id);
    return res;
  });
  inFlight.set(e.id, p);
  void p
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (inFlight.get(e.id) === p) inFlight.delete(e.id);
    });
  return p as Promise<T>;
}

/**
 * Persist a board score and submit it. The returned promise rejects on a failed
 * POST — but the entry is already on disk by then, so `flushPendingScores()`
 * will retry it. Drop-in for `api.submitGameScore` with that one difference.
 */
export function submitGameScoreDurably(
  body: GameScoreBody,
): Promise<{ ok: true; best: number }> {
  return submitPendingScore<{ ok: true; best: number }>(
    enqueuePendingScore({ kind: 'game', body }),
  );
}

/**
 * Retry everything still queued. Call it on mount.
 *
 * `allSettled` is correct HERE and only here: one entry failing must not stop
 * the others being tried, and a failure needs no inspection because the entry
 * simply stays queued for the next flush. It is not a substitute for handling a
 * rejection — see `submitPendingScore`.
 */
export async function flushPendingScores(): Promise<void> {
  const q = readPendingScores();
  if (q.length === 0) return;
  await Promise.allSettled(q.map((e) => submitPendingScore(e)));
}
