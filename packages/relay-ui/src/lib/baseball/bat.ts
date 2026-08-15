// The BAT: its published specification, and everything derived from it.
//
// Split out of `batSim.ts` for the same reason `pitches.ts` is split out of
// `pitchSim.ts` — this file is DATA plus the derivations that close over it,
// with no dynamics in it at all, and it hit the 500-line module cap as one file.
// The collision solve that consumes all of this lives in `batSim.ts`. Nothing
// here imports a trajectory, and nothing here is a dial: every constant states
// its category, and every quantity that can be derived is a function.
//
// No three, no Math.random, no clock, no state.

import { BALL_MASS_SLUG, BALL_RADIUS_FT } from './airPhysics';
import { FT_TO_IN, MPH_TO_FPS } from './units';

// ---------------------------------------------------------------------------
// The ONE SI bridge
// ---------------------------------------------------------------------------
//
// The game is ft/s/slug (units.ts) and stays that way. The bat, however, is
// published in SI — a swing-weight lab reports mass in kg, the balance point in
// metres from the knob and the moment of inertia in kg·m² — so those three
// numbers are kept in the units they were measured in rather than silently
// re-expressed. They meet the rest of the game in exactly two places, both
// dimensionless or converted here and nowhere else:
//
//   • the mass RATIO q = m_ball / M_eff, which is dimensionless and therefore
//     identical in either system;
//   • the contact point z, converted ft ↔ m for the swing geometry.

/** Kilograms per slug. FIXED (1 slug = 32.174049 lbm × 0.45359237 kg/lbm). */
export const KG_PER_SLUG = 14.5939029372;

/** Metres per foot. FIXED (the international foot, exactly 0.3048 m). */
export const M_PER_FT = 0.3048;

/**
 * Ball mass in kg. DERIVED from airPhysics's `BALL_MASS_SLUG`, which is itself
 * derived from the 5.125 oz rule-band midpoint — NOT hand-set to the round
 * "145 g" that bat-collision papers quote. The difference is real but tiny:
 * 145.29 g vs 145.0 g moves the sweet-spot `eA` from 0.2007 to 0.2002, i.e.
 * 0.05 mph of exit velocity. Deriving it keeps one ball spec in the game.
 */
export const BALL_MASS_KG = BALL_MASS_SLUG * KG_PER_SLUG;

// ---------------------------------------------------------------------------
// The bat — FIXED, published wood-bat specification
// ---------------------------------------------------------------------------

/** Bat length, in. FIXED (a 33 in / 31 oz wood bat, the league-modal size). */
export const BAT_LENGTH_IN = 33;

/** Bat mass, kg. FIXED (31 oz = 0.879 kg). */
export const BAT_MASS_KG = 0.879;

/** Balance point, m from the KNOB. FIXED (measured swing-weight data). */
export const BAT_CM_M = 0.56;

/** Moment of inertia about the balance point, kg·m². FIXED (measured). */
export const BAT_ICM_KGM2 = 0.044;

/** Barrel radius, in. FIXED (2.5 in diameter, the rule-book maximum). */
export const BAT_RADIUS_IN = 1.25;

/**
 * The sweet spot, m from the knob. FIXED — 0.72 m (28.3 in) is where the
 * published `M_eff` = 0.5816 kg / `eA` = 0.20 pair is quoted, so it is the
 * reference point every collision number in this file is stated at.
 */
export const SWEET_SPOT_M = 0.72;

/**
 * Bat-ball coefficient of restitution. FIXED — 0.50 is the BBCOR ceiling and the
 * measured wood-bat value at the sweet spot. Note this is the BALL-ON-BAT pair
 * COR, not the ball's own COR against a wall (~0.55 at these speeds).
 */
export const BAT_BALL_COR = 0.5;

/**
 * Distance between the ball's centre and the bat's centre LINE at contact, in.
 * DERIVED: r_ball + R_bat = 1.4523 + 1.25 = 2.7023 in. This is the length of the
 * line of centres, and therefore the denominator that turns an undercut in
 * inches into an angle: a vertical miss of E_v gives θ_LOC = asin(E_v / 2.7023).
 * Never hand-set — it moves if either radius moves.
 */
export const LOC_DISTANCE_IN = BALL_RADIUS_FT * FT_TO_IN + BAT_RADIUS_IN;

// ---------------------------------------------------------------------------
// Effective mass, mass ratio, collision efficiency — ALL DERIVED
// ---------------------------------------------------------------------------

/**
 * Effective mass of the bat at a contact point `zM` metres from the knob, kg.
 * DERIVED from the rigid-body impulse response of a free bat struck off its
 * centre of mass — the struck point recoils both linearly and rotationally:
 *
 *     1/M_eff(z) = 1/M + (z − z_cm)² / I_cm
 *
 * At the sweet spot: 1/0.879 + 0.16²/0.044 = 1.1377 + 0.5818 = 1.7195, so
 * M_eff = 0.5816 kg — the published figure, reproduced rather than asserted.
 *
 * ⚠ It is MAXIMAL at z = z_cm (0.56 m) and falls off both ways, which is the
 * source of one of this file's two honest findings — see `collisionEfficiency`.
 */
export function effectiveMassKg(zM: number): number {
  const d = zM - BAT_CM_M;
  return 1 / (1 / BAT_MASS_KG + (d * d) / BAT_ICM_KGM2);
}

/** q = m_ball / M_eff(z). DERIVED, dimensionless. 0.2498 at the sweet spot. */
export function massRatio(zM: number): number {
  return BALL_MASS_KG / effectiveMassKg(zM);
}

