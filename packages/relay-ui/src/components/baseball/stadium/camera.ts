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
// TRANSLATES the camera 136.3 ft — [0, 4, 19.5] to [−12, 120, 90] — while the fov
// goes 20° → 55° and the near plane 1 → 4 ft, all inside `CAMERA_EASE_S` = 0.8 s;
// see that constant for what that is in ft/s. And the FOLLOW alone is not a yaw
// either: aiming at the −40° ball swings the axis ~29° in BEARING and 2.4° in
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
  // ⚠ RE-FRAMED IN M2c, AND THE OLD ONE WAS MEASURABLY UNPLAYABLE. The M2c
  // placement — [0, 8.5, 20] looking at [0, 4, −55] — put the strike zone 13.3°
  // below the look axis against a 20° half-FOV, i.e. 78 % of the way DOWN a
  // portrait screen, under the HUD's own bottom chrome. The zone is this mode's
  // SUBJECT, so the framing is derived from the things the shot has to contain:
  // the release point (0, 5.8, −54), the zone (0, 1.6…3.4, 0), and — added in
  // M3b — the near GROUND, which nothing had ever been derived against.
  //
  // ⚠ M3b: THE NEAR DIRT WEDGE, AND THE FIX IS NOT THE ONE IT LOOKED LIKE. The
  // shipped frame put a flat brown band across its bottom 524 px — 32.7 % of the
  // picture, and 30.5 % of it classified as dirt. That band is the 13 ft SKINNED
  // CIRCLE at the plate (`field.ts`'s `HOME_CIRCLE_FT`), whose far rim at
  // (0, 0.18, −13) projected to y = 1076 px. The obvious diagnosis was the eye
  // height: 3.2 ft is a crouching catcher's, 2.3 ft under a standing batter's,
  // and raising it to 5.5 ft moves that rim to y ≈ 1315 — the band HALVES.
  //
  // ⚠ THAT MEASUREMENT IS REAL AND THE CONCLUSION FROM IT IS WRONG, which is
  // why the whole ladder is written out here. Raising the eye with the look
  // DIRECTION held also drags the zone down by the same 2.3 ft of parallax at
  // 8 ft of standoff: the zone bottom lands at v = 1.140, i.e. **224 px below
  // the bottom of the picture**. That is the M2c defect restored and then some.
  // Re-aiming to put the zone back costs the whole gain, because the near ground
  // and the zone are at the SAME PLACE — the circle is centred on the plate — so
  // nothing that moves one leaves the other. Measured, holding the zone framed
  // exactly as it is framed today (26–34 % of frame height, centre in 45–65 %,
  // bottom ≤ 75.5 %, release inside the middle 60 %), the best reachable dirt
  // band per eye height is:
  //
  //     eye ft   best z   fov   aim      dirt band     ← lower is better
  //       3.2      19.5    20   +0.40°   346 px (21.7 %)
  //       3.6      19.5    20   −0.75°   383 px (23.9 %)
  //       4.0      19.5    20   −1.90°   419 px (26.2 %)   ← SHIPPED
  //       4.4      19.0    20   −3.25°   462 px (28.9 %)
  //       4.8      19.0    20   −4.45°   501 px (31.3 %)
  //       5.2      14.5    26   −7.25°   613 px (38.3 %)
  //       5.5+     — no placement satisfies the zone framing at all —
  //
  // i.e. the relationship runs the OTHER WAY: once the zone is held, every inch
  // of eye height COSTS dirt, because a higher eye must aim further down to keep
  // a zone 8–20 ft away in frame, and aiming down is what puts the ground back
  // in the bottom of the picture. Above ~5.3 ft there is no placement at any
  // standoff or focal length that frames the zone at all.
  //
  // ⚠ SO THE LEVER IS STANDOFF AND FOCAL LENGTH, NOT HEIGHT. The zone's angular
  // size and the release-to-zone angular separation both fall as 1/z, so their
  // RATIO — which is what fixes where the zone sits in frame — is invariant to
  // backing away; the ground's depression angle is not. Pulling back from 8 ft
  // to 19.5 ft and halving the FOV therefore leaves the zone framed as it was
  // while the near ground falls out of the bottom crop. The frozen 4.0 ft /
  // 19.5 ft / 20° row above is what ships:
  //
  //     release (0, 5.8, −54)  → 33.6 % of frame height
  //     zone     1.6 … 3.4 ft  → 49.3 % … 75.4 %  (26.1 % tall, centre 62.4 %)
  //     plate-circle far rim   → y = 1181 px, a 419 px band  (was y = 1076 / 524)
  //
  // against the shipped 41.8 % / 44.1–74.9 % (30.8 % tall, centre 59.5 %). The
  // zone slides 2.9 % down the frame and loses 4.7 % of its height; the dirt
  // band loses a fifth of itself. THAT IS THE TRADE, and it is stated rather
  // than hidden because the whole ladder above is a knob the next reader will
  // want to turn.
  //
  // ⚠ AND HEIGHT STILL MOVED, TO 4.0 ft, WHICH IS NOT A BATTER'S EYE AND IS NOT
  // CLAIMED TO BE. 5.5 ft is unreachable (see the ladder); 4.0 ft is what the
  // dirt objective could pay for. This camera is not standing in the box in any
  // case — it is 19.5 ft BEHIND the plate on the centre line, which is a slot
  // camera, and a slot camera at 4 ft is an ordinary broadcast placement. The
  // rest of "the plate area reads as a flat brown lot" is answered where it
  // actually lives: `field.ts` now draws batter's boxes, a catcher's box and
  // seeded clay grain into what used to be one flat colour.
  //
  // ⚠ THE 20° LENS IS A GAMEPLAY GAIN, NOT JUST A FRAMING ONE. Everything past
  // the plate is magnified ~2× against the old 40°: the ball at release is
  // 7.5 px of radius instead of 4.3, and the mound, the wall and the bowl come
  // up with it. Reading break is the one skill this game has.
  //
  // ⚠ IT DOES NOT FOLLOW, AND THAT IS NON-NEGOTIABLE. This is the frame the
  // player times the swing against. A camera that drifts before the tap would
  // break the one skill the game has, so `follow: false` here is a gameplay
  // constraint, not a framing preference — and `camera.test.ts` asserts that a
  // ball in the scene moves this pose by exactly zero.
  batter: { pos: [0, 4, 19.5], look: [0, 2.36, -30], fov: 20, near: 1, follow: false },
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
  // spray) left the frame and was never seen again. Measured on the SHIPPED
  // placement, at 105 mph / 26.5° / 2.6 s: at −40° of spray the ball projects to
  // u = −0.632 and at +40° to u = +1.334, i.e. 569 px off the left edge and
  // 300 px past the right one. Widening the FOV cannot fix that — it needs 90°+,
  // which throws the ball away to a handful of pixels — whereas aiming at the
  // ball can, at no cost in angular resolution. It is NOT free in motion,
  // though: see `CAMERA_EASE_S` for the size of the move this mode is the
  // destination of.
  //
  // ⚠⚠ **THE STAND MOVED, x = −40 → −12, AND THE AIM WAS DECOUPLED FROM IT.**
  // −40 was chosen to favour the PULL corner back when the landmark stood on the
  // left; the landmark is now on the right (`tower.ts`, an owner correction) and
  // −40 was costing twice over. Both halves are measured:
  //
  //   (1) THE CORNERS. `follow-pull` and `follow-oppo` take their asymmetry from
  //       this `x` alone. Standoff to the ±40° ball at bt = 2.6 s:
  //
  //           x = −40   pull 313.3 ft   oppo 352.9 ft   asymmetry 11.9 %
  //           x = −12   pull 325.5 ft   oppo 337.4 ft   asymmetry  3.6 %
  //           x =   0   pull 331.3 ft   oppo 331.3 ft   asymmetry  0.0 %
  //
  //       The oppo corner was the far one and is now nearly the near one; the
  //       pull corner pays 12 ft of standoff (3.9 %) for it.
  //   (2) THE LANDMARK. `x` is a WEAK lever on a 1,900 ft tower (it moves its
  //       bearing by 1.1° over the whole 40 ft) and a STRONG one on the 530 ft
  //       centre-field structure (4.2°). What re-centring actually buys is
  //       therefore not the tower's angle but the WINDOW it has to live in: the
  //       structure's own right edge falls from 12.6° to 9.5° off the centre
  //       line, so the usable band between "behind the building" and "off the
  //       frame" widens from 3.7° to 6.8°.
  //
  // ⚠ AND `look.x` IS NO LONGER `pos.x`. It is +34, a **5.55° yaw** toward the
  // landmark side, and it is the thing that actually composes the shot. This is
  // free to do because for a FOLLOWING mode `look` is only ever used when there
  // is no batted ball — it cannot move `follow-pull`, `follow-oppo`,
  // `follow-ease`, `homerun` or `night-homerun` by a pixel. Measured, static
  // frame, before → after:
  //
  //       tower axis            u 0.953 → 0.750   (90.6 % → 50.0 % of half-width)
  //       tower pod, both edges u 0.917…1.004 → 0.712…0.795   (was CROPPED)
  //       mast tip              v 0.023 → 0.031   (still inside the top)
  //       board array           u 0.523…0.737 → 0.266…0.481   (same width)
  //       structure right edge  u 0.881 → 0.622
  //
  //   i.e. the board sits left of centre, the tower stands to its right in open
  //   sky with 0.09 frame widths of gap, and the frame finally is the owner's
  //   photograph rather than a picture with a sliver of concrete in the corner.
  //
  // ⚠⚠ **WHAT THIS DOES NOT FIX, STATED RATHER THAN LEFT TO BE DISCOVERED.** In
  // the four scenes where the camera FOLLOWS, the landmark's position in frame
  // is set by the BALL, not by this row, and moving `x` toward 0 moves it the
  // WRONG way there — because the celebration ball is pulled (−12° of spray) and
  // a camera further to the right yaws the axis further left. `homerun` /
  // `night-homerun` measured: the tower's pod ran u 0.977…1.063 at x = −40, i.e.
  // a 15 px sliver of its left flank at the frame edge; at x = −12 it is
  // 1.16…1.21, gone. That sliver is the whole cost and it is paid knowingly: 15
  // px of flank is not a landmark being visible, and nothing recovers it —
  //
  //     • a smaller tower bearing is gated by the structure's edge, and the
  //       feasible set of (x, bearing) with the tower BOTH fully inside the
  //       homerun frame AND clear of the building is measurably EMPTY over
  //       x ∈ [−60, +8], bearing ∈ [7°, 15°];
  //     • a PARTIAL follow (aim = anchor + k·(ball − anchor)) was measured too:
  //       at k = 0.7 the tower is still at u = 1.00 in `homerun` while the pull
  //       corner's ball has already fallen to u = 0.11, and at k = 0.6 the ball
  //       is off frame at u = −0.01. There is no k that holds both.
  //
  //   The ball is the subject of those four frames. It keeps the frame.
  flight: { pos: [-12, 120, 90], look: [34, 60, -380], fov: 55, near: 4, follow: true },
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
 * 136.3 ft (|[−12, 120, 90] − [0, 4, 19.5]|), plus fov 20° → 55°, near 1 → 4 ft,
 * and a look point slewing onto a moving ball. Over 0.8 s that averages
 * 170 ft/s, and a quintic's peak rate is 30u²(1−u)² at u = ½ = **1.875×** its
 * mean — so mid-move the camera is travelling ~319 ft/s. (It was 141.5 ft /
 * 177 / 332 from x = −40; re-centring the stand took 5.2 ft off the move.) That is the honest size
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
