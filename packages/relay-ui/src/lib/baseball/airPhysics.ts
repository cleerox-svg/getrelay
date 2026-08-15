// THE aerodynamic core for every baseball trajectory in the game — pitch AND
// batted ball. Pure math: no sim state, no three, no Math.random, no clock.
//
// This module exists so there is exactly ONE integrator and ONE set of aero
// coefficients in the codebase. `pitchSim` and `battedBallSim` both call
// `aeroAccel`/`stepBall` from here. A second copy of these equations — even a
// "simplified one just for the batted ball" — is the failure mode this file is
// designed to prevent: the moment they diverge, the fence you clear on screen
// stops matching the fence the physics cleared.
//
// Coordinate frame (feet, right-handed, Z UP):
//   +x — from the mound toward home plate (the pitch's travel direction)
//   +y — toward FIRST base / the catcher's right (a RHP's arm side is −y)
//   +z — up. Gravity is (0, 0, −g).
// The frame is declared here and nothing may redefine it; `zone.ts` and the GL
// scene consume this same convention.
//
// ⚠ STAGE-2 CORRECTION, comment only — no code, no constant and no test result
// moved. Stage 1 labelled +y "toward third base / the catcher's left", which
// cannot be true of a right-handed frame with +x mound→plate and +z up:
// ŷ = ẑ × x̂, and with home at the bottom of a bird's-eye diagram (first base
// right, centre field up, ẑ out of the page) that is the FIRST-base side. The
// stage-1 line was also self-contradictory, since it then said "a RHP's arm
// side is −y" — and a RHP's arm side IS the third-base side, so the
// parenthetical was right and the label was wrong. Corrected in that direction:
// the gameplay-load-bearing claim (arm side = −y) stands, unchanged. This
// matters to stage 2 because zone.ts maps y onto the Statcast lateral axis
// (+ = catcher's right), and an inverted label would mirror every pitch's
// horizontal break against its published sign.
//
// The frame is LOAD-BEARING for the Magnus SIGN, so pin it with the two cases
// the whole pitching game rests on (both asserted in airPhysics.test.ts):
//   • backspin — ω along −y on a ball travelling +x ⇒ ω̂ × v = (−ŷ) × x̂ = +ẑ,
//     i.e. UPWARD lift. A four-seamer resists gravity; it does not sink.
//   • sidespin — ω along +z ⇒ ẑ × x̂ = +ŷ, a push toward FIRST base (see the
//     stage-2 correction below).
// Swapping the cross-product operands inverts both and turns every fastball
// into a sinker, which is why the sign is asserted and not merely commented.
//
// Units: ft, s, slug (see units.ts). g is REAL — 32.174 ft/s².

import {
  AIR_KINEMATIC_VISC_FT2_S,
  C_D_BASE,
  C_D_SUBCRIT,
  FIXED_DT,
  FIXED_MS,
  RE_CRISIS_HI,
  RE_CRISIS_LO,
} from './tuning';
import { G_FPS2, IN_TO_FT, lbfToSlug, OZ_TO_LBF } from './units';

// ---------------------------------------------------------------------------
// Vectors
// ---------------------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const vAdd = (a: Vec3, b: Vec3): Vec3 => vec3(a.x + b.x, a.y + b.y, a.z + b.z);
export const vSub = (a: Vec3, b: Vec3): Vec3 => vec3(a.x - b.x, a.y - b.y, a.z - b.z);
export const vScale = (a: Vec3, s: number): Vec3 => vec3(a.x * s, a.y * s, a.z * s);
export const vDot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const vLen = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const vCross = (a: Vec3, b: Vec3): Vec3 =>
  vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);

// ---------------------------------------------------------------------------
// The ball — FIXED, published MLB specification (Rule 3.01)
// ---------------------------------------------------------------------------
//
// Weight 5 to 5.25 oz, circumference 9 to 9.25 in. We take the midpoint of each
// band, which is what every published aero study uses.

/** Ball weight, oz. FIXED (midpoint of the 5–5.25 oz rule band). */
export const BALL_WEIGHT_OZ = 5.125;

/**
 * Ball MASS in slugs. DERIVED: m = W/g = (5.125/16 lbf) / 32.174 ft/s²
 *                                     = 0.3203125 / 32.174 = 0.0099556 slug.
 * (Commonly quoted as ~0.00995 slug / 145.3 g.) Never hand-set — it moves if
 * the weight spec or g ever moves, and both are published.
 */
