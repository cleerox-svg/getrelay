import { useEffect, useMemo, useRef, useState } from 'react';
import { GolfCanvas } from './GolfCanvas';
import type { GolfCanvasHandle } from './GolfCanvas';
import { api } from '../../lib/api';
import { RangeMode } from '../../lib/golf/range';
import type { RangeState, ShotResult } from '../../lib/golf/range';
import { CLUBS, DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import { PINS, spawnTarget } from '../../lib/golf/rangeTargets';
import type { Pin } from '../../lib/golf/rangeTargets';
import { recordRangeGame } from '../../lib/golf/stats';
import { MAX_HOLE_POINTS, RANGE_BALLS } from '../../lib/golf/tuning';

// A single Target-Challenge shot, banked when the ball comes to rest / splashes.
export interface RangeShot {
  ball: number;
  club: string;
  carry: number;
  total: number;
  distToPin: number;
  result: ShotResult;
  points: number;
  onTarget: boolean;
}

// Shaped like GolfGameResult (score / roundsPlayed / bestStreak) but with a
// per-shot breakdown instead of per-hole, for the challenge results chips.
export interface RangeGameResult {
  score: number;
  roundsPlayed: number;
  bestStreak: number;
  perShot: RangeShot[];
}

interface Props {
  mode: 'practice' | 'challenge';
  // Challenge only — mirrors GolfGame's contract. Practice ignores these.
  paused?: boolean;
  onResume?: () => void;
  onFinish?: (result: RangeGameResult) => void;
  initialClubId?: string;
}

// Scoring: full points landing on the pin, fading to 0 by SCORE_RADIUS yards
// away; water/out = 0. Small bonuses for carrying the hazard and for the
// round's longest drive, clamped so no single shot exceeds MAX_HOLE_POINTS.
const SCORE_RADIUS = 45;
const FENCE_CARRY_BONUS = 150;
const LONGEST_BONUS = 120;

function shotPoints(st: RangeState, isLongest: boolean): number {
  if (st.lastResult === 'water' || st.lastResult === 'fence') return 0;
  const dist = st.nearestPin ?? 999;
  const near = Math.max(0, 1 - dist / SCORE_RADIUS);
  let pts = Math.round(MAX_HOLE_POINTS * near);
  if (pts <= 0) return 0;
  if (st.carry >= 390) pts += FENCE_CARRY_BONUS;
  if (isLongest) pts += LONGEST_BONUS;
  return Math.min(MAX_HOLE_POINTS, pts);
}

function longestStreak(shots: RangeShot[]): number {
  let best = 0;
  let cur = 0;
  for (const s of shots) {
    if (s.onTarget) {
      cur += 1;
      best = Math.max(best, cur);
    } else {
      cur = 0;
    }
  }
  return best;
}

// One-time random round wind (yd/s^2 acceleration). Cross moves the ball
// L/R in flight; along is a head/tail component.
function makeWind(): { along: number; cross: number } {
  const mag = 1 + Math.random() * 3;
  const ang = Math.random() * Math.PI * 2;
  return { along: Math.sin(ang) * mag * 0.6, cross: Math.cos(ang) * mag };
}

export function RangeGame({ mode, paused = false, onResume, onFinish, initialClubId }: Props) {
  const isChallenge = mode === 'challenge';
  const canvasRef = useRef<GolfCanvasHandle | null>(null);

  const wind = useMemo(makeWind, []);
  const seedRef = useRef(Math.floor(Math.random() * 1e6) + 1);
  // First challenge target (also drives the initial flag highlight).
  const firstTargetRef = useRef<Pin>(spawnTarget(0, seedRef.current));
  const [target, setTarget] = useState<Pin | null>(isChallenge ? firstTargetRef.current : null);

  const [readout, setReadout] = useState<RangeState | null>(null);
  const [ballNo, setBallNo] = useState(1);

  // Challenge run state, mirrored in refs for the event/unmount paths.
  const perShotRef = useRef<RangeShot[]>([]);
  const longestRef = useRef(0);
  const reportedRef = useRef(false);

  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;
  const onResumeRef = useRef(onResume);
  onResumeRef.current = onResume;

  const getMode = (): RangeMode | null => {
    const m = canvasRef.current?.getMode();
    return m instanceof RangeMode ? m : null;
  };

  // Live HUD: poll the mode a few times a second (cheap; avoids a React
  // render every animation frame). Paused freezes the poll too. Only commit
  // a new readout when it actually changed, so a ball at rest doesn't trigger
  // a steady stream of no-op re-renders.
  const lastReadoutRef = useRef('');
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      const m = getMode();
      if (!m) return;
      const next = m.getState();
      const sig = JSON.stringify(next);
      if (sig === lastReadoutRef.current) return;
      lastReadoutRef.current = sig;
      setReadout(next);
    }, 100);
    return () => window.clearInterval(id);
  }, [paused]);

  function score(): number {
    return perShotRef.current.reduce((s, x) => s + x.points, 0);
  }

  // End the challenge now with whatever balls are hit. Natural finish (8th
  // ball) and the pause sheet's "End game" both funnel here.
  function finishNow() {
    if (reportedRef.current) return;
    reportedRef.current = true;
    const perShot = perShotRef.current.slice();
    onFinishRef.current?.({
      score: score(),
      roundsPlayed: perShot.length,
      bestStreak: longestStreak(perShot),
      perShot,
    });
  }
  const finishRef = useRef(finishNow);
  finishRef.current = finishNow;

  // Abandon safety net: unmounted mid-round with >=1 ball hit and nothing
  // reported yet → bank the partial run directly (fire-and-forget POST,
  // local stats always update). Mirrors GolfGame.
  useEffect(() => {
    if (!isChallenge) return;
    return () => {
      if (reportedRef.current) return;
      const perShot = perShotRef.current;
      if (perShot.length < 1) return;
      reportedRef.current = true;
      const finalScore = perShot.reduce((s, x) => s + x.points, 0);
      const streak = longestStreak(perShot);
      recordRangeGame(finalScore, streak);
      api
        .submitGameScore({
          score: finalScore,
          rounds: perShot.length,
          bestStreak: streak,
          game: 'golfrange',
        })
        .catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shot came to rest / splashed / went out.
  function handleTerminal() {
    const m = getMode();
    if (!m) return;
    const st = m.getState();
    if (!isChallenge || reportedRef.current) return;

    const landed = st.lastResult === 'grass' || st.lastResult === 'island';
    const dist = st.total; // distance reached this shot
    const isLongest = landed && dist > longestRef.current;
    if (landed) longestRef.current = Math.max(longestRef.current, dist);
    const pts = shotPoints(st, isLongest);

    const shot: RangeShot = {
      ball: perShotRef.current.length + 1,
      club: st.clubName,
      carry: st.carry,
      total: st.total,
      distToPin: st.nearestPin ?? 0,
      result: st.lastResult ?? 'water',
      points: pts,
      onTarget: pts > 0,
    };
    perShotRef.current.push(shot);

    if (perShotRef.current.length >= RANGE_BALLS) {
      finishRef.current();
      return;
    }
    // Next target — highlight the new flag; the ball stays put until the
    // player starts the next drag (which re-tees it).
    const chosen = spawnTarget(perShotRef.current.length, seedRef.current, target?.id);
    m.setTarget(chosen);
    setTarget(chosen);
    setBallNo(perShotRef.current.length + 1);
  }

  function onEvent(type: string) {
    if (type === 'rest' || type === 'splash' || type === 'fence') handleTerminal();
  }

  function selectClub(id: string) {
    getMode()?.selectClub(id);
    setReadout((r) => (r ? { ...r, clubId: id } : r));
  }

  const clubId = readout?.clubId ?? initialClubId ?? DEFAULT_CLUB_ID;
  const st = readout;
  const totalScore = isChallenge ? score() : 0;

  return (
    <div className="px-4">
      {/* Header: challenge shows ball count + score; practice shows a title. */}
      <div
        className="flex items-baseline justify-between pb-2 text-sm font-semibold"
        style={{ color: 'var(--text)' }}
      >
        {isChallenge ? (
          <>
            <span>
              Ball {Math.min(ballNo, RANGE_BALLS)}/{RANGE_BALLS}
            </span>
            <span className="tabular-nums" style={{ color: 'var(--text-dim)' }}>
              {target ? `${target.d}yd target` : '—'}
            </span>
            <span className="tabular-nums">{totalScore.toLocaleString()} pts</span>
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
          </>
        ) : (
          <>
            <span>Driving range</span>
            <span className="tabular-nums" style={{ color: 'var(--text-dim)' }}>
              Longest {st?.longestDrive ?? 0}yd
            </span>
          </>
        )}
      </div>

      <GolfCanvas
        ref={canvasRef}
        makeMode={(ctx) =>
          new RangeMode(ctx, {
            pins: PINS,
            target: isChallenge ? firstTargetRef.current : null,
            initialClubId: initialClubId ?? DEFAULT_CLUB_ID,
            windAlong: wind.along,
            windCross: wind.cross,
          })
        }
        paused={paused}
        onEvent={(e) => onEvent(e.type)}
      />

      {/* Live readouts */}
      <div
        className="grid grid-cols-4 gap-2 pt-3 text-center"
        style={{ color: 'var(--text)' }}
      >
        {(
          [
            ['Carry', `${st?.carry ?? 0}`],
            ['Total', `${st?.total ?? 0}`],
            ['Apex', `${st?.apex ?? 0}`],
            ['Ball', `${st?.ballSpeed ?? 0}`],
          ] as [string, string][]
        ).map(([label, val]) => (
          <div
            key={label}
            className="rounded-xl py-1.5"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
          >
            <div className="text-[10px] font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
              {label.toUpperCase()}
            </div>
            <div className="text-[15px] font-bold tabular-nums">{val}</div>
          </div>
        ))}
      </div>

      {/* Wind + nearest-pin line */}
      <div className="flex items-center justify-between pt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
        <span>
          Wind {Math.abs(Math.round((st?.windCross ?? wind.cross) * 2))}{' '}
          {(st?.windCross ?? wind.cross) >= 0 ? '→' : '←'}
        </span>
        {st?.nearestPin != null ? (
          <span className="tabular-nums">
            {st.lastResult === 'water' ? 'Splash' : st.lastResult === 'fence' ? 'Out of bounds' : `${st.nearestPin}yd to pin`}
          </span>
        ) : (
          <span>Drag back from the tee to swing</span>
        )}
      </div>

      {/* Club selector */}
      <div className="pt-3">
        <div className="text-[10px] font-bold tracking-wider pb-1.5" style={{ color: 'var(--text-dim)' }}>
          CLUB
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CLUBS.map((c) => {
            const active = c.id === clubId;
            const disabled = !!st?.inFlight;
            return (
              <button
                key={c.id}
                type="button"
                disabled={disabled}
                onClick={() => selectClub(c.id)}
                style={{
                  border: '1px solid var(--separator)',
                  background: active ? 'var(--accent)' : 'var(--card-bg)',
                  color: active ? '#FFFFFF' : 'var(--text)',
                  opacity: disabled && !active ? 0.5 : 1,
                  borderRadius: 999,
                  padding: '5px 10px',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                {c.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pause sheet (challenge only), mirroring GolfGame. */}
      {isChallenge && paused ? (
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
              Ball {Math.min(ballNo, RANGE_BALLS)} of {RANGE_BALLS} · {totalScore.toLocaleString()} pts
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
