import { useCallback, useEffect, useRef, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '../../lib/api';
import { useEconomy } from '../../lib/golf/economy';
import { resolveFrameById } from '../../lib/golf/cosmetics';
import { getCourse } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';
import { synthTournamentCourse } from '../../lib/golf/tournamentCourse';
import { submitPendingResult, type PendingResult } from '../../lib/golf/pendingResult';
import { withTimeout } from '../../lib/golf/loadState';
import { LoadFailure, RetryButton } from './shared/LoadFailure';
import { MEDALS, fmtToPar } from './shared/scoreFormat';
import type {
  Tournament,
  TournamentLeaderboardEntry,
} from '../../lib/types';

// Ordinal-ish rank label ("1st", "2nd", "3rd", "12th").
function fmtRank(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
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

// Format a countdown (ms) as "Hh Mm" / "Mm Ss" / "Ss". Clamps at 0.
function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

// Friendly "Course · Hole n" line for one of the three tournament holes. The
// course id resolves to a real Course-mode name; the 1-based hole no. is shown
// as authored.
function holeLabel(courseId: string, hole: number): { course: string; hole: number; par?: number } {
  const c = getCourse(courseId);
  const h = c.holes[hole - 1];
  return { course: c.name, hole, par: h?.par };
}

interface Props {
  // Launch the seeded 3-hole tournament round. GolfScreen plays the synthesized
  // course as a GUARDED full round (NO startHole) through its Course free screen,
  // and reports the finished ROUND total back via pendingResult below.
  onPlay: (course: GolfCourse, seed: number) => void;
  // The PERSISTED pending result (lib/golf/pendingResult): the round's to-par +
  // total strokes, set by GolfScreen or read back on a later mount if the POST
  // never landed. POSTed here; onResultConsumed then clears GolfScreen's slot.
  pendingResult: PendingResult | null;
  onResultConsumed: () => void;
}

// The Tournaments sub-tab of the golf hub. Fetches the live event on mount, lets
// the player launch it as a seeded 3-hole round, submits the finishing round
// total, and shows the global/friends leaderboard. Every request degrades
// gracefully — a failed fetch shows a "needs connection" state rather than
// crashing.
export function GolfTournaments({ onPlay, pendingResult, onResultConsumed }: Props) {
  const [tourney, setTourney] = useState<Tournament | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const [improved, setImproved] = useState<boolean | null>(null);
  const [submitState, setSubmitState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');

  const [scope, setScope] = useState<'global' | 'friends'>('global');
  const [board, setBoard] = useState<TournamentLeaderboardEntry[] | null>(null);
  const [boardError, setBoardError] = useState(false);

  // Load the cosmetics catalog once so any row's equipped frame id resolves to a
  // visual. Degrades gracefully — no catalog yet → frames just don't render.
  const catalog = useEconomy((s) => s.catalog);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  useEffect(() => {
    void ensureCosmetics();
  }, [ensureCosmetics]);

  // Live countdown. `deadline` is an absolute local timestamp derived from the
  // server's `msLeft` at fetch time (Date.now() + msLeft) so the tick is immune
  // to any device-clock skew against `closesAt`. `now` ticks each second.
  const [now, setNow] = useState(() => Date.now());
  const deadlineRef = useRef<number | null>(null);
  useEffect(() => {
    if (!tourney) return;
    deadlineRef.current = Date.now() + tourney.msLeft;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [tourney]);
  const msLeft = deadlineRef.current != null ? deadlineRef.current - now : (tourney?.msLeft ?? 0);
  const closed = msLeft <= 0;

  // Fetch the live event on mount / retry. Unauthed (401) or offline lands in the
  // "needs connection" state.
  useEffect(() => {
    let cancelled = false;
    setTourney(null);
    setLoadError(false);
    setSubmitState('idle');
    setImproved(null);
    setBoard(null);
    // ⚠ Timed out, not merely awaited: a request that never settles used to
    // leave "Loading the live event…" up forever, indistinguishable from one
    // still in flight, with no error and no retry.
    withTimeout(api.getTournament())
      .then((t) => {
        if (!cancelled) setTourney(t);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const loadBoard = useCallback((s: 'global' | 'friends') => {
    setBoardError(false);
    setBoard(null);
    withTimeout(api.getTournamentLeaderboard(s))
      .then((r) => setBoard(r.entries))
      .catch(() => setBoardError(true));
  }, []);

  // Load the leaderboard once the player has an entry (fetched or just
  // submitted), and whenever the scope toggle changes.
  const hasEntry = tourney?.entry != null;
  useEffect(() => {
    if (hasEntry) loadBoard(scope);
  }, [hasEntry, scope, loadBoard]);

  // Submit a finished round total. Keeps the server's read-after-write standing
  // and badges "improved!"; refreshes the leaderboard. Retryable on failure.
  const submitPending = useCallback(
    (res: PendingResult) => {
      setSubmitState('saving');
      // Via pendingResult's once-only guard, NOT api directly — submittingRef
      // below dies with this mount, so a remount mid-flight would re-POST.
      submitPendingResult(res, (b) => api.postTournamentResult(b))
        .then((r) => {
          setTourney((prev) =>
            prev ? { ...prev, entry: r.entry, entrants: r.entrants } : prev,
          );
          setImproved(r.improved);
          setSubmitState('done');
          loadBoard(scope);
          onResultConsumed();
        })
        .catch(() => setSubmitState('error'));
    },
    [loadBoard, scope, onResultConsumed],
  );

  // Submittable only once we can PROVE the round belongs to the event now live:
  // the record is persisted, so it can outlive the event, and the POST body
  // carries no event id — a round played in the last one would be filed against
  // this one. GolfScreen evicts a mismatched record. Same rule as GolfDaily.
  const current = tourney && pendingResult?.tag === String(tourney.seed) ? pendingResult : null;

  // Fire the submit exactly once per pending result object (identity-guarded so a
  // re-render doesn't re-POST). GolfScreen clears pendingResult via
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
        title="Tournaments need a connection."
        detail="Couldn’t reach the live event."
        onRetry={() => setAttempt((a) => a + 1)}
      />
    );
  }
  if (!tourney) {
    return <div className="golf-empty">Loading the live event…</div>;
  }

  const entry = tourney.entry;

  function launch() {
    if (!tourney || closed) return;
    const course = synthTournamentCourse(tourney.id, tourney.holes);
    if (course) onPlay(course, tourney.seed);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Event card ---- */}
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
              Rapid Tournament · 3 holes
            </div>
            <div className="text-lg font-extrabold" style={{ color: 'var(--text)' }}>
              {closed ? 'Event closed' : 'Live now'}
            </div>
            <div className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
              {tourney.entrants} entrant{tourney.entrants === 1 ? '' : 's'}
            </div>
          </div>
          {/* Countdown pill — turns dim once the event has closed. */}
          <div
            className="shrink-0 flex flex-col items-center rounded-xl px-3 py-1.5"
            style={{
              background: closed
                ? 'var(--bubble-them)'
                : 'color-mix(in srgb, var(--golf-accent) 18%, transparent)',
            }}
            title={closed ? 'This event has closed' : 'Time left to enter'}
          >
            <span className="text-lg font-extrabold tabular-nums" style={{ color: 'var(--text)' }}>
              {closed ? '—' : fmtCountdown(msLeft)}
            </span>
            <span className="text-[10px] font-semibold" style={{ color: 'var(--text-dim)' }}>
              {closed ? 'closed' : 'left'}
            </span>
          </div>
        </div>

        {/* The three holes. */}
        <div
          className="grid grid-cols-3 divide-x px-4 py-3"
          style={{ borderTop: '1px solid var(--separator)', borderColor: 'var(--separator)' }}
        >
          {tourney.holes.map((ref, i) => {
            const h = holeLabel(ref.course, ref.hole);
            return (
              <div key={i} className="flex flex-col items-center px-1 text-center">
                <span
                  className="text-[10px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--text-dim)' }}
                >
                  Hole {i + 1}
                </span>
                <span
                  className="text-[13px] font-extrabold leading-tight"
                  style={{ color: 'var(--text)' }}
                >
                  {h.course}
                </span>
                <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  #{h.hole}
                  {h.par ? ` · Par ${h.par}` : ''}
                </span>
              </div>
            );
          })}
        </div>

        {/* Your current standing (once you've entered). */}
        {entry ? (
          <div
            className="grid grid-cols-3 divide-x px-4 py-3"
            style={{ borderTop: '1px solid var(--separator)', borderColor: 'var(--separator)' }}
          >
            <TourneyStat label="Rank" value={fmtRank(entry.rank)} />
            <TourneyStat
              label="To par"
              value={fmtToPar(entry.toPar)}
              accent={entry.toPar != null && entry.toPar < 0}
            />
            <TourneyStat label="Strokes" value={`${entry.strokes}`} />
          </div>
        ) : null}

        {/* Submit feedback. */}
        {submitState === 'done' && improved ? (
          <div className="px-4 pb-2 text-[13px] font-bold" style={{ color: 'var(--golf-accent)' }}>
            🏆 New best — you’re {entry ? fmtRank(entry.rank) : 'on the board'}!
          </div>
        ) : null}
        {submitState === 'done' && improved === false ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Kept your earlier best for this event.
          </div>
        ) : null}
        {submitState === 'saving' ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--text-dim)' }}>
            Saving your round…
          </div>
        ) : null}
        {submitState === 'error' && current ? (
          <div className="px-4 pb-2 text-[13px]" style={{ color: 'var(--ping)' }}>
            Couldn’t submit.
            <RetryButton className="ml-2" onClick={() => submitPending(current)} />
          </div>
        ) : null}

        {/* Play / Replay CTA. Server keeps the BEST, so replay is safe. Disabled
            once the event has closed — a new event appears on the next fetch. */}
        <div className="px-4 pb-4 pt-1">
          <button
            type="button"
            className="golf-cta w-full rounded-xl py-3 text-[15px] font-bold"
            disabled={closed}
            style={closed ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
            onClick={launch}
          >
            <span className="g-sheen" aria-hidden="true" />
            {closed ? 'Event closed' : entry ? 'Play again' : 'Play the 3 holes'}
          </button>
          {closed ? (
            <div className="pt-2 text-center text-[12px]" style={{ color: 'var(--text-dim)' }}>
              A new event opens shortly —
              <RetryButton
                className="ml-1"
                label="refresh"
                onClick={() => setAttempt((a) => a + 1)}
              />
            </div>
          ) : null}
        </div>
      </div>

      {/* ---- Leaderboard (once the player has entered) ---- */}
      {hasEntry ? (
        <div className="flex flex-col gap-2">
          {/* Global / Friends segmented toggle — same idiom as GolfLeaderboard. */}
          <div
            className="flex rounded-[10px] p-[3px] gap-[3px]"
            style={{ background: 'var(--bubble-them)' }}
          >
            {(
              [
                ['global', 'Global'],
                ['friends', 'Friends'],
              ] as const
            ).map(([key, label]) => {
              const active = scope === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setScope(key)}
                  className="flex-1 rounded-lg py-[6px] text-[13px] font-bold"
                  style={{
                    border: 'none',
                    background: active ? 'var(--accent)' : 'transparent',
                    color: active ? '#FFFFFF' : 'var(--text)',
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {boardError ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              Couldn’t load the leaderboard.
              <RetryButton className="block mx-auto mt-2" onClick={() => loadBoard(scope)} />
            </div>
          ) : board === null ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              Loading…
            </div>
          ) : board.length === 0 ? (
            <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
              {scope === 'friends'
                ? 'None of your friends have entered yet.'
                : 'You’re first on the board.'}
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
                      <span
                        className="text-xs font-normal ml-1"
                        style={{ color: 'var(--text-dim)' }}
                      >
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

// One stat cell in the "your standing" strip.
function TourneyStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
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