export const BALL_MASS_SLUG = lbfToSlug(BALL_WEIGHT_OZ * OZ_TO_LBF);

/** Ball circumference, in. FIXED (midpoint of the 9–9.25 in rule band). */
export const BALL_CIRCUM_IN = 9.125;

/**
 * Ball RADIUS in feet. DERIVED: r = C/(2π) = 9.125/(2π) in = 1.452285 in
 *                                          = 0.1210237 ft.
 * This is the r in the spin parameter S = r·ω/|v|, so it is load-bearing for
 * every break number, not just for the render.
 */
export const BALL_RADIUS_FT = (BALL_CIRCUM_IN / (2 * Math.PI)) * IN_TO_FT;

/**
 * Ball cross-sectional AREA in ft². DERIVED: A = π r² = 0.0460144 ft².
 */
export const BALL_AREA_FT2 = Math.PI * BALL_RADIUS_FT * BALL_RADIUS_FT;

// ---------------------------------------------------------------------------
// Air density
// ---------------------------------------------------------------------------
//
// FIXED constants of the US Standard Atmosphere / ideal gas law:

/** Sea-level standard pressure, lbf/ft². FIXED (1013.25 hPa). */
export const P0_LBF_FT2 = 2116.22;

/** Specific gas constant of DRY air, ft·lbf/(slug·°R). FIXED. */
export const R_DRY = 1716.49;

/**
 * Specific gas constant of WATER VAPOUR, ft·lbf/(slug·°R). DERIVED from R_DRY
 * and the molar-mass ratio M_v/M_d = 18.015/28.964 = 0.62197:
 *   R_v = R_dry / 0.62197 = 2759.8.
 * Vapour is LIGHTER than air, so humid air is LESS dense — the ball carries
 * further on a muggy night, which is the whole reason this term is here.
 */
export const R_VAPOR = R_DRY / 0.62197;

/**
 * ISA sea-level density, slug/ft³. DERIVED: ρ = p0/(R_dry·T0) with T0 = 518.67
 * °R (59 °F) → 2116.22/(1716.49·518.67) = 0.0023769. This is the textbook
 * "0.002378" figure, and it is quoted at 59 °F DRY — NOT at 70 °F/50 % RH,
 * which is meaningfully thinner (see airDensity's tests).
 */
export const RHO_ISA_SEA_LEVEL = P0_LBF_FT2 / (R_DRY * 518.67);

/**
 * Saturation vapour pressure of water at `tempF`, in lbf/ft². Tetens/Magnus
 * formula (published meteorological fit), evaluated in °C then converted:
 *   e_s(kPa) = 0.61078 · exp(17.27·T / (T + 237.3)),  T in °C
 *   1 kPa = 20.8854 lbf/ft².
 */
export function satVaporPressure(tempF: number): number {
  const tc = (tempF - 32) * (5 / 9);
  const kPa = 0.61078 * Math.exp((17.27 * tc) / (tc + 237.3));
  return kPa * 20.8854;
}

/**
 * Air density ρ in slug/ft³ at a park's elevation, temperature and humidity.
 *
 * Pressure follows the US Standard Atmosphere troposphere barometric formula
 *   p(h) = p0 · (1 − 6.87535e-6 · h_ft)^5.2559
 * (exponent g·M/(R·L) for the standard 0.0035662 °R/ft lapse rate), then the
 * ideal gas law is applied with the LOCAL temperature and a partial-pressure
 * split for humidity:
 *   ρ = (p − p_v)/(R_dry·T) + p_v/(R_v·T)
 * Both terms share T, so raising the temperature or the humidity thins the air
 * and lengthens every fly ball — a mile-high park and a July night are the same
 * lever pulled by different amounts.
 *
 * @param elevFt elevation above sea level, ft
 * @param tempF  ambient temperature, °F
 * @param rh     relative humidity, 0..1
 */
export function airDensity(elevFt: number, tempF: number, rh: number): number {
  const tR = tempF + 459.67;
  if (tR <= 0) return 0;
  const base = Math.max(0, 1 - 6.87535e-6 * elevFt);
  const p = P0_LBF_FT2 * Math.pow(base, 5.2559);
  const pv = Math.min(p, Math.min(1, Math.max(0, rh)) * satVaporPressure(tempF));
  return (p - pv) / (R_DRY * tR) + pv / (R_VAPOR * tR);
}

