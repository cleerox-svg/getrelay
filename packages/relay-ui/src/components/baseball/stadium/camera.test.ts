// The camera rig's bench. Six assertions, one per property the follow camera
// rests on, and every one of them has been watched to fail under a stated
// mutation — the log is at the bottom of this file.
//
// ⚠ IT NEEDS NO WebGL AND NO CANVAS. `PerspectiveCamera` is arithmetic; the rig
// takes `dtS` as an argument rather than reading a clock. That is not an
// accident of the design, it IS the design: a module that reads
// `performance.now()` cannot be tested for frame-rate independence and cannot be
// frozen by the screenshot harness, and those are the same property.

import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import {
  buildCameraRig,
  CAMERAS,
  CAMERA_EASE_S,
  FOLLOW_TAU_S,
  smootherstep,
} from './camera';

/** The harness's portrait viewport — the aspect every framing claim is made at. */
const ASPECT = 900 / 1600;

const makeCamera = () => {
  const c = new PerspectiveCamera(45, ASPECT, 1, 6000);
  return c;
};

/** Is a scene point inside the camera's frustum? The "in frame" question. */
function inFrame(camera: PerspectiveCamera, p: readonly [number, number, number]): boolean {
  camera.updateMatrixWorld(true);
  const f = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  return f.containsPoint(new Vector3(p[0], p[1], p[2]));
}

/** Where a scene point lands in 0…1 viewport coords, y down. `StadiumApi.ballScreen`. */
function screenOf(camera: PerspectiveCamera, p: readonly [number, number, number]) {
  camera.updateMatrixWorld(true);
  const v = new Vector3(p[0], p[1], p[2]).project(camera);
  return { u: (v.x + 1) / 2, v: (1 - v.y) / 2, z: v.z };
}

/**
 * A ball 2.6 s into a 105 mph / 26.5° fly at `sprayDeg`, in SCENE feet.
 *
 * Taken from the numbers the visual gate printed for the same launch rather than
 * re-integrated here: the point of this test is the CAMERA, and importing
 * `battedBallSim` to prove a framing claim would make a renderer test depend on
 * the whole aero core. Carry 433.5 ft, apex ~93.3 ft at t = 2.6 s.
 */
const flyAt = (sprayDeg: number): [number, number, number] => {
  const r = 256.2; // ground radius at t = 2.6 s, ft (gate: |x| 164.6, |z| 196.2 at 40°)
  const b = (sprayDeg * Math.PI) / 180;
  return [r * Math.sin(b), 93.3, -r * Math.cos(b)];
};

