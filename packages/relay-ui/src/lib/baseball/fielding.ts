// Fielding — deliberately the SMALLEST model in the game.
//
// ⚠ THE SCOPE CAP IS THE DESIGN, straight from the charter: a landing point, a
// hang time and ONE defender rating map to out / 1B / 2B / 3B / HR. No stolen
// bases, errors, substitutions, shifts, positioning, throws, cutoffs or
// baserunner state. Each is a later milestone and none is a small addition here;
// branches growing in this file is the signal to design the milestone.
//
// ⚠ AND ONE STATED LIMITATION, PINNED BY A TEST. The model reads the ball's
// LANDING POINT, but a ground ball does not stop where it lands — it rolls to
// the fielder, who throws — so a pure landing-point model scores routine infield
// grounders as base hits. That is the missing roll-and-throw, not a bug in the
// reach arithmetic, and the knob that stands in for it says so on its own line.
//
// No three, no Math.random, no wall clock, no state.

import type { FenceOutcome } from './parks';
import { FOUL_LINE_DEG } from './parks';
import { RUBBER_D_FT } from './zone';

export type PlayResult = 'OUT' | 'FOUL' | 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'HR';

/** A fielder's standing position, polar from the plate. */
export interface FielderSpot { pos: string; bearingDeg: number; distFt: number }

/**
 * The standard defensive alignment — the league-average depths and angles of a
 * straight-up diagram. PUBLISHED DATA in the weak sense (exact reference
 * unverified, flagged on the same standard the aero citations are held to).
 *
 * ⚠ IT IS A CONSTANT, AND THAT IS THE "NO SHIFTS" RULE EXPRESSED AS DATA: nothing
 * here may ever return a different alignment for a different batter, count or
 * park. The catcher and pitcher are omitted — neither is ever the nearest
 * fielder to a batted ball's landing point.
 */
export const ALIGNMENT: FielderSpot[] = [
  { pos: '3B', bearingDeg: -38, distFt: 108 },
  { pos: 'SS', bearingDeg: -19, distFt: 145 },
  { pos: '2B', bearingDeg: 19, distFt: 145 },
  { pos: '1B', bearingDeg: 38, distFt: 108 },
  { pos: 'LF', bearingDeg: -29, distFt: 290 },
  { pos: 'CF', bearingDeg: 0, distFt: 315 },
  { pos: 'RF', bearingDeg: 29, distFt: 290 },
];

/** Fielder sprint speed, ft/s. PUBLISHED DATA (MLB average sprint speed ~27). */
export const FIELDER_SPEED_FPS = 27;

/**
 * Reaction + route-recognition time before a fielder moves, s. PUBLISHED DATA
 * (the ~0.5 s "reaction" leg of published route work; exact reference
 * unverified — flagged on the same standard the aero citations are held to).
 */
export const FIELDER_REACTION_S = 0.5;

/**
 * Time from a standing start to sprint speed, s. PUBLISHED DATA (~1.8 s).
 * ⚠ NOT COSMETIC: an instantly-sprinting fielder is over-credited v·t/2 = 24.3 ft
 * on every play longer than the ramp — enough to turn a gap double into a routine
 * out. On a 4 s hang this model covers 70.2 ft against the instant-sprint
 * model's 94.5 (both printed by `fielding.test.ts`), and the published catch
 * envelope says ~100 ft on a 4 s hang is a FIVE-STAR play — so the 94.5 version
 * would price a five-star play as very nearly routine.
 */
export const FIELDER_TIME_TO_SPEED_S = 1.8;

/** Acceleration, ft/s². DERIVED: v_max / t_to_speed. Never hand-set. */
export const FIELDER_ACCEL_FPS2 = FIELDER_SPEED_FPS / FIELDER_TIME_TO_SPEED_S;

/**
 * Span of the one defender rating, as a multiplier on reach. FEEL KNOB.
 * `defense ∈ [0,1]` maps to 0.85× … 1.15× — ~±10 ft of reach on a 4 s fly. ONE
 * rating, ONE channel: it may never be made to reach anything else.
 */
