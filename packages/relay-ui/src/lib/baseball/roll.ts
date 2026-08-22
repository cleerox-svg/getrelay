// THE ROLL — the ball on the ground, and nothing about the defence.
//
// ⚠ EXTRACTED FROM `groundBall.ts` AT THE 500-LINE CAP, along the seam this
// codebase already uses one layer down: `airPhysics.ts` is the ball in the air
// and `pitchSim.ts` is what the game does with it. Same split here. This file
// knows the two surfaces, the deceleration on each and where the ball is at
// every instant; it does not know that fielders exist, that there is a base to
// throw to, or that anybody is running. `groundBall.ts` is the play.
//
// The seam is worth having beyond the line count: the two heavily-argued surface
// constants and the race that consumes them are re-read for different reasons —
// one is a physics question, the other a gameplay one — and separating them is
// what keeps "which of these numbers is calibrated against what" answerable on
// one screen.
//
// No three, no Math.random, no wall clock, no state.

import { infieldDepthFt } from './fielders';

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

/**
 * Deceleration of a batted ball rolling on the SKINNED INFIELD, ft/s².
 *
 * ⚠ CALIBRATED, AND THE HONEST VERSION OF THAT LABEL. It is solved against a
 * target OUTSIDE ITSELF — MLB's ~72 % ground-ball out rate — over 144 seeded
 * duel-bench games (48 at each of the three difficulties), with every other
 * number in the model held fixed while it was swept. Measured pooled
 * ground-ball out rate at the shipped value: 71.7 % on that fit sample and
 * 72.5 % on the 48-game bench `duelSim.test.ts` prints every run, against
 * 63.6 % at 58 ft/s² and 73.5 % at 72.
 *
 * ⚠ IT IS "THE ONE NUMBER WITHOUT A PUBLISHED ANCHOR", NOT "THE ONE FREE
 * PARAMETER", and an earlier draft of this comment said the latter, which
 * oversold it. Four of the five numbers held fixed while it was swept carry
 * `reference unverified` on their own lines — the 80 mph arm, the 0.7 s
 * exchange, the 0.2 s ground reaction and the 27 ft/s sprint — so the honest
 * statement is that this is the only one with NOTHING to point at, and each of
 * the others is pinned by a citation that is weak but real and by a stated
 * mechanism. The strong claim (one degree of freedom against one target) is
 * still what makes the fit mean something rather than nothing; it is just not
 * the same claim as "everything else is published fact".
 * `fielders.FIELDER_GROUND_REACTION_S` carries the sensitivity of the largest
 * of the four, because it is the one that moves this constant most.
 *
 * ⚠ AND WHY IT IS NOT PUBLISHED, STATED RATHER THAN GLOSSED. There is no single
 * published "batted-ball roll friction", because a ground ball is not doing one
 * thing: it lands, skids while sliding friction (μ ≈ 0.4–0.6, the same published
 * range this game argues `e_T` from) converts translation into spin, bounces
 * several times losing μ(1+e)·v_normal of ground speed at each one, and only
 * then rolls with a rolling resistance an order of magnitude smaller. A constant
 * deceleration is the COLLAPSE of that sequence into one number, and the
 * collapse — not the value — is the approximation.
 *
 * ⚠ SO 70 ft/s² IS 2.2 g AND THAT IS NOT A ROLLING RESISTANCE, WHICH IS THE
 * THING A READER SHOULD BE TOLD RATHER THAN LEFT TO NOTICE. It is a
 * BOUNCE-DOMINATED effective deceleration over the FIRST HUNDRED FEET, which is
 * the only stretch this model ever makes a decision on, and it is consistent
 * with the mechanism above: a typical bench grounder lands with ~40 ft/s of
 * downward velocity, so μ(1+e)v_n takes ~28 ft/s out of it inside the first
 * bounce alone.
 *
 * ⚠ AND IT ABSORBS THE MODEL'S OTHER SIMPLIFICATIONS, WHICH IS WHAT A FITTED
 * CONSTANT DOES AND WHY THE LABEL MATTERS. The largest is that `fielders.ts`
 * gives an infielder a STANDING SPRINTER'S ramp (0 → 27 ft/s in 1.8 s), which
 * under-states how much ground a set infielder covers over the 10–40 ft a
 * grounder actually asks for; the roll constant is doing some of that range's
 * work. TWO CONSEQUENCES FOLLOW AND BOTH ARE REAL:
 *   • the long tail is over-decelerated — a 91 mph ground ball comes to rest
 *     ~150 ft from the plate, where a real one is still moving when an
 *     outfielder picks it up. Not observable in this milestone's outcome set
 *     (every ball that gets through the infield is a single either way), but it
 *     will be the moment a renderer draws the roll;
 *   • medium-speed grounders (70–90 mph) die in front of the infield and are
 *     retired more often than they should be, while the hit band is pushed up
 *     towards 100 mph. The `[GROUND BALL LADDER]` prints that band.
 * The fix for both is a fielding-radius term applied CONSISTENTLY to the air
 * lookup and the ground race, with `fielding.XB_*` re-fitted underneath it. That
 * is a slice of its own and it is not this one.
 *
 * ⚠ WHAT IT IS *NOT* ALLOWED TO BE IS THE WHOLE MODEL. The aggregate out rate is
 * one scalar and a model can hit it by making every grounder a coin flip. So the
 * calibration is checked against SHAPE as well: a sharp two-hopper at the
 * shortstop is an out, the same slow roller is a hit down the third-base line
 * and an out down the first-base line, a ball through the 5-6 hole is a hit.
 * `groundBall.test.ts` asserts that ladder row by row and asserts the bearing
 * structure as a property, and those are what fail first if this number is doing
 * more work than it should.
 */
