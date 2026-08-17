// Course play HUD — wraps the interactive CourseGL scene and drives one hole of
// the course. CourseGL owns the Three.js scene + the slingshot drag and raises
// onArm when a shot is loaded; this component runs the Golf-Clash-style accuracy
// bar (tap to fire), polls sim.getState() for the readouts (club, strokes,
// distance-to-pin, lie), and shows the hole-out result. Reuses the range's
// controls so the two modes feel the same. Lazy-loaded so `three` stays out of
// the main bundle.

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { CourseSim, type CourseState } from '../../lib/golf/courseSim';
import type { GolfCourse } from '../../lib/golf/courses';
import type { GolfCosmetics } from '../../lib/golf/cosmetics';
import { api } from '../../lib/api';
import type { GolfRecords, GolfRecordsImproved } from '../../lib/api';
import { play } from '../../lib/audio';
import { makeWind, mulberry32 } from '../../lib/golf/wind';
import { WindChip } from './shared/WindChip';
import { PowerMeter } from './shared/PowerMeter';
import { SpinPuck } from './shared/SpinPuck';
import { AccuracyBar } from './shared/AccuracyBar';
import { ClubSelector } from './shared/ClubSelector';
import { MuteButton } from './shared/MuteButton';
import { TelemetryPanel, type ShotTelemetry } from './shared/TelemetryPanel';
import {
  frostedSurface,
  FROST_RADIUS_CARD,
  FROST_RADIUS_PILL,
  FROST_RADIUS_CHIP,
  FROST_TEXT,
  FROST_DIM,
  FROST_MINT,
  MONO_NUM,
} from './shared/frosted';

// Lazy so `three` (in CourseGL) stays out of the main entry chunk.
const CourseGL = lazy(() => import('./CourseGL'));

// Score label relative to par (strokes over/under).
function scoreName(strokes: number, par: number): string {
  const d = strokes - par;
  if (strokes === 1) return 'Hole in one!';
  if (d <= -3) return 'Albatross';
  if (d === -2) return 'Eagle';
  if (d === -1) return 'Birdie';
  if (d === 0) return 'Par';
  if (d === 1) return 'Bogey';
  if (d === 2) return 'Double bogey';
  return `+${d}`;
}

// One completed hole on the round scorecard (local to CourseGame — nothing is
// added to CourseSim, so the CourseSnapshot guard is untouched).
interface HoleScore {
  hole: number;
  par: number;
  strokes: number;
}

