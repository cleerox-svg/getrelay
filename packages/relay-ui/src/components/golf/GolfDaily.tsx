import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '../../lib/api';
import { useEconomy } from '../../lib/golf/economy';
import { resolveFrameById } from '../../lib/golf/cosmetics';
import { getCourse } from '../../lib/golf/courses';
import { submitPendingResult, type PendingResult } from '../../lib/golf/pendingResult';
import { withTimeout } from '../../lib/golf/loadState';
import { LoadFailure, RetryButton } from './shared/LoadFailure';
import { MEDALS, fmtToPar } from './shared/scoreFormat';
import type {
  DailyChallenge,
  DailyLeaderboardEntry,
} from '../../lib/types';

interface Props {
  // Launch the daily's Course hole. GolfScreen threads course/holeIdx/seed
  // through its existing free-screen Course path (the same wiring the friend
  // challenge uses: CourseGame gets course + startHole + seed). holeIdx is the
  // 0-based index into course.holes.
  onPlay: (courseId: string, holeIdx: number, seed: number) => void;
  // The PERSISTED pending result (lib/golf/pendingResult): set by GolfScreen when
  // a daily round finishes, or read back off localStorage on a later mount if the
  // POST never landed. We POST it here, show the updated streak / "improved!"
  // state, then call onResultConsumed so it isn't submitted twice.
  pendingResult: PendingResult | null;
  onResultConsumed: () => void;
}

