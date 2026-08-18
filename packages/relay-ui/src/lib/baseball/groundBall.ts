// THE ROLLING PHASE — the ball on the ground, from the bounce to the bag.
//
// ⚠ THIS IS THE FIX `fielding.ts` PREDICTED FOR ITSELF. Its header said, and
// BASEBALL.md repeated: "a ground ball does not stop where it lands — it rolls
// to the fielder, who throws — so a pure landing-point model scores routine
// infield grounders as base hits… when the duel wants real infield play the fix
// is a rolling phase, and `GROUND_INTERCEPT_FT` is deleted rather than tuned."
// The derby never exercised it (a derby has no defence); the duel did, and the
// artifact dominated the game — 274 balls in play at difficulty 0.50, 87 ground
// balls, 84 singles and 3 outs, a 3.4 % ground-ball out rate against MLB's ~72 %.
// This file is that rolling phase and `GROUND_INTERCEPT_FT` is gone.
//
// The whole model is four steps and there is no fifth:
//
//   1. the ball lands and ROLLS outward along its bearing, decelerating;
//   2. every fielder RACES it — he may field it at any point on the path he can
//      reach no later than the ball does, or walk to it once it has stopped;
//   3. he THROWS to first: a release time plus a flight at a published velocity;
//   4. the RUNNER is a published home-to-first time. Sooner is an out.
//
// ⚠ THE SCOPE CAP IS THE DESIGN, and this file is precisely the shape the
// charter allows and no larger. NO double plays, NO fielder's choice, NO tagging
// runners, NO cutoffs, NO relays, NO outfield assists, NO diving, NO error
// model, NO shifts, and NOTHING that reads a baserunner. There is ONE throw and
// it goes to ONE base, always first, because the batter is the only runner this
// milestone knows about. A BRANCH PER DEFENSIVE SITUATION APPEARING HERE IS THE
// SIGNAL TO DESIGN THE NEXT MILESTONE, not to add the branch — and note that
// every one of those omissions helps the OFFENCE, so the model is conservative
// in the direction it is missing.
//
// ⚠ AND NOTE WHAT IS *NOT* A BRANCH. "The first baseman fields it himself and
// steps on the bag" is not a special case here — it is the same throw, 21.6 ft
// long, taking 0.18 s. "The pitcher fields a comebacker" is not a special case
// either; he is a row in `fielders.ALIGNMENT`. One race, one throw, one
// comparison, and the geometry does the rest.
//
// No three, no Math.random, no wall clock, no state.

import {
  ALIGNMENT,
  FIELDER_GROUND_REACTION_S,
  infieldDepthFt,
  polarGapFt,
  reachMultiplier,
  timeToCoverS,
} from './fielders';
import { FOUL_LINE_DEG } from './parks';
import { MPH_TO_FPS } from './units';

// ---------------------------------------------------------------------------
// The surfaces
// ---------------------------------------------------------------------------

/**
 * Deceleration of a batted ball rolling on the SKINNED INFIELD, ft/s².
 *
 * ⚠ CALIBRATED, AND THE HONEST VERSION OF THAT LABEL. It is solved against a
 * target OUTSIDE ITSELF — MLB's ~72 % ground-ball out rate — over 144 seeded
 * duel-bench games (48 at each of the three difficulties), with every other
 * number in the model published or pinned and held fixed while it was swept. It
 * is the ONE free parameter, which is what makes the fit mean anything: a model
 * with three free numbers and one target is a knob wearing a badge. Measured
 * pooled ground-ball out rate at the shipped value: 71.7 %, against 63.6 % at
 * 58 ft/s² and 73.5 % at 72. `duelSim.test.ts` prints the table every run.
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
 * ⚠ AND IT IS NOT A DECORATIVE ONE: swept over a 1,215,504-case grid of
 * (landing distance × bearing × hang × ground speed × rating), 1.0× against 3.0×
 * moves **137,594 calls — 11.3 %** — and the sweep's out rate with it. It has
 * to be, because **36.6 %** of those balls are fielded BEYOND the grass line, so
 * the constant sets both when the fielder gets there and how long the throw is.
 * That is exactly why it is a knob and not a second calibration: two free
 * numbers fitted to one target is not a fit.
 *
 * ⚠ SO IT IS PINNED FIRST AND HELD, AND PINNED LOW ON PURPOSE. 1.25 is close to
 * the single-surface alternative — against 1.0× it moves 21,940 of the same
 * 1,215,504 cases, **1.8 %** — which is the smallest statement of the ordering
 * that is still a statement, and it keeps the fitted `ROLL_DECEL_DIRT_FPS2`
 * doing the explaining. The single-surface alternative (this at 1.0, one
 * deceleration everywhere) is a defensible ship and its cost is that 1.8 %; it
 * was rejected because the ball demonstrably does slow more on grass and the
 * renderer will one day draw the roll crossing that line.
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

/** Path sample spacing for the interception search, ft. See `groundOut`. */
export const ROLL_SAMPLE_FT = 1;

// ---------------------------------------------------------------------------
// The throw and the runner
// ---------------------------------------------------------------------------

