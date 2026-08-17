// The FLIGHT builder's bench — specifically, the progressive REVEAL.
//
// ⚠ WHAT THIS EXISTS TO PIN. The owner played the shipped build and reported
// "the arc is there steady when I expected it would be created as the ball is
// flying not ahead of it". It was: `setPaths` handed each tracer the whole
// flight, so the entire path — INCLUDING THE LANDING POINT — was drawn from the
// instant the pitch was served. That is an information leak, not a look problem:
// a home run is readable before it happens, and the break of an incoming pitch
// is readable before the player has to commit to a swing.
//
// The visual gate asserts the same thing on the real GPU buffers, in a browser.
// This file asserts it in 30 ms, so the property is defended in the suite that
// runs on every change rather than only in the one that needs Chromium.
//
// ⚠ NO WebGL. `buildFlight` allocates BufferGeometry and Meshes, which are plain
// objects until a renderer touches them. Nothing here renders.

import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { vec3 } from '../../../lib/baseball/airPhysics';
import { launchFromAngles, simulateBattedBall } from '../../../lib/baseball/battedBallSim';
import { HARBOURFRONT, parkConditions } from '../../../lib/baseball/parks';
import { PITCHES } from '../../../lib/baseball/pitches';
import { simulatePitch } from '../../../lib/baseball/pitchSim';
import { ZONE_CENTER } from '../../../lib/baseball/zone';
import { buildFlight } from './flight';
import type { StadiumCtx, Disposable } from './geom';
import { DAYLIGHT } from './daylight';

/**
 * The session seed the scene is built with here. FIXED — `StadiumCtx.seed`
 * exists so the tower's LED programme can differ per session, and a test that
 * fed it a clock would be the one thing the whole determinism chapter forbids.
 */
const TEST_SEED = 20260816;

const ctx = (): StadiumCtx => ({
  scene: new Scene(),
  track: <T extends Disposable>(r: T) => r,
  park: HARBOURFRONT,
  seed: TEST_SEED,
  daylight: DAYLIGHT.day,
  quality: {
    tier: 'medium',
    shadows: true,
    shadowMapSize: 1024,
    fenceStepDeg: 1.5,
    bowlStepDeg: 3,
    seatTexturePx: 256,
    grainPx: 256,
    trussCells: 96,
    pixelRatioCap: 1.5,
    reason: 'test',
  },
});

const SUN: [number, number, number] = [520, -700, -430];

const pitch = simulatePitch({ pitch: PITCHES[0]!, hand: 'R', target: ZONE_CENTER });
const conditions = parkConditions(HARBOURFRONT, true, 20260816);
const batted = simulateBattedBall(
  launchFromAngles(105, 26.5, -12, 2200, 0, vec3(0, 0, pitch.plate.h)),
  conditions.air,
  conditions.windFps,
);
const paths = { pitch: pitch.track, batted: batted.track, contactTS: pitch.plate.t };

/** How many of `times` are at or before `t`. Re-derived, not imported. */
const countAtOrBefore = (times: readonly number[], t: number) =>
  times.reduce((n, v) => (v <= t ? n + 1 : n), 0);

