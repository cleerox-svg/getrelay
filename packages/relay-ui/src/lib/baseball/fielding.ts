// Fielding — the LOOKUP. Where a batted ball ends up: out / 1B / 2B / 3B / HR.
//
// ⚠ THE SCOPE CAP IS THE DESIGN, straight from the charter: no stolen bases,
// errors, substitutions, shifts, positioning, cutoffs, relays, double plays,
// fielder's choice or baserunner state. Each is a later milestone and none is a
// small addition here; branches growing in this file is the signal to design the
// milestone.
//
// ⚠ THE LANDING-POINT LIMITATION IS FIXED, AND THIS HEADER USED TO BE WHERE IT
// WAS CONFESSED. The old text read: "the model reads the ball's LANDING POINT,
// but a ground ball does not stop where it lands — it rolls to the fielder, who
// throws — so a pure landing-point model scores routine infield grounders as
// base hits… when the duel wants real infield play the fix is a rolling phase."
// The rolling phase is `groundBall.ts`, `GROUND_INTERCEPT_FT` is DELETED rather
// than tuned exactly as that note promised, and the artifact it stood in for
// (3.4 % of ground balls retired, against MLB's ~72 %) is gone.
//
// What remains true, and is stated here rather than left to be rediscovered: the
// EXTRA-BASE index below still reads the landing point. That is correct for a
// ball in the air — a fly ball does land roughly where it is caught or falls —
// and it is the acknowledged approximation for a hard grounder that lands past
// the grass line and skips into the gap. See `XB_DEPTH_DATUM_FT`.
//
// THREE MODULES ALONG A REAL SEAM, none of them near the 500-line cap:
//   fielders.ts    where the defence stands, how fast it gets anywhere, and the
//                  infield arc — shared by both layers and by the RENDERER
//   groundBall.ts  the ball on the ground: roll, race, throw, runner
//   fielding.ts    this file — the ball in the air, and the one place a batted
//                  ball becomes a result
//
// No three, no Math.random, no wall clock, no state.

import type { FenceOutcome } from './parks';
import { FOUL_LINE_DEG } from './parks';
import {
  infieldDepthFt,
  nearestFielder,
  reachMultiplier,
  sprintFt,
} from './fielders';
import { groundOut } from './groundBall';
import type { GroundPlay } from './groundBall';

export type PlayResult = 'OUT' | 'FOUL' | 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'HR';

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * What a foot of DEPTH is worth against a foot of MISS. FEEL KNOB, and the
 * reason it exists: the same 20 ft of daylight is a bloop single at 200 ft and a
 * gap double at 380, because the throw back is 180 ft longer. One number instead
 * of a branch per case.
 */
export const XB_DEPTH_PER_FT = 0.3;

/**
 * The depth that credit is measured FROM, ft. FEEL KNOB — the offset of a
 * feel-knob index, and NOT a piece of geometry, however much its value looks
 * like one.
 *
 * ⚠ IT IS FLAT ON PURPOSE, AND THAT IS A DECISION WITH NUMBERS BEHIND IT. The
 * obvious move when `infieldDepthFt` became bearing-dependent was to measure
 * depth from the arc too — one symbol, one concept, done. Measured, that is the
 * change that moves the lookup: swept over distance × bearing × hang × rating it
 * re-calls **2.2 %** of the space, and two of the named ladder rows flip, BOTH
 * on the datum and NEITHER on the boundary.
 *
 * There is no mechanism behind those flips — and the reason is NOT that the
 * bearing effect is imaginary. It is that the infield arc is the WRONG
 * FUNCTIONAL FORM for it. The throw back genuinely IS longer down the line:
 * second base sits 127.28 ft out at 0°, so a 320 ft ball at 45° is **247.0 ft**
 * from it against **192.7 ft** for a 320 ft ball to centre. That is 54.3 ft of
 * extra throw, ~16.3 ft of index at `XB_DEPTH_PER_FT`. The arc datum hands the
 * same ball **8.4 ft** — half the magnitude, arrived at from the curvature of a
 * grass line that has nothing to do with where anybody throws. Right sign, wrong
 * size, wrong cause: a coincidental proxy, not a mechanism. Wiring one in would
 * mean re-fitting `XB_DOUBLE_FT` / `XB_TRIPLE_FT` against a law of cosines to
 * the BASES, which is a different change from a one-line datum swap.
 *
 * ⚠ AND THE HONEST PART: keeping it flat is ALSO what keeps the ladder still,
 * and a reviewer is entitled to read that as the reason rather than the
 * consequence. So the alternative is COMPUTED by `fielding.test.ts` rather than
 * described, and the day someone wants the arc datum the whole edit is
 * `infieldDepthFt(inp.bearingDeg)` on one line plus a re-fit — not an argument.
 *
 * Its VALUE is `infieldDepthFt(0)`, the arc's deepest point, so there is still
 * one geometric source and no 155.5 typed anywhere.
 */