// Format a running / total score relative to par: 0 → "E", positive → "+n",
// negative → "−n" (true minus sign).
function toPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${-n}`;
}

const lieLabel: Record<string, string> = {
  tee: 'Tee',
  fairway: 'Fairway',
  green: 'Green',
  fringe: 'Fringe',
  rough: 'Rough',
  bunker: 'Bunker',
  water: 'Water',
  cartpath: 'Cart path',
  ob: 'Out of bounds',
};

// The app bundles JetBrains Mono as var(--font-mono); Tailwind's `font-mono`
// only reaches the generic ui-monospace stack, so numerals use this inline.
const MONO = { fontFamily: 'var(--font-mono)' } as const;

// Broadcast "score state" palette, driven by strokes-relative-to-par (d):
// under → emerald, level → slate, over → rose. `grad` is the state stripe/bug
// gradient, `dark` the ink that reads on it, `chip`/`chipFg` the ± chip colours.
function scoreState(d: number): { grad: string; dark: string; chip: string; chipFg: string } {
  if (d < 0)
    return {
      grad: 'linear-gradient(155deg,#43c96d,#1c6f3d)',
      dark: '#062012',
      chip: 'rgba(67,201,109,.16)',
      chipFg: '#8ff0ab',
    };
  if (d > 0)
    return {
      grad: 'linear-gradient(155deg,#f0492e,#8f1f12)',
      dark: '#2a0a05',
      chip: 'rgba(240,73,46,.16)',
      chipFg: '#ffb3a6',
    };
  return {
    grad: 'linear-gradient(155deg,#64717d,#333e47)',
    dark: '#0b0f12',
    chip: 'rgba(255,255,255,.08)',
    chipFg: 'rgba(255,255,255,.6)',
  };
}

// Signed to-par bug label: even reads "E", otherwise the true ± sign.
function toParBug(d: number): string {
  return d === 0 ? 'E' : toPar(d);
}

// One "this hole" stat cell in the 3-column broadcast panel: tiny dim uppercase
// label over a big mono tabular value with a small unit.
function StatCol({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-1 text-center">
      <span className="text-[9px] font-bold uppercase tracking-wider text-white/40">{label}</span>
      <span
        className="mt-1 text-xl font-extrabold leading-none tabular-nums text-white"
        style={MONO}
      >
        {value}
        {unit && (
          <span className="ml-0.5 text-[10px] font-semibold text-white/45" style={MONO}>
            {unit}
          </span>
        )}
      </span>
    </div>
  );
}

// One "personal best" chip in the compact broadcast strip: dim label + brass
// mono value, with an optional brass "New best" pill when the server improved it.
function RecapRow({ label, value, badge }: { label: string; value: string; badge?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-[10px] font-bold uppercase tracking-wide text-white/45">{label}</span>
      <span className="font-extrabold tabular-nums" style={{ ...MONO, color: '#e6c266' }}>
        {value}
      </span>
      {badge && (
        <span
          className="rounded-full px-1.5 py-0.5 text-[9px] font-extrabold uppercase tracking-wide"
          style={{ background: '#e6c266', color: '#1a1206' }}
        >
          New best
        </span>
      )}
    </span>
  );
}

export default function CourseGame({
  course,
  startHole,
  seed,
  onExit,
  onRoundComplete,
  onHoleComplete,
  cosmetics,
}: {
  course: GolfCourse;
  startHole?: number;
  // Equipped ball skin + trail (golf economy), forwarded straight into the GL
  // scene. Optional — omitted → the stock look.
  cosmetics?: GolfCosmetics;
  // Optional deterministic round seed. When provided, the round wind is derived
  // from it (makeWind(mulberry32(seed))) at mount AND on "Play round again", so
  // an async challenge replays the SAME conditions for both players. When
  // omitted, wind is random and re-rolled on replay (unchanged behaviour).
  seed?: number;
  onExit?: () => void;
  // Fired EXACTLY ONCE per completed full round, when the FINAL hole is holed
  // out and carded (full-round mode only — never in single-hole mode). Lets the
  // parent record the round to the leaderboard. Optional: when omitted, nothing
  // changes.
  onRoundComplete?: (r: {
    courseId: string;
    holes: number;
    strokes: number;
    par: number;
    toPar: number;
  }) => void;
  // Fired EXACTLY ONCE per completed single hole, when the chosen hole is holed
  // out (single-hole mode only — never in full-round mode). Kept SEPARATE from
  // onRoundComplete so single-hole free play (which doesn't wire this) still
  // reports nothing; an async friend-challenge wires it to submit one hole.
  // Optional: when omitted, nothing changes.
  onHoleComplete?: (r: {
    courseId: string;
    hole: number;
    strokes: number;
    par: number;
    toPar: number;
  }) => void;
}) {
  // startHole provided → single-hole play (no round progression / scorecard);
  // omitted → full round starting at hole 1.
  const single = startHole != null;

  // One wind for the whole round (the Range makes one per round too, via the
  // SAME makeWind). It's applied to every hole so the round plays in a
  // consistent breeze; "Play round again" re-rolls it (unless seeded, when it
  // reproduces the same wind). Airborne-only in the sim.
  const [wind, setWindState] = useState(() =>
    seed != null ? makeWind(mulberry32(seed)) : makeWind(),
  );
  const windRef = useRef(wind);
  windRef.current = wind;

  const simRef = useRef<CourseSim | null>(null);
  if (!simRef.current) {
    simRef.current = new CourseSim(course.holes[single ? startHole : 0]!);
    simRef.current.setWind(wind.along, wind.cross);
  }
  const sim = simRef.current;

  const [armed, setArmed] = useState(false);
  const [st, setSt] = useState<CourseState>(() => sim.getState());
  const [resetKey, setResetKey] = useState(0);

  // Spin (contact point), wired to sim.setSpin like the Range. Persists across
  // shots within the round.
  const [spin, setSpin] = useState({ back: 0, side: 0 });
  const changeSpin = (back: number, side: number) => {
    sim.setSpin(back, side);
    setSpin({ back, side });
  };

  // Telemetry log for the shared debug panel (mirrors RangeGame). We capture a
  // record when a shot transitions from in-flight to rest; power + tap error at
  // the instant of firing are snapshotted here since the sim clears power on
  // launch.
  const [lastShot, setLastShot] = useState<ShotTelemetry | null>(null);
  const telemetryRef = useRef<ShotTelemetry[]>([]);
  const launchPowerRef = useRef(0);
  const launchAccRef = useRef(0);
  const wasInFlightRef = useRef(false);

  // Round state — all LOCAL to CourseGame (never added to CourseSim). holeIdx is
  // the 0-based index into course.holes; card accumulates one HoleScore per hole
  // holed out in full-round mode; showScorecard reveals the end-of-round summary.
  const [holeIdx, setHoleIdx] = useState(single ? startHole : 0);
  const [card, setCard] = useState<HoleScore[]>([]);
  const [showScorecard, setShowScorecard] = useState(false);
  const cardedRef = useRef(false); // one-shot: this hole appended to `card`.
  const roundReportedRef = useRef(false); // one-shot: round/hole reported once.

  // Running score across the holes carded so far (full-round HUD readout).
  const scoreToPar = card.reduce((a, h) => a + (h.strokes - h.par), 0);
  const isLastHole = holeIdx === course.holes.length - 1;

  // Personal best-shot records (from POST /game/golf-records on hole-out).
  // `records` stays null until the round-trip lands; `recordsState` tracks it so
  // the recap can show "Saving…" then either the bests or (unauthed/offline)
  // gracefully skip the section.
  const [records, setRecords] = useState<GolfRecords | null>(null);
  const [improved, setImproved] = useState<GolfRecordsImproved | null>(null);
  const [recordsState, setRecordsState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const postedRef = useRef(false);

  // Capture a completed shot into the rolling telemetry log (+ the debug panel).
  // Called on the in-flight → rest transition detected by the poll below.
  const recordTelemetry = (s: CourseState) => {
    const rec: ShotTelemetry = {
      club: s.clubName,
      powerPct: Math.round(launchPowerRef.current * 100),
      aimDeg: Math.round(s.aimDeg * 10) / 10,
      spinBack: Math.round(s.spinBack * 100) / 100,
      spinSide: Math.round(s.spinSide * 100) / 100,
      accuracy: Math.round(launchAccRef.current * 100) / 100,
      carry: s.carry,
      total: s.total,
      apex: s.apex,
      ballSpeed: s.ballSpeed,
      lateral: Math.round(sim.ball.x * 10) / 10,
      result: s.lastResult,
      ts: Date.now(),
    };
    const log = telemetryRef.current;
    log.push(rec);
    if (log.length > 30) log.shift();
    setLastShot(rec);
  };

  // Poll the sim for HUD readouts, and bank a telemetry record when a shot comes
  // to rest (mirrors how RangeGame captures last-shot telemetry off its events).
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = sim.getState();
      setSt(next);
      if (wasInFlightRef.current && !next.inFlight) recordTelemetry(next);
      wasInFlightRef.current = next.inFlight;
    }, 120);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim]);

  // Seed the Personal bests once on mount from the player's saved records, so the
  // recap can show last-known bests immediately (and still show them if the
  // hole-out POST later fails offline). Unauthed (401) / offline → stays null and
  // the bests section is simply skipped. Never sets `improved` (no shot to badge
  // yet); the hole-out POST supplies the read-after-write records + "New best!".
  useEffect(() => {
    let live = true;
    api
      .getGolfRecords()
      .then((r) => {
        if (live) setRecords(r.records);
      })
      .catch(() => {
        /* unauthed / offline — recap simply omits the bests until a POST lands */
      });
    return () => {
      live = false;
    };
  }, []);

  // On hole-out: POST this hole's best shots, then refresh the player's PERSONAL
  // bests from the read-after-write records, badging any the server says
  // improved. Fires once per hole (postedRef one-shot). Unauthed (401) / offline
  // leaves recordsState 'error' and no badges — the recap then falls back to the
  // GET-seeded bests (or skips the section if that failed too). Never crashes.
  useEffect(() => {
    if (!st.holed || postedRef.current) return;
    postedRef.current = true;
    const body: {
      longestDriveYards?: number;
      longestDriveHole?: number;
      closestToPinYards?: number;
      closestToPinHole?: number;
      longestPuttYards?: number;
      longestPuttHole?: number;
    } = {};
    if (st.driveYards != null && st.driveYards > 0) {
      body.longestDriveYards = st.driveYards;
      body.longestDriveHole = st.holeId;
    }
    // NOTE: closest-to-pin is sent when non-null INCLUDING 0 (drive/putt guard
    // > 0, but 0 is a legitimately great closest approach — a stone-dead shot —
    // and the server clamps/accepts it). Do NOT "fix" this to > 0: that would
    // silently drop the best approaches.
    if (st.closestToPinYards != null) {
      body.closestToPinYards = st.closestToPinYards;
      body.closestToPinHole = st.holeId;
    }
    if (st.longestPuttYards != null && st.longestPuttYards > 0) {
      body.longestPuttYards = st.longestPuttYards;
      body.longestPuttHole = st.holeId;
    }
    setRecordsState('saving');
    api
      .postGolfRecords(body)
      .then((r) => {
        setRecords(r.records);
        setImproved(r.improved);
        setRecordsState('done');
      })
      .catch(() => setRecordsState('error'));
  }, [st.holed, st.driveYards, st.closestToPinYards, st.longestPuttYards, st.holeId]);

  // Full-round only: on hole-out, append this hole's score to the card (once).
  // Single-hole mode never cards and never shows the scorecard.
  useEffect(() => {
    if (single || !st.holed || cardedRef.current) return;
    cardedRef.current = true;
    setCard((c) => [...c, { hole: sim.hole.id, par: st.par, strokes: st.strokes }]);
  }, [single, st.holed, st.par, st.strokes, sim]);

  // Full-round only: report the completed round when the FINAL hole is CARDED —
  // NOT when a button is pressed. It used to fire from revealScorecard(), so a
  // player who tapped "Menu" instead of "See scorecard" had the whole round (and
  // in a tournament, their event entry) silently discarded. The card holds one
  // entry per hole holed out, so card.length === course.holes.length IS "the
  // round is over"; reading it HERE, not in the carding effect above, guarantees
  // the final hole's strokes are already in the total.
  useEffect(() => {
    if (single || roundReportedRef.current) return;
    if (card.length === 0 || card.length < course.holes.length) return;
    roundReportedRef.current = true;
    const strokes = card.reduce((a, h) => a + h.strokes, 0);
    const par = card.reduce((a, h) => a + h.par, 0);
    const holes = card.length;
    onRoundComplete?.({ courseId: course.id, holes, strokes, par, toPar: strokes - par });
  }, [single, card, course.id, course.holes.length, onRoundComplete]);

  // Single-hole only: when the chosen hole is holed out (the same moment the
  // single-branch "Play again" recap becomes visible), report the result to the
  // parent EXACTLY ONCE. Guarded by roundReportedRef so it fires once even
  // across re-renders; playAgain resets the ref so a replay reports again.
  // Full-round mode is untouched (it never enters this branch).
  useEffect(() => {
    if (!single || !st.holed || roundReportedRef.current) return;
    roundReportedRef.current = true;
    onHoleComplete?.({
      courseId: course.id,
      hole: startHole!,
      strokes: st.strokes,
      par: st.par,
      toPar: st.strokes - st.par,
    });
  }, [single, st.holed, st.strokes, st.par, startHole, course.id, onHoleComplete]);

  const fire = (e: number) => {
    setArmed(false);
    // Snapshot the locked power + tap error before fireArmed() clears power, so
    // the telemetry record (banked when the shot rests) has the launch inputs.
    launchPowerRef.current = sim.power;
    launchAccRef.current = e;
    sim.fireArmed(e);
  };

  // Shared reset of the per-hole POST/records bookkeeping (used by every
  // rebuild path below). Keeps the known bests as a fallback but clears the
  // per-hole "New best!" badges and the round-trip state.
  const resetHoleBookkeeping = () => {
    setArmed(false);
    postedRef.current = false;
    cardedRef.current = false;
    setImproved(null);
    setRecordsState('idle');
  };

  // Apply the round's wind + the current spin to a freshly built hole sim, so
  // every hole plays in the same breeze and the spin puck stays truthful.
  const applyRoundState = (s: CourseSim) => {
    s.setWind(windRef.current.along, windRef.current.cross);
    s.setSpin(spin.back, spin.side);
  };

  // Single-hole mode: replay the same chosen hole (today's "Play again").
  const playAgain = () => {
    simRef.current = new CourseSim(course.holes[single ? startHole : holeIdx]!);
    applyRoundState(simRef.current);
    // Reset the one-shot report guard so a replayed hole reports again (mirrors
    // how playRoundAgain resets it for a fresh full round).
    roundReportedRef.current = false;
    setResetKey((k) => k + 1);
    setSt(simRef.current.getState());
    resetHoleBookkeeping();
  };

  // Full-round: build the next hole and advance.
  const nextHole = () => {
    const ni = holeIdx + 1;
    simRef.current = new CourseSim(course.holes[ni]!);
    applyRoundState(simRef.current);
    setHoleIdx(ni);
    setResetKey((k) => k + 1);
    setSt(simRef.current.getState());
    resetHoleBookkeeping();
  };

  // Full-round: reveal the end-of-round scorecard. PURELY PRESENTATIONAL — the
  // round is reported by the effect above, on the final hole-out.
  const revealScorecard = () => setShowScorecard(true);

  // Full-round: restart the whole round from hole 1 with a fresh scorecard AND a
  // freshly rolled round wind.
  const playRoundAgain = () => {
    const w = seed != null ? makeWind(mulberry32(seed)) : makeWind();
    setWindState(w);
    windRef.current = w;
    simRef.current = new CourseSim(course.holes[0]!);
    simRef.current.setWind(w.along, w.cross);
    simRef.current.setSpin(spin.back, spin.side);
    setHoleIdx(0);
    setCard([]);
    setShowScorecard(false);
    roundReportedRef.current = false;
    setResetKey((k) => k + 1);
    setSt(simRef.current.getState());
    resetHoleBookkeeping();
  };

  const club = (dir: 1 | -1) => {
    play('ui-club');
    sim.cycleClub(dir);
  };

  // Putt read (on the green): distance in feet + uphill/downhill + break, from
  // the slope under the ball relative to the line to the cup. World: x lateral
  // (+right), z = −d; downhill = (−∂h/∂x, ∂h/∂d) mirrors CourseGL's break vector.
  let puttRead: { ft: number; slope: string; brk: string } | null = null;
  if (st.putting && !st.inFlight && !st.holed) {
    const b = sim.ball;
    const pin = sim.hole.pin;
    const gr = sim.slopeUnder(b.d, b.x);
    const fdx = pin.x - b.x;
    const fdz = -(pin.d - b.d);
    const L = Math.hypot(fdx, fdz) || 1;
    const fx = fdx / L;
    const fz = fdz / L;
    const rx = -fz; // player's right = rotate forward −90°
    const rz = fx;
    const dwx = -gr.gx; // downhill (world x)
    const dwz = gr.gd; // downhill (world z)
    const up = -(dwx * fx + dwz * fz); // + = uphill to the cup
    const brk = dwx * rx + dwz * rz; // + = green falls to the right
    puttRead = {
      ft: Math.max(1, Math.round(st.distToPin * 3)),
      slope: up > 0.003 ? 'uphill' : up < -0.003 ? 'downhill' : 'flat',
      brk: brk > 0.003 ? 'breaks right' : brk < -0.003 ? 'breaks left' : 'dead straight',
    };
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 30 }}>
      <Suspense fallback={<div style={{ position: 'fixed', inset: 0, background: '#0a1a0a' }} />}>
        <CourseGL key={resetKey} sim={sim} paused={armed || st.holed} onArm={() => setArmed(true)} cosmetics={cosmetics} />
      </Suspense>

      {/* Top HUD */}
      <div
        className="text-white"
        style={{
          position: 'absolute',
          top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
          left: 12,
          right: 12,
          zIndex: 40,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          pointerEvents: 'none',
        }}
      >
        {/* Equal-width flanking slots keep the center hole card truly centered
            regardless of the WindChip's variable width. */}
        <div className="flex-1 flex justify-start">
          <button
            onClick={onExit}
            className="px-3 py-1 text-sm font-semibold"
            style={{ pointerEvents: 'auto', color: FROST_TEXT, ...frostedSurface(FROST_RADIUS_CHIP) }}
          >
            ‹ Back
          </button>
        </div>
        {/* Frosted hole card — broadcast hierarchy: eyebrow → context line → big
            mono yardage → stroke/lie → thru±. All data bindings unchanged. */}
        <div className="px-3.5 py-2 text-center" style={frostedSurface(FROST_RADIUS_CARD)}>
          <div
            className="text-[9px] font-bold uppercase leading-none"
            style={{ letterSpacing: 2, color: FROST_DIM }}
          >
            {course.name}
          </div>
          <div className="mt-1 text-[11px]" style={{ color: FROST_DIM }}>
            HOLE {sim.hole.id}
            {sim.hole.name ? ` · ${sim.hole.name}` : ''} · PAR {st.par}
          </div>
          <div
            className="mt-0.5 text-2xl font-extrabold leading-tight"
            style={{ color: FROST_TEXT, ...MONO_NUM }}
          >
            {puttRead ? `${puttRead.ft} ft` : `${st.distToPin} yd`}
          </div>
          <div className="text-[11px]" style={{ color: FROST_DIM }}>
            {/* Show the stroke ABOUT TO BE PLAYED (strokes taken + 1), the golf
                convention — so the tee reads "Stroke 1" and the shot after the
                drive reads "Stroke 2". Showing raw strokes-taken here read
                "Stroke 0" at the tee and "Stroke 1" at the second shot, which
                made a played-past-the-green lie look like a tee address. Once
                holed, show the final strokes taken. */}
            Stroke {st.holed ? st.strokes : st.strokes + 1} · {lieLabel[st.lie] ?? st.lie}
          </div>
          {!single && (
            <div
              className="text-[11px] font-semibold"
              // Under par reads mint (the shared accent); level/over stays white.
              style={{ color: scoreToPar < 0 ? FROST_MINT : FROST_TEXT }}
            >
              Thru {card.length} · {toPar(scoreToPar)}
            </div>
          )}
          {puttRead && (
            <div className="text-[11px] font-semibold" style={{ color: FROST_MINT }}>
              {puttRead.slope} · {puttRead.brk}
            </div>
          )}
        </div>
        {/* Round wind compass — same chip the Range shows, read from the sim —
            plus a compact quick-mute (Course has no pause sheet). */}
        <div className="flex-1 flex justify-end items-start gap-1.5">
          <MuteButton variant="icon" />
          <WindChip along={st.windAlong} cross={st.windCross} />
        </div>
      </div>

      {/* Club selector + power (bottom) */}
      {!st.holed && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
            left: 12,
            right: 12,
            zIndex: 40,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pointerEvents: 'none',
          }}
        >
          <ClubSelector
            variant="cycle"
            clubName={st.clubName}
            putting={st.putting}
            onCycle={club}
          />
          <div
            className="text-xs"
            style={{
              pointerEvents: 'auto',
              padding: '6px 12px',
              color: FROST_TEXT,
              fontWeight: 700,
              // Numerals go mono/tabular while aiming; the "Drag to aim" hint is
              // plain text.
              ...(st.aiming || st.armed ? MONO_NUM : null),
              ...frostedSurface(FROST_RADIUS_PILL),
            }}
          >
            {st.aiming || st.armed ? `${Math.round(st.power * 100)}%` : 'Drag to aim'}
          </div>
        </div>
      )}

      {/* Vertical power meter (fills as you pull back), shared with the range. */}
      <PowerMeter power={st.power} visible={(st.aiming || st.armed) && !st.holed} />

      {/* Spin selector, bottom-left (mirrors the range). Hidden once holed. */}
      {!st.holed && (
        <div
          style={{
            position: 'absolute',
            left: 'calc(env(safe-area-inset-left, 0px) + 12px)',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 72px)',
            zIndex: 42,
            pointerEvents: 'none',
          }}
        >
          <SpinPuck value={spin} onChange={changeSpin} />
        </div>
      )}

      {/* Telemetry debug panel + copy export, shared with the range. */}
      <TelemetryPanel lastShot={lastShot} log={telemetryRef.current} />

      {armed && !st.holed && <AccuracyBar onStop={fire} label="Tap to strike" />}

      {/* Hole-out result card (broadcast/TV-golf styling; always dark over the
          live 3D scene). All data + button logic below is unchanged. */}
      {st.holed && !showScorecard && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.5)',
          }}
        >
          {(() => {
            const d = st.strokes - st.par;
            const state = scoreState(d);
            return (
              <div
                className="w-[min(90vw,380px)] overflow-hidden rounded-2xl border text-left"
                style={{
                  background: 'linear-gradient(160deg,#0f1a14,#0a120d)',
                  borderColor: 'rgba(255,255,255,.08)',
                  boxShadow: '0 20px 60px rgba(0,0,0,.55)',
                }}
              >
                {/* Header band: state stripe + score bug + result title. */}
                <div className="relative flex items-center gap-3 py-3.5 pl-5 pr-4">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{ width: 7, background: state.grad }}
                  />
                  <div
                    className="flex h-[46px] w-[46px] flex-col items-center justify-center rounded-xl"
                    style={{ background: state.grad, color: state.dark }}
                  >
                    <span className="text-lg font-extrabold leading-none tabular-nums" style={MONO}>
                      {toParBug(d)}
                    </span>
                    <span className="text-[7px] font-bold uppercase tracking-wider opacity-75">
                      to par
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-lg font-extrabold uppercase leading-tight tracking-wide text-white">
                      {scoreName(st.strokes, st.par)}
                    </div>
                    <div
                      className="text-[11px] uppercase tracking-wide text-white/55"
                      style={MONO}
                    >
                      Holed in {st.strokes} · Par {st.par}
                    </div>
                  </div>
                </div>

                {/* This hole — 3-column broadcast stat panel. */}
                <div className="px-4">
                  <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/40">
                    This hole
                  </div>
                  <div className="grid grid-cols-3 divide-x divide-white/10 rounded-xl bg-white/[.04] py-2.5">
                    <StatCol
                      label="Drive"
                      value={st.driveYards != null ? `${st.driveYards}` : '—'}
                      unit={st.driveYards != null ? 'yd' : undefined}
                    />
                    <StatCol
                      label="To pin"
                      value={st.closestToPinYards != null ? `${st.closestToPinYards}` : '—'}
                      unit={st.closestToPinYards != null ? 'yd' : undefined}
                    />
                    <StatCol
                      label="Lng putt"
                      value={st.longestPuttYards ? `${st.longestPuttYards}` : '—'}
                      unit={st.longestPuttYards ? 'yd' : undefined}
                    />
                  </div>
                </div>

                {/* Personal bests — compact brass strip. Seeded from GET on
                    mount, refreshed by the hole-out POST (read-after-write +
                    "New best" badges). Shows last-known bests even if the POST
                    fails offline; only when records is still null (both GET and
                    POST failed / unauthed) is it skipped. */}
                {recordsState === 'saving' && (
                  <div className="px-4 pb-1 pt-3 text-[11px] text-white/50">Saving records…</div>
                )}
                {recordsState !== 'saving' && records && (
                  <div className="px-4 pt-3">
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-white/40">
                      Personal bests
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                      <RecapRow
                        label="Best drive"
                        value={records.longestDrive ? `${records.longestDrive.yards}` : '—'}
                        badge={improved?.longestDrive}
                      />
                      <span className="text-white/20">·</span>
                      <RecapRow
                        label="To pin"
                        value={records.closestToPin ? `${records.closestToPin.yards}` : '—'}
                        badge={improved?.closestToPin}
                      />
                      <span className="text-white/20">·</span>
                      <RecapRow
                        label="Putt"
                        value={records.longestPutt ? `${records.longestPutt.yards}` : '—'}
                        badge={improved?.longestPutt}
                      />
                    </div>
                  </div>
                )}

                {/* Buttons — context-dependent primary (logic unchanged) + Menu. */}
                <div className="flex gap-2.5 px-4 pb-4 pt-4">
                  {single ? (
                    <button
                      onClick={playAgain}
                      className="flex-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white"
                    >
                      Play again
                    </button>
                  ) : isLastHole ? (
                    <button
                      onClick={revealScorecard}
                      className="flex-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white"
                    >
                      See scorecard
                    </button>
                  ) : (
                    <button
                      onClick={nextHole}
                      className="flex-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white"
                    >
                      Next hole
                    </button>
                  )}
                  <button
                    onClick={onExit}
                    className="rounded-full bg-white/20 px-5 py-2.5 text-sm font-bold text-white"
                  >
                    Menu
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* End-of-round scorecard (full-round mode). Rows per hole with ± to par,
          front-9 and (18-hole) back-9 subtotals, and the totals. */}
      {showScorecard && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,.72)',
            padding: 16,
          }}
        >
          {(() => {
            const totalStrokes = card.reduce((a, h) => a + h.strokes, 0);
            const totalPar = card.reduce((a, h) => a + h.par, 0);
            const totalD = totalStrokes - totalPar;
            const totalState = scoreState(totalD);
            return (
              <div
                className="w-[min(92vw,420px)] overflow-hidden rounded-2xl border"
                style={{
                  background: 'linear-gradient(160deg,#0f1a14,#0a120d)',
                  borderColor: 'rgba(255,255,255,.08)',
                  boxShadow: '0 20px 60px rgba(0,0,0,.55)',
                }}
              >
                {/* Header: title + course on the left, total score bug right. */}
                <div className="flex items-end justify-between gap-3 px-4 pb-3 pt-4">
                  <div className="min-w-0">
                    <div className="text-2xl font-extrabold uppercase tracking-wide text-white">
                      Scorecard
                    </div>
                    <div
                      className="mt-0.5 text-[11px] uppercase tracking-wide text-white/55"
                      style={MONO}
                    >
                      {course.name}
                      {course.location ? ` · ${course.location}` : ''}
                    </div>
                  </div>
                  <div
                    className="flex flex-col items-center justify-center rounded-xl px-3 py-1.5"
                    style={{ background: totalState.grad, color: totalState.dark }}
                  >
                    <span
                      className="text-2xl font-extrabold leading-none tabular-nums"
                      style={MONO}
                    >
                      {totalStrokes}
                    </span>
                    <span className="mt-0.5 text-[8px] font-bold uppercase tracking-wider opacity-80">
                      {toParBug(totalD)} · to par
                    </span>
                  </div>
                </div>

                <div className="max-h-[52vh] overflow-auto px-4 pb-1">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] items-center">
                    <div className="py-1 pl-2 text-[10px] font-bold uppercase tracking-wide text-white/40">
                      Hole
                    </div>
                    <div className="py-1 px-3 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
                      Par
                    </div>
                    <div className="py-1 px-3 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
                      Score
                    </div>
                    <div className="py-1 pr-2 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
                      ±
                    </div>
                    {card.map((h, i) => (
                      <ScoreRow key={h.hole} hole={h} alt={i % 2 === 1} />
                    ))}
                  </div>

                  {(() => {
                    const front = card.slice(0, 9);
                    const back = card.slice(9);
                    const sub = (rows: HoleScore[]) => ({
                      par: rows.reduce((a, h) => a + h.par, 0),
                      strokes: rows.reduce((a, h) => a + h.strokes, 0),
                    });
                    const f = sub(front);
                    const b = sub(back);
                    const total = sub(card);
                    return (
                      <div className="mt-2 space-y-1.5 border-t border-white/15 px-2 pt-2.5">
                        {/* Out/In split only for an 18-hole round; a 9-hole round
                            would make "Out" identical to "Total", so just show the
                            total. */}
                        {back.length > 0 && (
                          <>
                            <SubtotalRow label="Out" par={f.par} strokes={f.strokes} />
                            <SubtotalRow label="In" par={b.par} strokes={b.strokes} />
                          </>
                        )}
                        <SubtotalRow label="Total" par={total.par} strokes={total.strokes} bold />
                      </div>
                    );
                  })()}
                </div>

                <div className="flex gap-2.5 px-4 pb-4 pt-3">
                  <button
                    onClick={playRoundAgain}
                    className="flex-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white"
                  >
                    Play round again
                  </button>
                  <button
                    onClick={onExit}
                    className="rounded-full bg-white/20 px-5 py-2.5 text-sm font-bold text-white"
                  >
                    Menu
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

// One hole row on the scorecard (broadcast): mono tabular cells, an alternating
// faint row tint, and the ± rendered as a state-coloured chip.
function ScoreRow({ hole, alt }: { hole: HoleScore; alt: boolean }) {
  const d = hole.strokes - hole.par;
  const state = scoreState(d);
  const cell = alt ? 'bg-white/[.03]' : '';
  return (
    <>
      <div className={`py-1.5 pl-2 tabular-nums text-white ${cell}`} style={MONO}>
        {hole.hole}
      </div>
      <div className={`py-1.5 px-3 text-right tabular-nums text-white/55 ${cell}`} style={MONO}>
        {hole.par}
      </div>
      <div
        className={`py-1.5 px-3 text-right font-semibold tabular-nums text-white ${cell}`}
        style={MONO}
      >
        {hole.strokes}
      </div>
      <div className={`py-1.5 pr-2 text-right ${cell}`}>
        <span
          className="inline-block rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
          style={{ ...MONO, background: state.chip, color: state.chipFg }}
        >
          {toPar(d)}
        </span>
      </div>
    </>
  );
}

// A subtotal / total line under the scorecard rows (broadcast): mono strokes +
// a state-coloured (±) suffix; the Total row is emphasised.
function SubtotalRow({
  label,
  par,
  strokes,
  bold,
}: {
  label: string;
  par: number;
  strokes: number;
  bold?: boolean;
}) {
  const d = strokes - par;
  const state = scoreState(d);
  return (
    <div className="flex items-center justify-between">
      <span
        className={`text-[11px] uppercase tracking-wide ${
          bold ? 'font-extrabold text-white' : 'font-bold text-white/70'
        }`}
      >
        {label}
      </span>
      <span className="tabular-nums" style={MONO}>
        <span className={bold ? 'text-base font-extrabold text-white' : 'font-semibold text-white'}>
          {strokes}
        </span>
        <span className="ml-1.5 text-xs font-bold" style={{ color: state.chipFg }}>
          ({toPar(d)})
        </span>
      </span>
    </div>
  );
}