/** Distance between bases, ft. PUBLISHED DATA — the rule book's 90 ft. */
export const BASE_PATH_FT = 90;

/**
 * First base, polar from the plate. DERIVED: the bases sit ON the foul lines, so
 * the bearing is `parks.FOUL_LINE_DEG` read from the one place that owns it and
 * the range is one base path. Nothing is typed twice and a park that ever moved
 * its lines would move the bag with them.
 */
export const FIRST_BASE = { bearingDeg: FOUL_LINE_DEG, distFt: BASE_PATH_FT };

/**
 * Infield throw velocity, mph. PUBLISHED DATA in the weak sense — Statcast's arm
 * strength leaderboard puts the MLB infield average near 80 mph (shortstops a
 * little above, second basemen a little below); exact reference unverified,
 * flagged on the same standard the aero citations are held to.
 *
 * ⚠ ONE NUMBER, NOT A PER-POSITION TABLE, and that is the "no shifts, one
 * defender rating" rule again: a table indexed by position is the first step
 * towards a defensive model with a row per player, which is a later milestone.
 */
export const THROW_SPEED_MPH = 80;

/** …in ft/s. DERIVED. Never hand-set. */
export const THROW_SPEED_FPS = THROW_SPEED_MPH * MPH_TO_FPS;

/**
 * Glove-to-release time on a routine play, s. PUBLISHED DATA in the weak sense —
 * the nearest thing baseball publishes is Statcast's catcher EXCHANGE time,
 * ~0.7 s, and it is taken UNADJUSTED rather than nudged, because the two
 * corrections point opposite ways and neither could be sized: an infielder is
 * not being rushed by a runner already moving, but he also has to gather and
 * step where a catcher receives the ball upright and set. Exact reference
 * unverified and flagged on the same standard the aero citations are held to.
 *
 * ⚠ IT IS PINNED, NOT SWEPT, AND IT IS *NOT* DEGENERATE WITH THE ROLL CONSTANT —
 * an earlier draft of this comment said it was, which was wrong and worth
 * correcting rather than deleting. They push the out rate OPPOSITE ways: a
 * longer release costs every play the same tenth of a second, so the roll
 * constant has to RISE to hold the target. Measured, that trade is real and it
 * changes the SHAPE — at 0.8 s the fitted roll constant goes 70 → 76 ft/s², the
 * bang-bang throws (slow rollers, balls fielded on the run) tip towards the
 * runner and the reach-limited ones (balls in the gaps between fielders) tip
 * towards the defence. So the pair is a genuine two-parameter family and only
 * one of them may be free. This is the one with a published anchor, so this is
 * the one that is pinned.
 */
export const THROW_RELEASE_S = 0.7;

/**
 * The batter's time from contact to first base, s. PUBLISHED DATA — MLB average
 * home-to-first is ~4.3 s on a competitive run.
 *
 * ⚠ IT IS ONE NUMBER AND THE THINGS IT IS NOT ARE WORTH NAMING, because each is
 * published and each is deliberately not modelled here: a left-handed batter
 * starts ~6 ft closer and runs it ~0.1–0.2 s quicker, an elite runner does 4.0
 * and a slow one 4.6, and a runner who sees a ball squirt away runs harder. Each
 * would need a batter attribute threaded into the fielding lookup, which is a
 * CARD stat and belongs to a progression milestone, not to this one. One
 * published average, stated, and the same for both sides.
 */
export const RUNNER_HOME_TO_FIRST_S = 4.3;

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
  /** Time from the bounce to a standstill, s. */
  stopS: number;
  /** Length of the roll spent on the skinned infield, ft. */
  dirtFt: number;
}

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
  const edge = infieldDepthFt(bearingDeg);
  const dirtLeft = Math.max(0, edge - landDistFt);
  // On the dirt first (possibly none of it, if the ball landed past the arc).
  const dirtStop = (v0 * v0) / (2 * ROLL_DECEL_DIRT_FPS2);
  if (dirtStop <= dirtLeft) {
    const rollFt = Math.min(dirtStop, MAX_ROLL_FT);
    return {
      v0Fps: v0,
      rollFt,
      stopDistFt: landDistFt + rollFt,
      stopS: v0 / ROLL_DECEL_DIRT_FPS2,
      dirtFt: rollFt,
    };
  }
  // …then across the grass line, carrying the speed it still has.
  const vEdge = Math.sqrt(Math.max(0, v0 * v0 - 2 * ROLL_DECEL_DIRT_FPS2 * dirtLeft));
  const grassStop = (vEdge * vEdge) / (2 * ROLL_DECEL_TURF_FPS2);
  const rollFt = Math.min(dirtLeft + grassStop, MAX_ROLL_FT);
  return {
    v0Fps: v0,
    rollFt,
    stopDistFt: landDistFt + rollFt,
    stopS: (v0 - vEdge) / ROLL_DECEL_DIRT_FPS2 + vEdge / ROLL_DECEL_TURF_FPS2,
    dirtFt: dirtLeft,
  };
}

