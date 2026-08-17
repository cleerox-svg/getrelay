// THE CAMERA RIG — the four placements, and the one thing that moves between
// them.
//
// ⚠ WHY THIS IS A MODULE AND NOT TEN LINES IN THE COMPOSER. `StadiumGL.tsx` owns
// "the renderer, the lights, the camera modes and the loop"; the moment a camera
// mode acquires STATE — a pose it is easing from, a follow point it is damping
// toward — it stops being a table lookup and becomes a subsystem with an
// invariant. `CourseGL.tsx` is 2630 lines because every such subsystem was
// reasonable to inline once. This one is `(dt, ball) => pose`, it is pure, and
// it has its own test file.
//
// ⚠ ONE SCENE, CAMERA MODES — still. This adds no second camera and no second
// scene. `batter` / `pitcher` / `flight` / `wide` are the same four placements
// M1 shipped; what is new is that switching between them is an EASE rather than
// a CUT, and that `flight` AIMS AT THE BALL instead of at a fixed point in the
// outfield. Both were asked for by the owner after playing the live build:
// "when the ball is hit the camera should follow it a bit", and "it's odd that I
// can't see the ball if it's hit to left or right field".
//
// ⚠ IT IS NOT A SMALL MOVE, AND CALLING IT ONE WAS WRONG. This work has been
// described as a "yaw-only pull-back" and as "aiming at the ball", both of which
// read as a stationary camera turning its head. It is not. `batter` → `flight`
// TRANSLATES the camera 148.2 ft — [0, 3.2, 8] to [−40, 120, 90] — while the fov
// goes 40° → 55° and the near plane 1 → 4 ft, all inside `CAMERA_EASE_S` = 0.8 s;
// see that constant for what that is in ft/s. And the FOLLOW alone is not a yaw
// either: aiming at the −40° ball swings the axis 23.5° in BEARING and 2.4° in
// ELEVATION. Nothing about the behaviour is wrong — the description was, and an
// understated one is how a future reader decides this is safe to touch without
// ever looking at it in motion.
//
// ⚠ TIME COMES FROM `lib/scene3d/clock.ts`, NEVER FROM `performance.now()`.
// Nothing in this file reads a clock at all — `update()` takes `dtS` — which is
// the shape that lets the screenshot harness freeze the world. `dtS === 0` must
// be a no-op in every branch here, and it is: `u` does not advance and the
// damping factor `1 − e⁰` is exactly 0. Golf measured 23 of 25 scenes differing
// between two identical runs because their animation sampled the wall clock;
// this is the same mistake, one game later, and it is designed out rather than
// tested for.

import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';

export type CameraMode = 'batter' | 'pitcher' | 'flight' | 'wide';

export const CAMERA_MODES: CameraMode[] = ['batter', 'pitcher', 'flight', 'wide'];

export const isCameraMode = (v: unknown): v is CameraMode =>
  CAMERA_MODES.includes(v as CameraMode);

export interface CameraSpec {
  pos: [number, number, number];
  look: [number, number, number];
  fov: number;
  near: number;
  /**
   * Does this mode AIM AT THE BALL? Exactly one does, and making it a column
   * rather than an `if (mode === 'flight')` is the anti-bloat rule applied to
   * behaviour: a second following camera is a row, not a branch.
   *
   * ⚠ `look` IS STILL LOAD-BEARING FOR A FOLLOWING MODE. It is where the camera
   * aims when there is no ball to follow — which is every frame of the pitch,
   * because the follow target is the BATTED ball alone (see `StadiumGL`'s
   * `followScene`). Point a following camera at a pitch and the harness's
   * `flight` scene re-frames for no reason.
   */
  follow: boolean;
}