// ---------------------------------------------------------------------------
// K — the single derived aero scale
// ---------------------------------------------------------------------------
//
// Both aero forces have the form F = ½·ρ·C·A·|v|·v. Dividing by m to get an
// acceleration puts the SAME group in front of both:
//
//     a = F/m = (ρ·A / 2m) · C · |v| · v   ⇒   K ≡ ρ·A / (2m)   [ft⁻¹]
//
// At ISA sea level: K = 0.0023770 · 0.0460144 / (2 · 0.0099556) = 0.0054932 ft⁻¹
// (and the round textbook ρ = 0.002378 gives 0.0054947, the "0.005498" figure).
//
// ⚠ K IS DERIVED. Never hand-set it, never "adjust K a bit for feel" — it is
// the only channel through which a park's altitude and a night's weather reach
// the ball, so an edited K silently makes Denver behave like sea level. If a
// trajectory is wrong, the honest dials are C_D and C_L (calibrated) or a
// labelled feel knob.

/** K = ρA/2m, ft⁻¹. DERIVED from ρ; the one place air ever enters the physics. */
export function aeroScale(rho: number): number {
  return (rho * BALL_AREA_FT2) / (2 * BALL_MASS_SLUG);
}

// ---------------------------------------------------------------------------
// Aero coefficients
// ---------------------------------------------------------------------------

/**
 * Spin parameter S = r·ω_eff/|v| — the dimensionless ratio of the ball's
 * SURFACE speed to its travel speed, and the only variable C_L depends on.
 * `spinRadS` must already be the EFFECTIVE (velocity-perpendicular) spin;
 * `aeroAccel` projects the gyro component out before calling this.
 */
export function spinParameter(speedFps: number, spinRadS: number): number {
  if (speedFps <= 1e-6) return 0;
  return (BALL_RADIUS_FT * Math.abs(spinRadS)) / speedFps;
}

/**
 * Ceiling on C_L. FEEL KNOB (a safety clamp), explicitly NOT part of the
 * published fit below — the fit is linear and unbounded, real balls are not.
 * It bites at S = (0.35 − 0.09)/0.6 = 0.4333.
 *
 * ⚠ CORRECTED IN STAGE 3b. Stage 1 wrote "it never binds anywhere" — true of the
 * PITCH table (a four-seamer's S is 0.221 at release and rises only a little as
 * it decays) and false of the BATTED BALL, which stage 3 then created and stage
 * 3's drag repair sharpened. A fly ball's S CLIMBS through the flight because
 * spin is constant while |v| decays to ~45 mph, so a well-struck ball crosses
 * 0.4333 on the way down and finishes clamped. Measured, at the shipped
 * coefficients:
 *
 *   • the max-carry ladder at 2200 rpm runs clamped for up to 33 % of the
 *     flight (90 mph rung) — but the clamp is worth ≤ 0.65 ft of carry at every
 *     rung, because it only ever binds in the slow tail where the aero forces
 *     are small. The ladder is NOT measuring this knob.
 *   • the reference swing (0.56 in undercut, 2391 rpm) is clamped 42 % of its
 *     flight for 1.4 ft of its 414 ft. Same story.
 *   • the 1000 → 2500 rpm backspin sensitivity IS partly this knob: 24.2 ft
 *     clamped against 27.5 ft unclamped, i.e. 12 % of the number, because its
 *     2500 rpm endpoint is clamped 56 % of the flight. That test says so.
 *   • the undercut sweep above ~0.9 in is clamped 90–100 % of the flight at
 *     S up to 3.4. Those rows ARE the clamp — which is the clamp doing its
 *     labelled job, since 4000–7000 rpm off a bat is exactly the absurd input
 *     it exists for, and the published `C_L` fit has no business being
 *     extrapolated to S = 3.
 *
 * It was left at 0.35 rather than raised, on the strength of those numbers: the
 * carry results it backs move by ≤ 1.4 ft, so raising it would buy nothing real
 * while changing every golden. Where it IS load-bearing the affected assertion
 * says so. `battedBallSim.test.ts` prints the clamped fraction and the clamp's
 * cost so this stays measured rather than asserted.
 */
export const C_L_MAX = 0.35;

