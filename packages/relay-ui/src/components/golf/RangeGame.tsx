import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { RangeSim } from '../../lib/golf/rangeSim';
import type { RangeState, ShotResult } from '../../lib/golf/rangeSim';
import { CLUBS, DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import { PINS, spawnTarget } from '../../lib/golf/rangeTargets';
import type { Pin } from '../../lib/golf/rangeTargets';
import { recordRangeGame } from '../../lib/golf/stats';
import { MAX_HOLE_POINTS, RANGE_BALLS } from '../../lib/golf/tuning';

// Lazy-load the whole Three.js scene so it lands in its own chunk and never
// bloats the main entry — the HUD/orchestration below is plain React.
const RangeGL = lazy(() => import('./RangeGL'));

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
  // Practice only: leave the full-bleed range back to the golf menu.
  onExit?: () => void;
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
      Loading range…
    </div>
  );
}

// Compass wind chip: an arrow pointing the way the wind pushes the ball, plus
// a mph readout. Up = downrange; +cross pushes right.
function WindChip({ along, cross }: { along: number; cross: number }) {
  const mph = Math.round(Math.hypot(along, cross) * 2.5);
  const deg = (Math.atan2(cross, Math.max(0.0001, along)) * 180) / Math.PI;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        borderRadius: 999,
        padding: '5px 10px 5px 6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
    >
      <svg width={26} height={26} viewBox="0 0 26 26" style={{ transform: `rotate(${deg}deg)` }}>
        <circle cx={13} cy={13} r={12} fill="none" stroke="var(--separator)" strokeWidth={1.5} />
        <path d="M13 4 L17 15 L13 12 L9 15 Z" fill="var(--accent)" />
      </svg>
      <div style={{ lineHeight: 1 }}>
        <div className="tabular-nums" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          {mph}
        </div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-dim)' }}>
          MPH
        </div>
      </div>
    </div>
  );
}