/**
 * The four camera placements, in SCENE feet: `x` lateral (+ = first-base side),
 * `y` up, `z` negative toward centre field. See `stadium/geom.ts` for the frame.
 *
 * These are FRAMING, the one honestly subjective thing in the scene — every
 * other number in it is data. They are written as a table so that re-framing a
 * shot is an edit to five numbers and not to a render path.
 *
 * ⚠ `near` IS PER MODE, AND THAT IS A BUG FIX, NOT A FLOURISH. A stadium spans
 * three orders of magnitude — a 0.05 ft gap between the grass and the warning
 * track, read from 1200 ft away in the `wide` shot. With one 0.5 ft near plane
 * and a 6000 ft far plane the depth buffer could not separate them: the first
 * `wide` render showed the seating bowl as TRANSLUCENT and the turf striped with
 * radial spokes, both of which are z-fighting and neither of which is a material
 * problem. The near plane is therefore pushed out to just inside the nearest
 * geometry each camera can actually see. It is INTERPOLATED across a transition
 * like everything else, so a camera easing from the box to the upper deck never
 * clips through geometry it has already passed.
 */
export const CAMERAS: Record<CameraMode, CameraSpec> = {
  // Behind the plate at CATCHER/UMPIRE height, inside the backstop (which stands
  // at `foulTerritoryFt`, so the camera has to sit nearer than that or it shoots
  // through the stands).
  //
  // ⚠ RE-FRAMED IN M2c, AND THE OLD ONE WAS MEASURABLY UNPLAYABLE. The previous
  // placement — [0, 8.5, 20] looking at [0, 4, −55] — put the strike zone 13.3°
  // below the look axis against a 20° half-FOV, i.e. 78 % of the way DOWN a
  // portrait screen, under the HUD's own bottom chrome. The visual gate
  // photographed it the moment the reticle existed to sit in it. The zone is
  // this mode's SUBJECT now, so the framing is derived from the two things the
  // shot has to contain:
  //
  //     release point  (0, 5.8, −54) → +2.4° from a camera at (0, 3.2, 8)
  //     zone centre    (0, 2.5,   0) → −5.0° from the same camera
  //
  // Aim at the bisector (−1.3°) and the whole pitch spans 41 %→59 % of the
  // frame, dead centre, with the 1.8 ft zone 32 % of the screen height tall.
  //
  // ⚠ IT DOES NOT FOLLOW, AND THAT IS NON-NEGOTIABLE. This is the frame the
  // player times the swing against. A camera that drifts before the tap would
  // break the one skill the game has, so `follow: false` here is a gameplay
  // constraint, not a framing preference — and `camera.test.ts` asserts that a
  // ball in the scene moves this pose by exactly zero.
  batter: { pos: [0, 3.2, 8], look: [0, 2.52, -30], fov: 40, near: 1, follow: false },
  // From the mound, looking in at the plate. Narrow, because a pitcher's view of
  // a 17 in plate 55 ft away IS narrow and pretending otherwise flatters the aim.
  pitcher: { pos: [0, 6, -55], look: [0, 2.6, 0], fov: 26, near: 1, follow: false },
  // Upper deck behind home, a little to the third-base side, looking out over
  // the whole outfield — the frame a batted ball is watched in. Two earlier
  // framings put the camera beside or behind the bowl and photographed the back
  // of the seating rake; a camera ABOVE the rake looking down its axis is what
  // clears it. It is also the only mode that gets the 282 ft roof and the 10 ft
  // wall into one frame, so the ceiling reads as a height against something.
  //
  // ⚠ THIS IS THE MODE THE OWNER'S SECOND DEFECT LIVED IN. Its horizontal field
  // of view at 900×1600 portrait is 2·atan(tan(27.5°)·0.5625) = 32.6°, i.e.
  // ±16.3° about a fixed axis — so a ball pulled to either corner (±45° of
  // spray) left the frame and was never seen again. Measured before the fix, at
  // 105 mph / 26.5° / 2.6 s: at −40° of spray the ball projects to u = −0.241,
  // 217 px off the left edge with a sliver of tracer showing; at +40° to
  // u = +1.716, 645 px past the right edge, with the ball AND the whole arc
  // absent from the picture entirely. (⚠ An earlier version of this note quoted
  // −0.083 / +1.098, a pair symmetric about u ≈ 0.5075 — which only a camera at
  // x = 0 can produce, and this one stands at x = −40. The asymmetry is exactly
  // why the oppo corner is ~3× worse than the pull corner. See the SCENES table
  // in `scripts/shoot-baseball.mjs` for the full correction.) Widening the FOV
  // cannot fix that — it needs 90°+, which throws the ball away to a handful of
  // pixels — whereas aiming at the ball can, at no cost in angular resolution.
  // It is NOT free in motion, though: see `CAMERA_EASE_S` for the size of the
  // move this mode is the destination of.
  flight: { pos: [-40, 120, 90], look: [-40, 60, -380], fov: 55, near: 4, follow: true },
  // The whole park. High enough to clear the back of the bowl behind home
  // (deck top 130 ft at r ≈ 160 ft), which the first framing did not and so
  // photographed the outside of the backstop instead of the field. Nearest
  // geometry is the roof rim at ~780 ft, so a 200 ft near plane is generous.
  wide: { pos: [0, 1000, 470], look: [0, 0, -200], fov: 56, near: 200, follow: false },
};

