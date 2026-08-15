// The geometry every layer of the pitching game shares: where the ball is
// released, where the plate is, what counts as a strike, and the ONE mapping
// between the physics frame, the broadcast-style reporting frame the tables are
// published in, and the HUD's reticle.
//
// ⚠ ONE ZONE, THREE CONSUMERS. The sim calls `isStrike`, the HUD draws the box
// from `RULE_ZONE`/`reticleToPlate`, and the GL scene places its floating
// strike-zone frame from the same constants. A second copy of "the zone is
// about 1.7 by 1.8 feet" anywhere else is how the umpire ends up disagreeing
// with the picture. No three, no state, no clock.
//
// ---------------------------------------------------------------------------
// TWO FRAMES, AND WHY BOTH EXIST
// ---------------------------------------------------------------------------
//
// WORLD (airPhysics.ts, right-handed, the frame the integrator runs in):
//   +x  mound → plate, origin AT THE RELEASE POINT (so x is distance flown)
//   +y  toward first base / the catcher's right (a RHP's arm side is −y)
//   +z  up
//
// REPORT (this file — the frame every published table and this game's HUD use):
//   d   distance from the plate, + toward centre field: 0 at the plate's rear
//       point, 60.5 at the rubber, ~54 at release. A pitch travels in −d.
//   x   lateral, + to the catcher's/umpire's RIGHT (the first-base side)
//   h   height above the plate
//
// The two are the same three axes; only the downrange one is reversed and
// re-origined, so `d = RELEASE_D_FT − x_world` and `x = y_world`, `h = z_world`.
// REPORT is deliberately a labelled TUPLE and not a basis — (d, x, h) taken in
// that order is left-handed, so never take a cross product in it. Do the physics
// in WORLD; report in REPORT.
//
// The x axis is Statcast's lateral axis exactly, sign and all, which is what
// lets published data be asserted without a mental mirror at every step: a RHP's
// average release is at x ≈ −1.9 ft (arm side, third-base side) and his
// four-seamer's horizontal break is toward −x. That both come out negative is
// the check that the frame has not been flipped.

import { BALL_RADIUS_FT, vec3 } from './airPhysics';
import type { Vec3 } from './airPhysics';
import { IN_TO_FT } from './units';

// ---------------------------------------------------------------------------
// Handedness
// ---------------------------------------------------------------------------

/** Which hand a pitcher throws with / a batter stands on. */
export type Handedness = 'R' | 'L';

/**
 * The sign of the REPORT-x axis that points to a pitcher's ARM side.
 *
 * A RHP's arm side is the third-base side, which is the catcher's LEFT, which is
 * −x. This one function is the only place that mirror is written down; every
 * arm-side/glove-side conversion in the game goes through it, because a mirror
 * applied twice (or zero times) is the single most likely way for the pitch
 * table to end up backwards while every magnitude still looks perfect.
 */
export const armSideX = (hand: Handedness): number => (hand === 'R' ? -1 : 1);

// ---------------------------------------------------------------------------
// Field geometry — PUBLISHED DATA (rule book)
// ---------------------------------------------------------------------------

/** Rubber → the plate's rear point, ft. PUBLISHED (Rule 2.01: 60 ft 6 in). */
export const RUBBER_D_FT = 60.5;

/** Plate width, ft. PUBLISHED (Rule 2.02: 17 in across the front edge). */
export const PLATE_WIDTH_FT = 17 * IN_TO_FT;

/**
 * Plate depth, ft. DERIVED from the rule-book plate: a 17 in front edge, two
 * 8.5 in sides and a point, so the rear point sits 8.5 + 8.5 = 17 in back.
 * d = 0 is that REAR point (the physics reference); the front edge is at
 * d = PLATE_DEPTH_FT, which is where a radar plate speed is actually read —
 * the ~1.4 ft that C_D's calibration note calls out as one of its two biases.
 */
export const PLATE_DEPTH_FT = 17 * IN_TO_FT;

// ---------------------------------------------------------------------------
// Release — PUBLISHED DATA (league-average Statcast release point)
// ---------------------------------------------------------------------------

