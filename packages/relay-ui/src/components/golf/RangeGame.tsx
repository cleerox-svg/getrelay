import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
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

// Always-visible vertical power meter pinned to the right edge, clear of the
// ball's central drag zone. Empty at rest; fills 0→100% as the player pulls
// back, ramping from accent to red near max. Display-only (pointer-transparent).
function PowerMeter({ power }: { power: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, power)) * 100);
  const hot = power > 0.8;
  const fill = hot ? '#ff4d4d' : 'var(--accent)';
  return (
    <div
      style={{
        position: 'absolute',
        right: 'calc(env(safe-area-inset-right, 0px) + 10px)',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        {pct}%
      </div>
      <div
        style={{
          position: 'relative',
          width: 12,
          height: 168,
          borderRadius: 999,
          background: 'rgba(20,28,40,0.5)',
          border: '1px solid var(--separator)',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${pct}%`,
            background: fill,
            transition: 'height 60ms linear',
          }}
        />
      </div>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        POWER
      </div>
    </div>
  );
}

// Circular "ball face" spin selector pinned to the bottom-left, above the club
// strip. Drag the dot from centre: up/down = back/top spin, left/right =
// draw/fade. Centre = no spin. Value persists across shots. onChange gets
// (back, side) in [-1..1] with back>0 = backspin, side>0 = fade (curves right).
function SpinPuck({
  value,
  onChange,
}: {
  value: { back: number; side: number };
  onChange: (back: number, side: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const SIZE = 84;
  const R = SIZE / 2 - 12; // dot travel radius (px)
  const dotX = SIZE / 2 + value.side * R;
  const dotY = SIZE / 2 - value.back * R;

  const apply = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    onChange(Math.max(-1, Math.min(1, -dy / R)), Math.max(-1, Math.min(1, dx / R)));
  };

  return (
    <div
      ref={ref}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        apply(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) apply(e.clientX, e.clientY);
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => onChange(0, 0)}
      style={{
        position: 'relative',
        width: SIZE,
        height: SIZE,
        borderRadius: '50%',
        background: 'radial-gradient(circle at 50% 42%, #ffffff, #d9dee4)',
        border: '1px solid var(--separator)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
        pointerEvents: 'auto',
        touchAction: 'none',
        cursor: 'grab',
      }}
    >
      {/* Cross-hair + label baked onto the ball face. */}
      <div style={{ position: 'absolute', left: '50%', top: 4, bottom: 4, width: 1, background: 'rgba(0,0,0,0.10)' }} />
      <div style={{ position: 'absolute', top: '50%', left: 4, right: 4, height: 1, background: 'rgba(0,0,0,0.10)' }} />
      <div
        style={{
          position: 'absolute',
          top: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 8,
          fontWeight: 800,
          letterSpacing: 1,
          color: '#5a6472',
        }}
      >
        SPIN
      </div>
      <div
        style={{
          position: 'absolute',
          left: dotX,
          top: dotY,
          width: 16,
          height: 16,
          marginLeft: -8,
          marginTop: -8,
          borderRadius: '50%',
          background: 'var(--accent)',
          border: '2px solid #fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
        }}
      />
    </div>
  );
}

// Step 2 accuracy UI: a horizontal track with a highlighted centre sweet-spot
// and a marker that ping-pongs left↔right at a steady, readable rate. Tapping
// anywhere on the full-bleed overlay stops the marker and reports the error e ∈
// [-1..1] (0 = dead centre). The marker is animated via its own rAF writing
// straight to the element's style (no React re-render per frame, no per-frame
// allocation); the rAF is cancelled on unmount. Paused freezes the sweep in
// place (phase persists across the pause). The overlay captures the tap so it
// can never also register as a canvas drag.
function AccuracyBar({
  paused,
  onStop,
}: {
  paused: boolean;
  onStop: (e: number) => void;
}) {
  const markerRef = useRef<HTMLDivElement | null>(null);
  // Triangle phase in [0..2): 0→1 sweeps L→R, 1→2 sweeps R→L. Persisted in a ref
  // so pausing/resuming continues from where it stopped.
  const phaseRef = useRef(0);
  const firedRef = useRef(false);
  const SWEEP_MS = 950; // one side→side pass

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      if (!paused) {
        let ph = phaseRef.current + dt / SWEEP_MS;
        ph %= 2;
        phaseRef.current = ph;
        const p = ph < 1 ? ph : 2 - ph; // 0..1 marker position
        const m = markerRef.current;
        if (m) m.style.left = `${p * 100}%`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  const stop = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (firedRef.current || paused) return;
    firedRef.current = true;
    const ph = phaseRef.current;
    const p = ph < 1 ? ph : 2 - ph;
    onStop((p - 0.5) * 2); // e ∈ [-1..1]
  };

  return (
    <div
      onPointerDown={stop}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 45,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 120px)',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 'min(78vw, 340px)' }}>
        <div
          className="text-[12px] font-bold text-center"
          style={{
            color: '#fff',
            marginBottom: 8,
            letterSpacing: 0.4,
            textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          }}
        >
          TAP TO STOP IN THE CENTER
        </div>
        <div
          style={{
            position: 'relative',
            height: 22,
            borderRadius: 999,
            background: 'rgba(20,28,40,0.7)',
            border: '1px solid var(--separator)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          {/* Centre sweet-spot band. */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: '13%',
              transform: 'translateX(-50%)',
              background:
                'linear-gradient(90deg, rgba(74,222,128,0), rgba(74,222,128,0.6), rgba(74,222,128,0))',
            }}
          />
          {/* Centre line. */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 3,
              bottom: 3,
              width: 2,
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.55)',
            }}
          />
          {/* Sweeping marker (left set each frame by the rAF above). */}
          <div
            ref={markerRef}
            style={{
              position: 'absolute',
              top: -2,
              bottom: -2,
              left: '50%',
              width: 5,
              marginLeft: -2.5,
              borderRadius: 3,
              background: '#fff',
              boxShadow: '0 0 8px rgba(255,255,255,0.95)',
            }}
          />
        </div>
      </div>
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

// Dedicated AIM control, fully DECOUPLED from the power pull. A prominent
// horizontal SLIDER (drag the thumb left/right to swing the shot line ±40°, the
// sim clamps) is the primary control, flanked by hold-to-repeat ◀ ▶ fine-nudge
// buttons and a live degree readout ("AIM 20°R"). The on-turf aim arrow (RangeGL)
// follows aimRad live as you drag/nudge, so it's obvious which way the shot goes.
// Tapping the readout re-centres to straight. Big touch targets; only the control
// opts into pointer events, and it lives in the top HUD, clear of the central
// power-pull drag channel and the club strip.
const AIM_STEP_DEG = 2;
const AIM_MAX_DEG = 40;
function AimSlider({
  deg,
  disabled,
  onSet,
  onNudge,
  onCenter,
}: {
  deg: number;
  disabled: boolean;
  onSet: (deg: number) => void;
  onNudge: (deltaDeg: number) => void;
  onCenter: () => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  // Single timer id for the press-and-hold nudge repeat; cleared on release/
  // unmount so the armed/aim state can never strand a running interval.
  const holdRef = useRef<number | null>(null);
  // Live `disabled` for the running repeat loop: if the shot arms/launches
  // mid-hold (a multi-touch edge), the loop bails instead of ticking on.
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const stopHold = () => {
    if (holdRef.current != null) {
      window.clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };
  const startHold = (delta: number) => {
    if (disabled) return;
    onNudge(delta);
    const rep = () => {
      if (disabledRef.current) return stopHold();
      onNudge(delta);
      holdRef.current = window.setTimeout(rep, 55);
    };
    holdRef.current = window.setTimeout(rep, 300);
  };
  useEffect(() => stopHold, []);

  const setFromClientX = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    onSet((f * 2 - 1) * AIM_MAX_DEG);
  };

  const clamped = Math.max(-AIM_MAX_DEG, Math.min(AIM_MAX_DEG, deg));
  const frac = (clamped / AIM_MAX_DEG + 1) / 2; // 0..1 thumb position
  const abs = Math.round(Math.abs(deg));
  const label = abs < 1 ? 'CTR' : `${abs}°${deg < 0 ? 'L' : 'R'}`;

  const nudgeBtn = (dir: -1 | 1, glyph: string) => (
    <button
      type="button"
      disabled={disabled}
      aria-label={dir < 0 ? 'Aim left' : 'Aim right'}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        startHold(dir * AIM_STEP_DEG);
      }}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
      style={{
        pointerEvents: 'auto',
        flex: '0 0 auto',
        width: 38,
        height: 38,
        borderRadius: 10,
        border: '1px solid var(--separator)',
        background: 'var(--card-bg)',
        color: 'var(--text)',
        fontSize: 17,
        fontWeight: 800,
        lineHeight: 1,
        opacity: disabled ? 0.5 : 1,
        touchAction: 'none',
        boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
      }}
    >
      {glyph}
    </button>
  );

  return (
    <div
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        borderRadius: 14,
        padding: '6px 10px 8px',
        boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1.5, color: 'var(--text-dim)' }}
        >
          AIM
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onCenter}
          aria-label="Centre aim"
          className="tabular-nums"
          style={{
            pointerEvents: 'auto',
            border: 0,
            background: 'transparent',
            color: abs < 1 ? 'var(--text-dim)' : 'var(--accent)',
            fontSize: 15,
            fontWeight: 800,
            padding: 0,
          }}
        >
          {label}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {nudgeBtn(-1, '◀')}
        <div
          ref={trackRef}
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (disabled) return;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) setFromClientX(e.clientX);
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          onPointerCancel={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId))
              e.currentTarget.releasePointerCapture(e.pointerId);
          }}
          style={{
            position: 'relative',
            flex: '1 1 auto',
            height: 38,
            borderRadius: 10,
            background: 'rgba(20,28,40,0.35)',
            border: '1px solid var(--separator)',
            touchAction: 'none',
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {/* Baseline track + centre tick. */}
          <div
            style={{
              position: 'absolute',
              left: 10,
              right: 10,
              top: '50%',
              height: 4,
              transform: 'translateY(-50%)',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.28)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 7,
              bottom: 7,
              width: 2,
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.5)',
            }}
          />
          {/* Draggable thumb. */}
          <div
            style={{
              position: 'absolute',
              left: `calc(10px + ${frac} * (100% - 20px))`,
              top: '50%',
              width: 22,
              height: 22,
              marginLeft: -11,
              marginTop: -11,
              borderRadius: '50%',
              background: 'var(--accent)',
              border: '2px solid #fff',
              boxShadow: '0 1px 5px rgba(0,0,0,0.4)',
            }}
          />
        </div>
        {nudgeBtn(1, '▶')}
      </div>
    </div>
  );
}

// A completed shot's full record — captured for the in-app telemetry panel and
// the "Copy telemetry" export, so real device numbers can be compared against
// the headless harness (rangeSim.test.ts). One per shot that comes to rest.
interface ShotTelemetry {
  club: string;
  powerPct: number;
  aimDeg: number;
  spinBack: number;
  spinSide: number;
  accuracy: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  lateral: number;
  result: ShotResult;
  ts: number;
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
  const [spin, setSpin] = useState({ back: 0, side: 0 });
  // Aim in degrees (+ = right), mirrored from the sim for the dedicated aim
  // control. Decoupled from the power pull; persists across shots.
  const [aimDeg, setAimDeg] = useState(0);
  // Brief post-shot accuracy feedback ("Perfect!" / "Slight hook" / "Slice").
  const [feedback, setFeedback] = useState<{ text: string; good: boolean } | null>(null);
  const feedbackTimer = useRef<number | null>(null);

  // Telemetry: capture each completed shot for the collapsible debug panel and
  // the "Copy telemetry" export (real device numbers to compare vs the harness).
  const [debugOpen, setDebugOpen] = useState(false);
  const [lastShot, setLastShot] = useState<ShotTelemetry | null>(null);
  const [copyMsg, setCopyMsg] = useState('');
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

  // Aim nudge (dedicated control). The sim clamps to ±40°; read it back so the
  // readout and the on-turf arrow stay in lockstep. Direction-independent of
  // the power pull.
  function changeAim(deltaDeg: number) {
    sim.nudgeAim((deltaDeg * Math.PI) / 180);
    setAimDeg((sim.aimRad * 180) / Math.PI);
  }
  // Absolute aim set (degrees, + = right) from the slider drag; the sim clamps.
  function setAimAbsolute(deg: number) {
    sim.setAim((deg * Math.PI) / 180);
    setAimDeg((sim.aimRad * 180) / Math.PI);
  }
  function centerAim() {
    sim.setAim(0);
    setAimDeg((sim.aimRad * 180) / Math.PI);
  }

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

  // Copy the rolling telemetry log as JSON to the clipboard, guarded for
  // environments (older WebViews) without the async clipboard API.
  async function copyTelemetry() {
    const json = JSON.stringify(telemetryRef.current, null, 2);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        setCopyMsg(`Copied ${telemetryRef.current.length}`);
      } else {
        setCopyMsg('No clipboard');
      }
    } catch {
      setCopyMsg('Copy failed');
    }
    window.setTimeout(() => setCopyMsg(''), 1500);
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
          sim={sim}
          pins={PINS}
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

        {/* Prominent AIM slider — the primary aim control, decoupled from the
            power pull and sitting in the top HUD, clear of the central drag
            channel and the club strip. Drives the on-turf aim arrow live. */}
        <AimSlider
          deg={aimDeg}
          disabled={!!st?.inFlight || !!st?.armed}
          onSet={setAimAbsolute}
          onNudge={changeAim}
          onCenter={centerAim}
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
              : 'Set AIM · drag straight back for power'}
        </div>
      </div>

      {/* Bottom HUD: just the slim club picker, pinned to the very bottom and
          safe-area padded. It's the only bottom-interactive element and stays
          thin so the ball's drag zone above it is clear. The scroll container
          is pointer-transparent; each chip opts back in. */}
      <div
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 10px)',
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          paddingBottom: 2,
          scrollbarWidth: 'none',
          pointerEvents: 'none',
        }}
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
                pointerEvents: 'auto',
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
      <div
        style={{
          position: 'absolute',
          left: 'calc(env(safe-area-inset-left, 0px) + 10px)',
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          pointerEvents: 'none',
          zIndex: 40,
        }}
      >
        <button
          type="button"
          onClick={() => setDebugOpen((o) => !o)}
          aria-label="Toggle shot telemetry"
          style={{
            pointerEvents: 'auto',
            width: 26,
            height: 26,
            borderRadius: 8,
            border: '1px solid var(--separator)',
            background: 'var(--card-bg)',
            color: debugOpen ? 'var(--accent)' : 'var(--text-dim)',
            fontSize: 15,
            fontWeight: 800,
            lineHeight: 1,
            boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
          }}
        >
          ﹒
        </button>
        {debugOpen ? (
          <div
            style={{
              pointerEvents: 'auto',
              width: 188,
              background: 'var(--card-bg)',
              border: '1px solid var(--separator)',
              borderRadius: 12,
              padding: 10,
              boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
              fontSize: 11,
              color: 'var(--text)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 6,
              }}
            >
              <span style={{ fontWeight: 800, letterSpacing: 0.5 }}>DEBUG</span>
              <span style={{ color: 'var(--text-dim)' }}>{telemetryRef.current.length} logged</span>
            </div>
            {lastShot ? (
              <div className="tabular-nums" style={{ lineHeight: 1.5 }}>
                <div>
                  {lastShot.club} · {lastShot.powerPct}% · aim {lastShot.aimDeg}°
                </div>
                <div>
                  carry {lastShot.carry} · total {lastShot.total} · {lastShot.result}
                </div>
                <div>
                  apex {lastShot.apex} · ball {lastShot.ballSpeed} · lat {lastShot.lateral}
                </div>
                <div>
                  spin b{lastShot.spinBack}/s{lastShot.spinSide} · acc {lastShot.accuracy}
                </div>
              </div>
            ) : (
              <div style={{ color: 'var(--text-dim)' }}>No shots yet</div>
            )}
            <button
              type="button"
              onClick={copyTelemetry}
              disabled={telemetryRef.current.length === 0}
              style={{
                pointerEvents: 'auto',
                width: '100%',
                marginTop: 8,
                borderRadius: 8,
                border: '1px solid var(--separator)',
                background: 'var(--accent)',
                color: '#fff',
                fontSize: 12,
                fontWeight: 700,
                padding: '6px 0',
                opacity: telemetryRef.current.length === 0 ? 0.5 : 1,
              }}
            >
              {copyMsg || 'Copy telemetry'}
            </button>
          </div>
        ) : null}
      </div>

      {/* Step 2 accuracy bar — shown only while a shot is armed (aim+power
          locked). Full-bleed interactive overlay so a tap can't leak to the
          canvas as a drag. Firing (or leaving the armed state) unmounts it. */}
      {st?.armed ? <AccuracyBar paused={paused} onStop={fireAccuracy} /> : null}

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
            Drag the AIM slider · pull straight back for power · tap to stop the marker
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