export const XB_DEPTH_DATUM_FT = infieldDepthFt(0);

/**
 * Extra-base thresholds on `missFt + depth credit`, ft. FEEL KNOBS, set against
 * the printed ladder of named batted balls in `fielding.test.ts` rather than by
 * taste — a shallow bloop and a gap liner have similar MISS and must not score
 * the same. ⚠ They are thin: the 320 ft ball down the line indexes 70.1 against
 * a threshold of 68. A lookup has boundaries and its boundaries are boundaries.
 */
export const XB_DOUBLE_FT = 68;
export const XB_TRIPLE_FT = 130;

/** Off the wall this far off centre is a triple, deg. FEEL KNOB (long throw). */
export const CORNER_DEG = 30;

/** A foul pop needs this much hang to be run down, s. FEEL KNOB. */
export const FOUL_CATCH_MIN_HANG_S = 2.2;

export interface FieldingInput {
  /** From `parks.resolveFence` — the fence and roof have already been judged. */
  outcome: FenceOutcome;
  /** Plate → the landing (or fence) point: ground distance ft, bearing deg. */
  distFt: number;
  bearingDeg: number;
  hangS: number;
  /**
   * GROUND speed at the landing point, ft/s — `BattedFlight.landingGroundFps`.
   *
   * ⚠ REQUIRED, NOT OPTIONAL WITH A DEFAULT, and that is deliberate. A default
   * of zero would mean "the ball stops dead where it lands", which is precisely
   * the landing-point model this slice deleted — so a caller that forgot to
   * plumb the roll through would silently get the old artifact back instead of a
   * type error. There is no quiet way to lose the rolling phase.
   */
  landingGroundFps: number;
  /** The park's catchable foul ground, ft. */
  foulTerritoryFt: number;
}

export interface FieldingPlay {
  result: PlayResult;
  /**
   * Who made the play. The nearest fielder to the landing point on a ball in the
   * air, the fielder who actually gloved it on a ball on the ground, and '' when
   * nobody was asked (HR, uncatchable foul).
   */
  nearest: string;
  /** Fielder → landing point, ft; ground he could cover; how far short he was. */
  gapFt: number;
  reachFt: number;
  missFt: number;
  /** The rolling phase's own numbers — null unless the ball was on the ground. */
  ground: GroundPlay | null;
}

/**
 * Resolve a batted ball into a result. `defense ∈ [0,1]` is the ONE defender
 * rating — a card stat is expected to feed it, which is why it is a single
 * scalar and not a per-position table. It reaches exactly one quantity, ground
 * covered, in the air (`reachFt`) and on the dirt (`groundBall`'s race) alike,
 * so its whole effect is "the fielder got there or he didn't".
 */