export const ROLL_DECEL_DIRT_FPS2 = 70;

/**
 * How much slower outfield GRASS is than the skinned infield, as a multiple.
 *
 * ⚠ FEEL KNOB, EXPLICITLY, AND AN EARLIER DRAFT OF THIS COMMENT CALLED IT
 * "DERIVED AND UNOBSERVABLE" — WHICH WAS FALSE, AND MEASURING IT IS WHAT CAUGHT
 * THAT. The ordering is real (a mown grass surface takes more energy out of a
 * rolling ball than hard-packed clay does); the MAGNITUDE could not be sourced.
 * Baseball publishes no ball-roll figure for either surface, and the nearest
 * analogues — a Stimpmeter reading, a sports-turf ball-roll test — are other
 * balls on other surfaces. So it is a knob and it says so.
 *
 * ⚠ IT IS NOT DECORATIVE, AND THE BOUND ON ITS REACH IS COMPUTED RATHER THAN
 * DESCRIBED. This constant can only touch a play whose PICKUP happens beyond the
 * grass line, and `groundBall.test.ts` sweeps for exactly that: over a uniform
 * grid of (landing distance × bearing × hang × ground speed × rating), **36.8 %
 * of balls are fielded beyond the arc and 12.7 % of the OUTS are decided there**.
 * A first draft of this comment claimed the opposite — "not one call moves" —
 * and quoted a re-call percentage that lived only in the comment. Both were
 * wrong in the same way: an unreproduced number is not a measurement, and this
 * file spends a paragraph refusing that standard from everyone else.
 *
 * ⚠ BUT A UNIFORM GRID IS NOT THE GAME, AND THAT IS THE ARGUMENT THAT MATTERS —
 * because the question this constant has to answer is not "can it change a call"
 * but "does it co-vary with the constant fitted underneath it". It does not, and
 * the reason is the POPULATION: **every putout the duel bench records is an
 * INFIELDER's** — P 48, SS 47, 2B 46, 1B 29, 3B 15, zero outfielders — because a
 * fielder who has chased a ball onto the grass has a throw too long to beat a
 * 4.3 s runner. So the grid over-states this knob's relevance to the ~72 % that
 * `ROLL_DECEL_DIRT_FPS2` is solved against. Both halves are asserted rather than
 * asserted-about: the grid bound in `groundBall.test.ts`, the population one in
 * `duelSim.test.ts`, which reads `GroundPlay.infield` to do it.
 *
 * ⚠ SO IT IS PINNED FIRST AND HELD, AND PINNED LOW ON PURPOSE. 1.25 is the
 * smallest statement of the ordering that is still a statement, and pinning it
 * near the single-surface case keeps the fitted `ROLL_DECEL_DIRT_FPS2` doing the
 * explaining. Setting it to 1.0 — one deceleration everywhere — is a defensible
 * ship; it was rejected because the ball demonstrably does slow more on grass
 * and because the renderer will one day draw the roll crossing that line.
 */
