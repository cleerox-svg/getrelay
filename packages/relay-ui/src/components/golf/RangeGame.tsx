import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { RangeSim } from '../../lib/golf/rangeSim';
import type { RangeState, ShotResult } from '../../lib/golf/rangeSim';
import { DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import {
  RANGE_LAYOUTS,
  pinsFor,
  readStoredLayout,
  spawnTarget,
  writeStoredLayout,
} from '../../lib/golf/rangeTargets';
import type { Pin, RangeLayout } from '../../lib/golf/rangeTargets';
import { play } from '../../lib/audio';
import { recordRangeGame } from '../../lib/golf/stats';
import { MAX_HOLE_POINTS, RANGE_BALLS } from '../../lib/golf/tuning';
import { makeWind } from '../../lib/golf/wind';
import { WindChip } from './shared/WindChip';
import { PowerMeter } from './shared/PowerMeter';
import { SpinPuck } from './shared/SpinPuck';
import { AccuracyBar } from './shared/AccuracyBar';
import { ClubSelector } from './shared/ClubSelector';
import { MuteButton } from './shared/MuteButton';
import { TelemetryPanel, type ShotTelemetry } from './shared/TelemetryPanel';

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

// Map an accuracy error e ∈ [-1..1] to brief feedback. e<0 (stopped left of
// centre) hooks; e>0 (right) slices; near 0 is a pure strike.
function describeAccuracy(e: number): { text: string; good: boolean } {
  const a = Math.abs(e);
  if (a < 0.08) return { text: 'Perfect!', good: true };
  const side = e < 0 ? 'hook' : 'slice';
  const mag = a < 0.32 ? 'Slight ' : a < 0.62 ? '' : 'Big ';
  const label = `${mag}${side}`;
  return { text: label.charAt(0).toUpperCase() + label.slice(1), good: false };
}

// Range-layout picker: a compact segmented control (Center lane / Practice lane
// / Fairway) with a one-line blurb for the active choice, so the player can try
// each landing-area design on-device. Persisted by the parent; changing it
// rebuilds the scene. Lives in the top HUD, clear of the central drag channel
// and the play controls. Disabled while a shot is in flight/armed so the scene
// can't rebuild mid-swing. Only the buttons opt into pointer events.
function LayoutPicker({
  layout,
  disabled,
  onChange,
}: {
  layout: RangeLayout;
  disabled: boolean;
  onChange: (l: RangeLayout) => void;
}) {
  const meta = RANGE_LAYOUTS.find((m) => m.id === layout);
  return (
    <div
      style={{
        // Container is pointer-transparent so the label/blurb region can't
        // swallow a power-pull drag that starts high on the screen; only the
        // buttons below opt back into pointer events.
        pointerEvents: 'none',
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        borderRadius: 14,
        padding: '6px 8px 7px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: 1.5,
          color: 'var(--text-dim)',
          paddingBottom: 4,
        }}
      >
        RANGE LAYOUT
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {RANGE_LAYOUTS.map((m) => {
          const active = m.id === layout;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(m.id)}
              style={{
                pointerEvents: 'auto',
                flex: '1 1 0',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
                background: active ? 'var(--accent)' : 'var(--card-bg)',
                color: active ? '#FFFFFF' : 'var(--text)',
                borderRadius: 9,
                padding: '5px 2px',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1.1,
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {meta ? (
        <div
          style={{
            fontSize: 10,
            lineHeight: 1.3,
            color: 'var(--text-dim)',
            paddingTop: 5,
            textAlign: 'center',
          }}
        >
          {meta.blurb}
        </div>
      ) : null}
    </div>
  );
}

const HINT_KEY = 'relay.golf.range.hintSeen';

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

  // Selectable landing-area design (persisted to localStorage, default
  // 'fairway'). Changing it rebuilds the sim + remounts RangeGL below so the
  // whole scene swaps to the new layout.
  const [layout, setLayoutState] = useState<RangeLayout>(() => readStoredLayout());

  // First challenge target (also drives the initial flag highlight) — drawn
  // from the ACTIVE layout's pin set.
  const firstTargetRef = useRef<Pin>(spawnTarget(0, seedRef.current, undefined, layout));
  const [target, setTarget] = useState<Pin | null>(isChallenge ? firstTargetRef.current : null);

  // Challenge run state, mirrored in refs for the event/unmount paths. Declared
  // before the sim so a layout rebuild can reset them synchronously.
  const perShotRef = useRef<RangeShot[]>([]);
  const longestRef = useRef(0);
  const reportedRef = useRef(false);

  // The headless sim, owned here and driven by RangeGL each frame. Rebuilt when
  // the layout changes (a fresh scene): the run is reset so challenge scoring
  // restarts cleanly on the new design.
  const simRef = useRef<RangeSim | null>(null);
  const simLayoutRef = useRef<RangeLayout | null>(null);
  if (!simRef.current || simLayoutRef.current !== layout) {
    const ft = spawnTarget(0, seedRef.current, undefined, layout);
    firstTargetRef.current = ft;
    simRef.current = new RangeSim({
      pins: pinsFor(layout),
      target: isChallenge ? ft : null,
      initialClubId: initialClubId ?? DEFAULT_CLUB_ID,
      windAlong: wind.along,
      windCross: wind.cross,
      layout,
      isChallenge,
    });
    simLayoutRef.current = layout;
    perShotRef.current = [];
    longestRef.current = 0;
    reportedRef.current = false;
  }
  const sim = simRef.current;

  const [readout, setReadout] = useState<RangeState | null>(null);
  const [ballNo, setBallNo] = useState(1);
  const [spin, setSpin] = useState({ back: 0, side: 0 });
  // Brief post-shot accuracy feedback ("Perfect!" / "Slight hook" / "Slice").
  const [feedback, setFeedback] = useState<{ text: string; good: boolean } | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  // Telemetry: capture each completed shot for the collapsible debug panel and
  // the "Copy telemetry" export (real device numbers to compare vs the harness).
  // The panel (shared/TelemetryPanel) owns its open/copy UI state; we just keep
  // the rolling log + the last shot to feed it.
  const [lastShot, setLastShot] = useState<ShotTelemetry | null>(null);
  const telemetryRef = useRef<ShotTelemetry[]>([]);
  // Power + accuracy-error at the instant of firing (the sim clears power on
  // launch), captured by fireAccuracy() and read back when the shot comes to rest.
  const launchPowerRef = useRef(0);
  const launchAccRef = useRef(0);
  const [showHint, setShowHint] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) !== '1';
    } catch {
      return true;
    }
  });

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

  // When the layout changes the sim was rebuilt (above, during render); reflect
  // the fresh sim + reset run in the HUD. Skips the initial mount.
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setTarget(isChallenge ? firstTargetRef.current : null);
    setBallNo(1);
    setFeedback(null);
    const next = sim.getState();
    lastReadoutRef.current = JSON.stringify(next);
    setReadout(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // Persist + switch the landing-area design. No-op if unchanged; the render
  // rebuild + the effect above do the rest.
  function changeLayout(next: RangeLayout) {
    if (next === layout) return;
    writeStoredLayout(next);
    setLayoutState(next);
  }

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
    const chosen = spawnTarget(perShotRef.current.length, seedRef.current, target?.id, layout);
    sim.setTarget(chosen);
    setTarget(chosen);
    setBallNo(perShotRef.current.length + 1);
  }

  function dismissHint() {
    setShowHint(false);
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
  }

  function changeSpin(back: number, side: number) {
    sim.setSpin(back, side);
    setSpin({ back, side });
  }

  // Aim is no longer a HUD control — it's steered by the pull-back gesture
  // (slingshot) in the sim; the on-turf arrow + predicted arc read sim.aimRad
  // live as you drag.

  // Capture a completed shot into the rolling telemetry log (+ the debug panel).
  function recordTelemetry() {
    const st = sim.getState();
    const rec: ShotTelemetry = {
      club: st.clubName,
      powerPct: Math.round(launchPowerRef.current * 100),
      aimDeg: Math.round(st.aimDeg * 10) / 10,
      spinBack: Math.round(st.spinBack * 100) / 100,
      spinSide: Math.round(st.spinSide * 100) / 100,
      accuracy: Math.round(launchAccRef.current * 100) / 100,
      carry: st.carry,
      total: st.total,
      apex: st.apex,
      ballSpeed: st.ballSpeed,
      lateral: Math.round(sim.ball.x * 10) / 10,
      result: st.lastResult ?? 'water',
      ts: Date.now(),
    };
    const log = telemetryRef.current;
    log.push(rec);
    if (log.length > 30) log.shift();
    setLastShot(rec);
  }

  // Step 2 tap: stop the accuracy marker, launch the armed shot with the miss
  // baked into hook/slice spin, hide the bar, and flash brief feedback.
  function fireAccuracy(e: number) {
    if (!sim.armed) return;
    // Snapshot the locked power + accuracy error before swing() clears power.
    launchPowerRef.current = sim.power;
    launchAccRef.current = e;
    sim.fireArmed(e);
    setFeedback(describeAccuracy(e));
    // Reflect the fired state at once so the accuracy bar unmounts without
    // waiting for the next poll tick.
    const next = sim.getState();
    lastReadoutRef.current = JSON.stringify(next);
    setReadout(next);
    if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setFeedback(null), 1300);
  }

  // Clear a pending feedback timer on unmount.
  useEffect(
    () => () => {
      if (feedbackTimer.current != null) window.clearTimeout(feedbackTimer.current);
    },
    [],
  );

  function onEvent(type: string) {
    if (type === 'arm') {
      // Raise the accuracy bar the instant the shot is armed, without waiting
      // for the next poll tick (mirrors fireAccuracy's immediate refresh).
      const next = sim.getState();
      lastReadoutRef.current = JSON.stringify(next);
      setReadout(next);
      return;
    }
    if (type === 'launch') {
      if (showHint) dismissHint();
      return;
    }
    if (type === 'rest' || type === 'splash' || type === 'fence') {
      recordTelemetry();
      handleTerminal();
    }
  }

  function selectClub(id: string) {
    play('ui-club');
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
      {/* 3D scene, lazy-loaded into its own chunk. */}
      <Suspense fallback={<Spinner />}>
        <RangeGL
          key={layout}
          sim={sim}
          pins={pinsFor(layout)}
          layout={layout}
          isChallenge={isChallenge}
          targetId={isChallenge ? (target?.id ?? null) : null}
          paused={paused}
          onEvent={(e) => onEvent(e.type)}
        />
      </Suspense>

      {/* Top HUD stack: wind + status row, a compact readout strip, and the
          hint/result line — all clustered at the top so the whole centre and
          lower-centre of the screen stays an open drag channel over the ball.
          The container is pointer-transparent; only the End/Done/Exit button
          opts back into pointer events. Offset only for the status bar now
          that the app navbar is hidden while immersive. */}
      <div
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
          left: 12,
          right: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <WindChip along={st?.windAlong ?? wind.along} cross={st?.windCross ?? wind.cross} />

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
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
                    pointerEvents: 'auto',
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
                    pointerEvents: 'auto',
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

        {/* Compact, display-only readout strip. */}
        <div className="grid grid-cols-4 gap-1.5">
          {stat('CARRY', `${st?.carry ?? 0}`)}
          {stat('TOTAL', `${st?.total ?? 0}`)}
          {stat('APEX', `${st?.apex ?? 0}`)}
          {stat('BALL', `${st?.ballSpeed ?? 0}`)}
        </div>

        {/* Aim is steered by the pull-back gesture now (drag back for power,
            angle the pull to steer left/right — slingshot), so there's no
            separate AIM control here. The on-turf arrow + predicted arc show
            the direction live as you drag. */}

        {/* Range-layout picker — switch landing-area design on the fly. Disabled
            mid-swing so the scene can't rebuild while a shot is live. */}
        <LayoutPicker
          layout={layout}
          // Also lock it once a Challenge run is underway — switching rebuilds
          // the scene and resets the round, so it must not silently discard
          // banked shots. A fresh run (ballNo 1) can still pick a layout.
          disabled={!!st?.inFlight || !!st?.armed || (isChallenge && ballNo > 1)}
          onChange={changeLayout}
        />

        {/* Hint / nearest-pin / result line — top-centred so it never sits on
            the ball. Display-only. */}
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
          {st?.armed
            ? 'Tap to stop the marker in the center'
            : st?.nearestPin != null
              ? st.lastResult === 'water'
                ? 'Splash!'
                : st.lastResult === 'fence'
                  ? 'Out of bounds'
                  : `${st.nearestPin}yd to pin`
              : 'Pull back for power · angle the pull to aim'}
        </div>
      </div>

      {/* Bottom HUD: just the slim club picker, pinned to the very bottom and
          safe-area padded. It's the only bottom-interactive element and stays
          thin so the ball's drag zone above it is clear. The scroll container
          is pointer-transparent; each chip opts back in. */}
      <ClubSelector
        variant="strip"
        clubId={clubId}
        disabled={!!st?.inFlight}
        onSelect={selectClub}
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)',
        }}
      />

      {/* Always-visible power meter, pinned to the right edge. */}
      <PowerMeter power={st?.power ?? 0} />

      {/* Spin selector, bottom-left above the club strip. */}
      <div
        style={{
          position: 'absolute',
          left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 52px)',
          pointerEvents: 'none',
        }}
      >
        <SpinPuck value={spin} onChange={changeSpin} />
      </div>

      {/* Telemetry: a tiny debug toggle + collapsible last-shot panel with a
          Copy-to-clipboard export of the rolling shot log. Unobtrusive, pinned
          to the left edge, clear of the central drag channel. */}
      <TelemetryPanel lastShot={lastShot} log={telemetryRef.current} />

      {/* Step 2 accuracy bar — shown only while a shot is armed (aim+power
          locked). Full-bleed interactive overlay so a tap can't leak to the
          canvas as a drag. Firing (or leaving the armed state) unmounts it. */}
      {st?.armed ? (
        <AccuracyBar paused={paused} onStop={fireAccuracy} label="TAP TO STOP IN THE CENTER" />
      ) : null}

      {/* Brief accuracy feedback after a shot fires. Pointer-transparent. */}
      {feedback ? (
        <div
          className="fade-in"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '42%',
            textAlign: 'center',
            pointerEvents: 'none',
            zIndex: 46,
          }}
        >
          <span
            className="text-[18px] font-extrabold"
            style={{
              display: 'inline-block',
              color: '#fff',
              background: feedback.good ? 'rgba(34,160,90,0.92)' : 'rgba(20,28,40,0.82)',
              border: '1px solid var(--separator)',
              borderRadius: 999,
              padding: '8px 20px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.32)',
              letterSpacing: 0.4,
            }}
          >
            {feedback.text}
          </span>
        </div>
      ) : null}

      {/* One-time instructional hint — auto-hides (and remembers) after the
          first swing. Pointer-transparent so it never blocks the drag. */}
      {showHint ? (
        <div
          className="fade-in"
          style={{
            position: 'absolute',
            left: 24,
            right: 24,
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 150px)',
            textAlign: 'center',
            pointerEvents: 'none',
          }}
        >
          <span
            className="text-[12px] font-semibold"
            style={{
              display: 'inline-block',
              color: 'var(--text)',
              background: 'var(--card-bg)',
              border: '1px solid var(--separator)',
              borderRadius: 999,
              padding: '6px 14px',
              boxShadow: '0 2px 10px rgba(0,0,0,0.2)',
            }}
          >
            Pull back for power · angle the pull left/right to aim · tap to stop the marker
          </span>
        </div>
      ) : null}

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