describe('camera rig', () => {
  it('snaps to a mode with no ease, and the pose is the table', () => {
    const cam = makeCamera();
    const rig = buildCameraRig();
    rig.snap(cam, 'batter', null);
    expect(rig.mode()).toBe('batter');
    expect(rig.progress()).toBe(1);
    expect(cam.position.toArray()).toEqual(CAMERAS.batter.pos);
    expect(cam.fov).toBe(CAMERAS.batter.fov);
    expect(cam.near).toBe(CAMERAS.batter.near);
    expect(rig.target()).toEqual(CAMERAS.batter.look);
    // And a snapped mode does not drift when time passes with nothing to follow.
    const before = cam.position.toArray();
    rig.update(cam, 0.5, null);
    expect(cam.position.toArray()).toEqual(before);
    expect(rig.target()).toEqual(CAMERAS.batter.look);
  });

  it('a frozen clock (dt = 0) moves nothing — the byte-identical-PNG contract', () => {
    const cam = makeCamera();
    const rig = buildCameraRig();
    rig.snap(cam, 'batter', null);
    rig.setMode('flight');
    rig.update(cam, 0.25, flyAt(-40));
    const pose = [...cam.position.toArray(), cam.fov, cam.near, ...rig.target()];
    const u = rig.progress();
    // Fifty frames of a FROZEN clock. Every one must render the same picture, or
    // the screenshot harness's whole claim — two runs, identical bytes — is gone.
    for (let i = 0; i < 50; i++) rig.update(cam, 0, flyAt(-40));
    expect([...cam.position.toArray(), cam.fov, cam.near, ...rig.target()]).toEqual(pose);
    expect(rig.progress()).toBe(u);
  });

  it('a mode change EASES: it does not cut, and it does not lurch', () => {
    const cam = makeCamera();
    const rig = buildCameraRig();
    rig.snap(cam, 'batter', null);
    const from = cam.position.clone();
    const to = new Vector3(...CAMERAS.flight.pos);
    const span = from.distanceTo(to);

    rig.setMode('flight');
    // Not a cut: one frame in, the camera has barely left the box.
    rig.update(cam, 1 / 60, null);
    expect(cam.position.distanceTo(from)).toBeLessThan(0.01 * span);
    expect(cam.position.distanceTo(to)).toBeGreaterThan(0.9 * span);

    // ⚠ THE HOLD THROUGH CONTACT, MEASURED. The quintic's derivative is zero at
    // u = 0, so a quarter of the way through the transition only a tenth of the
    // move has happened — ~190 ms of near-hold on the frame the player timed
    // against. A LINEAR blend gives 25 % here, which is what the upper bound
    // below rejects.
    //
    // ⚠ STEPPED AT 60 fps, NOT IN ONE 200 ms LEAP, AND THE FIRST DRAFT OF THIS
    // TEST WAS WRONG BECAUSE OF IT. `MAX_DT_S = 0.1` clamps any single frame, so
    // a lone `update(cam, 0.2)` advances `u` by 0.125 and not 0.25 — it read
    // 1.6 % of the move and looked like a broken curve. The clamp is correct (a
    // backgrounded tab must not teleport the camera) and is asserted separately
    // below; what was wrong was asking a real subsystem to swallow a frame no
    // browser would ever deliver.
    rig.snap(cam, 'batter', null);
    rig.setMode('flight');
    const quarter = CAMERA_EASE_S * 0.25;
    for (let t = 0; t < quarter - 1e-9; t += 1 / 60) rig.update(cam, 1 / 60, null);
    expect(rig.progress()).toBeCloseTo(0.25, 9);
    const moved = cam.position.distanceTo(from) / span;
    expect(moved).toBeCloseTo(smootherstep(0.25), 6);
    expect(moved).toBeGreaterThan(0.09);
    expect(moved).toBeLessThan(0.12);

    // And it ARRIVES, exactly, rather than asymptotically.
    for (let i = 0; i < 60; i++) rig.update(cam, 1 / 60, null);
    expect(rig.progress()).toBe(1);
    expect(cam.position.distanceTo(to)).toBeLessThan(1e-9);
    expect(cam.fov).toBeCloseTo(CAMERAS.flight.fov, 10);
    expect(cam.near).toBeCloseTo(CAMERAS.flight.near, 10);
  });

  it('clamps a monstrous frame — a backgrounded tab must not teleport the camera', () => {
    // `MAX_DT_S` is 0.1 s. A tab restored after 30 s hands the loop a 30,000 ms
    // dt; without the clamp the camera would jump the whole transition in one
    // frame, which is the cut this change exists to remove, arriving by the back
    // door on exactly the frame a player is looking at again.
    const cam = makeCamera();
    const rig = buildCameraRig();
    rig.snap(cam, 'batter', null);
    rig.setMode('flight');
    rig.update(cam, 30, null);
    expect(rig.progress()).toBeCloseTo(0.1 / CAMERA_EASE_S, 9);
    // NaN and negative dt are the same class of input and are also refused.
    const u = rig.progress();
    rig.update(cam, Number.NaN, null);
    rig.update(cam, -5, null);
    expect(rig.progress()).toBe(u);
  });

  it('the transition is FRAME-RATE INDEPENDENT — 60 fps and 20 fps land together', () => {
    // ⚠ THIS IS WHAT MAKES THE HARNESS AGREE WITH THE APP. The preview runs 50 ms
    // virtual frames and the phone runs ~16.7 ms real ones; if the ease were a
    // per-frame constant lerp the captured pose would be a function of frame
    // rate, which is the exact class of bug `lib/scene3d/clock.ts` exists to
    // remove.
    //
    // ⚠ AND THE TWO HALVES DO NOT HAVE THE SAME GUARANTEE, WHICH THIS TEST
    // FOUND AND `camera.ts`'s comment ORIGINALLY OVERSTATED. The BLEND is exact
    // under subdivision — `u` is a sum of `dt / CAMERA_EASE_S`, so any split of
    // the same total gives the same number, and position/fov/near follow it.
    // The follow damping is exact only for a STATIONARY target: its homogeneous
    // part composes as `e^(−T/τ)` whatever the steps, but a target that MOVES
    // between samples is zero-order held, and a longer hold lags further. The
    // residual is `≈ v·Δh/2` — here 202 ft/s × 33 ms / 2 ≈ 3.4 ft, measured
    // 1.34 ft — which at the ~400 ft the deck camera stands off a fly ball is
    // 0.19°, i.e. 9 px of a 1600 px frame. The SCREENSHOT HARNESS is immune to
    // it either way, because `?t=` freezes the ball and a frozen target is the
    // stationary case; this bound is about the app on two different handsets.
    const total = 0.6;
    // ⚠ THE BALL MUST MOVE, AND THE FIRST DRAFT'S DID NOT. A PARKED ball is
    // copied exactly on first sight (see `aimFor`), so the damping never runs
    // and this test degenerated into a check on the BLEND alone — the
    // per-frame-`lerp` mutation it exists for survived it. The ball is now a
    // function of ELAPSED TIME, not of step index, so both runs see the same
    // trajectory sampled at different rates, which is exactly the comparison
    // between a 50 ms virtual frame and a 16.7 ms real one.
    const ballAt = (t: number): [number, number, number] => [
      -20 - 90 * t,
      3 + 120 * t - 16 * t * t,
      -140 * t,
    ];
    const run = (step: number) => {
      const cam = makeCamera();
      const rig = buildCameraRig();
      rig.snap(cam, 'batter', null);
      rig.setMode('flight');
      let t = 0;
      for (; t < total - 1e-9; t += step) rig.update(cam, step, ballAt(t + step));
      return { pos: cam.position.toArray(), aim: rig.target(), u: rig.progress() };
    };
    const fast = run(1 / 60);
    const slow = run(0.05);
    // The blend: EXACT.
    expect(fast.u).toBeCloseTo(slow.u, 12);
    fast.pos.forEach((v, i) => expect(v).toBeCloseTo(slow.pos[i]!, 9));
    // The aim: inside the zero-order-hold residual derived above. A per-frame
    // `lerp(0.12)` — the mutation this exists for — puts the two aims 22 ft
    // apart, because its lag is proportional to the step rather than to τ.
    const aimGap = Math.hypot(...fast.aim.map((v, i) => v - slow.aim[i]!));
    expect(aimGap).toBeLessThan(4);
  });

  it('the FLIGHT camera keeps a pulled and an opposite-field ball in frame', () => {
    // ⚠ THE OWNER'S SECOND DEFECT, AS A NUMBER. "it's odd that I can't see the
    // ball if it's hit to left or right field." The flight camera's horizontal
    // FOV at this viewport is 2·atan(tan(27.5°)·0.5625) = 32.6°, i.e. ±16.3°
    // about a FIXED axis — so both corners were off the picture. The `static`
    // arm below reproduces that, so this test states the bug as well as the fix
    // and cannot pass by accident on a camera that happens to be pointed well.
    for (const spray of [-40, 40, -22, 22, 0]) {
      const ball = flyAt(spray);

      const stat = makeCamera();
      stat.position.set(...CAMERAS.flight.pos);
      stat.fov = CAMERAS.flight.fov;
      stat.near = CAMERAS.flight.near;
      stat.lookAt(...CAMERAS.flight.look);
      stat.updateProjectionMatrix();

      const cam = makeCamera();
      const rig = buildCameraRig();
      rig.snap(cam, 'flight', ball);
      // Settle: the ball is parked, so the damping converges onto it.
      for (let i = 0; i < 60; i++) rig.update(cam, 1 / 60, ball);

      const s = screenOf(cam, ball);
      expect(s.u, `spray ${spray}° u`).toBeGreaterThanOrEqual(0);
      expect(s.u, `spray ${spray}° u`).toBeLessThanOrEqual(1);
      expect(s.v, `spray ${spray}° v`).toBeGreaterThanOrEqual(0);
      expect(s.v, `spray ${spray}° v`).toBeLessThanOrEqual(1);
      expect(inFrame(cam, ball), `spray ${spray}° frustum`).toBe(true);

      // The corners are exactly the ones the STATIC camera lost.
      if (Math.abs(spray) === 40) {
        expect(inFrame(stat, ball), `static camera should MISS ${spray}°`).toBe(false);
      }
    }
  });

  it('the BATTER camera ignores the ball entirely — the timing frame never moves', () => {
    // ⚠ NON-NEGOTIABLE, and it is the reason `follow` is a column in the table
    // rather than a global. This is the frame the player times the swing
    // against; a camera that drifted before the tap would break the one skill
    // the game has. Compared against a rig that never sees a ball at all, over a
    // ball moving through the whole flight.
    const withBall = buildCameraRig();
    const without = buildCameraRig();
    const a = makeCamera();
    const b = makeCamera();
    withBall.snap(a, 'batter', flyAt(-40));
    without.snap(b, 'batter', null);
    for (let i = 0; i < 40; i++) {
      withBall.update(a, 1 / 60, flyAt(-40 + i));
      without.update(b, 1 / 60, null);
    }
    expect(a.position.toArray()).toEqual(b.position.toArray());
    expect(withBall.target()).toEqual(without.target());
    expect(withBall.target()).toEqual(CAMERAS.batter.look);
  });

  it('the follow LAGS the ball rather than nailing it to frame centre', () => {
    // "an ease, not a rigid chase". With the target moving at a steady `v` the
    // damped point settles ~v·τ behind it, so the ball sits AHEAD of the axis,
    // which is what reads as speed. Zero lag would be the rigid chase.
    const cam = makeCamera();
    const rig = buildCameraRig();
    const v = 150; // ft/s along +x, roughly a ball off the bat
    let x = 0;
    rig.snap(cam, 'flight', [x, 90, -250]);
    const step = 1 / 120;
    for (let i = 0; i < 240; i++) {
      x += v * step;
      rig.update(cam, step, [x, 90, -250]);
    }
    const lag = x - rig.target()[0];
    // ⚠ `v·τ` IS THE CONTINUOUS LIMIT, NOT THE DISCRETE ANSWER, and the first
    // draft of this line asserted the limit to ±0.5 and failed at 29.378 against
    // 30. A discrete filter `p += (target − p)·a` tracking a ramp settles at
    // `L = v·h·(1 − a)/a`, which tends to `v·τ` only as the step `h → 0`; at
    // h = 1/120 and τ = 0.2 that is 29.38 ft, a 2.1 % deficit. Asserting the
    // ratio says the thing that is actually true and stays true if the bench's
    // step changes. A per-frame `lerp(0.12)` — the mutation this exists for —
    // lands at 9.2 ft, i.e. a ratio of 0.31.
    expect(lag / (v * FOLLOW_TAU_S)).toBeCloseTo(1, 1);
    expect(lag).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS WATCHED TO FAIL — applied to `stadium/camera.ts`, this file run,
// then reverted. Counts are of failing tests in THIS file.
//
//   (1) `follow: true` → `false` on the flight row (i.e. the camera
//       does not follow the ball at all — the SHIPPED behaviour)     → 2 fail
//   (2) the quintic blend replaced by a linear `s = u`               → 1 fail
//   (3) `setMode` applies instantly (`u = 1`), i.e. a CUT            → 2 fail
//   (4) the follow damping replaced by a per-frame `lerp(0.12)`      → 2 fail
//   (5) the `dt` clamp/guard replaced by a raw `const dt = dtS`      → 1 fail
//   (6) `follow` made global — the batter row follows too            → 1 fail
//   (7) first-sight `copy` replaced by a damp from the mode anchor   → 1 fail
//
// ⚠ (4) FIRST KILLED ONLY ONE TEST, AND THE SECOND ONE WAS HOLLOW. The
// frame-rate-independence test held the ball STILL, and a stationary target is
// copied exactly on first sight — so the damping it was written to police never
// ran. The ball is now a function of elapsed time, which also exposed that the
// exponential's exactness under subdivision covers the homogeneous part only;
// both the test and `camera.ts`'s comment were corrected rather than the bound
// widened.
// ---------------------------------------------------------------------------
