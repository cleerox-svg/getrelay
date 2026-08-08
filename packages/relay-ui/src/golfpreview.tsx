// Dev/CI-only preview harness for the golf 3D scenes. Mounts exactly ONE scene
// (CourseGL or RangeGL) standalone — no <App>, no auth, no store — so the golf
// renderer can be screenshotted headlessly (scripts/shoot-golf.mjs) for visual
// QA. It is NEVER imported by the app and is not a production build input.
//
// URL query:
//   ?scene=course                     → CourseGL on HOLE_1
//   ?scene=range&layout=fairway       → RangeGL (layout: lane|practiceLane|fairway)
//
// The scenes own only the Three.js renderer; they take a sim instance as a prop,
// built here exactly as CourseGame/RangeGame build it. Once the scene has drawn
// a few frames we set window.__golfReady so the shooter can wait for a real
// render (not just DOMContentLoaded) before capturing.

import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import CourseGL from './components/golf/CourseGL';
import RangeGL from './components/golf/RangeGL';
import { CourseSim } from './lib/golf/courseSim';
import { HOLE_1, heightAt } from './lib/golf/terrain';
import { FIXED_MS } from './lib/golf/tuning';
import { RangeSim } from './lib/golf/rangeSim';
import { pinsFor, DEFAULT_LAYOUT, type RangeLayout } from './lib/golf/rangeTargets';

declare global {
  interface Window {
    __golfReady?: boolean;
    __sim?: CourseSim;
  }
}

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'course';
const layout = (params.get('layout') as RangeLayout | null) ?? DEFAULT_LAYOUT;

// Flip the readiness flag after the scene has had time to build its textures and
// draw a handful of frames (the scenes animate — water shimmer, camera settle —
// so a few frames in is a stable "address" view).
function ReadyBeacon({ until }: { until?: () => boolean }) {
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    const tick = () => {
      // If a readiness predicate is given (e.g. wait for a fired shot to rest),
      // hold until it's satisfied; otherwise a few frames to let textures land.
      if (until ? until() && frames >= 20 : frames >= 45) {
        window.__golfReady = true;
        return;
      }
      frames++;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Hard fallback so the shooter never hangs.
    const t = window.setTimeout(() => (window.__golfReady = true), until ? 16000 : 4000);
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
  return <CoursePreview at={params.get('at')} />;
}

function CoursePreview({ at }: { at: string | null }) {
  // ONE stable sim (a ref, so StrictMode's double-render doesn't create two and
  // leave a stray fired-but-unstepped ball — that masked the real state earlier).
  const simRef = useRef<CourseSim | null>(null);
  if (!simRef.current) {
    const sim = new CourseSim(HOLE_1);
    // ?at=<lie> teleports the ball for a specific view; the ball is mutable and
    // getState() reclassifies the lie from position.
    const b = sim.ball;
    if (at === 'green') {
      b.d = HOLE_1.pin.d - 6;
      b.x = HOLE_1.pin.x;
      b.h = heightAt(HOLE_1, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
    } else if (at === 'holed') {
      b.d = HOLE_1.pin.d;
      b.x = HOLE_1.pin.x;
      b.h = heightAt(HOLE_1, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
      sim.holed = true;
    } else if (at === 'fairway') {
      b.d = 254;
      b.x = -0.7;
      b.h = heightAt(HOLE_1, b.d, b.x);
      b.inFlight = b.grounded = false;
      b.resting = true;
      sim.selectClub('5iron');
    } else if (at === 'approach') {
      // ~45 yd short of the green, so the whole green reads at approach distance.
      b.d = 468;
      b.x = 16;
      b.h = heightAt(HOLE_1, b.d, b.x);
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