/**
 * Distance from the plate at release, ft. PUBLISHED: 60.5 less ~6.5 ft of
 * extension, which is the modern league average (the 6–6.6 ft band).
 *
 * ⚠ Not the same 55 ft as stage 1's drag calibration and break-convention
 * table, which used the older ~5.5 ft extension figure. Nothing is inconsistent
 * — break is measured over BREAK_SEGMENT_FT of the last part of the flight, not
 * over "the whole flight", precisely so the release point is not silently part
 * of the reported number. The 1 ft difference moves plate speed by ~0.15 mph.
 */
export const RELEASE_D_FT = 54.0;

/** Release height, ft. PUBLISHED (league-average, over-the-top three-quarters). */
export const RELEASE_H_FT = 5.8;

/**
 * Release offset toward the throwing arm, ft. PUBLISHED (league average ~1.9,
 * i.e. Statcast release_pos_x ≈ −1.9 for a RHP). Apply with `armSideX`.
 */
export const RELEASE_SIDE_FT = 1.9;

/** Release point in REPORT coordinates for a pitcher of this hand. */
export function releasePoint(hand: Handedness): { d: number; x: number; h: number } {
  return { d: RELEASE_D_FT, x: armSideX(hand) * RELEASE_SIDE_FT, h: RELEASE_H_FT };
}

// ---------------------------------------------------------------------------
// The strike zone
// ---------------------------------------------------------------------------

/**
 * Zone floor / ceiling, ft. PUBLISHED as a league-average of a per-batter
 * quantity: the rule zone runs from the hollow beneath the knee to the midpoint
 * between shoulders and belt, which for the average hitter is ~1.60 to ~3.40 ft.
 * A future per-batter zone scales THESE, it does not replace them.
 */
export const ZONE_BOTTOM_FT = 1.6;
export const ZONE_TOP_FT = 3.4;

/** The rule zone: what the HUD and the GL scene DRAW. In REPORT coords. */
export const RULE_ZONE = {
  left: -PLATE_WIDTH_FT / 2,
  right: PLATE_WIDTH_FT / 2,
  bottom: ZONE_BOTTOM_FT,
  top: ZONE_TOP_FT,
} as const;

/**
 * The CALLED zone: what the umpire in this game actually judges, which is the
 * rule zone grown by one BALL RADIUS on every side.
 *
 * WHY A RADIUS. A pitch is a strike if ANY PART of the ball passes over ANY PART
 * of the zone, and the trajectory we integrate is the ball's CENTRE. The centre
 * may therefore sit up to one radius (0.1210 ft = 1.452 in) outside an edge with
 * the ball's near surface still touching it. Effective called width is thus
 * 17 in + 2r = 19.90 in = 1.6587 ft, and effective height 1.80 + 2r = 2.042 ft.
 *
 * ⚠ NOT a ball DIAMETER each side. That would give 22.81 in / 1.901 ft, which is
 * a figure that circulates (and which stage 2's own brief quoted as "widened by
 * a ball radius each side → 1.91 ft" — the words say radius, the number says
 * diameter, and only the words are geometrically possible). A diameter's worth
 * of grow would call a strike on a pitch whose nearest surface missed the black
 * by a full ball, which is a 1.4 in wider zone on each side than the rule allows.
 * The words won; the discrepancy is recorded here rather than silently resolved.
 */
export const CALL_ZONE = {
  left: RULE_ZONE.left - BALL_RADIUS_FT,
  right: RULE_ZONE.right + BALL_RADIUS_FT,
  bottom: RULE_ZONE.bottom - BALL_RADIUS_FT,
  top: RULE_ZONE.top + BALL_RADIUS_FT,
} as const;

/** Called width of the zone for the ball's CENTRE, ft. DERIVED. 1.6587. */
export const CALL_ZONE_WIDTH_FT = CALL_ZONE.right - CALL_ZONE.left;

/** Called height of the zone for the ball's CENTRE, ft. DERIVED. 2.0421. */
export const CALL_ZONE_HEIGHT_FT = CALL_ZONE.top - CALL_ZONE.bottom;

/**
 * Ball or strike, from the ball CENTRE's position at the plate crossing.
 * Half-open on no edge: a centre exactly on the called boundary is a strike,
 * because the alternative is a pitch that grazes the line being a ball while
 * its mirror image is a strike.
 */
