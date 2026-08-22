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
// FOUR MODULES, and this one is the third:
//
//   fielders.ts    where the defence stands and how fast it gets anywhere
//   roll.ts        the ball on the ground — the surfaces, and where it is when
//   groundBall.ts  this file: the RACE, the THROW and the RUNNER
//   fielding.ts    the ball in the air, and the one place a batted ball becomes
//                  a result — it is what calls in here
//
// `roll.ts` came out of this file at the 500-line cap, along the seam
// `airPhysics.ts`/`pitchSim.ts` already uses one layer down: the ball's own
// motion on one side, what the game does about it on the other. Extraction, not
// a raised cap.
//
// The whole model is four steps and there is no fifth:
//
//   1. the ball lands and ROLLS outward along its bearing, decelerating
//      (`roll.ts`);
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
// steps on the bag" is not a special case here — it is the same throw, 21.66 ft
// long, taking 0.18 s. "The pitcher fields a comebacker" is not a special case
// either; he is a row in `fielders.ALIGNMENT`. One race, one throw, one
// comparison, and the geometry does the rest.
//
// No three, no Math.random, no wall clock, no state.

import {
  ALIGNMENT,
  FIELDER_GROUND_REACTION_S,
  polarGapFt,
  reachMultiplier,
  timeToCoverS,
} from './fielders';
import { ROLL_SAMPLE_S, rollDistFt, rollPath, rollTimeS } from './roll';
import type { RollPath } from './roll';
import { FOUL_LINE_DEG } from './parks';
import { MPH_TO_FPS } from './units';

const rad = (deg: number) => (deg * Math.PI) / 180;

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
  const steps = Math.max(1, Math.ceil(path.stopS / ROLL_SAMPLE_S));
  for (const f of ALIGNMENT) {
    // ⚠ EVERY FIELDER GETS HIS CLOSEST APPROACH AS AN EXACT CANDIDATE, and it is
    // not a refinement of the grid — it is the one point no grid can be trusted
    // to find. Where the ball's ray passes THROUGH a fielder's post the gap goes
    // to zero, and `timeToCoverS` is √-shaped near zero, so the window in which
    // he beats the ball there can be a few thousandths of a second wide. A
    // uniform sampler straddles it and the model falls back to fielding the ball
    // at REST, 1.99 s later — measured, on a ball rolling straight through the
    // second baseman. The closest approach is the foot of the perpendicular from
    // his post to the ray, `d·cos Δβ`, which is closed form and costs one extra
    // evaluation per fielder.
    const sStar = Math.min(
      Math.max(0, f.distFt * Math.cos(rad(bearingDeg - f.bearingDeg)) - landDistFt),
      path.rollFt,
    );
    for (let i = 0; i <= steps + 1; i++) {
      // The last grid sample is the ball coming to REST, exactly, so that case
      // is always in the search rather than landing between two samples; the
      // extra one is the closest approach above.
      const tRoll =
        i === steps + 1
          ? rollTimeS(path, sStar)
          : i === steps
            ? path.stopS
            : i * ROLL_SAMPLE_S;
      const at = landDistFt + rollDistFt(path, tRoll);
      const tBall = hangS + tRoll;
      const tCover = timeToCoverS(polarGapFt(bearingDeg, at, f.bearingDeg, f.distFt) / mul,
        FIELDER_GROUND_REACTION_S);
      const stopped = tRoll >= path.stopS - 1e-12;
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
