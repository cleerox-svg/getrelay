// Dev/CI-only preview harness for the golf 3D scenes. Mounts exactly ONE scene
// (CourseGL or RangeGL) standalone — no <App>, no auth, no store — so the golf
// renderer can be screenshotted headlessly (scripts/shoot-golf.mjs) for visual
// QA. It is NEVER imported by the app and is not a production build input.
//
// URL query:
//   ?scene=course                     → CourseGL on HOLE_1 (default, unchanged)
//   ?scene=course&course=augusta&hole=11
//                                     → CourseGL on GOLF_COURSES hole (hole is a
//                                       0-based index; out-of-range → hole 0)
//   ?scene=range&layout=fairway       → RangeGL (layout: lane|practiceLane|fairway)
//
// The scenes own only the Three.js renderer; they take a sim instance as a prop,
// built here exactly as CourseGame/RangeGame build it. Once the scene has drawn
// a few frames we set window.__golfReady so the shooter can wait for a real
// render (not just DOMContentLoaded) before capturing.

import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  advanceSceneClock,
  engageVirtualClock,
  freezeSceneClock,
  sceneClockPending,
} from './lib/scene3d/clock';
import CourseGL from './components/golf/CourseGL';
import RangeGL from './components/golf/RangeGL';
import PuttGL from './components/golf/PuttGL';
import { CourseSim } from './lib/golf/courseSim';
import { PuttSim } from './lib/golf/puttSim';
import { getPuttCourse } from './lib/golf/puttCourses';
import { HOLE_1, heightAt, type CourseHole } from './lib/golf/terrain';
import { getCourse } from './lib/golf/courses';
import { FIXED_MS } from './lib/golf/tuning';
import { RangeSim } from './lib/golf/rangeSim';
import { pinsFor, DEFAULT_LAYOUT, type RangeLayout } from './lib/golf/rangeTargets';

declare global {
  interface Window {
    __golfReady?: boolean;
    __sim?: CourseSim | PuttSim;
    /** Harness handle on the virtual clock — see the block comment below. */
    __sceneClock?: {
      advance: (ms: number) => void;
      freeze: () => void;
      pending: () => number;
    };
  }
}

// ---------------------------------------------------------------------------
// DETERMINISM: take time away from the wall clock.
//
// Every animated thing in these scenes — Gerstner waves, splash rings, confetti,
// camera easing, the fixed-step physics accumulator — is driven by elapsed
// seconds. Sampling that from `performance.now()` makes the captured frame a
// function of how fast the machine ran, and two identical harness runs then
// produce two different PNGs (measured: 23 of 25 scenes differed). Seeding the
// RNGs does not help; the generators were already seeded. TIME was the variable.
//
// So the preview runs on a VIRTUAL clock: one fixed 60 fps step per rendered
// frame, engaged here before any scene mounts, and FROZEN the moment we raise
// `window.__golfReady`. Frozen means dt === 0 — no substeps, no uniform moves —
// so the shooter's settle delay and every later rAF tick render the identical
// frame no matter how long it waits.
//
// `window.__sceneClock.advance(ms)` hands the scene an exact, replayable slice
// of animation (used by the drag/second-aim sequences, which need the camera to
// settle between steps) and re-freezes when it drains. The shipped app never
// touches any of this: `lib/scene3d/clock.ts` is a pass-through to
// `performance.now()` unless something engages it, and only this file does.
// ---------------------------------------------------------------------------
engageVirtualClock();
window.__sceneClock = {
  advance: (ms: number) => advanceSceneClock(ms),
  freeze: () => freezeSceneClock(),
  pending: () => sceneClockPending(),
};

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'course';
const layout = (params.get('layout') as RangeLayout | null) ?? DEFAULT_LAYOUT;