describe('flight tracer reveal', () => {
  it('draws NOTHING before the ball is released', () => {
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    // ⚠ THE WIND-UP IS A REAL 380 ms OF THE GAME. `DerbyGame.serve()` hands the
    // renderer the flight immediately and runs the play clock NEGATIVE until
    // release, so before this fix the complete pitch — break and all — sat on
    // screen while the pitcher was still holding the ball.
    f.setTime(-0.2);
    expect(f.tracer('pitch')).toEqual([]);
    expect(f.tracer('batted')).toEqual([]);
    expect(f.tracerVisible('pitch')).toBe(false);
    // …and the GEOMETRY is nonetheless fully built, which is the half that makes
    // the visual gate's drawn-vs-sim comparison still mean something.
    expect(f.tracerFull('pitch').length / 3).toBe(pitch.track.t.length);
    expect(f.tracerFull('batted').length / 3).toBe(batted.track.t.length);
  });

  it('reveals exactly the samples that have HAPPENED, and never one more', () => {
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    for (const t of [0, 0.05, 0.15, 0.3]) {
      f.setTime(t);
      const want = countAtOrBefore(pitch.track.t, t);
      expect(f.tracer('pitch').length / 3, `pitch at t = ${t}`).toBe(want);
      // Strictly short of the whole path everywhere before the plate — the
      // assertion the old full-reveal implementation fails on every row.
      expect(want).toBeLessThan(pitch.track.t.length);
      // The batted ball has not been struck yet, so none of it is on screen.
      expect(f.tracer('batted')).toEqual([]);
    }
    // ⚠ THE CONTACT INSTANT ITSELF IS A BOUNDARY AND IT IS ASSERTED, NOT
    // AVOIDED. `t === contactTS` counts as struck, so the pitch goes fully drawn
    // and the batted ball reveals its FIRST sample — one vertex, which a `Line`
    // rasterises as nothing at all. That is the correct half-open answer (a
    // trail cannot exist before its first segment) and it is what the loop above
    // tripped over when it was written as `t <= plate.t`.
    f.setTime(pitch.plate.t);
    expect(f.tracer('pitch').length / 3).toBe(pitch.track.t.length);
    expect(f.tracer('batted').length / 3).toBe(1);
    expect(f.tracerVisible('batted')).toBe(true);
  });

  it('CONTACT IS THE PLATE CROSSING — the premise the pitch reveal rests on', () => {
    // ⚠ THIS TEST EXISTS BECAUSE A MUTATION PASSED. `applyReveal` first shipped
    // with a second mechanism — "once struck, pin the pitch trail fully open" —
    // and deleting it failed 0 of 6 tests here. It is unreachable: `contactTS`
    // is the plate crossing, which is the pitch track's LAST sample, so
    // `tS ≥ contactTS` already reveals the whole track through the ordinary
    // path. The branch is gone; this is the premise it was standing on,
    // asserted, so that a caller who one day contacts the ball out in front of
    // the plate gets a failing test rather than a pitch trail that keeps
    // drawing itself after the ball has been hit.
    const last = pitch.track.t[pitch.track.t.length - 1]!;
    expect(paths.contactTS).toBe(last);
  });

  it('leaves the pitch trail up once the ball is struck, and grows the batted one', () => {
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    for (const bt of [0, 0.12, 1.0, 2.6]) {
      f.setTime(paths.contactTS + bt);
      // The pitch is HISTORY: fully drawn, because that trail is what makes the
      // contact seam legible.
      expect(f.tracer('pitch').length / 3, `pitch after contact +${bt}`).toBe(
        pitch.track.t.length,
      );
      expect(f.tracer('batted').length / 3, `batted at +${bt}`).toBe(
        countAtOrBefore(batted.track.t, bt),
      );
    }
    // And at the end of the flight the whole arc is legitimately on screen.
    f.setTime(paths.contactTS + batted.hangS + 1);
    expect(f.tracer('batted').length / 3).toBe(batted.track.t.length);
  });

  it('the drawn vertices are a PREFIX of the built path — geometry is revealed, not rewritten', () => {
    // ⚠ THE OTHER HALF OF THE CONTRACT, and the one the visual gate's tolerance
    // depends on. If the renderer re-authored the buffer each frame to end
    // exactly at the ball, the trail would look right and the gate's 0.002 ft
    // drawn-vs-sim check would be comparing something that no longer exists a
    // frame later. Bit-for-bit, because a Float32 prefix has no tolerance to
    // spend.
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    const all = f.tracerFull('batted');
    for (const bt of [0.12, 1.0, 2.6]) {
      f.setTime(paths.contactTS + bt);
      const drawn = f.tracer('batted');
      expect(drawn.length).toBeGreaterThan(0);
      expect(drawn).toEqual(all.slice(0, drawn.length));
    }
    // The full buffer itself never moved across all of that.
    expect(f.tracerFull('batted')).toEqual(all);
  });

  it("the trail's tip is BEHIND the ball, by under one substep", () => {
    // The geometric statement of the leak, independent of any count: walking
    // from the tip toward the next (hidden) vertex must walk TOWARD the ball,
    // and must not overshoot it. A tracer written in reverse order, or revealed
    // from the wrong end, passes every count assertion above and dies here.
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    let worstLag = 0;
    for (const bt of [0.05, 0.4, 1.3, 2.6, 4.0]) {
      f.setTime(paths.contactTS + bt);
      const drawn = f.tracer('batted');
      const all = f.tracerFull('batted');
      const n = drawn.length / 3;
      const ball = f.ballScene()!;
      expect(ball).not.toBeNull();
      if (n >= all.length / 3) continue;
      const tip = [drawn[(n - 1) * 3]!, drawn[(n - 1) * 3 + 1]!, drawn[(n - 1) * 3 + 2]!];
      const next = [all[n * 3]!, all[n * 3 + 1]!, all[n * 3 + 2]!];
      const toBall = ball.map((v, i) => v - tip[i]!);
      const toNext = next.map((v, i) => v - tip[i]!);
      const dot = toBall[0]! * toNext[0]! + toBall[1]! * toNext[1]! + toBall[2]! * toNext[2]!;
      const lag = Math.hypot(...toBall);
      const step = Math.hypot(...toNext);
      // ⚠ THE SIGN NEEDS AN EPSILON, AND THE REASON IS FLOAT32 — the first draft
      // asserted `dot >= 0` and failed at +1.3 s with dot = −9.5e-7. 1.3 s is an
      // exact multiple of the 1/120 s substep, so the ball sits exactly ON the
      // tip vertex, `toBall` is a difference between a Float64 sample and its
      // Float32 copy in the GPU buffer (2.7e-5 ft at 450 ft) and its sign is
      // noise. Normalising by the step and comparing against the gate's own
      // derived 0.002 ft float32 tolerance makes this "the ball is not
      // measurably behind the tip", which is the claim that was meant.
      expect(dot / step, `tip must point at the ball at +${bt}`).toBeGreaterThan(-0.002);
      expect(lag, `tip lag at +${bt}`).toBeLessThanOrEqual(step + 0.002);
      worstLag = Math.max(worstLag, lag);
    }
    // ⚠ THE MEASURED BOUND, PRINTED RATHER THAN ASSUMED. The reveal is
    // sample-granular, so the tip lags by up to `|v|·FIXED_MS` — 1.25 ft off a
    // 105 mph bat. That is nearly all ALONG the view axis in the two cameras
    // that watch a batted ball, which is why sample granularity was chosen over
    // writing an interpolated tip vertex (which would break the prefix property
    // above, and with it the gate's geometry seam).
    expect(worstLag).toBeLessThan(1.5);
    expect(worstLag).toBeGreaterThan(0);
  });

  it('followScene is the BATTED ball only — a pitch never moves the deck camera', () => {
    // The camera's follow target is deliberately narrower than `ballScene`. A
    // following camera pointed at a PITCH would re-frame every harness shot that
    // has a pitch in the air and no swing, and would put the upper-deck camera
    // on a 55 ft flight the batter camera is already holding.
    const f = buildFlight(ctx(), { sunDir: SUN });
    f.setPaths(paths);
    f.setTime(0.2);
    expect(f.ballScene()).not.toBeNull();
    expect(f.followScene()).toBeNull();
    f.setTime(paths.contactTS + 1.0);
    expect(f.followScene()).toEqual(f.ballScene());
    f.setTime(-1);
    expect(f.followScene()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS WATCHED TO FAIL — applied to `stadium/flight.ts` or `tracer.ts`,
// this file run, then reverted. Counts are of failing tests in THIS file.
//
//   (1) `applyReveal` deleted, i.e. `set()`'s full reveal stands
//       (the SHIPPED behaviour the owner reported)                   → 4 fail
//   (2) `revealCount` returns `n + 1` (an off-by-one LEAD)           → 3 fail
//   (3) the pitch reveal's `struck ? full : count` branch deleted    → 0 fail
//   (4) `<=` → `<` in `revealCount`'s binary-search predicate        → 1 fail
//   (5) `followScene` returns `ballPos` (i.e. follows the pitch too) → 1 fail
//   (6) `set()` writes the path REVERSED                             → 1 fail
//   (7) `reveal()` ignores its argument and reveals everything       → 4 fail
//   (8) `readAll()` aliases `read()` — the GEOMETRY seam narrows to
//       the revealed prefix, which would silently gut the visual
//       gate's 0.002 ft drawn-vs-sim check                           → 3 fail
//
// ⚠ (3) IS A MUTATION WATCHED TO **PASS**, and the branch is gone because of it.
// `contactTS` IS the plate crossing — the pitch track's own last sample — so
// `tS ≥ contactTS` already reveals the whole pitch through the ordinary path.
// Two mechanisms covering one case, the same shape BASEBALL.md records in
// `fielding.ts`. The premise is asserted instead, by the test named for it, so
// that a caller who contacts the ball somewhere other than the plate gets a red
// run rather than a trail that keeps drawing itself after the ball is hit.
// ---------------------------------------------------------------------------