export function fieldBattedBall(inp: FieldingInput, defense = 0.5): FieldingPlay {
  const none = (result: PlayResult): FieldingPlay =>
    ({ result, nearest: '', gapFt: 0, reachFt: 0, missFt: 0, ground: null });
  if (inp.outcome === 'homeRun') return none('HR');

  if (inp.outcome === 'foul') {
    // Perpendicular depth into foul ground, from the nearer line.
    const beyond = Math.max(0, Math.abs(inp.bearingDeg) - FOUL_LINE_DEG);
    const depthFt = inp.distFt * Math.sin(rad(beyond));
    const caught = inp.hangS >= FOUL_CATCH_MIN_HANG_S && depthFt <= inp.foulTerritoryFt;
    return none(caught ? 'OUT' : 'FOUL');
  }

  const near = nearestFielder(inp.bearingDeg, inp.distFt);
  const reachFt = sprintFt(inp.hangS) * reachMultiplier(defense);
  const missFt = Math.max(0, near.gapFt - reachFt);
  const base = { nearest: near.pos, gapFt: near.gapFt, reachFt, missFt, ground: null };

  // Off the wall is never an out — the ball has already gone past everybody.
  if (inp.outcome === 'offWall') {
    return { ...base, result: Math.abs(inp.bearingDeg) >= CORNER_DEG ? 'TRIPLE' : 'DOUBLE' };
  }
  // ⚠ CAUGHT IN THE AIR, AND THIS IS THE ONLY CLAUSE THAT USES HANG TIME AS
  // REACH. A grounder never satisfies it — a 1.05 s hang buys 2.3 ft of ground
  // against a 25 ft gap — so the ball falls through to the roll below, which is
  // exactly the ordering the fix needs. A LINE DRIVE straight at somebody does
  // satisfy it, and that is a line out, which is also correct.
  if (missFt === 0) return { ...base, result: 'OUT' };

  // ---- THE ROLLING PHASE ----
  // ⚠ THE GATE IS "DID IT HIT THE DIRT", not a launch-angle threshold, and the
  // difference matters. A ground ball is not a ball under 10° off the bat; it is
  // a ball that reached the skinned infield still travelling, and the census
  // agrees — 84 of the duel bench's 87 sub-10° balls in play land inside this
  // arc. The three that do not are hard grounders that skipped onto the outfield
  // grass, and they take the fly-ball path below with their landing point: a
  // known, measured, deliberately-unfixed residue of the old model, because
  // pricing them properly means running the extra-base index off the roll's
  // stopping point and re-fitting `XB_DOUBLE_FT`/`XB_TRIPLE_FT`, which is a
  // different slice from this one.
  if (inp.distFt < infieldDepthFt(inp.bearingDeg)) {
    const g = groundOut(inp.distFt, inp.bearingDeg, inp.hangS, inp.landingGroundFps, defense);
    // ⚠ AND A BALL THE INFIELD DOES NOT RETIRE IS A SINGLE, WHICH IS THE OLD CAP
    // KEPT FOR A NEW REASON. It used to be there because the miss arithmetic
    // scored a chopper landing 7 ft in front of the plate as a double — a
    // landing-point artifact. It is here now because it is the RULE: a ball that
    // gets through the infield on the ground is a base hit, and the batter does
    // not take second on it without a baserunning model this milestone does not
    // have.
    return { ...base, nearest: g.fielder, ground: g, result: g.out ? 'OUT' : 'SINGLE' };
  }

  // Depth is credited from `XB_DEPTH_DATUM_FT` — a flat datum, argued on its own
  // declaration — and NOT from the arc above. The term can go NEGATIVE (to
  // −8.37 ft at the foul line) for a ball past the arc but nearer than 155.5 ft,
  // and it is deliberately not clamped: such a ball is shallow, the throw back
  // is short, and a debit is the correct sign. Clamping it to 0 would say a
  // 130 ft bloop down the line and a 156 ft ball to centre are equally deep.
  const xb = missFt + XB_DEPTH_PER_FT * (inp.distFt - XB_DEPTH_DATUM_FT);
  if (xb < XB_DOUBLE_FT) return { ...base, result: 'SINGLE' };
  if (xb < XB_TRIPLE_FT) return { ...base, result: 'DOUBLE' };
  return { ...base, result: 'TRIPLE' };
}