// Which hole the course scene renders. With NO ?course param this is HOLE_1 —
// byte-identical to the original behaviour, so the committed `course`/`secondAim`
// scenes are unaffected. With ?course=<id>&hole=<idx> (idx 0-based) it resolves
// the hole from the GOLF_COURSES registry, clamping an out-of-range/invalid idx
// back to hole 0 so the shooter can never land on `undefined`.
function resolveHole(): CourseHole {
  const courseParam = params.get('course');
  if (!courseParam) return HOLE_1;
  const course = getCourse(courseParam);
  const idx = Number.parseInt(params.get('hole') ?? '', 10);
  const ok = Number.isInteger(idx) && idx >= 0 && idx < course.holes.length;
  return (ok ? course.holes[idx] : course.holes[0])!;
}
const HOLE = resolveHole();

// Flip the readiness flag after the scene has had time to build its textures and
// draw a handful of frames (the scenes animate — water shimmer, camera settle —
// so a few frames in is a stable "address" view). Readiness is counted in
// FRAMES, never in milliseconds, so with the virtual clock engaged the scene has
// always advanced exactly the same amount of virtual time when we freeze it.
function ReadyBeacon({ until }: { until?: () => boolean }) {
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    const ready = () => {
      // Stop the world HERE. Everything the shooter does afterwards (its settle
      // delay, pointer drags, extra rAF ticks) then renders the same frame.
      freezeSceneClock();
      window.__golfReady = true;
    };
    const tick = () => {
      // If a readiness predicate is given (e.g. wait for a fired shot to rest),
      // hold until it's satisfied; otherwise a few frames to let textures land.
      if (until ? until() && frames >= 20 : frames >= 45) {
        ready();
        return;
      }
      frames++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Hard fallback so the shooter never hangs. This is the ONE wall-clock path
    // left, and tripping it would freeze the scene at an arbitrary frame — i.e.
    // a non-deterministic shot. It is set well above the worst observed
    // frame-count time (and below the shooter's own 15 s ready timeout for the
    // non-predicate case) so it only ever fires on a genuinely stuck scene.
    const t = window.setTimeout(() => {
      // console.error (not warn) — shoot-golf.mjs captures errors, and a shot
      // frozen at an arbitrary frame is a result worth failing loudly over.
      console.error('[golfpreview] ready fallback fired — this shot is NOT deterministic');
      ready();
    }, until ? 16000 : 12000);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, []);
  return null;
}

function Preview() {
  if (scene === 'range') {
    const pins = pinsFor(layout);
    const sim = new RangeSim({ pins, layout, isChallenge: false });
    return (
      <>
        <RangeGL sim={sim} pins={pins} layout={layout} isChallenge={false} />
        <ReadyBeacon />
      </>
    );
  }
  if (scene === 'putt') return <PuttPreview />;
  return <CoursePreview at={params.get('at')} />;
}

// Mini-golf scene: mount PuttGL on a PuttSim built exactly as GolfGame builds it
// (new PuttSim(course.holes[idx])). The hole is selectable via ?hole=<idx>
// (0-based into the default GARDEN course) so the harness can shoot a slope hole,
// a ramp hole and a banked-rail hole. ?course=<id> picks another registry course.
function PuttPreview() {
  const simRef = useRef<PuttSim | null>(null);
  const course = getPuttCourse(params.get('course') ?? undefined);
  const idxParam = Number.parseInt(params.get('hole') ?? '', 10);
  const idx = Number.isInteger(idxParam) && idxParam >= 0 && idxParam < course.holes.length ? idxParam : 0;
  const hole = course.holes[idx]!;
  if (!simRef.current) {
    const sim = new PuttSim(hole);
    // ?t=<seconds> pre-advances the sim's deterministic clock BEFORE the scene
    // mounts, so a moving obstacle (windmill/gate) is caught MID-rotation, not
    // frozen at phase 0. The ball is at rest, so substep() only accumulates
    // simTime (it early-returns after the clock tick) — no physics side effect.
    // PuttGL's own loop then keeps stepping from here, so the obstacle stays live.
    const t = Number.parseFloat(params.get('t') ?? '');
    if (Number.isFinite(t) && t > 0) {
      const h = FIXED_MS / 1000;
      const steps = Math.min(100000, Math.round(t / h));
      for (let i = 0; i < steps; i++) sim.substep(h);
    }
    simRef.current = sim;
  }
  const sim = simRef.current;
  window.__sim = sim; // dev-only: lets the shooter inspect aim state
  return (
    <>
      <PuttGL sim={sim} hole={hole} />
      <ReadyBeacon />
    </>
  );
}