/**
 * Collision efficiency eA(z) — the "bat performance factor". DERIVED:
 *
 *     eA = (e − q) / (1 + q)
 *
 * At the sweet spot q = 0.2498 and eA = 0.2002, which is the published 0.20.
 * ⚠ It is DERIVED and exported as a FUNCTION precisely so that nobody can write
 * the literal 0.20 anywhere: the whole point is that the derivation closes, so
 * `e`, the bat's inertia and the ball's mass all reach exit velocity through
 * this one channel and a change to any of them propagates.
 *
 * ⚠ HONEST LIMITATION, and it is not small. This is a RIGID-body model: the bat
 * cannot vibrate, so no energy is lost to bending modes. On a real bat the
 * sweet spot is sweet BECAUSE it sits on the fundamental bending node, and `e`
 * itself collapses away from it. Here `e` is constant, so `eA` simply keeps
 * rising toward the balance point, and the model's exit-velocity optimum lands
 * ~3 in toward the HANDLE of the real sweet spot (106.95 mph against 103.83 for
 * a 90 mph pitch). Toward the barrel tip the model is right for the right
 * reason — `M_eff` collapses — and 4 in out costs 11.25 mph. Toward the handle
 * it is wrong, and gains 2.6 mph where a real bat would lose. `batSim.test.ts`
 * pins BOTH numbers so the gap stays visible; closing it needs a measured
 * e(z) profile, which is a calibration this stage does not have data for.
 */
export function collisionEfficiency(zM: number): number {
  const q = massRatio(zM);
  return (BAT_BALL_COR - q) / (1 + q);
}

// ---------------------------------------------------------------------------
// The swing — ONE rotation model
// ---------------------------------------------------------------------------

/**
 * Bat angular speed at contact, rad/s. FIXED (published swing tracking, ~32
 * rad/s ≈ 306 rpm for a competitive adult swing). ⚠ This is THE swing model:
 * spray angle, contact point and the exit-velocity penalty for mistiming are all
 * consequences of this one number. There is deliberately no second timing knob.
 */
export const BAT_OMEGA_RADS = 32;

/**
 * League-average bat speed at the sweet spot, mph. FIXED (2024 Statcast bat
 * tracking: 71.5 mph average; hard swingers reach ~77).
 */
export const BAT_SPEED_MPH = 71.5;

/**
 * Distance from the swing's instantaneous rotation axis to the sweet spot, ft.
 * DERIVED: v = ωR ⇒ R = 71.5 mph / 32 rad/s = 3.2771 ft. That puts the axis
 * 0.915 ft behind the knob (the sweet spot is 2.362 ft from it), which is a
 * sane hands-plus-lead-arm radius — a useful check that the two published
 * numbers are mutually consistent rather than a coincidence we imposed.
 */
export const SWING_AXIS_FT = (BAT_SPEED_MPH * MPH_TO_FPS) / BAT_OMEGA_RADS;

/**
 * Attack angle, degrees (+ = swinging up). FIXED (MLB average +10°). The swing
 * plane is tilted by this, so a level bat with zero undercut still launches the
 * ball at roughly +10°.
 */
export const ATTACK_ANGLE_DEG = 10;

/**
 * Tangential coefficient of restitution: the contact patch's tangential
 * relative velocity leaves as `−e_T ×` its incoming value.
 *
 * ⚠ CALIBRATED, AND THE VALUE IS NEGATIVE. −0.20 is calibrated against the one
 * published tangential observable — batted-ball backspin, 1900–2500 rpm on a
 * reference 0.75 in undercut. A negative e_T is not a sign error and not a
 * fudge: it says the contact point never reverses at all, and is still sliding
 * FORWARD at 20 % of its initial rate when the ball leaves. Writing the impulse
 * as J_t = −(1 + e_T)·(2m/7)·s makes the reading plain — (1 + e_T) = 0.80 is a
 * GRIP FRACTION, where 1.0 is exactly the rolling condition (the patch stops
 * sliding) and >1 is tangential rebound. The collision reaches 80 % of rolling.
 *
 * The textbook rigid-surface value e_T = +0.20 gives **4430 rpm** on that same
 * swing — 1.8× the published band — and neither Coulomb friction (the solve
 * needs only J_t/J_n = 0.12, far inside μ ≈ 0.5) nor the bat's own tangential
 * recoil (worth 6.6 %) closes the gap. See the ⚠ note on `swingContact` for the
 * consequence, which is a genuine finding and not a tuning problem.
 */
export const E_T = -0.2;
/**
 * Exit velocity from the published closed form, for the head-on case only:
 *
 *     EV = eA·v_pitch + (1 + eA)·v_bat
 *
 * ⚠ NOT used by `swingContact` — that solves the full oblique collision, of
 * which this is the zero-obliquity limit. It is exported because it is the
 * identity the whole model is checked against (`batSim.test.ts` asserts the two
 * agree to < 0.01 mph at zero undercut with a level swing and a level pitch),
 * and because the HUD wants a cheap "what would a perfect swing do" number
 * without running a collision.
 */
export function exitVelocityMph(pitchMph: number, batMph: number, zM: number = SWEET_SPOT_M): number {
  const eA = collisionEfficiency(zM);
  return eA * pitchMph + (1 + eA) * batMph;
}

/**
 * Line-of-centres angle for a vertical miss, radians. `asin(E_v / (r + R))` —
 * pure geometry, the only place an undercut becomes an angle.
 */
export function locAngleRad(offsetIn: number): number {
  return Math.asin(Math.max(-1, Math.min(1, offsetIn / LOC_DISTANCE_IN)));
}