/**
 * How long a mode change takes, s. FEEL KNOB.
 *
 * ⚠ AND THE CURVE MATTERS MORE THAN THE NUMBER. The blend is a QUINTIC
 * smootherstep `6u⁵ − 15u⁴ + 10u³`, whose derivative is zero at BOTH ends, so
 * the camera does not lurch on the frame contact happens and does not slam to a
 * stop on arrival. Concretely: 10.4 % of the move has happened at 25 % of the
 * duration, which at 0.8 s is ~190 ms of near-hold on the batter camera after
 * the bat meets the ball. That hold is the design intent — "hold the batter
 * camera through contact" — expressed by the curve rather than by a second
 * timer, so there is one piece of state and not two.
 *
 * ⚠ AND WHAT IT IS EASING IS BIG. `batter` → `flight` interpolates POSITION over
 * 148.2 ft (|[−40, 120, 90] − [0, 3.2, 8]|), plus fov 40° → 55°, near 1 → 4 ft,
 * and a look point slewing onto a moving ball. Over 0.8 s that averages
 * 185 ft/s, and a quintic's peak rate is 30u²(1−u)² at u = ½ = **1.875×** its
 * mean — so mid-move the camera is travelling ~347 ft/s. That is the honest size
 * of the move, and it is recorded here because the same curve that gives the
 * 190 ms hold at the START is what concentrates the speed in the MIDDLE.
 *
 * ⚠ THE VISUAL GATE CANNOT ADJUDICATE THIS. `follow-ease` photographs exactly
 * one frame of it (smootherstep(0.5) = 0.5, the half-way pose, which is also
 * where the rate peaks) and a still frame says nothing about whether a swoop of
 * this size reads as broadcast or as motion sickness. Only real-time capture or
 * on-device play can. See BASEBALL.md § "M2e" for the on-device watch list —
 * the near plane sweeping 1 → 4 ft through the same 0.8 s is on it.
 */
export const CAMERA_EASE_S = 0.8;