// The Daily sub-tab of the golf hub. Fetches today's challenge on mount, lets
// the player launch it as a seeded single Course hole, submits the finishing
// score, and shows the streak flame + today's leaderboard. Every request
// degrades gracefully — a failed fetch shows a "needs connection" state rather
// than crashing.
export function GolfDaily({ onPlay, pendingResult, onResultConsumed }: Props) {
  const [daily, setDaily] = useState<DailyChallenge | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [improved, setImproved] = useState<boolean | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');

  const [board, setBoard] = useState<DailyLeaderboardEntry[] | null>(null);
  const [boardError, setBoardError] = useState(false);

  // Load the cosmetics catalog once so any row's equipped frame id resolves to a
  // visual. Degrades gracefully — no catalog yet → frames just don't render.
  const catalog = useEconomy((s) => s.catalog);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  useEffect(() => {
    void ensureCosmetics();
  }, [ensureCosmetics]);

  // Fetch today's challenge on mount / retry. Unauthed (401) or offline lands in
  // the "needs connection" state.
  useEffect(() => {
    let cancelled = false;
    setDaily(null);
    setLoadError(false);
    // Timed out, so a hung request becomes a retryable error instead of a
    // permanent spinner (same rule as GolfTournaments).
    withTimeout(api.getDaily())
      .then((d) => {
        if (!cancelled) setDaily(d);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const loadBoard = useCallback(() => {
    setBoardError(false);
    withTimeout(api.getDailyLeaderboard())
      .then((r) => setBoard(r.entries))
      .catch(() => setBoardError(true));
  }, []);

  // Load the leaderboard once we know the player has a result today (either
  // fetched or just submitted) — that's when the board is worth showing.
  const playedToday = daily?.today != null;
  useEffect(() => {
    if (playedToday) loadBoard();
  }, [playedToday, loadBoard]);

  // Submit a finished round. Keeps the server's read-after-write today + streak
  // and badges "improved!"; refreshes the leaderboard. Retryable on failure.
  const submitPending = useCallback(
    (res: PendingResult) => {
      setSubmitState('saving');
      // Via pendingResult's once-only guard, NOT api directly: the submittingRef
      // below dies with this mount, so a remount mid-flight would re-POST.
      submitPendingResult(res, (b) => api.postDailyResult(b))
        .then((r) => {
          setDaily((prev) =>
            prev ? { ...prev, today: r.today, streak: r.streak } : prev,
          );
          setImproved(r.improved);
          setSubmitState('done');
          loadBoard();
          onResultConsumed();
        })
        .catch(() => setSubmitState('error'));
    },
    [loadBoard, onResultConsumed],
  );

  // A result is only submittable once we can PROVE it belongs to the challenge
  // now live: the record is persisted, so it can outlive the day (offline), and
  // the POST body carries no date — yesterday's hole would be filed as today's
  // attempt. Waiting for the fetch costs nothing, since a server we can't reach
  // can't take the POST either; GolfScreen evicts a mismatched record.
  const current = daily && pendingResult?.tag === String(daily.seed) ? pendingResult : null;

  // Fire the submit exactly once per pending result object (identity-guarded so
  // a re-render doesn't re-POST). GolfScreen clears pendingResult via
  // onResultConsumed on success, so a failed submit leaves it for the Retry.
  const submittingRef = useRef<PendingResult | null>(null);
  useEffect(() => {
    if (current && submittingRef.current !== current) {
      submittingRef.current = current;
      submitPending(current);
    }
  }, [current, submitPending]);

  // ---- Loading / needs-connection states ----
  if (loadError) {
    return (
      <LoadFailure
        title="Daily needs a connection."
        detail="Couldn’t reach today’s challenge."
        onRetry={() => setAttempt((a) => a + 1)}
      />
    );
  }
  if (!daily) {
    return <div className="golf-empty">Loading today’s challenge…</div>;
  }

  // Resolve the daily's 1-based hole number to a 0-based index. Course holes are
  // authored with a 1-based `id`, so match on that; fall back to hole-1.
  const course = getCourse(daily.course);
  const byId = course.holes.findIndex((h) => h.id === daily.hole);
  const holeIdx = byId >= 0 ? byId : daily.hole - 1;
  const holeMeta = course.holes[holeIdx];
  const playable = !!holeMeta;

  const today = daily.today;
  const streak = daily.streak;

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Today's challenge card ---- */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
      >
        <div className="flex items-start justify-between gap-3 p-4">
          <div className="min-w-0">
            <div
              className="text-[10px] font-bold uppercase tracking-wider"
              style={{ color: 'var(--text-dim)' }}
            >
              Daily Challenge · {daily.date}
            </div>
            <div className="text-lg font-extrabold" style={{ color: 'var(--text)' }}>
              {course.name}
            </div>
            <div className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
              Hole {holeMeta?.id ?? daily.hole}
              {holeMeta?.name ? ` · ${holeMeta.name}` : ''}
              {holeMeta ? ` · Par ${holeMeta.par} · ${holeMeta.yards} yd` : ''}
            </div>
          </div>
          {/* Streak flame: current 🔥 + best. Subtle when the streak is 0. */}
          <div
            className="shrink-0 flex flex-col items-center rounded-xl px-3 py-1.5"
            style={{
              background:
                streak.current > 0
                  ? 'color-mix(in srgb, #f0842e 18%, transparent)'
                  : 'var(--bubble-them)',
            }}
            title={`Current streak ${streak.current} · best ${streak.best}`}
          >
            <span className="text-lg font-extrabold tabular-nums" style={{ color: 'var(--text)' }}>
              <span aria-hidden="true">🔥</span> {streak.current}
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-dim)' }}>
              best {streak.best}
            </span>
          </div>
        </div>

        {/* Today's result (already played) — strokes / to-par / score. */}
        {today ? (
          <div
            className="grid grid-cols-3 divide-x px-4 py-3"
            style={{ borderTop: '1px solid var(--separator)', borderColor: 'var(--separator)' }}
          >
            <DailyStat label="Strokes" value={`${today.strokes}`} />
            <DailyStat
              label="To par"
              value={fmtToPar(today.toPar)}
              accent={today.toPar < 0}
            />
            <DailyStat label="Score" value={today.score.toLocaleString()} />
          </div>
        ) : null}

        {/* "Improved!" badge after a successful submit. */}
        {submitState === 'done' && improved ? (
          <div
            className="px-4 pb-2 text-[13px] font-bold"
            style={{ color: 'var(--golf-accent)' }}
          >
            🎉 New best for today!
          </div>
        ) : null}
        {submitState === 'done' && improved === false ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Kept your earlier best for today.
          </div>
        ) : null}
        {submitState === 'saving' ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Saving your score…
          </div>
        ) : null}
        {submitState === 'error' && current ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--ping)' }}>
            Couldn’t submit.
            <RetryButton className="ml-2" onClick={() => submitPending(current)} />
          </div>
        ) : null}

        {/* Play / Replay CTA. Server keeps the BEST, so replay is safe. */}
        <div className="px-4 pb-4 pt-1">
          <button
            type="button"
            className="golf-cta w-full rounded-xl py-3 text-[15px] font-bold"
            disabled={!playable}
            style={playable ? undefined : { opacity: 0.5, cursor: 'not-allowed' }}
            onClick={() => playable && onPlay(daily.course, holeIdx, daily.seed)}
          >
            <span className="g-sheen" aria-hidden="true" />
            {today ? 'Play again' : 'Play today’s hole'}
          </button>
          {!playable ? (
            <div className="pt-2 text-center text-[12px]" style={{ color: 'var(--text-dim)' }}>
              This hole isn’t available in your app version.
            </div>
          ) : null}
        </div>
      </div>

      {/* ---- Today's leaderboard (once the player has a score) ---- */}
      {playedToday ? (
        <div className="flex flex-col gap-2">
          <div
            className="text-[10px] font-bold uppercase tracking-wider px-1"
            style={{ color: 'var(--text-dim)' }}
          >
            Today’s leaderboard
          </div>
          {boardError ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              Couldn’t load the leaderboard.
              <RetryButton className="block mx-auto mt-2" onClick={loadBoard} />
            </div>
          ) : board === null ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              Loading…
            </div>
          ) : board.length === 0 ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              You’re first on the board today.
            </div>
          ) : (
            <div
              className="rounded-2xl overflow-hidden"
              style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
            >
              {board.map((e, i) => (
                <div
                  key={e.userId}
                  className="flex items-center gap-3 px-3 py-2"
                  style={{
                    borderTop: i > 0 ? '1px solid var(--separator)' : undefined,
                    background: e.mine
                      ? 'color-mix(in srgb, var(--golf-accent) 12%, transparent)'
                      : undefined,
                  }}
                >
                  <span
                    className="w-6 text-center text-sm font-bold tabular-nums shrink-0"
                    style={{ color: i < 3 ? MEDALS[i] : 'var(--text-dim)' }}
                  >
                    {i + 1}
                  </span>
                  <Avatar
                    src={e.avatarUrl}
                    name={e.displayName}
                    size={32}
                    frame={resolveFrameById(catalog, e.frame)}
                  />
                  <span
                    className="flex-1 min-w-0 truncate text-sm font-semibold"
                    style={{ color: 'var(--text)' }}
                  >
                    {e.displayName}
                    {e.mine ? (
                      <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-dim)' }}>
                        (you)
                      </span>
                    ) : null}
                  </span>
                  <span
                    className="text-sm font-bold tabular-nums w-10 text-right"
                    style={{ color: e.toPar < 0 ? 'var(--golf-accent)' : 'var(--text)' }}
                  >
                    {fmtToPar(e.toPar)}
                  </span>
                  <span
                    className="text-xs tabular-nums w-14 text-right shrink-0"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    {e.strokes} stroke{e.strokes === 1 ? '' : 's'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

// One stat cell in the "today's result" strip.
function DailyStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col items-center px-1 text-center">
      <span
        className="text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        {label}
      </span>
      <span
        className="text-xl font-extrabold tabular-nums"
        style={{ color: accent ? 'var(--golf-accent)' : 'var(--text)' }}
      >
        {value}
      </span>
    </div>
  );
}
