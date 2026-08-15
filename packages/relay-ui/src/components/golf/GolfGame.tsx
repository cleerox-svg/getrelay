import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { getPuttCourse, type PuttCourse } from '../../lib/golf/puttCourses';
import type { GolfCosmetics } from '../../lib/golf/cosmetics';
import { PuttSim } from '../../lib/golf/puttSim';
import { recordGolfGame } from '../../lib/golf/stats';
import { holePoints } from '../../lib/golf/tuning';
import { MuteButton } from './shared/MuteButton';

// Lazy-load the whole Three.js scene so it lands in its own chunk (shared
// with the range's vendor chunk) and never bloats the main entry — the
// HUD/orchestration below is plain React.
const PuttGL = lazy(() => import('./PuttGL'));

export interface GolfGameResult {
  score: number;
  // Holes completed (sunk). course.holes.length for a full round; 1..len-1
  // when ended early; 0 when nothing was completed — callers must
  // record/submit NOTHING for a 0-hole game.
  roundsPlayed: number;
  bestStreak: number;
  perHole: { hole: number; par: number; strokes: number; sunk: boolean }[];
}

interface Props {
  onFinish: (result: GolfGameResult) => void;
  // Freeze the round and show the pause sheet. Same contract as
  // GuessGame: the back gesture that raises it is a history event owned
  // by the parent (routes/Games.tsx); Resume calls onResume, "End game"
  // funnels through the same finishNow as the header End pill.
  paused: boolean;
  onResume: () => void;
  // The mini-golf course to play. Defaults to the registry's default course
  // (GARDEN, 8 holes). Threaded from the menu's course picker via GolfScreen;
  // the round iterates the course's ACTUAL hole count (<= 8).
  course?: PuttCourse;
  // Single-hole play: start on (and finish after) this 0-based hole index. When
  // undefined the full round plays from hole 1. Mirrors CourseGame's startHole.
  startHole?: number;
  // Equipped ball skin (golf economy), forwarded into the GL scene. Mini-golf
  // has no tracer, so only the ball colour applies.
  cosmetics?: GolfCosmetics;
}

type PerHole = GolfGameResult['perHole'];

// Short beat between sinking a hole and teeing the next, so the ball's
// drop-into-cup animation reads before the scene swaps.
const TRANSITION_MS = 750;

// Sum of per-hole points.
function totalScore(perHole: PerHole): number {
  return perHole.reduce((s, h) => s + holePoints(h.strokes, h.par), 0);
}

// Longest run of holes finished at or under par.
function longestStreak(perHole: PerHole): number {
  let best = 0;
  let cur = 0;
  for (const h of perHole) {
    if (h.strokes <= h.par) {
      cur += 1;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

function Spinner() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontSize: 14,
        fontWeight: 600,
        textShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }}
    >
      Loading course…
    </div>
  );
}