export function RangeGame({
  mode,
  paused = false,
  onResume,
  onFinish,
  initialClubId,
  onExit,
}: Props) {
  const isChallenge = mode === 'challenge';

  const wind = useMemo(makeWind, []);
  const seedRef = useRef(Math.floor(Math.random() * 1e6) + 1);
  // First challenge target (also drives the initial flag highlight).
  const firstTargetRef = useRef<Pin>(spawnTarget(0, seedRef.current));
  const [target, setTarget] = useState<Pin | null>(isChallenge ? firstTargetRef.current : null);

  // The headless sim: created once, owned here, driven by RangeGL each frame.
  const simRef = useRef<RangeSim | null>(null);
  if (!simRef.current) {
    simRef.current = new RangeSim({
      pins: PINS,
      target: isChallenge ? firstTargetRef.current : null,
      initialClubId: initialClubId ?? DEFAULT_CLUB_ID,
      windAlong: wind.along,
      windCross: wind.cross,
    });
  }
  const sim = simRef.current;

  const [readout, setReadout] = useState<RangeState | null>(null);
  const [ballNo, setBallNo] = useState(1);

  // Challenge run state, mirrored in refs for the event/unmount paths.
  const perShotRef = useRef<RangeShot[]>([]);
  const longestRef = useRef(0);
  const reportedRef = useRef(false);

  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  // Live HUD: poll the sim a few times a second (cheap; avoids a React render
  // every animation frame). Paused freezes the poll too. Only commit a new
  // readout when it actually changed.
  const lastReadoutRef = useRef('');
  useEffect(() => {
    if (paused) return;
    const id = window.setInterval(() => {
      const next = sim.getState();
      const sig = JSON.stringify(next);
      if (sig === lastReadoutRef.current) return;
      lastReadoutRef.current = sig;
      setReadout(next);
    }, 100);
    return () => window.clearInterval(id);
  }, [paused, sim]);

  function score(): number {
    return perShotRef.current.reduce((s, x) => s + x.points, 0);
  }

  // End the challenge now with whatever balls are hit.
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
  // reported yet → bank the partial run directly. Mirrors GolfGame.
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
    const st = sim.getState();
    if (!isChallenge || reportedRef.current) return;

    const landed = st.lastResult === 'grass' || st.lastResult === 'island';
    const dist = st.total;
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
    const chosen = spawnTarget(perShotRef.current.length, seedRef.current, target?.id);
    sim.setTarget(chosen);
    setTarget(chosen);
    setBallNo(perShotRef.current.length + 1);
  }

  function onEvent(type: string) {
    if (type === 'rest' || type === 'splash' || type === 'fence') handleTerminal();
  }

  function selectClub(id: string) {
    sim.selectClub(id);
    setReadout((r) => (r ? { ...r, clubId: id } : r));
  }

  const clubId = readout?.clubId ?? initialClubId ?? DEFAULT_CLUB_ID;
  const st = readout;
  const totalScore = isChallenge ? score() : 0;

  const stat = (label: string, val: string) => (
    <div
      key={label}
      className="rounded-lg text-center"
      style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        padding: '4px 2px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
      }}
    >
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
        inset: 0,
        zIndex: 15,
        overflow: 'hidden',
        background: '#bfe0f2',
        touchAction: 'none',
      }}
    >
      {/* 3D scene, lazy-loaded into its own chunk. */}
      <Suspense fallback={<Spinner />}>
        <RangeGL
          sim={sim}
          pins={PINS}
          targetId={isChallenge ? (target?.id ?? null) : null}
          paused={paused}
          onEvent={(e) => onEvent(e.type)}
        />
      </Suspense>

      {/* Top HUD: wind (left) + challenge/practice status (right). Offset to
          clear a possible top navbar. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 56px)',
          left: 12,
          right: 12,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          <WindChip along={st?.windAlong ?? wind.along} cross={st?.windCross ?? wind.cross} />
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            pointerEvents: 'auto',
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '5px 6px 5px 12px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
          }}
        >
          {isChallenge ? (
            <>
              <span className="text-[13px] font-bold" style={{ color: 'var(--text)' }}>
                Ball {Math.min(ballNo, RANGE_BALLS)}/{RANGE_BALLS}
              </span>
              <span className="text-[13px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                {target ? `${target.d}yd` : '—'}
              </span>
              <span className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--accent)' }}>
                {totalScore.toLocaleString()}
              </span>
              <button
                type="button"
                onClick={finishNow}
                className="text-[12px] font-semibold"
                style={{
                  color: 'var(--text)',
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
              <span className="text-[13px] tabular-nums" style={{ color: 'var(--text-dim)' }}>
                Longest {st?.longestDrive ?? 0}yd
              </span>
              <button
                type="button"
                onClick={onExit}
                className="text-[12px] font-semibold"
                style={{
                  color: 'var(--text)',
                  background: 'transparent',
                  border: '1px solid var(--separator)',
                  borderRadius: 999,
                  padding: '2px 10px',
                }}
              >
                Done
              </button>
            </>
          )}
        </div>
      </div>

      {/* Bottom HUD: hint / result line, readouts, club picker. Offset to
          clear the bottom tab bar. */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 62px)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Hint / nearest-pin / result line. */}
        <div
          className="text-[12px] font-semibold text-center"
          style={{
            color: 'var(--text)',
            background: 'var(--card-bg)',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '4px 12px',
            alignSelf: 'center',
            boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
          }}
        >
          {st?.nearestPin != null
            ? st.lastResult === 'water'
              ? 'Splash!'
              : st.lastResult === 'fence'
                ? 'Out of bounds'
                : `${st.nearestPin}yd to pin`
            : 'Drag back from the tee to swing'}
        </div>

        {/* Readouts. */}
        <div className="grid grid-cols-4 gap-1.5">
          {stat('CARRY', `${st?.carry ?? 0}`)}
          {stat('TOTAL', `${st?.total ?? 0}`)}
          {stat('APEX', `${st?.apex ?? 0}`)}
          {stat('BALL', `${st?.ballSpeed ?? 0}`)}
        </div>

        {/* Club picker. */}
        <div
          className="flex gap-1.5"
          style={{ overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}
        >
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
                  flex: '0 0 auto',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
                  background: active ? 'var(--accent)' : 'var(--card-bg)',
                  color: active ? '#FFFFFF' : 'var(--text)',
                  opacity: disabled && !active ? 0.5 : 1,
                  borderRadius: 12,
                  padding: '6px 12px',
                  fontSize: 12,
                  fontWeight: 700,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
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
