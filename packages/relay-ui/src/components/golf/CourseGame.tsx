// Course play HUD — wraps the interactive CourseGL scene and drives one hole of
// the course. CourseGL owns the Three.js scene + the slingshot drag and raises
// onArm when a shot is loaded; this component runs the Golf-Clash-style accuracy
// bar (tap to fire), polls sim.getState() for the readouts (club, strokes,
// distance-to-pin, lie), and shows the hole-out result. Reuses the range's
// controls so the two modes feel the same. Lazy-loaded so `three` stays out of
// the main bundle.

import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { CourseSim, type CourseState } from '../../lib/golf/courseSim';
import { HOLE_1 } from '../../lib/golf/terrain';

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

function AccuracyBar({ onStop }: { onStop: (e: number) => void }) {
  const markerRef = useRef<HTMLDivElement | null>(null);
  const phaseRef = useRef(0);
  const firedRef = useRef(false);
  const SWEEP_MS = 950;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      let ph = (phaseRef.current + dt / SWEEP_MS) % 2;
      phaseRef.current = ph;
      const p = ph < 1 ? ph : 2 - ph;
      if (markerRef.current) markerRef.current.style.left = `${p * 100}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  const stop = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (firedRef.current) return;
    firedRef.current = true;
    const ph = phaseRef.current;
    const p = ph < 1 ? ph : 2 - ph;
    onStop((p - 0.5) * 2);
  };
  return (
    <div
      onPointerDown={stop}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 45,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 110px)',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 'min(78vw, 340px)' }}>
        <div className="text-[12px] font-bold text-center text-white mb-1 drop-shadow">
          Tap to strike
        </div>
        <div
          style={{
            position: 'relative',
            height: 18,
            borderRadius: 9,
            background: 'linear-gradient(90deg,#ef4444,#f59e0b,#22c55e,#f59e0b,#ef4444)',
            boxShadow: '0 1px 6px rgba(0,0,0,.4)',
          }}
        >
          <div
            ref={markerRef}
            style={{
              position: 'absolute',
              top: -3,
              left: '50%',
              width: 4,
              height: 24,
              marginLeft: -2,
              borderRadius: 2,
              background: '#fff',
              boxShadow: '0 0 4px rgba(0,0,0,.6)',
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default function CourseGame({ onExit }: { onExit?: () => void }) {
  const simRef = useRef<CourseSim | null>(null);
  if (!simRef.current) simRef.current = new CourseSim(HOLE_1);
  const sim = simRef.current;

  const [armed, setArmed] = useState(false);
  const [st, setSt] = useState<CourseState>(() => sim.getState());
  const [resetKey, setResetKey] = useState(0);

  // Poll the sim for HUD readouts.
  useEffect(() => {
    const id = window.setInterval(() => setSt(sim.getState()), 120);
    return () => window.clearInterval(id);
  }, [sim]);

  const fire = (e: number) => {
    setArmed(false);
    sim.fireArmed(e);
  };

  const playAgain = () => {
    simRef.current = new CourseSim(HOLE_1);
    setArmed(false);
    setResetKey((k) => k + 1);
    setSt(simRef.current.getState());
  };

  const club = (dir: 1 | -1) => sim.cycleClub(dir);

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
        <button
          onClick={onExit}
          className="rounded-full bg-black/45 px-3 py-1 text-sm font-semibold"
          style={{ pointerEvents: 'auto' }}
        >
          ‹ Back
        </button>
        <div className="rounded-2xl bg-black/45 px-3 py-1.5 text-center">
          <div className="text-[11px] opacity-80">HOLE 1 · PAR {st.par}</div>
          <div className="text-lg font-extrabold leading-tight">{st.distToPin} yd</div>
          <div className="text-[11px] opacity-80">
            Stroke {st.strokes} · {lieLabel[st.lie] ?? st.lie}
          </div>
        </div>
        <div className="w-[52px]" />
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
          <div className="flex items-center gap-1" style={{ pointerEvents: 'auto' }}>
            <button
              onClick={() => club(-1)}
              className="rounded-full bg-black/45 text-white w-8 h-8 text-lg font-bold"
            >
              ‹
            </button>
            <div className="rounded-xl bg-black/45 px-3 py-1 text-white text-sm font-bold min-w-[92px] text-center">
              {st.clubName}
            </div>
            <button
              onClick={() => club(1)}
              className="rounded-full bg-black/45 text-white w-8 h-8 text-lg font-bold"
            >
              ›
            </button>
          </div>
          <div className="rounded-xl bg-black/45 px-3 py-1 text-white text-xs">
            {st.aiming || st.armed ? `${Math.round(st.power * 100)}%` : 'Drag to aim'}
          </div>
        </div>
      )}

      {armed && !st.holed && <AccuracyBar onStop={fire} />}

      {/* Hole-out banner */}
      {st.holed && (
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
            <div className="text-lg mb-5">
              Holed in {st.strokes} (par {st.par})
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={playAgain}
                className="rounded-full bg-emerald-500 px-5 py-2 font-bold text-white"
              >
                Play again
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