/**
 * Lift (Magnus) coefficient C_L(S).
 *
 * ⚠ PUBLISHED DATA — NOT calibrated, and nothing in this repo calibrates it.
 *   S ≤ 0.1 : C_L = 1.5·S          (through the origin: no spin, no Magnus)
 *   S > 0.1 : C_L = 0.09 + 0.6·S   (continuous at S = 0.1, both give 0.15)
 * This is Alan Nathan's published baseball-aerodynamics lift fit — the standard
 * piecewise form used throughout the baseball trajectory literature, steeper
 * through the low-S region and flattening as the boundary layer saturates.
 * (Exact reference unverified — confirm the journal/volume/page before
 * publication. A general attribution is honest; an invented citation is not.)
 *
 * Because it is published, the honest way to change it is to find a BETTER
 * published fit — not to nudge the slope until one pitch looks right. Stage 2
 * checks all eight pitch-table rows against THIS fit; if the table cannot be
 * reached, the error is in the table's spin/tilt data, in the break-reporting
 * convention (see BASEBALL.md § induced break), or in C_D — never here.
 * `airPhysics.test.ts` anchors the fit at fixed S values so any edit to either
 * branch fails immediately.
 *
 * Monotonically non-decreasing by construction, which the test asserts — a
 * non-monotone C_L would make a HIGHER-spin pitch break LESS and is always a
 * bug.
 */
export function liftCoef(S: number): number {
  const s = Math.max(0, S);
  const cl = s <= 0.1 ? 1.5 * s : 0.09 + 0.6 * s;
  return Math.min(C_L_MAX, cl);
}

/**
 * Reynolds number of a ball moving at `speedFps`, using the ball's diameter and
 * a FIXED sea-level kinematic viscosity. DERIVED: Re = |v|·D/ν.
 *
 * ⚠ ν is held fixed, so the drag crisis below sits at the same SPEED in every
 * park. That is a modelling choice with a measured price (~28 ft of mile-high
 * carry at 105 mph) — see `AIR_KINEMATIC_VISC_FT2_S` in tuning.ts, where the
 * number and the reason are both written down.
 */
// The four drag numbers live in tuning.ts (category + basis per number) and are
// re-exported here so stage-1 consumers import them from the integrator, exactly
// as FIXED_MS/FIXED_DT are.
export { C_D_BASE, C_D_SUBCRIT, RE_CRISIS_LO, RE_CRISIS_HI };

export function reynolds(speedFps: number): number {
  return (Math.abs(speedFps) * 2 * BALL_RADIUS_FT) / AIR_KINEMATIC_VISC_FT2_S;
}

/**
 * Drag coefficient C_D(Re) — the drag crisis, smoothed across a Reynolds band.
 *
 *     Re ≤ RE_CRISIS_LO  →  C_D_SUBCRIT  (0.500, ~below 49 mph)
 *     Re ≥ RE_CRISIS_HI  →  C_D_BASE     (0.300, ~above 88 mph)
 *     between            →  quintic smootherstep between them
 *
 * ⚠ EVERY ONE OF THOSE FOUR NUMBERS HAS ITS CATEGORY AND ITS BASIS WRITTEN OUT
 * IN `tuning.ts` — published (0.500), calibrated-and-unmoved (0.300),
 * calibrated-with-a-published-prior (the band) — together with what the
 * smoothstep SHAPE is (an assumed interpolation, not a fit to measured C_D(Re)
 * data) and what it is measured to be worth. Read that note before touching any
 * of them; do not re-derive it here.
 *
 * C_D_BASE = 0.300 IS STAGE 1'S CALIBRATION AND IT DID NOT MOVE. The conditions
 * are part of the number: a four-seamer released at 94.0 mph, spinless, over
 * 55 ft of ISA air (59 °F, DRY, ρ = 0.0023770, K = 0.00549317 ft⁻¹), crossing
 * the plate at ~86.3 mph, where 86.3 is the VECTOR MAGNITUDE |v| — which is what
 * a radar plate speed reports, and the whole reason the number is 0.300 and not
 * the 0.2829 the gravity-free closed form v_x = v0·exp(−K·C_D·x) inverts to.
 * That closed form is accurate to 0.2 % about v_x; it just answers a different
 * question. `airPhysics.test.ts` re-measures the plate speed every run against
 * 86.3 ±0.4, which pins the supercritical branch to about ±0.016.
 *
 * ⚠ THE CRISIS CURVE REPRODUCES IT: 86.287 mph against the old constant's
 * 86.288 (86.283 was the cubic smoothstep's figure, stale since the shape became
 * a quintic). That is not luck — a 94 mph pitch is at Re = 2.3e5 at release and
 * 1.94e5 at the plate, so it only ever grazes the top of the band, where the
 * smoothstep is flat. The SLOWER pitches DO sample the band and DO get more
 * drag (a 79 mph curveball loses 1.1 mph more by the plate), which moves their
 * break — reported in pitchSim.test.ts, not absorbed.
 *
 * HONEST RESIDUAL SLOP on the supercritical branch (~±0.2 mph, ~±2 % of C_D
 * each, and they partly cancel): the game plays at 70 °F/50 % RH, thinner than
 * the ISA air this is calibrated in (86.48 mph with the same C_D, biasing HIGH);
 * and 55 ft measures to the plate's REAR point while a published plate speed is
 * read ~1.4 ft nearer the front (biasing LOW). "Inside the convention slop of
 * the published number" is the claim; "dead on it" is not.
 *
 * `S` stays in the signature and is deliberately unread — see tuning.ts for why
 * a spin-dependent C_D is ruled out as a standalone repair.
 */