export const ROLL_GRASS_RATIO = 1.25;

/** …on the grass, ft/s². DERIVED from the two above. Never hand-set. */
export const ROLL_DECEL_TURF_FPS2 = ROLL_GRASS_RATIO * ROLL_DECEL_DIRT_FPS2;

/**
 * Longest roll the model will follow, ft. ⚠ A BOUND, NOT A RULE, exactly as
 * `battedBallSim.MAX_FLIGHT_S` is: it only ever bites on a ball nobody could
 * field anyway, and then it bites instead of scanning forever.
 */
export const MAX_ROLL_FT = 450;

/**
 * Sample spacing for the interception search, **s**. ⚠ A RESOLUTION DERIVED FROM
 * THE DECISION IT FEEDS, not a knob: the verdict is one time comparison against a
 * 4.30 s runner and the closest rows of the ladder sit ~0.10 s from it, so
 * 0.005 s is 20× finer than the margin it has to resolve.
 *
 * ⚠ IT IS SAMPLED IN TIME, AND IT USED TO BE SAMPLED IN DISTANCE — 1 ft of roll,
 * which was wrong in exactly the place it mattered. A foot of roll is `1/v_ball`
 * seconds, and `v_ball` is not bounded below: one foot before the ball comes to
 * rest it is doing 11.8 ft/s at this deceleration, so a foot of sampling was
 * **0.17 s** there, LARGER than the margins the ladder decides on. The bound
 * that was asserted for it used the FASTEST ball, where it needed the slowest.
 * Sampling the ball's own clock makes the worst-case timing error exactly this
 * constant at every speed, which is the bound the search actually needs and the
 * one `groundBall.test.ts` now asserts.
 */
export const ROLL_SAMPLE_S = 0.005;

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

/** The ball on the ground: where it goes, and when. */
export interface RollPath {
  /** Ground speed at the first bounce, ft/s. */
  v0Fps: number;
  /** How far it rolls before stopping, ft (bounded by `MAX_ROLL_FT`). */
  rollFt: number;
  /** Plate-centred distance where it comes to rest, ft. */
  stopDistFt: number;
  /**
   * Time from the bounce to the END OF `rollFt`, s.
   *
   * ⚠ NOT "to a standstill" WHEN `MAX_ROLL_FT` TRUNCATES, and the distinction is
   * the reason this reads the way it does. The bound is unreachable in the game
   * — no batted ball rolls 450 ft — but a renderer playing the roll back would
   * read this against `rollFt` and, if the two disagreed, draw a ball that
   * arrives somewhere it never reached. The two always describe the same event.
   */
  stopS: number;
  /** Length of the roll spent on the skinned infield, ft, and the time it took. */
  dirtFt: number;
  dirtS: number;
  /** Ground speed as it crosses the grass line, ft/s. 0 if it never gets there. */
  vEdgeFps: number;
}

/** Time to cover `sFt` from `v` under constant deceleration `a`, s. */
const decelTimeS = (v: number, a: number, sFt: number): number =>
  (v - Math.sqrt(Math.max(0, v * v - 2 * a * sFt))) / a;

/** Distance covered in `tS` from `v` under constant deceleration `a`, ft. */
const decelDistFt = (v: number, a: number, tS: number): number => {
  const t = Math.min(Math.max(0, tS), v / a);
  return v * t - 0.5 * a * t * t;
};

