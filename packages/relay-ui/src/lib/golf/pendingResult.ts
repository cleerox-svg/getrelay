// A finished Daily Challenge / Rapid Tournament score that has NOT reached the
// server yet.
//
// WHY THIS EXISTS. The result used to be plain `GolfScreen` component state:
// holing out the daily and then tapping another tab unmounted the screen, and
// the score went with it — never POSTed, no error, nothing told the player, and
// the day's entry was spent. localStorage is the established idiom for golf's
// own-player data (see `stats.ts`), so a pending result is written to it the
// moment the hole is carded and only removed once the POST has RESOLVED. The
// next mount reads it back and submits it.
//
// WHY THE RECORD CARRIES AN `id`. Exactly-once has to survive a remount, and
// the guards it used to rely on (`submittingRef` in `GolfDaily` /
// `GolfTournaments`) are object-identity checks that live for one mount: read
// the same score back off localStorage and it is a different object, so the
// guard passes and the POST goes out twice. The id is a stable name for one
// ATTEMPT, so:
//   • `submitPendingResult` can recognise a record whose POST is already in
//     flight and hand back the SAME promise instead of issuing a second request
//     — the caller still gets the real server response, so a remount mid-flight
//     keeps its "saving…" → "new best!" feedback;
//   • `clearPending` only drops the record still sitting in the slot, so a
//     late-resolving POST cannot delete a NEWER attempt the player has since
//     played.
// A failed POST releases the in-flight claim, so Retry (and every later mount)
// can try again. There is deliberately no persisted "in flight" flag: a claim
// that outlived the page would strand a result forever, and a reload is
// precisely when an interrupted request SHOULD be retried.
//
// WHY THE RECORD ALSO CARRIES A `tag`. Persistence introduced a hazard the
// old lose-it-on-unmount behaviour did not have: a record can now outlive the
// CHALLENGE it was played on. Offline through the midnight rollover and
// yesterday's hole would be POSTed as today's attempt — the endpoints take only
// {strokes,toPar} and file against whatever is current — which pollutes another
// day's board and is worse than the score merely being absent. The tag is the
// challenge's / event's `seed`, which the server derives from the period, so it
// IS that period's identity. A consumer submits only on a tag match and
// `dropStalePending` deletes the rest. A record with no tag can only come from
// the pre-tag build, so `readPending` rejects it rather than guessing.
//
// DETERMINISM. The id comes from a persisted counter, not `Date.now()` /
// `Math.random()` — neither is allowed anywhere a render can reach it (the
// screenshot gate is exact-pixel).

/** Which flow owns a pending result. One slot per kind: they are independent. */
export type PendingKind = 'daily' | 'tournament';

export interface PendingResult {
  kind: PendingKind;
  /** Stable identity of this attempt; survives a remount (see the header). */
  id: number;
  /** The challenge/event this score was played on — its seed. See the header. */
  tag: string;
  strokes: number;
  toPar: number;
}

/** The score a pending result submits — the body both endpoints take. */
export interface PendingScore {
  strokes: number;
  toPar: number;
}

const KEYS: Record<PendingKind, string> = {
  daily: 'relay.golfPendingDaily',
  tournament: 'relay.golfPendingTourney',
};

/** Monotonic attempt counter, shared by both kinds so no two ids collide. */
const SEQ_KEY = 'relay.golfPendingSeq';

/**
 * The next attempt id. EXPORTED because `pendingScore.ts` (the queue for board /
 * challenge submits) draws its entry ids from this same counter: one counter
 * across every unsent golf result means an id names exactly one attempt, which
 * is what makes the once-only claim survive a remount.
 */
export function nextPendingId(): number {
  let n = 0;
  try {
    n = Number(localStorage.getItem(SEQ_KEY)) || 0;
  } catch {
    /* private mode — ids restart, which only weakens dedupe within a session */
  }
  const id = (Number.isFinite(n) ? n : 0) + 1;
  try {
    localStorage.setItem(SEQ_KEY, String(id));
  } catch {
    /* ignored — see above */
  }
  return id;
}

/** The pending result for `kind`, or null. Rejects a partial / corrupt record. */
export function readPending(kind: PendingKind): PendingResult | null {
  try {
    const raw = localStorage.getItem(KEYS[kind]);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PendingResult>;
    if (
      typeof p.id !== 'number' ||
      typeof p.tag !== 'string' ||
      typeof p.strokes !== 'number' ||
      typeof p.toPar !== 'number'
    )
      return null;
    return { kind, id: p.id, tag: p.tag, strokes: p.strokes, toPar: p.toPar };
  } catch {
    return null;
  }
}

/**
 * Persist a just-finished score as the pending result for `kind` and return the
 * record (with its fresh id) for the caller to hold in state. Replaces any
 * earlier pending result of the same kind — a replay supersedes it. `tag` is the
 * challenge/event seed this score was played on (see the header).
 */
export function writePending(
  kind: PendingKind,
  score: PendingScore,
  tag: string | number,
): PendingResult {
  const rec: PendingResult = {
    kind,
    id: nextPendingId(),
    tag: String(tag),
    strokes: score.strokes,
    toPar: score.toPar,
  };
  try {
    localStorage.setItem(KEYS[kind], JSON.stringify(rec));
  } catch {
    /* private mode — the result stays in component state for this mount only */
  }
  return rec;
}

/**
 * Drop the pending result for `kind`. With an `id`, only if THAT attempt is
 * still the one in the slot (so a late POST can't wipe a newer attempt).
 */
export function clearPending(kind: PendingKind, id?: number): void {
  if (id != null) {
    const cur = readPending(kind);
    if (cur && cur.id !== id) return;
  }
  try {
    localStorage.removeItem(KEYS[kind]);
  } catch {
    /* nothing to do — the read side treats an unreadable slot as empty */
  }
}

/**
 * Delete the pending result for `kind` if it was played on a DIFFERENT
 * challenge/event than the live one (`tag`), and report whether it went. A
 * stranded record has to be deleted, not just skipped: it would otherwise steer
 * the hub's opening tab forever and could never be filed correctly — the POST
 * body carries no date, so the server would credit it to the CURRENT period.
 */
export function dropStalePending(kind: PendingKind, tag: string | number): boolean {
  const cur = readPending(kind);
  if (!cur || cur.tag === String(tag)) return false;
  clearPending(kind, cur.id);
  return true;
}

/**
 * In-flight POSTs by kind. Module scope on purpose: that is what makes the
 * once-only guarantee outlive a component's mount, which is the whole bug.
 */
const inFlight = new Map<PendingKind, { id: number; p: Promise<unknown> }>();

/**
 * POST `rec` at most once. A second call for the same attempt while the first
 * is still in flight gets the FIRST promise back — one request, and both
 * callers see the real response. Clears the stored record on success; releases
 * the claim on failure so a Retry (or the next mount) can try again.
 */
export function submitPendingResult<T>(
  rec: PendingResult,
  post: (score: PendingScore) => Promise<T>,
): Promise<T> {
  const live = inFlight.get(rec.kind);
  if (live && live.id === rec.id) return live.p as Promise<T>;

  const p = post({ strokes: rec.strokes, toPar: rec.toPar }).then((res) => {
    clearPending(rec.kind, rec.id);
    return res;
  });
  inFlight.set(rec.kind, { id: rec.id, p });
  // Release the claim once settled, either way — but only if a newer attempt
  // hasn't already replaced it.
  void p.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    if (inFlight.get(rec.kind)?.p === p) inFlight.delete(rec.kind);
  });
  return p;
}
