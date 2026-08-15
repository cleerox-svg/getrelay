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
 * M_eff = 0.5816 kg, matching the figure the bat-collision literature quotes for
 * this spec. ⚠ That is ARITHMETIC ON FOUR FIXED INPUTS, not corroboration:
 * M_eff, q and eA are one formula applied to the published mass, balance point,
 * inertia and COR, so reproducing them checks the transcription, not the model.
 * The only genuinely external content in the chain is `|eA − 0.20| < 0.01`,
 * which compares the RESULT against a separately-published performance factor.
 * `batSim.test.ts` asserts all four, but only the last one can surprise us.
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
 * reason — `M_eff` collapses — and 4 in out costs 11.53 mph. Toward the handle
 * it is wrong, and gains 2.71 mph where a real bat would lose. `batSim.test.ts`
 * pins BOTH numbers so the gap stays visible; closing it needs a measured
 * e(z) profile, which is a calibration this stage does not have data for.
 *
 * ⚠ AND IT HAS A SECOND, LARGER CONSEQUENCE, added in stage 3b: the model has no
 * JAMMING. An inside pitch is a smaller aim radius, i.e. contact nearer the
 * hands, so the same rising `eA` REWARDS it — exit velocity peaks 3 in inside
 * the sweet spot (+3.0 mph) and does not fall back below the sweet-spot value
 * until ~6 in inside. Stage 3 cited the aim radius as the place jamming lives;
 * it is not, and `batSim.ts`'s `contactGeometry` note carries the retraction.
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
 * ⚠ DERIVED — from the Coulomb stick condition, NOT calibrated. This is a
 * category change, and stage 3b made it after retracting a finding; the whole
 * story is in `batSim.swingContact`'s ⚠ note and in BASEBALL.md § "The
 * collision". In short:
 *
 *   The solve needs a tangential impulse of only J_t/J_n = 0.084 to bring the
 *   contact patch to ROLLING (0.103 at the 0.75 in undercut stage 3 swept at).
 *   Leather on wood is μ ≈ 0.4–0.6, so the friction
 *   available is ~5–7× what is required: the contact is deep inside the STICK
 *   regime, the patch must reach rolling, and the grip fraction (1 + e_T) is
 *   forced to exactly 1.0. That is e_T = 0. Nothing in a rigid-body impulse
 *   solve can remove tangential impulse while friction is in surplus, so a
 *   NEGATIVE e_T — the −0.20 stage 3 shipped, which claimed the patch was
 *   "still sliding forward at 20 %" — has no mechanism behind it. The admissible
 *   range is e_T ∈ [0, +0.2]: 0 is Coulomb stick, positive values are tangential
 *   COMPLIANCE (the bat's surface and the ball's cover storing and returning
 *   tangential strain), which is what the textbook bat-ball e_T ≈ +0.2 measures.
 *
 * ⚠ AND IT MEETS BOTH PUBLISHED TARGETS, which stage 3 wrongly reported as
 * impossible. Stage 3 varied e_T at a FIXED 0.75 in undercut — but the undercut
 * is a free SWING parameter, not published data, so that sweep answered the
 * wrong question. Over the 2-D (e_T, undercut) region the bands are NOT
 * disjoint: e_T ∈ [−0.16, +0.02] can hit "LA 25–29°" and "backspin
 * 1900–2500 rpm" simultaneously, and intersecting that with the admissible
 * [0, +0.2] leaves [0, +0.02]. e_T = 0 is in it, and it is the physically
 * principled end. At 0.56 in of undercut the reference swing gives LA 25.3°,
 * backspin 2391 rpm, EV 101.6 mph — both bands, at once, with no dial turned.
 * `batSim.test.ts` prints the whole 2-D region.
 *
 * ⚠ AND THE PRICE OF THE TIEBREAK, STATED WHERE THE CLAIM IS, because "DERIVED,
 * zero free parameters" is only true of the collision solve and not of the
 * swing that feeds it. Two qualifications, both of which BASEBALL.md's category
 * table already carries and this note did not:
 *
 *   • It is derived WITHIN A STATED MODEL — rigid bodies, Coulomb friction, no
 *     tangential compliance. The published bat-ball `e_T ≈ +0.2` measures
 *     exactly the compliance this model omits, and the feasible window above
 *     ([0, +0.02]) EXCLUDES it. So the derivation closes against its own
 *     assumptions; it does not overturn the published figure.
 *   • The free parameter did not vanish, it MIGRATED. Fixing `e_T` at 0 forced
 *     the reference undercut from 0.75 in to 0.56 (joint window 0.552–0.582 in,
 *     0.03 in wide), and that undercut is CALIBRATED — chosen so the two
 *     published bands are met. One dial replaced another; the trade is that the
 *     new one is a swing input with an admitted range rather than a coefficient
 *     with no mechanism.
 */
export const E_T = 0;
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