export const DEFENSE_SPAN = 0.3;

/**
 * Extra ground a fielder covers on a ball that lands in the INFIELD, ft.
 * ⚠ FEEL KNOB, AND A STAND-IN FOR PHYSICS THIS MODEL DOES NOT HAVE — the roll
 * from the landing point to the fielder, and the throw. A grounder scored purely
 * off where it first touched the dirt is a base hit every time, which is not
 * fixable inside a landing-point lookup. When the duel wants real infield play
 * the fix is a rolling phase, and this constant is deleted rather than tuned.
 */
export const GROUND_INTERCEPT_FT = 26;

/**
 * Radius of the infield dirt as this model uses it — a PLATE-CENTRED circle, ft.
 *
 * Its VALUE is derived: `RUBBER_D_FT + 95` is where the published 95 ft infield
 * arc, struck from the pitcher's plate, crosses the centre-field line. Not a
 * round number somebody liked.
 *
 * ⚠ BUT THE GEOMETRY IS AN APPROXIMATION AND THE LABEL USED TO HIDE IT. The real
 * arc is centred on the RUBBER and this is used as a radius from the PLATE, and
 * the two only coincide at dead centre. The true arc's distance from the plate
 * is 155.5 ft at 0°, 149.6 at 20°, 135.1 at 38° (where the corners stand) and
 * 127.6 at the foul line — so one plate-centred circle over-states the dirt by
 * up to 27.9 ft down the lines. That matters: `distFt < INFIELD_DEPTH_FT` is
 * what caps an unfielded ball at a single, so a 140 ft ball down the line is
 * treated as an infield chopper when it landed on the outfield grass.
 *
 * Left as one circle DELIBERATELY, for now: making it bearing-dependent is a
 * behaviour change to the lookup (it moves the ladder), and the smallest-model
 * rule says that lands with the rolling phase that supersedes
 * `GROUND_INTERCEPT_FT`, not before it. Flagged here rather than mislabelled.
 */
export const INFIELD_DEPTH_FT = RUBBER_D_FT + 95;

/**
 * What a foot of DEPTH is worth against a foot of MISS. FEEL KNOB, and the
 * reason it exists: the same 20 ft of daylight is a bloop single at 200 ft and a
 * gap double at 380, because the throw back is 180 ft longer. One number instead
 * of a branch per case.
 */
export const XB_DEPTH_PER_FT = 0.3;

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
  /** The park's catchable foul ground, ft. */
  foulTerritoryFt: number;
}