// The scored mini-golf round in real 3D (course.holes.length holes, <= 8).
// Each hole: drag back from the ball to
// aim in any direction, release to putt around the walls, sink the cup,
// advance. Points scale with strokes under/over par (see lib/golf/tuning.ts).
// Ending early banks the holes already completed. Full-bleed immersive shell,
// mirroring RangeGame: the scene owns the viewport; the HUD is a display-only
// top strip with only the End button interactive, so the whole centre stays a
// clear drag zone over the ball.
export function GolfGame({
  onFinish,
  paused,
  onResume,
  course = getPuttCourse(),
  startHole,
  cosmetics,
}: Props) {
  const holeCount = course.holes.length;
  // Single-hole play: start on (and finish after) startHole; otherwise play the
  // full round from hole 0. Clamp to a valid index so a stray arg can't crash.
  const single = startHole != null;
  const firstHole =
    single && startHole! >= 0 && startHole! < holeCount ? startHole! : 0;
  const perHoleRef = useRef<PerHole>([]);
  const strokesRef = useRef(0);
  const holeIdxRef = useRef(firstHole);
  // Single "reported" gate consulted by every way a round can end —
  // natural finish, the End pill, the pause sheet's "End game" and the
  // unmount safety net — so a score is never recorded or submitted twice.
  const reportedRef = useRef(false);
  const advanceTimerRef = useRef<number | null>(null);

  const [holeIdx, setHoleIdx] = useState(firstHole);
  const [strokes, setStrokes] = useState(0);
  const [score, setScore] = useState(0);
  // True during the post-sink beat: an input-blocking veil covers the
  // scene while the ball drops and the next hole is prepared.
  const [transitioning, setTransitioning] = useState(false);

  const hole = course.holes[holeIdx];
  const holeNo = holeIdx + 1;

  // A fresh sim per hole; PuttGL remounts by the same key so its GPU scene
  // is rebuilt for the new hole's walls/cup.
  const sim = useMemo(() => (hole ? new PuttSim(hole) : null), [holeIdx, hole]);

  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  // If the pause sheet opens during the post-sink beat, defer the hole
  // advance (index of the next hole) until resume, so we never remount the
  // scene to the next tee behind the sheet.
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const pendingAdvanceRef = useRef<number | null>(null);

  // Ends the round now with whatever holes are complete. The natural
  // finish (after the last sink), the End pill and the pause sheet's
  // "End game" all funnel through here; the parent decides
  // results-vs-menu from roundsPlayed.
  function finishNow() {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const perHole = perHoleRef.current.slice();
    onFinish({
      score: totalScore(perHole),
      roundsPlayed: perHole.length,
      bestStreak: longestStreak(perHole),
      perHole,
    });
  }
  const finishRef = useRef(finishNow);
  finishRef.current = finishNow;

  // Abandon safety net: unmounted mid-round (route change, tab switch,
  // navbar link, or the second back press while paused) with >=1
  // completed hole and nothing reported yet: record the partial score
  // directly. No setState here — the whole route may be unmounting. The
  // POST is fire-and-forget; local stats always update.
  useEffect(() => {
    return () => {
      if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current);
      if (reportedRef.current) return;
      const perHole = perHoleRef.current;
      if (perHole.length < 1) return; // never record/submit a 0-hole game
      reportedRef.current = true;
      const finalScore = totalScore(perHole);
      recordGolfGame(finalScore, longestStreak(perHole));
      api
        .submitGameScore({
          score: finalScore,
          rounds: perHole.length,
          bestStreak: longestStreak(perHole),
          game: 'golf',
        })
        .catch(() => undefined);
    };
  }, []);

  function handleStroke() {
    strokesRef.current += 1;
    setStrokes(strokesRef.current);
  }

  function handleSink() {
    const idx = holeIdxRef.current;
    const h = course.holes[idx];
    if (!h) return;
    perHoleRef.current.push({
      hole: idx + 1,
      par: h.par,
      strokes: strokesRef.current,
      sunk: true,
    });
    setScore(totalScore(perHoleRef.current));
    // Hold on the sunk hole briefly so the ball visibly drops, then either
    // finish the round or tee the next hole (a fresh sim + remounted scene).
    setTransitioning(true);
    const next = idx + 1;
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      // Paused mid-beat: hold the advance until resume (see the effect below).
      if (pausedRef.current) {
        pendingAdvanceRef.current = next;
        return;
      }
      doAdvance(next);
    }, TRANSITION_MS);
  }

  // Commit the hole transition: finish the round on the last hole, else tee
  // the next one (a fresh sim + remounted scene).
  function doAdvance(next: number) {
    // Single-hole play finishes after its one hole; a full round finishes once
    // the last hole is done.
    if (single || next >= holeCount) {
      finishRef.current();
      return;
    }
    holeIdxRef.current = next;
    strokesRef.current = 0;
    setStrokes(0);
    setHoleIdx(next);
    setTransitioning(false);
  }

  // Flush a deferred advance once the pause sheet closes.
  useEffect(() => {
    if (paused) return;
    if (pendingAdvanceRef.current == null) return;
    const next = pendingAdvanceRef.current;
    pendingAdvanceRef.current = null;
    doAdvance(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  const readout = (label: string, val: string) => (
    <div style={{ textAlign: 'center' }}>
      <div className="text-[9px] font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div className="text-[14px] font-bold tabular-nums" style={{ color: 'var(--text)' }}>
        {val}
      </div>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        // Full dynamic viewport so the scene truly fills the screen on mobile
        // (dvh accounts for the collapsing browser/URL bar). zIndex sits ABOVE
        // the app's bottom tab bar (z-20) and top navbar — while immersive
        // those are hidden too, but this guarantees full coverage regardless.
        width: '100vw',
        height: '100dvh',
        zIndex: 30,
        overflow: 'hidden',
        background: '#bfe0f2',
        touchAction: 'none',
      }}
    >
      {/* 3D scene, lazy-loaded into its own chunk. Remounts per hole. */}
      {hole && sim ? (
        <Suspense fallback={<Spinner />}>
          <PuttGL
            key={holeIdx}
            sim={sim}
            hole={hole}
            paused={paused}
            cosmetics={cosmetics}
            onEvent={(e) => {
              if (e.type === 'stroke') handleStroke();
              // A water ball resets the shot and costs +1, exactly like a real
              // penalty stroke; the ensuing replay putt is its own 'stroke'.
              else if (e.type === 'penalty') handleStroke();
              else if (e.type === 'sink') handleSink();
            }}
          />
        </Suspense>
      ) : null}

      {/* Top HUD: a single display-only readout pill + the End button,
          clustered at the top so the whole centre/lower screen stays an open
          drag channel over the ball. The container is pointer-transparent;
          only the End button opts back into pointer events. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
          left: 12,
          right: 12,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 6,
          pointerEvents: 'none',
        }}
      >
        {/* Which mini-golf course is in play (name + theme). */}
        <div
          className="text-[11px] font-bold"
          style={{
            color: 'var(--text)',
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '3px 12px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
          }}
        >
          {course.name}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '6px 8px 6px 16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}
        >
          {readout('HOLE', single ? `${holeNo}` : `${holeNo}/${holeCount}`)}
          {readout('PAR', `${hole?.par ?? '—'}`)}
          {readout('STROKES', `${strokes}`)}
          {readout('PTS', score.toLocaleString())}
          {/* Ends the round on the spot, no confirmation — an explicit tap,
              unlike the back gesture (which pauses first). Results if >=1
              hole is done, straight back to the menu otherwise. */}
          <button
            type="button"
            onClick={finishNow}
            className="text-[12px] font-semibold"
            style={{
              pointerEvents: 'auto',
              color: 'var(--text)',
              background: 'transparent',
              border: '1px solid var(--separator)',
              borderRadius: 999,
              padding: '4px 12px',
            }}
          >
            End
          </button>
        </div>
      </div>

      {/* Bottom hint — display-only, pinned low and centred so it never sits
          on the ball. */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)',
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          className="text-[12px] font-semibold text-center"
          style={{
            color: 'var(--text)',
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '5px 14px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
          }}
        >
          Drag back from the ball to aim, release to putt.
        </div>
      </div>

      {/* Post-sink veil: swallows taps while the ball drops + the next hole
          is prepared, so a stray tap can't re-aim the sunk ball. */}
      {transitioning ? <div style={{ position: 'absolute', inset: 0, zIndex: 40 }} /> : null}

      {/* Pause sheet. The round stays mounted and frozen underneath, so
          Resume is a true continue; "End game" is the same finishNow
          funnel as the header End pill. */}
      {paused ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Game paused"
          onClick={onResume}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
          }}
        >
          <div
            className="fade-in"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 320,
              background: 'var(--card-bg)',
              color: 'var(--text)',
              border: '1px solid var(--separator)',
              borderRadius: 18,
              padding: 20,
              boxShadow: '0 16px 40px rgba(0,0,0,0.32)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 19, fontWeight: 700 }}>Game paused</div>
            <div
              className="tabular-nums"
              style={{ fontSize: 13, paddingTop: 4, color: 'var(--text-dim)' }}
            >
              Hole {holeNo} of {holeCount} · {score.toLocaleString()} pts
            </div>
            {/* Compact scorecard: every hole completed so far, strokes vs par
                (E / +n / -n). The perHole data already backs the results screen;
                surfacing it here lets a paused player read their card. */}
            {perHoleRef.current.length > 0 ? (
              <div className="flex flex-wrap justify-center gap-1.5 pt-3">
                {perHoleRef.current.map((h) => {
                  const diff = h.strokes - h.par;
                  const label = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;
                  const under = diff <= 0;
                  return (
                    <span
                      key={h.hole}
                      className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums"
                      style={{
                        background: under
                          ? 'color-mix(in srgb, var(--online) 18%, transparent)'
                          : 'color-mix(in srgb, var(--ping) 15%, transparent)',
                        color: under ? 'var(--online)' : 'var(--ping)',
                      }}
                    >
                      H{h.hole} {label}
                    </span>
                  );
                })}
              </div>
            ) : null}
            <div
              style={{ fontSize: 13, paddingTop: 10, lineHeight: 1.45, color: 'var(--text-dim)' }}
            >
              Your round is frozen right where you left it.
            </div>
            <button
              type="button"
              onClick={onResume}
              style={{
                width: '100%',
                marginTop: 16,
                borderRadius: 12,
                border: 0,
                padding: '13px 0',
                fontSize: 15,
                fontWeight: 700,
                background: 'var(--accent)',
                color: '#FFFFFF',
              }}
            >
              Resume
            </button>
            <MuteButton />
            <button
              type="button"
              onClick={finishNow}
              style={{
                width: '100%',
                marginTop: 8,
                borderRadius: 12,
                border: '1px solid var(--separator)',
                padding: '13px 0',
                fontSize: 15,
                fontWeight: 600,
                background: 'transparent',
                color: 'var(--text)',
              }}
            >
              End game
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