/**
 * Follow lag, s. FEEL KNOB — "an ease, not a rigid chase".
 *
 * The look point chases the ball with an exponential of this time constant, so
 * a ball moving at `v` settles to a steady lag of about `v·τ` behind the camera
 * axis and therefore sits AHEAD of frame centre, which is what reads as speed.
 * At 0.20 s: ~30 ft of lag just off the bat (≈4° at the ~420 ft the flight
 * camera stands off a corner), shrinking as the ball slows through its arc, so
 * the ball drifts back toward centre as it hangs. Zero would be a rigid chase
 * and would look like the ball was nailed to the middle of the screen.
 *
 * ⚠ THAT PARAGRAPH IS AN INTENT, NOT A VERIFIED RESULT, AND THE VISUAL GATE
 * STRUCTURALLY CANNOT VERIFY IT. Every captured frame puts the ball at exactly
 * (0.500, 0.500) — `follow-pull` and `follow-oppo` both print it — because `?t=`
 * / `?bt=` FREEZE the ball, and a stationary target is the converged case of
 * `1 − e^(−dt/τ)`: `aimFor` copies it on first sight and then damps toward a
 * point that never moves. So what the gate photographs is precisely the RIGID
 * CHASE this comment says the constant avoids, and the 30 ft of lead is
 * unphotographed. The arithmetic above is sound; whether it reads as speed is a
 * claim only a real-time capture or on-device play can settle. Recorded in
 * BASEBALL.md § "M2e" as a known limit rather than left reading as measured.
 *
 * ⚠ AN EXPONENTIAL, NOT A PER-FRAME CONSTANT `lerp(0.1)`, BECAUSE THE STEP SIZE
 * MUST NOT CHANGE THE ANSWER. `1 − e^(−dt/τ)` applied over steps summing to `T`
 * leaves exactly `e^(−T/τ)` of the error whatever the steps were — so a
 * STATIONARY target (which is every screenshot, since `?t=` freezes the ball) is
 * converged to identically by the harness's 50 ms virtual frames and the app's
 * ~16.7 ms real ones. A fixed per-frame factor has no such property and would
 * make the captured frame a function of machine speed.
 *
 * ⚠ THE EXACTNESS IS THE HOMOGENEOUS PART ONLY, and an earlier draft of this
 * comment claimed more than that. A target that MOVES between samples is
 * zero-order held, so a longer step lags further: the residual between two step
 * sizes is `≈ v·Δh/2`, measured at 1.34 ft between 16.7 ms and 50 ms on a
 * 202 ft/s ball. That is 0.19° at the ~400 ft the deck camera stands off a fly,
 * i.e. 9 px of a 1600 px frame — invisible, bounded, and asserted in
 * `camera.test.ts` rather than assumed away. It cannot reach the visual gate at
 * all, because a frozen ball is the stationary case.
 */
export const FOLLOW_TAU_S = 0.2;

/** Largest `dt` a single frame may claim, s. A tab-switch must not teleport. */
const MAX_DT_S = 0.1;

