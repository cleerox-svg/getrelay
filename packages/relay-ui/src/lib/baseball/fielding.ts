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
// ⚠ IT ALSO OWNS ONE PIECE OF FIELD GEOMETRY, `infieldDepthFt`, and owns it for
// BOTH LAYERS. `stadium/field.ts` draws the dirt by sampling this function, so
// the boundary a human sees in a screenshot is the boundary the lookup tests
// against. That is not tidiness — M1's visual gate inverted a render back to
// world feet, measured the dirt edge at 155.6 ft, and caught a physics bug that
// two prose passes had already looked straight at.
//
// No three, no Math.random, no wall clock, no state.

import type { FenceOutcome } from './parks';
import { FOUL_LINE_DEG } from './parks';
import { RUBBER_D_FT } from './zone';

export type PlayResult = 'OUT' | 'FOUL' | 'SINGLE' | 'DOUBLE' | 'TRIPLE' | 'HR';

const rad = (deg: number) => (deg * Math.PI) / 180;

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
 * Radius of the infield arc — the grass line — struck from the pitcher's plate,
 * ft. PUBLISHED DATA (the field-layout diagram's 95 ft skinned-infield arc;
 * exact reference unverified, flagged on the same standard the aero citations
 * are held to).
 *
 * ⚠ The CENTRE is the ambiguity, not the radius. Groundskeeping references
 * variously strike this arc from the front edge of the rubber (`RUBBER_D_FT`,
 * 60.5 ft) and from the centre of the mound circle (59 ft). We use the rubber,
 * because 60.5 is already published data in `zone.ts` and adding a second,
 * separately-unverified 59 would buy nothing: measured, the two centres differ
 * by 1.5 ft at dead centre and 0.5 ft at the foul line, against the 27.9 ft
 * error this whole function exists to remove.
 */
export const INFIELD_ARC_R_FT = 95;

/**
 * Distance from the PLATE to the edge of the infield dirt at a bearing, ft.
 * DERIVED, and a FUNCTION rather than a constant because the real thing is one:
 * the arc is centred on the rubber, the lookup asks in plate-centred polars, and
 * the two only coincide at dead centre.
 *
 * Law of cosines on the triangle plate → rubber → arc point, solved for the
 * plate-side leg:
 *
 *     r(β) = d·cos β + √(R² − (d·sin β)²)     d = RUBBER_D_FT, R = 95
 *
 * The discriminant can never go negative — `d < R`, so `|d·sin β| ≤ 60.5 < 95`
 * at every bearing including behind the plate — which is why there is no clamp
 * and why a clamp appearing here later would be a bug, not a safety net.
 *
 * 155.5 ft at 0°, 149.6 at 20°, 135.1 at ±38° (where the corners stand), 127.6
 * at the foul line.
 *
 * ⚠ THIS REPLACES A PLATE-CENTRED CIRCLE OF 155.5 ft, WHICH WAS WRONG BY UP TO
 * 27.9 ft down the lines. Stage 4b fixed the constant's LABEL and left the
 * geometry; a 140 ft ball down the line was still being scored as an infield
 * chopper when it had landed on outfield grass, and the M1 visual gate then
 * measured the renderer faithfully drawing a dirt lot that filled ~60 % of the
 * batter's-eye frame. The renderer added no error of its own:
 * `stadium/field.ts` calls THIS function, so the drawn dirt is the dirt the
 * fielder model uses, which is the whole point of one shared source.
 *
 * ⚠ IT ANSWERS EXACTLY ONE QUESTION — "did the ball land on the skinned
 * infield?" — and the extra-base index deliberately does NOT measure depth from
 * it. See `XB_DEPTH_DATUM_FT`, which is where the second half of this fix is
 * argued and where the numbers for the alternative are recorded.
 *
 * ⚠ THE BASELINE CUTOUTS ARE DELIBERATELY NOT MODELLED, and they need not be:
 * every one of them is strictly INSIDE this arc (second base sits 127.3 ft out
 * against an arc at 155.5; a 13 ft cutout around first reaches 103 ft against an
 * arc at 127.6), so the arc is the OUTER boundary of the dirt at every bearing
 * and "did this ball land on the dirt" needs nothing else. The infield grass
 * diamond inside it is a texture question for the renderer, not a lookup input.
 */
