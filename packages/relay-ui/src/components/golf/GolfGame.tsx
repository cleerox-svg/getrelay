import { useEffect, useRef, useState } from 'react';
import { GolfCanvas } from './GolfCanvas';
import type { GolfCanvasHandle } from './GolfCanvas';
import { api } from '../../lib/api';
import { COURSE } from '../../lib/golf/course';
import { PuttingMode } from '../../lib/golf/putting';
import { recordGolfGame } from '../../lib/golf/stats';
import { HOLES, holePoints } from '../../lib/golf/tuning';

export interface GolfGameResult {
  score: number;
  // Holes completed (sunk). HOLES for a full round; 1..HOLES-1 when
  // ended early; 0 when nothing was completed — callers must
  // record/submit NOTHING for a 0-hole game.
  roundsPlayed: number;
  bestStreak: number;
  perHole: { hole: number; par: number; strokes: number; sunk: boolean }[];
}

interface Props {
  onFinish: (result: GolfGameResult) => void;
  // Freeze the round and show the pause sheet. Same contract as
  // GuessGame: the back gesture that raises it is a history event owned
  // by the parent (routes/Fog.tsx); Resume calls onResume, "End game"
  // funnels through the same finishNow as the header End pill.
  paused: boolean;
  onResume: () => void;
}

type PerHole = GolfGameResult['perHole'];

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

// The scored 6-hole round. Each hole: putt around the walls, sink the
// cup, advance. Points scale with strokes under/over par (see
// lib/golf/tuning.ts). Ending early banks the holes already completed.
export function GolfGame({ onFinish, paused, onResume }: Props) {
  const canvasRef = useRef<GolfCanvasHandle | null>(null);
  const perHoleRef = useRef<PerHole>([]);
  const strokesRef = useRef(0);
  const holeIdxRef = useRef(0);
  // Single "reported" gate consulted by every way a round can end —
  // natural finish, the End pill, the pause sheet's "End game" and the
  // unmount safety net — so a score is never recorded or submitted twice.
  const reportedRef = useRef(false);

  const [holeIdx, setHoleIdx] = useState(0);
  const [strokes, setStrokes] = useState(0);
  const [score, setScore] = useState(0);

  const hole = COURSE.holes[holeIdx];
  const holeNo = holeIdx + 1;

  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

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
    const h = COURSE.holes[idx];
    if (!h) return;
    perHoleRef.current.push({
      hole: idx + 1,
      par: h.par,
      strokes: strokesRef.current,
      sunk: true,
    });
    setScore(totalScore(perHoleRef.current));
    const next = idx + 1;
    if (next >= HOLES) {
      finishRef.current();
      return;
    }
    holeIdxRef.current = next;
    strokesRef.current = 0;
    setStrokes(0);
    setHoleIdx(next);
  }

  return (
    <div className="px-4">
      {/* Hole / par / strokes header */}
      <div
        className="flex items-baseline justify-between pb-2 text-sm font-semibold"
        style={{ color: 'var(--text)' }}
      >
        <span>
          Hole {holeNo}/{HOLES}
        </span>
        <span className="tabular-nums" style={{ color: 'var(--text-dim)' }}>
          Par {hole?.par ?? '—'}
        </span>
        <span className="tabular-nums">
          {strokes} stroke{strokes === 1 ? '' : 's'}
        </span>
        <span className="tabular-nums" style={{ color: 'var(--text-dim)' }}>
          {score.toLocaleString()} pts
        </span>
        {/* Ends the round on the spot, no confirmation — an explicit tap,
            unlike the back gesture (which pauses first). Results if >=1
            hole is done, straight back to the menu otherwise. */}
        <button
          type="button"
          onClick={finishNow}
          className="text-xs font-semibold"
          style={{
            color: 'var(--text-dim)',
            background: 'transparent',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '2px 10px',
          }}
        >
          End
        </button>
      </div>

      {hole ? (
        <GolfCanvas
          ref={canvasRef}
          makeMode={(ctx) => new PuttingMode(ctx, hole)}
          modeKey={hole.id}
          paused={paused}
          onEvent={(e) => {
            if (e.type === 'stroke') handleStroke();
            else if (e.type === 'sink') handleSink();
          }}
        />
      ) : null}

      <div className="text-xs text-center pt-3" style={{ color: 'var(--text-dim)' }}>
        Drag back from the ball to aim, release to putt.
      </div>

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
              Hole {holeNo} of {HOLES} · {score.toLocaleString()} pts
            </div>
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
