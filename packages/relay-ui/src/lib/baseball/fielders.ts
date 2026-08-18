// The DEFENCE — where the fielders stand, how fast they get anywhere, and where
// the dirt they stand on ends. Data and kinematics; NO outcome lives here.
//
// ⚠ EXTRACTED FROM `fielding.ts` WHEN THE ROLLING PHASE LANDED, and extracted
// rather than copied. `fielding.ts` (the ball in the AIR) and `groundBall.ts`
// (the ball on the GROUND) both need the same seven standing positions, the same
// acceleration ramp and the same infield arc, and two modules reaching for those
// through each other is an import cycle. One module underneath both is the seam:
// nothing here knows what an OUT is, and both layers above read exactly one
// alignment, one ramp and one arc. The 500-line cap is what forced the question
// and this is the extraction it asked for, not a raised cap.
//
// ⚠ AND IT STILL OWNS `infieldDepthFt` FOR BOTH LAYERS — the SIM layer and the
// RENDER layer. `components/baseball/stadium/field.ts` draws the dirt by
// sampling this function, so the boundary a human sees in a screenshot is the
// boundary the lookup tests against and the surface the roll model decelerates
// on. Moving the function one file sideways changed no geometry and no drawn
// pixel; it changed one import line. That coupling is deliberate — M1's visual
// gate inverted a render back to world feet, measured the dirt edge at 155.6 ft,
// and caught a physics bug that two prose passes had already looked straight at.
//
// No three, no Math.random, no wall clock, no state.

import { RUBBER_D_FT } from './zone';

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A fielder's standing position, polar from the plate. */
export interface FielderSpot {
  pos: string;
  bearingDeg: number;
  distFt: number;
  /** Is he one of the five who can field a grounder and throw a runner out? */
  infield: boolean;
}

/**
 * The standard defensive alignment — the league-average depths and angles of a
 * straight-up diagram. PUBLISHED DATA in the weak sense (exact reference
 * unverified, flagged on the same standard the aero citations are held to),
 * except the pitcher, whose 60.5 ft is `zone.RUBBER_D_FT` and is hard published
 * data read from the one place that already owns it.
 *
 * ⚠ IT IS A CONSTANT, AND THAT IS THE "NO SHIFTS" RULE EXPRESSED AS DATA: nothing
 * here may ever return a different alignment for a different batter, count or
 * park.
 *
 * ⚠ THE PITCHER IS IN IT AND THE CATCHER IS NOT, AND BOTH HALVES OF THAT ARE
 * DECISIONS. This list used to say "the catcher and pitcher are omitted —
 * neither is ever the nearest fielder to a batted ball's LANDING POINT", which
 * was true of a landing-point model and became false the moment the ball started
 * ROLLING: a grounder up the middle passes within a few feet of the rubber, and
 * without the pitcher in the list the model had a hole exactly where the spray
 * chart is densest (measured on the duel bench: ~20 % of balls in play leave the
 * bat inside ±10° of dead centre). A 1-3 putout is ordinary baseball. The
 * CATCHER stays out because the only balls he ever fields are bunts and balls
 * that die within ~30 ft of the plate, and this game has no bunt and no ball
 * that dies there — the topped balls the bench produces land 1–6 ft out still
 * carrying 70–130 ft/s and roll past him before he is out of his crouch.
 */
export const ALIGNMENT: FielderSpot[] = [
  { pos: 'P', bearingDeg: 0, distFt: RUBBER_D_FT, infield: true },
  { pos: '3B', bearingDeg: -38, distFt: 108, infield: true },
  { pos: 'SS', bearingDeg: -19, distFt: 145, infield: true },
  { pos: '2B', bearingDeg: 19, distFt: 145, infield: true },
  { pos: '1B', bearingDeg: 38, distFt: 108, infield: true },
  { pos: 'LF', bearingDeg: -29, distFt: 290, infield: false },
  { pos: 'CF', bearingDeg: 0, distFt: 315, infield: false },
  { pos: 'RF', bearingDeg: 29, distFt: 290, infield: false },
];

/** Fielder sprint speed, ft/s. PUBLISHED DATA (MLB average sprint speed ~27). */
export const FIELDER_SPEED_FPS = 27;

/**
 * Reaction + route-recognition time before a fielder moves on a ball IN THE AIR,
 * s. PUBLISHED DATA (the ~0.5 s "reaction" leg of published route work; exact
 * reference unverified — flagged on the same standard the aero citations are
 * held to).
 */
export const FIELDER_REACTION_S = 0.5;

/**
 * The same, for a ball ON THE GROUND, s. PUBLISHED DATA in the weak sense —
 * ~0.2 s is the published human simple visual reaction time, and it is the whole
 * of what an infielder owes on a grounder.
 *
 * ⚠ THE SPLIT IS THE MECHANISM, NOT A DISCOUNT FOR THE INFIELD. The 0.5 s above
 * is "reaction PLUS route recognition" and says so on its own line: an
 * outfielder has to read a trajectory — angle off the bat, carry, whether it is
 * over his head — before he knows which way to run. A ground ball has no route
 * to read. It is on the ground, it is coming, and the only decision is a first
 * step. Charging the infielder the outfielder's route tax is what made a
 * one-second play unplayable: on a 1.0 s grounder it spends HALF the play
 * standing still, and `fielding.test.ts` prints both legs so the claim is
 * arithmetic rather than an assertion.
 */