export interface FieldingPlay {
  result: PlayResult;
  /** Nearest fielder, '' when nobody was asked (HR, uncatchable foul). */
  nearest: string;
  /** Fielder → landing point, ft; ground he could cover; how far short he was. */
  gapFt: number;
  reachFt: number;
  missFt: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Straight-line distance between two polar points on the ground plane, ft. */
const gap = (aDeg: number, aFt: number, bDeg: number, bFt: number): number =>
  Math.sqrt(Math.max(0, aFt * aFt + bFt * bFt - 2 * aFt * bFt * Math.cos(rad(aDeg - bDeg))));

/** Ground covered in `hangS`, ft: react, ramp (½aτ²), then sprint v(τ − t/2). */
export function sprintFt(hangS: number): number {
  const tau = Math.max(0, hangS - FIELDER_REACTION_S);
  if (tau <= FIELDER_TIME_TO_SPEED_S) return 0.5 * FIELDER_ACCEL_FPS2 * tau * tau;
  return FIELDER_SPEED_FPS * (tau - FIELDER_TIME_TO_SPEED_S / 2);
}

/** The fielder nearest a landing point, and how far away he is. */
export function nearestFielder(bearingDeg: number, distFt: number): { pos: string; gapFt: number } {
  let best = { pos: '', gapFt: Infinity };
  for (const f of ALIGNMENT) {
    const g = gap(bearingDeg, distFt, f.bearingDeg, f.distFt);
    if (g < best.gapFt) best = { pos: f.pos, gapFt: g };
  }
  return best;
}

/**
 * Resolve a batted ball into a result. `defense ∈ [0,1]` is the ONE defender
 * rating — a card stat is expected to feed it, which is why it is a single
 * scalar and not a per-position table. It reaches exactly one quantity,
 * `reachFt`, so its whole effect is "the fielder got there or he didn't".
 */
export function fieldBattedBall(inp: FieldingInput, defense = 0.5): FieldingPlay {
  const none = (result: PlayResult): FieldingPlay =>
    ({ result, nearest: '', gapFt: 0, reachFt: 0, missFt: 0 });
  if (inp.outcome === 'homeRun') return none('HR');

  if (inp.outcome === 'foul') {
    // Perpendicular depth into foul ground, from the nearer line.
    const beyond = Math.max(0, Math.abs(inp.bearingDeg) - FOUL_LINE_DEG);
    const depthFt = inp.distFt * Math.sin(rad(beyond));
    const caught = inp.hangS >= FOUL_CATCH_MIN_HANG_S && depthFt <= inp.foulTerritoryFt;
    return none(caught ? 'OUT' : 'FOUL');
  }

  const near = nearestFielder(inp.bearingDeg, inp.distFt);
  const mul = 1 + (Math.min(1, Math.max(0, defense)) - 0.5) * DEFENSE_SPAN;
  const infield = inp.distFt < INFIELD_DEPTH_FT ? GROUND_INTERCEPT_FT : 0;
  const reachFt = (sprintFt(inp.hangS) + infield) * mul;
  const missFt = Math.max(0, near.gapFt - reachFt);
  const base = { nearest: near.pos, gapFt: near.gapFt, reachFt, missFt };

  // Off the wall is never an out — the ball has already gone past everybody.
  if (inp.outcome === 'offWall') {
    return { ...base, result: Math.abs(inp.bearingDeg) >= CORNER_DEG ? 'TRIPLE' : 'DOUBLE' };
  }
  if (missFt === 0) return { ...base, result: 'OUT' };
  // ⚠ A ball that lands on the dirt and is not fielded is an infield hit, and
  // this clause is load-bearing rather than tidy: a chopper landing 7 ft in front
  // of the plate is 100 ft from the nearest fielder's STANDING SPOT, so without
  // it the miss arithmetic scores it a double. The landing-point limitation
  // showing its teeth; capped honestly until there is a rolling phase.
  if (inp.distFt < INFIELD_DEPTH_FT) return { ...base, result: 'SINGLE' };
  // Depth beyond the infield is a CREDIT, and it can only be positive HERE
  // because the line above has already returned for everything shallower. It
  // used to carry a `Math.max(0, …)` as well; that clamp was PROVABLY
  // unreachable, so it is deleted rather than kept for comfort.
  //
  // ⚠ AND THE HONEST CONSEQUENCE, MEASURED RATHER THAN ASSERTED AWAY. With the
  // clamp gone the two clauses are equivalent IN EFFECT: swept over the whole
  // infield (every distance, bearing, hang and rating), the index this line
  // would produce for a shallow ball peaks at 39.25 against the 68 ft
  // single/double threshold, so deleting the cap above would not change a single
  // call — its mutation is unobservable, not merely unobserved. The cap stays
  // because it is the explicit statement of the rule and because that 28.75 ft
  // of margin is an artefact of today's feel knobs, not a theorem; the day a
  // knob narrows it, the cap becomes load-bearing. `fielding.test.ts` measures
  // the margin so that day is a test failure rather than a surprise.
  const xb = missFt + XB_DEPTH_PER_FT * (inp.distFt - INFIELD_DEPTH_FT);
  if (xb < XB_DOUBLE_FT) return { ...base, result: 'SINGLE' };
  if (xb < XB_TRIPLE_FT) return { ...base, result: 'DOUBLE' };
  return { ...base, result: 'TRIPLE' };
}
