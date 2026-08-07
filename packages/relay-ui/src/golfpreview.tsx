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

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import CourseGL from './components/golf/CourseGL';
import RangeGL from './components/golf/RangeGL';
import { CourseSim } from './lib/golf/courseSim';
import { HOLE_1, heightAt } from './lib/golf/terrain';
import { RangeSim } from './lib/golf/rangeSim';
import { pinsFor, DEFAULT_LAYOUT, type RangeLayout } from './lib/golf/rangeTargets';

declare global {
  interface Window {
    __golfReady?: boolean;
  }
}

const params = new URLSearchParams(location.search);
const scene = params.get('scene') ?? 'course';
const layout = (params.get('layout') as RangeLayout | null) ?? DEFAULT_LAYOUT;

// Flip the readiness flag after the scene has had time to build its textures and
// draw a handful of frames (the scenes animate — water shimmer, camera settle —
// so a few frames in is a stable "address" view).
function ReadyBeacon() {
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    const tick = () => {
      if (++frames >= 45) {
        window.__golfReady = true;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Hard fallback so the shooter never hangs if rAF is throttled.
    const t = window.setTimeout(() => (window.__golfReady = true), 4000);
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
  const sim = new CourseSim(HOLE_1);
  // ?at=<lie> places the ball somewhere other than the tee so the different
  // views (putting camera, an approach with an iron) can be screenshotted. The
  // ball object is mutable; set position and let getState() reclassify the lie.
  const at = params.get('at');
  if (at === 'green') {
    const b = sim.ball;
    b.d = HOLE_1.pin.d - 6;
    b.x = HOLE_1.pin.x;
    b.h = heightAt(HOLE_1, b.d, b.x);
    b.inFlight = b.grounded = false;
    b.resting = true;
  } else if (at === 'fairway') {
    // Mid-fairway approach, the "after driving" state — with an iron, so the
    // aim arc for a non-driver club can be exercised by a scripted drag.
    const b = sim.ball;
    b.d = 254;
    b.x = -0.7;
    b.h = heightAt(HOLE_1, b.d, b.x);
    b.inFlight = b.grounded = false;
    b.resting = true;
    sim.selectClub('5iron');
  }
  return (
    <>
      <CourseGL sim={sim} />
      <ReadyBeacon />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