export const FIELDER_GROUND_REACTION_S = 0.2;

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

/** Ground covered during the ramp alone, ft. DERIVED: ½·a·t². */
export const FIELDER_RAMP_FT = 0.5 * FIELDER_ACCEL_FPS2 * FIELDER_TIME_TO_SPEED_S ** 2;

/**
 * Span of the one defender rating, as a multiplier on reach. FEEL KNOB.
 * `defense ∈ [0,1]` maps to 0.85× … 1.15× — ~±10 ft of reach on a 4 s fly. ONE
 * rating, ONE channel: it may never be made to reach anything else. The ground
 * model reads it through the SAME multiplier (a fielder who covers 15 % more
 * ground covers it whether the ball is in the air or on the dirt), which is what
 * keeps "one rating, one channel" true across two layers instead of one.
 */
export const DEFENSE_SPAN = 0.3;

/** `defense ∈ [0,1]` → the reach multiplier. Clamped, never extrapolated. */
export const reachMultiplier = (defense: number): number =>
  1 + (Math.min(1, Math.max(0, defense)) - 0.5) * DEFENSE_SPAN;

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
 * ⚠ THIS REPLACED A PLATE-CENTRED CIRCLE OF 155.5 ft, WHICH WAS WRONG BY UP TO
 * 27.9 ft down the lines. Stage 4b fixed the constant's LABEL and left the
 * geometry; a 140 ft ball down the line was still being scored as an infield
 * chopper when it had landed on outfield grass, and the M1 visual gate then
 * measured the renderer faithfully drawing a dirt lot that filled ~60 % of the
 * batter's-eye frame. The renderer added no error of its own:
 * `stadium/field.ts` calls THIS function, so the drawn dirt is the dirt the
 * fielder model uses, which is the whole point of one shared source.
 *
 * ⚠ IT NOW ANSWERS TWO QUESTIONS, NOT ONE, AND THE SECOND IS NEW. It has always
 * answered "did the ball land on the skinned infield?". It also answers "which
 * surface is the ball rolling on RIGHT NOW?" — `groundBall.ts` integrates the
 * roll piecewise across this boundary, because a skinned infield and outfield
 * grass do not slow a ball at the same rate. Same function, same arc, same
 * drawn line: the surface the roll decelerates on is the surface in the picture.
 *
 * ⚠ THE EXTRA-BASE INDEX DELIBERATELY DOES NOT MEASURE DEPTH FROM IT. See
 * `fielding.XB_DEPTH_DATUM_FT`, which is where that half of the argument lives.
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

/** Straight-line distance between two polar points on the ground plane, ft. */
export const polarGapFt = (
  aDeg: number,
  aFt: number,
  bDeg: number,
  bFt: number,
): number =>
  Math.sqrt(Math.max(0, aFt * aFt + bFt * bFt - 2 * aFt * bFt * Math.cos(rad(aDeg - bDeg))));

/**
 * Ground covered in `tS` from the pitch, ft: react, ramp (½aτ²), then sprint
 * v(τ − t/2). `reactionS` is which reaction applies — the outfielder's route
 * read by default, `FIELDER_GROUND_REACTION_S` for a ball on the dirt.
 */
export function sprintFt(tS: number, reactionS = FIELDER_REACTION_S): number {
  const tau = Math.max(0, tS - reactionS);
  if (tau <= FIELDER_TIME_TO_SPEED_S) return 0.5 * FIELDER_ACCEL_FPS2 * tau * tau;
  return FIELDER_SPEED_FPS * (tau - FIELDER_TIME_TO_SPEED_S / 2);
}

/**
 * The EXACT INVERSE of `sprintFt` — how long it takes to cover `distFt`, s.
 *
 * ⚠ ONE RAMP, TWO DIRECTIONS, NO SECOND MODEL. The air lookup asks "how far in
 * this much time"; the ground lookup asks "how much time for this far", because
 * a rolling ball's arrival at a point is what the fielder is racing. Writing the
 * second question as its own approximation is exactly the fork this codebase
 * refuses, so it is solved analytically from the same three constants and
 * `fielders.test.ts` asserts the round trip to 1e-9 at every distance.
 */
export function timeToCoverS(distFt: number, reactionS = FIELDER_REACTION_S): number {
  if (distFt <= 0) return reactionS;
  const tau =
    distFt <= FIELDER_RAMP_FT
      ? Math.sqrt((2 * distFt) / FIELDER_ACCEL_FPS2)
      : distFt / FIELDER_SPEED_FPS + FIELDER_TIME_TO_SPEED_S / 2;
  return reactionS + tau;
}

/** The fielder nearest a point on the ground, and how far away he is. */
export function nearestFielder(bearingDeg: number, distFt: number): { pos: string; gapFt: number } {
  let best = { pos: '', gapFt: Infinity };
  for (const f of ALIGNMENT) {
    const g = polarGapFt(bearingDeg, distFt, f.bearingDeg, f.distFt);
    if (g < best.gapFt) best = { pos: f.pos, gapFt: g };
  }
  return best;
}