export function infieldDepthFt(bearingDeg: number): number {
  const b = rad(bearingDeg);
  const s = RUBBER_D_FT * Math.sin(b);
  return RUBBER_D_FT * Math.cos(b) + Math.sqrt(INFIELD_ARC_R_FT * INFIELD_ARC_R_FT - s * s);
}

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
 * re-calls **2.2 %** of the space, of which the dirt-boundary fix accounts for
 * 7,376 cases (OUT → SINGLE, balls landing on outfield grass that were being
 * handed the infield roll-and-throw credit — the defect) and the depth datum for
 * **19,606** (12,470 SINGLE → DOUBLE, 7,136 DOUBLE → TRIPLE). Two of the
 * thirteen named ladder rows flip, and BOTH flip on the datum, NEITHER on the
 * boundary.
 *
 * There is no mechanism behind those 19,606 — and the reason is NOT that the
 * bearing effect is imaginary. It is that the infield arc is the WRONG
 * FUNCTIONAL FORM for it. This comment used to argue "a base does not move when
 * the grass line curves", which understates the case: the throw back genuinely
 * IS longer down the line. Second base sits 127.28 ft out at 0°, so a 320 ft ball
 * at 45° is **247.0 ft** from it against **192.7 ft** for a 320 ft ball to
 * centre. That is 54.3 ft of extra throw, ~16.3 ft of index at
 * `XB_DEPTH_PER_FT`. The arc datum hands the same ball **8.4 ft** — half the
 * magnitude, arrived at from the curvature of a grass line that has nothing to do
 * with where anybody throws. Right sign, wrong size, wrong cause: a coincidental
 * proxy, not a mechanism. Wiring one in would mean re-fitting `XB_DOUBLE_FT` /
 * `XB_TRIPLE_FT` against a law of cosines to the BASES, which is a different
 * change from the one-line `infieldDepthFt(inp.bearingDeg)` that started this.
 *
 * ⚠ AND ONE CORRECTION TO WHAT THIS COMMENT USED TO CLAIM. It said the bearing
 * effect was "already priced honestly and explicitly twice over: through `missFt`
 * … and through `CORNER_DEG`". Half of that is false. `CORNER_DEG` appears in
 * exactly one non-test place — the `outcome === 'offWall'` branch of
 * `fieldBattedBall` — which RETURNS before `xb` is ever computed, so it never
 * executes on this path and prices nothing here. The `missFt` half is real and
 * stands: the LF is 80.1 ft from the ladder's 320 ft / −43° ball down the line
 * while the CF is 15.0 ft from its 330 ft ball to centre, both printed by
 * `fielding.test.ts`. So ONE honest bearing term, not two — which is still the
 * reason a third, implicit one is unwelcome, and now the count is right.
 *
 * ⚠ AND THE HONEST PART: keeping it flat is ALSO what keeps the ladder still,
 * and a reviewer is entitled to read that as the reason rather than the
 * consequence. So the alternative's numbers are recorded above rather than
 * described, `XB_DOUBLE_FT`/`XB_TRIPLE_FT` were fitted against the named ladder
 * WITH this offset in place and would need re-fitting without it, and the day
 * someone wants the arc datum the whole edit is `infieldDepthFt(inp.bearingDeg)`
 * on one line plus a re-fit — not an argument.
 *
 * Its VALUE is `infieldDepthFt(0)`, the arc's deepest point, so there is still
 * one geometric source in this file and no 155.5 typed anywhere.
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
  // ⚠ THE DIRT EDGE AT THIS BEARING, read once and used by both clauses that ask
  // "did it land on the dirt". The extra-base index below asks a different
  // question and answers it from `XB_DEPTH_DATUM_FT`; the two were one constant
  // only because a wrong circle happened to be numerically equal to a datum.
  const infieldFt = infieldDepthFt(inp.bearingDeg);
  const infield = inp.distFt < infieldFt ? GROUND_INTERCEPT_FT : 0;
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
  if (inp.distFt < infieldFt) return { ...base, result: 'SINGLE' };
  // Depth is credited from `XB_DEPTH_DATUM_FT` — a flat datum, argued on its own
  // declaration — and NOT from the arc above. It used to carry a `Math.max(0, …)`
  // as well; that clamp was PROVABLY unreachable, so it is deleted rather than
  // kept for comfort.
  //
  // ⚠ THE CLAMP'S CASE IS NOW REACHABLE AND STILL DOES NOT WANT A CLAMP, which
  // is a real change from stage 4b and not a slip. The datum is the arc's
  // deepest point, so a ball past the arc down the line but nearer than 155.5 ft
  // lands HERE with a NEGATIVE term — up to −8.37 ft at the foul line. That is
  // the term doing its job, not overflowing it: such a ball is shallow, the
  // throw back is short, and a debit is the correct sign. Clamping it to 0 would
  // say a 130 ft bloop down the line and a 156 ft ball to centre are equally deep.
  //
  // ⚠ AND THE OVERLAP, MEASURED RATHER THAN ASSERTED AWAY. With the clamp gone
  // the two clauses are equivalent IN EFFECT: swept over the whole dirt (every
  // distance, bearing, hang and rating), the index this line would produce for a
  // ball on the dirt peaks at 39.25 against the 68 ft single/double threshold,
  // so deleting the cap above would not change a single call — its mutation is
  // unobservable, not merely unobserved. The cap stays because it is the explicit
  // statement of the rule and because that 28.75 ft of margin is an artefact of
  // today's feel knobs, not a theorem; the day a knob narrows it, the cap becomes
  // load-bearing. `fielding.test.ts` measures the margin so that day is a test
  // failure rather than a surprise.
  const xb = missFt + XB_DEPTH_PER_FT * (inp.distFt - XB_DEPTH_DATUM_FT);
  if (xb < XB_DOUBLE_FT) return { ...base, result: 'SINGLE' };
  if (xb < XB_TRIPLE_FT) return { ...base, result: 'DOUBLE' };
  return { ...base, result: 'TRIPLE' };
}