export function dragCoef(speedFps: number, S: number): number {
  void S;
  const re = reynolds(speedFps);
  if (re <= RE_CRISIS_LO) return C_D_SUBCRIT;
  if (re >= RE_CRISIS_HI) return C_D_BASE;
  const u = (re - RE_CRISIS_LO) / (RE_CRISIS_HI - RE_CRISIS_LO);
  // Quintic smootherstep, u³(6u² − 15u + 10). The quintic rather than the cubic
  // for a MEASURED reason, not an aesthetic one — see tuning.ts.
  return C_D_SUBCRIT + (C_D_BASE - C_D_SUBCRIT) * u * u * u * (u * (6 * u - 15) + 10);
}

// ---------------------------------------------------------------------------
// The acceleration
// ---------------------------------------------------------------------------

/**
 * TOTAL acceleration on a ball moving at `v` (ft/s) spinning at `omega`
 * (rad/s, a real 3-vector along the spin axis by the right-hand rule), for a
 * park/weather aero scale `K`:
 *
 *     a = (0,0,−g) − K·C_D·|v|·v + K·C_L·|v|·(ω̂_eff × v)
 *
 * ⚠ GYRO PROJECTION. `ω_eff` is the component of ω PERPENDICULAR to v:
 *     ω_eff = ω − (ω·v̂)·v̂
 * The velocity-PARALLEL component (gyro spin, the rifle-bullet spiral) produces
 * ZERO Magnus force — ω̂ × v vanishes when ω̂ ∥ v — and it must be projected out
 * every single call, not once at release, because v rotates through the flight
 * and a spin axis that starts perpendicular does not stay perpendicular.
 *
 * This projection IS the difference between pitch types. A slider and a
 * four-seamer can both be thrown at 2400 rpm; the slider's axis points near its
 * direction of travel, so most of that spin is gyro and does nothing, and only
 * the small perpendicular remainder sweeps it. Without the projection the
 * slider would break as hard as the fastball rises, every pitch would collapse
 * toward the same shape, and the entire pitch table would be unreachable.
 * Note that S is computed from |ω_eff| too, so gyro spin correctly stops
 * inflating C_L as well as the cross product.
 */
export function aeroAccel(v: Vec3, omega: Vec3, K: number): Vec3 {
  const speed = vLen(v);
  const a = vec3(0, 0, -G_FPS2);
  if (speed <= 1e-9) return a;

  const vHat = vScale(v, 1 / speed);

  // Gyro projection: strip the velocity-parallel spin component.
  const gyro = vDot(omega, vHat);
  const omegaEff = vSub(omega, vScale(vHat, gyro));
  const omegaEffMag = vLen(omegaEff);

  const S = spinParameter(speed, omegaEffMag);

  // Drag: opposes velocity, magnitude K·C_D·|v|².
  const kd = K * dragCoef(speed, S) * speed;
  a.x -= kd * v.x;
  a.y -= kd * v.y;
  a.z -= kd * v.z;

  // Magnus: K·C_L·|v|·(ω̂_eff × v). |ω̂_eff × v| = |v| (unit axis ⊥ v), so the
  // magnitude is K·C_L·|v|² — same v² law as drag, different direction.
  if (omegaEffMag > 1e-9) {
    const axis = vScale(omegaEff, 1 / omegaEffMag);
    const m = vCross(axis, v);
    const kl = K * liftCoef(S) * speed;
    a.x += kl * m.x;
    a.y += kl * m.y;
    a.z += kl * m.z;
  }
  return a;
}