/** Time from the bounce for the ball to have rolled `sFt`, s. */
export function rollTimeS(path: RollPath, sFt: number): number {
  const s = Math.min(Math.max(0, sFt), path.rollFt);
  if (s <= path.dirtFt) {
    const v = Math.sqrt(Math.max(0, path.v0Fps ** 2 - 2 * ROLL_DECEL_DIRT_FPS2 * s));
    return (path.v0Fps - v) / ROLL_DECEL_DIRT_FPS2;
  }
  const vEdge = Math.sqrt(
    Math.max(0, path.v0Fps ** 2 - 2 * ROLL_DECEL_DIRT_FPS2 * path.dirtFt),
  );
  const v = Math.sqrt(Math.max(0, vEdge ** 2 - 2 * ROLL_DECEL_TURF_FPS2 * (s - path.dirtFt)));
  return (path.v0Fps - vEdge) / ROLL_DECEL_DIRT_FPS2 + (vEdge - v) / ROLL_DECEL_TURF_FPS2;
}

// ---------------------------------------------------------------------------
// The race, the throw and the verdict
// ---------------------------------------------------------------------------

export interface GroundPlay {
  /** Did the throw beat the runner? */
  out: boolean;
  /** Who fielded it, and is he an infielder. */
  fielder: string;
  infield: boolean;
  /** Where he gloved it, polar from the plate: ft along the ball's bearing. */
  fieldedAtFt: number;
  /** Time from CONTACT to the glove, s — the hang time is already in it. */
  fieldedS: number;
  /** Throw to first: distance ft, and the whole play's time to the bag, s. */
  throwFt: number;
  playS: number;
  /** The roll itself, for the printed tables and for a renderer to draw. */
  path: RollPath;
}

/**
 * The ball is on the ground. Who gets it, and does the throw beat the runner?
 *
 * ⚠ THE RACE IS A CONSTRAINT, NOT A DISTANCE COMPARISON, and getting that
 * backwards is the easy bug here. A fielder may field the ball at a point on its
 * path only if he can BE at that point NO LATER THAN THE BALL — the ball does
 * not wait at a spot he arrives at two seconds late, it has gone past. So the
 * feasible set is `{ s : t_cover(gap(s)) ≤ t_ball(s) }`, and the fielding time
 * at a feasible `s` is the BALL's arrival time, because he gets there first and
 * waits. The ONE exception is the stopping point: a ball at rest does wait, so
 * `s = rollFt` is feasible for everybody and its fielding time is
 * `max(t_ball, t_cover)`. That single `max` is the whole of "he ran it down".
 *
 * ⚠ AND THE DEFENCE OPTIMISES THE PLAY, NOT THE PICKUP. The minimisation is over
 * the whole play time to the bag — reach plus release plus throw — because a
 * fielder charging a slow roller is trading a later pickup for a shorter throw,
 * and that trade is the entire reason a charge exists. Minimising the pickup
 * time alone would make a model that never charges.
 *
 * `defense ∈ [0,1]` is the SAME one rating the air lookup takes and it reaches
 * the SAME one quantity: ground covered, through `fielders.reachMultiplier`. It
 * does not touch the release, the arm or the runner.
 */
export function groundOut(
  landDistFt: number,
  bearingDeg: number,
  hangS: number,
  landingGroundFps: number,
  defense = 0.5,
): GroundPlay {
  const path = rollPath(landDistFt, bearingDeg, landingGroundFps);
  const mul = reachMultiplier(defense);

  let best: GroundPlay | null = null;
  const steps = Math.max(1, Math.ceil(path.rollFt / ROLL_SAMPLE_FT));
  for (const f of ALIGNMENT) {
    for (let i = 0; i <= steps; i++) {
      // The last sample is the stopping point exactly, so the "ball at rest"
      // case is always in the search rather than landing between two samples.
      const s = i === steps ? path.rollFt : i * ROLL_SAMPLE_FT;
      const at = landDistFt + s;
      const tBall = hangS + rollTimeS(path, s);
      const tCover = timeToCoverS(polarGapFt(bearingDeg, at, f.bearingDeg, f.distFt) / mul,
        FIELDER_GROUND_REACTION_S);
      const stopped = i === steps;
      if (!stopped && tCover > tBall) continue;
      const fieldedS = stopped ? Math.max(tBall, tCover) : tBall;
      const throwFt = polarGapFt(bearingDeg, at, FIRST_BASE.bearingDeg, FIRST_BASE.distFt);
      const playS = fieldedS + THROW_RELEASE_S + throwFt / THROW_SPEED_FPS;
      if (best && playS >= best.playS) continue;
      best = {
        out: playS <= RUNNER_HOME_TO_FIRST_S,
        fielder: f.pos,
        infield: f.infield,
        fieldedAtFt: at,
        fieldedS,
        throwFt,
        playS,
        path,
      };
    }
  }
  // Unreachable: the stopping point is feasible for every fielder, so the search
  // always has at least eight candidates. A throw is left rather than an
  // exception because a lookup that can throw is a lookup a HUD has to guard.
  return (
    best ?? {
      out: false,
      fielder: '',
      infield: false,
      fieldedAtFt: path.stopDistFt,
      fieldedS: Infinity,
      throwFt: 0,
      playS: Infinity,
      path,
    }
  );
}