export function isStrike(x: number, h: number): boolean {
  return x >= CALL_ZONE.left && x <= CALL_ZONE.right && h >= CALL_ZONE.bottom && h <= CALL_ZONE.top;
}

/**
 * How far outside the called zone a pitch was, in feet (0 if a strike). The
 * Chebyshev distance to the called box — the AI uses it to decide whether a
 * pitch was a "close" ball worth chasing, and the HUD tints the reticle by it.
 */
export function missDistance(x: number, h: number): number {
  const dx = Math.max(CALL_ZONE.left - x, 0, x - CALL_ZONE.right);
  const dh = Math.max(CALL_ZONE.bottom - h, 0, h - CALL_ZONE.top);
  return Math.max(dx, dh);
}

// ---------------------------------------------------------------------------
// Reticle ↔ plate
// ---------------------------------------------------------------------------
//
// The HUD's aiming reticle lives in a normalised square, u and v ∈ [−1, 1],
// with +u to the RIGHT ON SCREEN and +v UP ON SCREEN — the batter's view, which
// is the umpire's view, which is REPORT-x and REPORT-h. No mirror anywhere in
// this mapping; the mirror the game does need is `armSideX`, and it lives in
// exactly one place.
//
// u = ±1 / v = ±1 is the RULE zone edge — the box the player can see — not the
// called edge, so a pitch nicking the corner reads as |u| slightly over 1 and is
// still a strike. That is the correct relationship between what is drawn and
// what is called, and it is only correct because both come from this file.
// Values outside [−1, 1] are legal and mean "aiming off the plate", which is
// what a pitcher does on purpose.

/** Reticle (u, v) → plate (x, h), both in ft. */
export function reticleToPlate(u: number, v: number): { x: number; h: number } {
  return {
    x: (u * PLATE_WIDTH_FT) / 2,
    h: (ZONE_BOTTOM_FT + ZONE_TOP_FT) / 2 + (v * (ZONE_TOP_FT - ZONE_BOTTOM_FT)) / 2,
  };
}

/** Plate (x, h) in ft → reticle (u, v). The exact inverse of `reticleToPlate`. */
export function plateToReticle(x: number, h: number): { u: number; v: number } {
  return {
    u: (2 * x) / PLATE_WIDTH_FT,
    v: (2 * h - (ZONE_TOP_FT + ZONE_BOTTOM_FT)) / (ZONE_TOP_FT - ZONE_BOTTOM_FT),
  };
}

/** Dead centre of the zone, in REPORT coords — the default aim. */
export const ZONE_CENTER = {
  x: 0,
  h: (ZONE_BOTTOM_FT + ZONE_TOP_FT) / 2,
} as const;

// ---------------------------------------------------------------------------
// WORLD ↔ REPORT
// ---------------------------------------------------------------------------

/** WORLD position (origin at release, +x toward the plate) → REPORT (d, x, h). */
export function reportFromWorld(p: Vec3): { d: number; x: number; h: number } {
  return { d: RELEASE_D_FT - p.x, x: p.y, h: p.z };
}

/** REPORT (d, x, h) → WORLD position. The exact inverse of `reportFromWorld`. */
export function worldFromReport(d: number, x: number, h: number): Vec3 {
  return vec3(RELEASE_D_FT - d, x, h);
}

/**
 * WORLD x at which a given REPORT distance-from-the-plate is reached. This is
 * the target `crossingFraction` solves against, so it is written once: the plate
 * itself is `worldXAt(0)`, and the break segment starts at
 * `worldXAt(BREAK_SEGMENT_FT)`.
 */
export const worldXAt = (d: number): number => RELEASE_D_FT - d;

/**
 * Spray angle of a ball moving with WORLD velocity `v`, in radians, as seen from
 * the plate: 0 straight up the middle toward centre field, + toward the
 * first-base/right-field side (matching REPORT +x). Batted balls in stage 3 use
 * the same function, which is why it is here and not in battedBallSim.
 */
export const sprayAngle = (v: Vec3): number => Math.atan2(v.y, -v.x);