function CoursePreview({ at }: { at: string | null }) {
  // ONE stable sim (a ref, so StrictMode's double-render doesn't create two and
  // leave a stray fired-but-unstepped ball — that masked the real state earlier).
  const simRef = useRef<CourseSim | null>(null);
  if (!simRef.current) {
    const sim = new CourseSim(HOLE);
    // ?at=<lie> teleports the ball for a specific view; the ball is mutable and
    // getState() reclassifies the lie from position. The green/holed views are
    // pin-relative so they work for ANY hole; fairway/approach use HOLE_1's
    // distances and are only meaningful on the default hole (they're the
    // committed HOLE_1 QA views).
    const b = sim.ball;
    if (at === 'green') {
      b.d = HOLE.pin.d - 6;
      b.x = HOLE.pin.x;
      b.h = heightAt(HOLE, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
    } else if (at === 'holed') {
      b.d = HOLE.pin.d;
      b.x = HOLE.pin.x;
      b.h = heightAt(HOLE, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
      sim.holed = true;
    } else if (at === 'fairway') {
      b.d = 254;
      b.x = -0.7;
      b.h = heightAt(HOLE, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
      sim.selectClub('5iron');
    } else if (at === 'pond') {
      // Pin-relative (so it works on ANY hole): ~62 yd short of the flag on the
      // line to it — the wedge-in view the water work is judged from, matching
      // the reference screenshots. On a hole with a greenside pond this frames
      // the water across the whole lower half of the screen.
      const back = 62;
      const dx = HOLE.pin.x - HOLE.tee.x;
      const dd = HOLE.pin.d - HOLE.tee.d;
      const len = Math.max(1, Math.hypot(dx, dd));
      b.d = HOLE.pin.d - (dd / len) * back;
      b.x = HOLE.pin.x - (dx / len) * back;
      b.h = heightAt(HOLE, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
      sim.selectClub('sw');
    } else if (at === 'approach') {
      // ~45 yd short of the green, so the whole green reads at approach distance.
      b.d = 468;
      b.x = 16;
      b.h = heightAt(HOLE, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
    }
    simRef.current = sim;
  }
  const sim = simRef.current;
  window.__sim = sim; // dev-only: lets the shooter read sim state to debug

  // ?at=played reproduces the REAL device flow: fire a full tee shot through the
  // sim's own pipeline, let CourseGL's loop roll it to rest, THEN the shooter
  // drags to aim the NEXT shot — the only way to catch a bug that only shows on
  // the shot AFTER one you actually played. Fired in an effect (once) so there's
  // no double-fire, and it's the SAME sim CourseGL steps.
  useEffect(() => {
    if (at !== 'played') return;
    sim.onPointerDown({ x: 0, y: 0 });
    sim.onPointerMove({ x: 0, y: -300 });
    sim.arm({ x: 0, y: -300 });
    sim.fireArmed(0);
    // Advance to TRUE rest deterministically — headless rAF is throttled, so the
    // live loop would still be rolling when the shooter drags (exactly the device
    // situation the fix targets). CourseGL's own loop then no-ops (not inFlight).
    const dt = FIXED_MS / 1000;
    let guard = 0;
    while (sim.ball.inFlight && guard++ < 200000) sim.substep(dt);
  }, [sim, at]);

  const waitRest =
    at === 'played' ? () => sim.getState().resting && sim.getState().strokes > 0 : undefined;

  return (
    <>
      <CourseGL sim={sim} />
      <ReadyBeacon until={waitRest} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
