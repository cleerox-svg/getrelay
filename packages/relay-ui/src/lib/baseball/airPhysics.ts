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
//   +y — toward third base / the catcher's left (a RHP's arm side is −y)
//   +z — up. Gravity is (0, 0, −g).
// The frame is declared here and nothing may redefine it; `zone.ts` and the GL
// scene consume this same convention.
//
// Units: ft, s, slug (see units.ts). g is REAL — 32.174 ft/s².

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
export function vNormalize(a: Vec3): Vec3 {
  const l = vLen(a);
  return l > 1e-12 ? vScale(a, 1 / l) : vec3(0, 0, 0);
}

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
 * Lift (Magnus) coefficient C_L(S). CALIBRATED — a piecewise fit, steeper in
 * the low-S region and flattening as the boundary layer saturates:
 *   S ≤ 0.1 : C_L = 1.5·S          (through the origin: no spin, no Magnus)
 *   S > 0.1 : C_L = 0.09 + 0.6·S   (continuous at S = 0.1, both give 0.15)
 *   capped at C_L_MAX = 0.35       (real balls stop gaining lift past S ≈ 0.45)
 * Monotonically non-decreasing by construction, which the test asserts — a
 * non-monotone C_L would make a HIGHER-spin pitch break LESS and is always a
 * calibration bug.
 *
 * ⚠ Stage 2 recalibrates this against ALL EIGHT rows of the pitch table at
 * once. Never nudge it to fix one pitch.
 */
export const C_L_MAX = 0.35;
export function liftCoef(S: number): number {
  const s = Math.max(0, S);
  const cl = s <= 0.1 ? 1.5 * s : 0.09 + 0.6 * s;
  return Math.min(C_L_MAX, cl);
}

/**
 * Drag coefficient C_D. CALIBRATED, currently a constant.
 *
 * Value: 0.300. Calibrated against the published Statcast speed loss — a
 * four-seamer released at 94.0 mph crosses the plate at ~86.3 mph after ~55 ft
 * of flight, an 8.2 % loss. Closed form for the horizontal decay is
 * v(x) = v0·exp(−K·C_D·x), so C_D = ln(94/86.3)/(K·55) = 0.298 at sea level;
 * the full 3-D integration (gravity adds a downward component that raises |v|
 * slightly) lands 0.300 at 86.3 mph, dead on the published number. The starting
 * guess of 0.35 gave 84.6 mph — clearly outside the band — so it was moved.
 * `airPhysics.test.ts` re-measures this every run.
 *
 * The `speedFps`/`S` parameters are deliberately in the signature though the
 * body ignores them: a real baseball has a mild drag crisis (C_D falls with
 * Reynolds number) and gains drag with spin. When the pitch table demands that
 * detail it goes HERE, behind this signature, so no caller changes.
 */
export const C_D_BASE = 0.3;
export function dragCoef(speedFps: number, S: number): number {
  void speedFps;
  void S;
  return C_D_BASE;
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
// trajectory trustworthy evidence about the physics. Stage 2 moves the constant
// to tuning.ts and re-exports; nothing else about it changes.
//
// It is also why PITCH_TEMPO (the slow-motion feel knob) must NEVER scale dt:
// gravity is linear in dt while the aero terms go as v², so a time-scaled dt
// re-weights them against each other and silently rewrites every break number.
// Playback speed belongs to the render layer, never to the integrator.

/** The one substep, in milliseconds. 120 Hz. */
export const FIXED_MS = 1000 / 120;

/** The one substep, in seconds. DERIVED from FIXED_MS. */
export const FIXED_DT = FIXED_MS / 1000;

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
 * Fraction t ∈ [0,1] at which a scalar crosses `target` between `from` and
 * `to`. Returns null if the pair does not straddle the target. Pair with
 * `lerpBallState` for analytic event resolution.
 */
export function crossingFraction(from: number, to: number, target: number): number | null {
  const d = to - from;
  if (Math.abs(d) < 1e-12) return null;
  const t = (target - from) / d;
  return t >= 0 && t <= 1 ? t : null;
}
