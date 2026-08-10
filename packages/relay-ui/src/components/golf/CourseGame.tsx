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
import { api } from '../../lib/api';
import type { GolfRecords, GolfRecordsImproved } from '../../lib/api';
import { makeWind } from '../../lib/golf/wind';
import { WindChip } from './shared/WindChip';
import { PowerMeter } from './shared/PowerMeter';
import { SpinPuck } from './shared/SpinPuck';
import { AccuracyBar } from './shared/AccuracyBar';
import { ClubSelector } from './shared/ClubSelector';
import { TelemetryPanel, type ShotTelemetry } from './shared/TelemetryPanel';

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

// One line in a recap card: a label on the left, a value on the right, with an
// optional "New best!" badge for a metric the server reported as improved.
function RecapRow({ label, value, badge }: { label: string; value: string; badge?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="opacity-80">{label}</span>
      <span className="flex items-center gap-2 font-semibold tabular-nums">
        {value}
        {badge && (
          <span className="rounded-full bg-amber-400 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-black">
            New best!
          </span>
        )}
      </span>
    </div>
  );
}

export default function CourseGame({
  course,
  startHole,
  onExit,
}: {
  course: GolfCourse;
  startHole?: number;
  onExit?: () => void;
}) {
  // startHole provided → single-hole play (no round progression / scorecard);
  // omitted → full round starting at hole 1.
  const single = startHole != null;

  // One wind for the whole round (the Range makes one per round too, via the
  // SAME makeWind). It's applied to every hole so the round plays in a
  // consistent breeze; "Play round again" re-rolls it. Airborne-only in the sim.
  const [wind, setWindState] = useState(makeWind);
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

  // Full-round: restart the whole round from hole 1 with a fresh scorecard AND a
  // freshly rolled round wind.
  const playRoundAgain = () => {
    const w = makeWind();
    setWindState(w);
    windRef.current = w;
    simRef.current = new CourseSim(course.holes[0]!);
    simRef.current.setWind(w.along, w.cross);
    simRef.current.setSpin(spin.back, spin.side);
    setHoleIdx(0);
    setCard([]);
    setShowScorecard(false);
    setResetKey((k) => k + 1);
    setSt(simRef.current.getState());
    resetHoleBookkeeping();
  };

  const club = (dir: 1 | -1) => sim.cycleClub(dir);

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
        <CourseGL key={resetKey} sim={sim} paused={armed || st.holed} onArm={() => setArmed(true)} />
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
            className="rounded-full bg-black/45 px-3 py-1 text-sm font-semibold"
            style={{ pointerEvents: 'auto' }}
          >
            ‹ Back
          </button>
        </div>
        <div className="rounded-2xl bg-black/45 px-3 py-1.5 text-center">
          <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">
            {course.name}
          </div>
          <div className="text-[11px] opacity-80">
            HOLE {sim.hole.id}
            {sim.hole.name ? ` · ${sim.hole.name}` : ''} · PAR {st.par}
          </div>
          <div className="text-lg font-extrabold leading-tight">
            {puttRead ? `${puttRead.ft} ft` : `${st.distToPin} yd`}
          </div>
          <div className="text-[11px] opacity-80">
            {/* Show the stroke ABOUT TO BE PLAYED (strokes taken + 1), the golf
                convention — so the tee reads "Stroke 1" and the shot after the
                drive reads "Stroke 2". Showing raw strokes-taken here read
                "Stroke 0" at the tee and "Stroke 1" at the second shot, which
                made a played-past-the-green lie look like a tee address. Once
                holed, show the final strokes taken. */}
            Stroke {st.holed ? st.strokes : st.strokes + 1} · {lieLabel[st.lie] ?? st.lie}
          </div>
          {!single && (
            <div className="text-[11px] font-semibold text-amber-200">
              Thru {card.length} · {toPar(scoreToPar)}
            </div>
          )}
          {puttRead && (
            <div className="text-[11px] font-semibold text-emerald-200">
              {puttRead.slope} · {puttRead.brk}
            </div>
          )}
        </div>
        {/* Round wind compass — same chip the Range shows, read from the sim. */}
        <div className="flex-1 flex justify-end">
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
              background: 'var(--card-bg)',
              border: '1px solid var(--separator)',
              borderRadius: 12,
              padding: '6px 12px',
              color: 'var(--text)',
              fontWeight: 700,
              boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
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

      {/* Hole-out banner */}
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
          <div className="text-white text-center">
            <div className="text-3xl font-extrabold mb-1">{scoreName(st.strokes, st.par)}</div>
            <div className="text-lg mb-4">
              Holed in {st.strokes} (par {st.par})
            </div>

            {/* This hole's best shots. */}
            <div className="mx-auto mb-3 w-[min(84vw,340px)] rounded-2xl bg-white/10 px-4 py-3 text-left text-sm">
              <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide opacity-70">
                This hole
              </div>
              <div className="space-y-1">
                <RecapRow
                  label="Drive"
                  value={st.driveYards != null ? `${st.driveYards} yd` : '—'}
                />
                <RecapRow
                  label="Closest to pin"
                  value={st.closestToPinYards != null ? `${st.closestToPinYards} yd` : '—'}
                />
                <RecapRow
                  label="Longest putt"
                  value={st.longestPuttYards ? `${st.longestPuttYards} yd` : '—'}
                />
              </div>
            </div>

            {/* Personal bests. Seeded from GET on mount, refreshed by the
                hole-out POST (read-after-write + "New best!" badges). Shows the
                last-known bests even if the POST fails offline; only when BOTH
                the GET and POST failed (records still null) is it skipped. */}
            {recordsState === 'saving' && (
              <div className="mb-5 text-sm opacity-70">Saving records…</div>
            )}
            {recordsState !== 'saving' && records && (
              <div className="mx-auto mb-5 w-[min(84vw,340px)] rounded-2xl bg-white/10 px-4 py-3 text-left text-sm">
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide opacity-70">
                  Personal bests
                </div>
                <div className="space-y-1">
                  <RecapRow
                    label="Longest drive"
                    value={records.longestDrive ? `${records.longestDrive.yards} yd` : '—'}
                    badge={improved?.longestDrive}
                  />
                  <RecapRow
                    label="Closest to pin"
                    value={records.closestToPin ? `${records.closestToPin.yards} yd` : '—'}
                    badge={improved?.closestToPin}
                  />
                  <RecapRow
                    label="Longest putt"
                    value={records.longestPutt ? `${records.longestPutt.yards} yd` : '—'}
                    badge={improved?.longestPutt}
                  />
                </div>
              </div>
            )}

            <div className="flex gap-3 justify-center">
              {single ? (
                <button
                  onClick={playAgain}
                  className="rounded-full bg-emerald-500 px-5 py-2 font-bold text-white"
                >
                  Play again
                </button>
              ) : isLastHole ? (
                <button
                  onClick={() => setShowScorecard(true)}
                  className="rounded-full bg-emerald-500 px-5 py-2 font-bold text-white"
                >
                  See scorecard
                </button>
              ) : (
                <button
                  onClick={nextHole}
                  className="rounded-full bg-emerald-500 px-5 py-2 font-bold text-white"
                >
                  Next hole
                </button>
              )}
              <button
                onClick={onExit}
                className="rounded-full bg-white/20 px-5 py-2 font-bold text-white"
              >
                Menu
              </button>
            </div>
          </div>
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
          <div className="w-[min(92vw,420px)] text-white">
            <div className="mb-1 text-center text-2xl font-extrabold">Scorecard</div>
            <div className="mb-3 text-center text-sm opacity-80">
              {course.name}
              {course.location ? ` · ${course.location}` : ''}
            </div>
            <div className="max-h-[52vh] overflow-auto rounded-2xl bg-white/10 px-4 py-3 text-sm">
              <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 gap-y-1 tabular-nums">
                <div className="text-[11px] font-bold uppercase tracking-wide opacity-70">Hole</div>
                <div className="text-right text-[11px] font-bold uppercase tracking-wide opacity-70">
                  Par
                </div>
                <div className="text-right text-[11px] font-bold uppercase tracking-wide opacity-70">
                  Score
                </div>
                <div className="text-right text-[11px] font-bold uppercase tracking-wide opacity-70">
                  ±
                </div>
                {card.map((h) => (
                  <ScoreRow key={h.hole} hole={h} />
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
                  <div className="mt-2 space-y-1 border-t border-white/20 pt-2">
                    {/* Out/In split only for an 18-hole round; a 9-hole round would
                        make "Out" identical to "Total", so just show the total. */}
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

            <div className="mt-4 flex justify-center gap-3">
              <button
                onClick={playRoundAgain}
                className="rounded-full bg-emerald-500 px-5 py-2 font-bold text-white"
              >
                Play round again
              </button>
              <button
                onClick={onExit}
                className="rounded-full bg-white/20 px-5 py-2 font-bold text-white"
              >
                Menu
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// One hole row on the scorecard, coloured ± to par.
function ScoreRow({ hole }: { hole: HoleScore }) {
  const d = hole.strokes - hole.par;
  return (
    <>
      <div>{hole.hole}</div>
      <div className="text-right opacity-80">{hole.par}</div>
      <div className="text-right font-semibold">{hole.strokes}</div>
      <div
        className={`text-right font-semibold ${
          d < 0 ? 'text-emerald-300' : d > 0 ? 'text-rose-300' : 'opacity-70'
        }`}
      >
        {toPar(d)}
      </div>
    </>
  );
}

// A subtotal / total line under the scorecard rows.
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
  return (
    <div className={`flex items-center justify-between ${bold ? 'font-extrabold' : 'font-semibold'}`}>
      <span className="opacity-80">{label}</span>
      <span className="tabular-nums">
        {strokes} <span className="opacity-70">({toPar(strokes - par)})</span>
      </span>
    </div>
  );
}