/**
 * Roll a ball out along its bearing from where it landed.
 *
 * ⚠ THE PATH IS THE BEARING RAY, AND THAT IS A MODELLING DECISION WITH A REASON.
 * A ball on the ground carries on the way it was going; its ground velocity at
 * the bounce points along the ray from the plate through the landing point to
 * within the sidespin curvature the flight already spent, so the ray is the
 * ball's own direction and not a convenience. It also means the bearing — hence
 * the SURFACE, hence fair or foul — is constant for the whole roll, which is why
 * a ball that lands fair cannot roll foul in this model and why no foul-line
 * test appears below.
 *
 * ⚠ AND THERE IS NO BOUNCE-RETENTION FACTOR: the roll starts at the ball's OWN
 * horizontal landing speed, which the integrator already produces
 * (`BattedFlight.landingGroundFps`) and which already carries the whole
 * angle dependence that matters — the bench's grazing screamers land at
 * 126–144 ft/s of ground speed and its topped choppers at 72–104, off the same
 * exit velocities. Multiplying that by a retention constant would be a second
 * free number with no target to fit it to, and the deceleration it would trade
 * against is the one that IS fitted.
 *
 * The integration is piecewise-analytic, not stepped: constant deceleration on
 * each surface, `v² = v₀² − 2as`, so the grass-line crossing is exact for the
 * same reason every other event in this game is (`crossingFraction`'s argument,
 * one layer down).
 */
export function rollPath(landDistFt: number, bearingDeg: number, v0Fps: number): RollPath {
  const v0 = Math.max(0, v0Fps);
  const dirtLeft = Math.max(0, infieldDepthFt(bearingDeg) - landDistFt);
  // On the dirt first (possibly none of it, if the ball landed past the arc).
  const dirtStop = (v0 * v0) / (2 * ROLL_DECEL_DIRT_FPS2);
  if (dirtStop <= dirtLeft) {
    const rollFt = Math.min(dirtStop, MAX_ROLL_FT);
    const stopS = decelTimeS(v0, ROLL_DECEL_DIRT_FPS2, rollFt);
    return { v0Fps: v0, rollFt, stopDistFt: landDistFt + rollFt, stopS, dirtFt: rollFt, dirtS: stopS, vEdgeFps: 0 };
  }
  // …then across the grass line, carrying the speed it still has.
  const vEdgeFps = Math.sqrt(Math.max(0, v0 * v0 - 2 * ROLL_DECEL_DIRT_FPS2 * dirtLeft));
  const dirtS = decelTimeS(v0, ROLL_DECEL_DIRT_FPS2, dirtLeft);
  const grassStop = (vEdgeFps * vEdgeFps) / (2 * ROLL_DECEL_TURF_FPS2);
  const rollFt = Math.min(dirtLeft + grassStop, MAX_ROLL_FT);
  return {
    v0Fps: v0,
    rollFt,
    stopDistFt: landDistFt + rollFt,
    // ⚠ MEASURED TO `rollFt`, so the bound truncating the roll truncates the
    // clock with it. See `RollPath.stopS`.
    stopS: dirtS + decelTimeS(vEdgeFps, ROLL_DECEL_TURF_FPS2, rollFt - dirtLeft),
    dirtFt: dirtLeft,
    dirtS,
    vEdgeFps,
  };
}

/** Time from the bounce for the ball to have rolled `sFt`, s. */
export function rollTimeS(path: RollPath, sFt: number): number {
  const s = Math.min(Math.max(0, sFt), path.rollFt);
  if (s <= path.dirtFt) return decelTimeS(path.v0Fps, ROLL_DECEL_DIRT_FPS2, s);
  return path.dirtS + decelTimeS(path.vEdgeFps, ROLL_DECEL_TURF_FPS2, s - path.dirtFt);
}

/**
 * How far the ball has rolled `tS` after the bounce, ft — the EXACT INVERSE of
 * `rollTimeS`, and the one the interception search iterates on.
 *
 * ⚠ THE SEARCH SAMPLES THE BALL'S CLOCK, NOT ITS PATH, and that is why this
 * function exists. `ROLL_SAMPLE_S` carries the argument: the verdict is a time
 * comparison, so a uniform sample in TIME has a uniform error in the quantity
 * being decided, where a uniform sample in DISTANCE has an error of `1/v` that
 * blows up exactly where the ball is slowest and the plays are closest.
 */
export function rollDistFt(path: RollPath, tS: number): number {
  if (tS <= 0) return 0;
  if (tS >= path.stopS) return path.rollFt;
  if (tS <= path.dirtS) return decelDistFt(path.v0Fps, ROLL_DECEL_DIRT_FPS2, tS);
  return Math.min(
    path.rollFt,
    path.dirtFt + decelDistFt(path.vEdgeFps, ROLL_DECEL_TURF_FPS2, tS - path.dirtS),
  );
}
