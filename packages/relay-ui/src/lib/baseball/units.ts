// Baseball unit system — FEET, SECONDS, SLUGS (US customary, the engineering
// "gravitational" system where force is lbf and mass is slug = lbf·s²/ft).
//
// WHY NOT METRIC, WHY NOT ARCADE UNITS. Every reference number this game is
// calibrated against is published in feet / inches / mph / rpm: the mound is
// 60.5 ft from the plate, the rubber 10 in above it, the strike zone ~17 in
// wide, a four-seamer leaves the hand at 94 mph with 2400 rpm and arrives ~86,
// induced vertical break is quoted in INCHES, and every outfield fence distance
// on every park diagram is in feet. Working natively in ft/s lets those numbers
// drop straight into the code and straight into the tests, with no conversion
// step to get wrong and no "is this the metric or the imperial constant?"
// ambiguity in review. The only conversions we ever do are at the INPUT edge
// (mph → ft/s, in → ft, rpm → rad/s) and they live here.
//
// ⚠ GRAVITY IS REAL HERE. `lib/golf/rangeSim.ts` uses an arcade `GRAVITY = 16`
// in an abstract yard-space, and models spin as a bounded constant acceleration.
// Do NOT copy either idea into baseball. Induced break — the single most
// important number in the pitching game — is DEFINED as the difference between
// the real trajectory and a gravity-only trajectory of the same release. A
// fudged g therefore does not just scale the drop, it corrupts the definition of
// break, and with it C_L's calibration, the pitch table, the strike zone
// crossing point and the batted-ball carry. g is 32.174 ft/s², full stop; if a
// pitch feels wrong the fix is in the aero coefficients or in an explicitly
// labelled feel knob, never in g.

/** Miles per hour → feet per second. Exact: 5280 ft/mi ÷ 3600 s/h. */
export const MPH_TO_FPS = 1.466667;

/** Feet per second → miles per hour (the inverse; published speeds are mph). */
export const FPS_TO_MPH = 1 / MPH_TO_FPS;

/** Inches → feet. Zone width, seam height, break figures all arrive in inches. */
export const IN_TO_FT = 1 / 12;

/** Feet → inches. Induced break is REPORTED in inches, so tables convert back. */
export const FT_TO_IN = 12;

/** Revolutions per minute → radians per second. 2π rad/rev ÷ 60 s/min. */
export const RPM_TO_RADS = Math.PI / 30;

/** Radians per second → rpm (Statcast publishes spin rate in rpm). */
export const RADS_TO_RPM = 30 / Math.PI;

/**
 * Standard gravity in ft/s². FIXED — a published constant, never a feel knob.
 * See the header: break is defined against a gravity-only trajectory.
 */
export const G_FPS2 = 32.174;

/** Ounces → pounds-force (ball weight is specified in ounces). */
export const OZ_TO_LBF = 1 / 16;

/**
 * Pounds-FORCE (weight) → slugs of MASS: m = W / g. The slug is the mass that
 * accelerates at 1 ft/s² under 1 lbf, so this division is the whole definition.
 */
export function lbfToSlug(weightLbf: number): number {
  return weightLbf / G_FPS2;
}