// ---------------------------------------------------------------------------
// Fixed-timestep integrator
// ---------------------------------------------------------------------------
//
// ⚠ FIXED_MS is THE shared substep of the whole game: the live rAF loop, the
// headless `predict()` used by the AI, the vitest harness and the screenshot
// driver all advance by exactly this. That identity is what makes an on-screen
// trajectory trustworthy evidence about the physics.
//
// It is also why PITCH_TEMPO (the slow-motion feel knob) must NEVER scale dt:
// gravity is linear in dt while the aero terms go as v², so a time-scaled dt
// re-weights them against each other and silently rewrites every break number.
// Playback speed belongs to the render layer, never to the integrator.
//
// The constant itself now lives in tuning.ts (stage 2), alongside every other
// labelled number, so the render layer can import the substep without importing
// this integrator. It is re-exported here so stage-1 consumers are unchanged.

export { FIXED_MS, FIXED_DT };

/** Position + velocity. The complete state of a ball in flight. */
export interface BallState {
  p: Vec3;
  v: Vec3;
}

/**
 * Advance one ball by `dt` with classical RK4. The acceleration depends only on
 * v (and on the constants ω, K), so the four stages differ only in the velocity
 * they sample. RK4 at 120 Hz is far more accurate than the trajectory needs,
 * which is the point: the integrator must not be a source of error we later
 * mistake for aerodynamics.
 *
 * Pure and allocation-light: returns a NEW state, never mutates the input, so
 * snapshot/restore of sim state stays trivially correct.
 */
export function stepBall(s: BallState, omega: Vec3, K: number, dt: number = FIXED_DT): BallState {
  const a1 = aeroAccel(s.v, omega, K);
  const v2 = vAdd(s.v, vScale(a1, dt / 2));
  const a2 = aeroAccel(v2, omega, K);
  const v3 = vAdd(s.v, vScale(a2, dt / 2));
  const a3 = aeroAccel(v3, omega, K);
  const v4 = vAdd(s.v, vScale(a3, dt));
  const a4 = aeroAccel(v4, omega, K);

  const dv = vScale(vAdd(vAdd(a1, vScale(vAdd(a2, a3), 2)), a4), dt / 6);
  const dp = vScale(vAdd(vAdd(s.v, vScale(vAdd(v2, v3), 2)), v4), dt / 6);
  return { p: vAdd(s.p, dp), v: vAdd(s.v, dv) };
}

/** Linear blend of two vectors. */
export const vLerp = (a: Vec3, b: Vec3, t: number): Vec3 =>
  vec3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);

/**
 * Linear blend of two ball states. Used to land EXACTLY on an event (the plate
 * crossing, the fence plane, the ground) instead of snapping to a substep
 * boundary: at 95 mph the ball covers 1.16 ft per substep against a 1.9 ft tall
 * strike zone, so snapping would quantise the called strike by more than half a
 * zone. Solve for the crossing fraction, then interpolate here.
 */
export function lerpBallState(a: BallState, b: BallState, t: number): BallState {
  return { p: vLerp(a.p, b.p, t), v: vLerp(a.v, b.v, t) };
}

/**
 * Fraction at which a scalar crosses `target` between `from` and `to`, or null
 * if this step does not cross it. Pair with `lerpBallState` for analytic event
 * resolution.
 *
 * ⚠ HALF-OPEN, t ∈ (0, 1]. The start of the step is EXCLUDED and the end is
 * INCLUDED, for two reasons that both matter once `battedBallSim` uses this for
 * ground contact:
 *   • no spurious contact — a ball launched from exactly z = 0 would otherwise
 *     report a crossing on its first substep and be "caught" at the tee;
 *   • no double count and no miss — a crossing landing exactly on a substep
 *     boundary is reported once, by the step that ENDS there (t = 1), never
 *     again by the step that begins there.
 * Consumers therefore scan steps in order and take the first non-null t.
 */
export function crossingFraction(from: number, to: number, target: number): number | null {
  const d = to - from;
  if (Math.abs(d) < 1e-12) return null;
  const t = (target - from) / d;
  return t > 0 && t <= 1 ? t : null;
}