/** `6u⁵ − 15u⁴ + 10u³` — C² at both ends. See `CAMERA_EASE_S`. */
export function smootherstep(u: number): number {
  const t = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export interface CameraRig {
  /** Ease to `mode`. Re-selecting the mode already targeted is a no-op. */
  setMode(mode: CameraMode): void;
  /** Jump to `mode` with no ease — mount, and only mount. */
  snap(camera: PerspectiveCamera, mode: CameraMode, follow: Ball): void;
  /**
   * Advance one frame and write the camera. `dtS` comes from the scene clock,
   * and `0` (frozen) must leave every value untouched.
   */
  update(camera: PerspectiveCamera, dtS: number, follow: Ball): void;
  mode(): CameraMode;
  /** 0 → just switched, 1 → settled. The gate reads it to know a shot is stable. */
  progress(): number;
  /** Where the camera is aimed right now, scene ft. */
  target(): [number, number, number];
}

/** The ball to follow, scene ft, or `null` when there is nothing to follow. */
export type Ball = readonly [number, number, number] | null;

export function buildCameraRig(): CameraRig {
  let mode: CameraMode = 'wide';
  /** Blend parameter 0…1 from `from*` to `CAMERAS[mode]`. */
  let u = 1;
  const fromPos = new Vector3();
  const fromLook = new Vector3();
  let fromFov = CAMERAS.wide.fov;
  let fromNear = CAMERAS.wide.near;

  /** The damped aim point. Meaningful only while `followSeen`. */
  const followPoint = new Vector3();
  let followSeen = false;

  /** Scratch, reused every frame — a HUD/GL rule: no per-frame allocation. */
  const specPos = new Vector3();
  const aim = new Vector3();
  const look = new Vector3();

  // The live pose, kept here rather than read back off the camera so that the
  // rig is the single source of truth (reading `camera.position` back would work
  // for position and not for the look point, which three does not store).
  let fovNow = CAMERAS.wide.fov;
  let nearNow = CAMERAS.wide.near;

  const specOf = (m: CameraMode) => CAMERAS[m];

  const setMode = (next: CameraMode) => {
    if (next === mode) return;
    // Capture where the camera IS, not where the previous mode's anchor was —
    // interrupting a transition halfway must not snap back to its origin first.
    fromPos.copy(specPos);
    fromLook.copy(look);
    fromFov = fovNow;
    fromNear = nearNow;
    mode = next;
    u = 0;
    // A new mode re-acquires its own follow point from scratch; carrying the old
    // one over would aim the batter camera at wherever the deck camera left off.
    followSeen = false;
  };

  const aimFor = (dtS: number, follow: Ball): Vector3 => {
    const spec = specOf(mode);
    if (!spec.follow) {
      followSeen = false;
      return aim.set(spec.look[0], spec.look[1], spec.look[2]);
    }
    if (follow) {
      if (!followSeen) {
        // ⚠ FIRST SIGHT IS A COPY, NOT A DAMP, AND THAT IS A DETERMINISM
        // REQUIREMENT. Damping from the mode's static anchor would make the
        // captured pose a function of HOW MANY FRAMES had been rendered before
        // the harness froze the clock; copying makes it a function of the ball
        // alone. It is also right for gameplay: the follow begins at the ball.
        followPoint.set(follow[0], follow[1], follow[2]);
        followSeen = true;
      } else {
        const a = 1 - Math.exp(-dtS / FOLLOW_TAU_S);
        followPoint.x += (follow[0] - followPoint.x) * a;
        followPoint.y += (follow[1] - followPoint.y) * a;
        followPoint.z += (follow[2] - followPoint.z) * a;
      }
    }
    // No ball yet (a pitch is in the air, or the play is over): hold the last
    // followed point if there was one, else the mode's own anchor.
    return followSeen
      ? aim.copy(followPoint)
      : aim.set(spec.look[0], spec.look[1], spec.look[2]);
  };

  const write = (camera: PerspectiveCamera, dtS: number, follow: Ball) => {
    const spec = specOf(mode);
    const target = aimFor(dtS, follow);
    const s = smootherstep(u);
    specPos.set(
      fromPos.x + (spec.pos[0] - fromPos.x) * s,
      fromPos.y + (spec.pos[1] - fromPos.y) * s,
      fromPos.z + (spec.pos[2] - fromPos.z) * s,
    );
    look.set(
      fromLook.x + (target.x - fromLook.x) * s,
      fromLook.y + (target.y - fromLook.y) * s,
      fromLook.z + (target.z - fromLook.z) * s,
    );
    fovNow = fromFov + (spec.fov - fromFov) * s;
    nearNow = fromNear + (spec.near - fromNear) * s;
    camera.position.copy(specPos);
    camera.fov = fovNow;
    camera.near = nearNow;
    camera.lookAt(look);
    camera.updateProjectionMatrix();
  };

  return {
    setMode,
    mode: () => mode,
    progress: () => u,
    target: () => [look.x, look.y, look.z],
    snap(camera, next, follow) {
      mode = next;
      u = 1;
      followSeen = false;
      const spec = specOf(next);
      fromPos.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      fromFov = spec.fov;
      fromNear = spec.near;
      // `fromLook` has to be the target too, or `s = 1` would still read a stale
      // origin on the first frame after a snap into a following mode.
      const target = aimFor(0, follow);
      fromLook.copy(target);
      write(camera, 0, follow);
    },
    update(camera, dtS, follow) {
      const dt = Number.isFinite(dtS) ? Math.min(MAX_DT_S, Math.max(0, dtS)) : 0;
      if (dt > 0 && u < 1) u = Math.min(1, u + dt / CAMERA_EASE_S);
      write(camera, dt, follow);
    },
  };
}
