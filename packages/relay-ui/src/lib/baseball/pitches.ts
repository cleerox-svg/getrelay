// The arsenal, as DATA. Eight rows of published league-average Statcast values
// for a right-handed pitcher, plus the one function that turns a row into a spin
// VECTOR in the physics frame.
//
// ⚠ CONTENT IS DATA, NEVER A BRANCH. Adding a ninth pitch means adding a ninth
// row here — no `if (id === 'kc')` anywhere in the sim, ever. `validatePitches()`
// runs as a test, so a bad row is a failing build rather than a pitch that
// quietly does nothing.
//
// ⚠ THE BREAK COLUMNS ARE TARGETS, NOT INPUTS. `ivbIn` / `hbIn` are never read
// by the simulation. Velo, spin rate, tilt and active spin go in; the integrator
// produces break; `pitchSim.test.ts` compares that against these columns and
// fails if the physics has drifted. If you ever find yourself adding
// `ivbIn` to a force, stop: that is the fifth category the physics rule forbids.

import { vCross, vLen, vScale, vec3 } from './airPhysics';
import type { Vec3 } from './airPhysics';
import { armSideX } from './zone';
import type { Handedness } from './zone';
import { RPM_TO_RADS } from './units';

/** Stable id of a pitch type. Two letters, matching the usual scouting codes. */
export type PitchId = 'ff' | 'si' | 'fc' | 'sl' | 'st' | 'cu' | 'ch' | 'fs';

export interface Pitch {
  id: PitchId;
  /** Display name. No club, player or trademarked names — see ip.test.ts. */
  name: string;
  /** Release speed, mph. PUBLISHED (league average). */
  veloMph: number;
  /** Total spin rate, rpm. PUBLISHED (league average). */
  spinRpm: number;
  /**
   * Spin tilt as a clock face, "H:MM".
   *
   * ⚠ THE CLOCK IS FIXED IN SPACE AND IT POINTS THE WAY THE BALL BREAKS.
   * 12:00 is straight up, 6:00 straight down, and 3:00 is the THIRD-base side —
   * which is a RHP's arm side and a LHP's glove side. That spatial fixing is why
   * a RHP's fastball is quoted near 1:00 and a LHP's near 11:00: the two mirror
   * because the clock does not. Read as a clock painted on the outfield wall in
   * centre field and viewed from behind the pitcher; from the catcher's view it
   * runs anticlockwise, which is the usual source of sign errors here.
   *
   * It describes the direction of the MAGNUS FORCE, not the raw spin axis
   * (a pure-backspin fastball's axis is horizontal, yet its tilt is 12:00) —
   * `spinVector` rotates it into an axis, once.
   */
  tilt: string;
  /**
   * Active spin, 0..1. PUBLISHED (Statcast "spin efficiency"): the fraction of
   * the spin VECTOR's magnitude that is perpendicular to the direction of
   * travel and therefore does aerodynamic work. The remaining
   * √(1 − activeSpin²) is gyro spin — the rifle-bullet spiral — which produces
   * exactly zero Magnus force and is projected out every substep by
   * `aeroAccel`. This column IS what makes a slider a slider: it is thrown
   * HARDER-spinning than a four-seamer and breaks a fifth as much.
   */
  activeSpin: number;
  /** TARGET induced vertical break, inches, + up. PUBLISHED. Never an input. */
  ivbIn: number;
  /** TARGET horizontal break, inches, + toward the ARM side. PUBLISHED. */
  hbIn: number;
}

/**
 * The eight-row published table (RHP, league averages). The `ivbIn`/`hbIn`
 * columns are quoted on the public convention, where + horizontal is arm-side
 * for both handednesses — a display mirror that raw Statcast does not apply, and
 * `armSideX` is where this game applies it, once.
 */
export const PITCHES: readonly Pitch[] = [
  { id: 'ff', name: '4-Seam Fastball', veloMph: 93.9, spinRpm: 2300, tilt: '12:45', activeSpin: 0.93, ivbIn: 16.0, hbIn: 7.0 },
  { id: 'si', name: 'Sinker', veloMph: 93.0, spinRpm: 2130, tilt: '1:45', activeSpin: 0.9, ivbIn: 8.5, hbIn: 15.0 },
  { id: 'fc', name: 'Cutter', veloMph: 89.0, spinRpm: 2400, tilt: '11:15', activeSpin: 0.75, ivbIn: 7.5, hbIn: -2.0 },
  { id: 'sl', name: 'Slider', veloMph: 84.5, spinRpm: 2430, tilt: '9:30', activeSpin: 0.45, ivbIn: 0.5, hbIn: -8.0 },
  { id: 'st', name: 'Sweeper', veloMph: 81.5, spinRpm: 2800, tilt: '9:00', activeSpin: 0.85, ivbIn: -1.5, hbIn: -17.0 },
  { id: 'cu', name: 'Curveball', veloMph: 79.5, spinRpm: 2620, tilt: '6:30', activeSpin: 0.88, ivbIn: -12.0, hbIn: -6.0 },
  { id: 'ch', name: 'Changeup', veloMph: 84.5, spinRpm: 1750, tilt: '1:30', activeSpin: 0.85, ivbIn: 6.0, hbIn: 14.5 },
  { id: 'fs', name: 'Splitter', veloMph: 85.5, spinRpm: 1400, tilt: '1:15', activeSpin: 0.7, ivbIn: 2.0, hbIn: 9.0 },
];

/** Lookup by id. Throws on an unknown id rather than silently throwing a ff. */
export function pitchById(id: PitchId): Pitch {
  const p = PITCHES.find((q) => q.id === id);
  if (!p) throw new Error(`unknown pitch id: ${id}`);
  return p;
}

// ---------------------------------------------------------------------------
// Tilt → angle
// ---------------------------------------------------------------------------

/**
 * "H:MM" → the break direction as an angle in radians, measured from straight UP
 * and increasing toward the THIRD-base side (the 3:00 direction). 12:00 → 0,
 * 3:00 → π/2, 6:00 → π. Each hour is 30°, each minute 0.5°.
 *
 * Rejects malformed input loudly: a tilt typo that parses as NaN would give a
 * pitch with no break at all, and a pitch with no break is a pitch that looks
 * "a bit flat" rather than obviously broken.
 */
export function tiltAngleRad(tilt: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(tilt.trim());
  if (!m) throw new Error(`bad tilt "${tilt}" (want "H:MM")`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 1 || hh > 12 || mm > 59) throw new Error(`bad tilt "${tilt}" (out of range)`);
  const hours = (hh % 12) + mm / 60;
  return hours * (Math.PI / 6);
}

// ---------------------------------------------------------------------------
// Row → spin vector
// ---------------------------------------------------------------------------

/**
 * The spin vector ω (rad/s, WORLD frame) for a pitch thrown by `hand` whose
 * release velocity direction is `vHat`.
 *
 * Built in three steps, in this order, because each depends on the last:
 *
 *  1. A BASIS PERPENDICULAR TO TRAVEL. `side = v̂ × ẑ` points to the third-base
 *     side (for v̂ = +x̂ that is −ŷ), i.e. the clock's 3:00; `up = side × v̂` is
 *     the clock's 12:00. Built from the actual release velocity rather than from
 *     +x̂, so a pitch aimed at the corner still gets a genuinely transverse axis
 *     instead of one a degree off.
 *  2. THE BREAK DIRECTION from the tilt clock: m̂ = cos θ·up + sin θ·side, with
 *     θ mirrored for a LHP, since the clock is fixed in space and handedness
 *     mirrors the pitcher, not the clock.
 *  3. THE AXIS THAT PRODUCES IT. Magnus is ω̂ × v, so the axis wanted is
 *     ω̂ = v̂ × m̂ — the tilt rotated 90°. (Check: m̂ = up ⇒ ω̂ = x̂ × ẑ = −ŷ,
 *     backspin, which lifts. The stage-1 sign test pins that exact case.)
 *
 * Then the gyro component is ADDED BACK along v̂ at √(1 − activeSpin²), so that
 * |ω| is the published TOTAL spin rate and the transverse part is
 * activeSpin × |ω|. It is added rather than omitted for three reasons: |ω| then
 * matches the published rpm, a spin-axis render can draw the real axis, and —
 * the one that matters — it forces `aeroAccel`'s gyro projection to be exercised
 * on every pitch of every plate appearance, so a regression there shows up as
 * eight wrong break numbers instead of nothing at all.
 */
export function spinVector(p: Pitch, hand: Handedness, vHat: Vec3): Vec3 {
  const theta = tiltAngleRad(p.tilt) * (hand === 'R' ? 1 : -1);

  const sideRaw = vCross(vHat, vec3(0, 0, 1));
  const sideLen = vLen(sideRaw);
  // Degenerate only for a pitch thrown straight up or straight down, which no
  // release can produce; fall back to the third-base direction so it cannot NaN.
  const side = sideLen > 1e-9 ? vScale(sideRaw, 1 / sideLen) : vec3(0, -1, 0);
  const up = vCross(side, vHat);

  const breakDir = vec3(
    Math.cos(theta) * up.x + Math.sin(theta) * side.x,
    Math.cos(theta) * up.y + Math.sin(theta) * side.y,
    Math.cos(theta) * up.z + Math.sin(theta) * side.z,
  );

  const omegaMag = p.spinRpm * RPM_TO_RADS;
  const transverse = vScale(vCross(vHat, breakDir), p.activeSpin * omegaMag);
  // ⚠ The gyro sense mirrors with handedness. Spin is an AXIAL vector, so a
  // mirrored pitcher is not a copy with y negated: reflecting a right-handed
  // screw gives a LEFT-handed one. Without this sign a LHP's slider would carry
  // its gyro spin the same way round as a RHP's, which is not the mirror of
  // anything — invisible in the break (the component is projected out) and
  // wrong the moment a spin axis is drawn or a bat imparts torque.
  const gyroSense = hand === 'R' ? 1 : -1;
  const gyro = vScale(
    vHat,
    gyroSense * Math.sqrt(Math.max(0, 1 - p.activeSpin * p.activeSpin)) * omegaMag,
  );
  return vec3(transverse.x + gyro.x, transverse.y + gyro.y, transverse.z + gyro.z);
}

/**
 * The published break of a pitch as a REPORT-frame displacement in INCHES —
 * i.e. `hbIn` with the arm-side display mirror undone. This is the ONLY place
 * the published table's sign convention is converted to the game's frame, and
 * the test asserts against its output rather than against `hbIn` directly, so
 * the mirror is exercised rather than reimplemented in the test.
 */
export function publishedBreak(p: Pitch, hand: Handedness): { ivbIn: number; hbIn: number } {
  return { ivbIn: p.ivbIn, hbIn: p.hbIn * armSideX(hand) };
}

// ---------------------------------------------------------------------------
// Validation — run as a test
// ---------------------------------------------------------------------------

/**
 * Structural and physical sanity of the table. Returns a list of problems;
 * `pitches.test.ts` asserts it is empty, so bad DATA is a build failure exactly
 * as bad CODE is.
 *
 * The interesting check is the last one: the published break direction must
 * agree in SIGN with the tilt clock on both axes (where the tilt has a
 * meaningful component on that axis at all). That catches the single most
 * likely data error — a mirrored tilt — which would otherwise show up as a
 * pitch that breaks perfectly, in the wrong direction.
 */
export function validatePitches(pitches: readonly Pitch[] = PITCHES): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const p of pitches) {
    if (seen.has(p.id)) problems.push(`${p.id}: duplicate id`);
    seen.add(p.id);
    if (!p.name.trim()) problems.push(`${p.id}: empty name`);
    if (!(p.veloMph > 50 && p.veloMph < 110)) problems.push(`${p.id}: velo ${p.veloMph} out of band`);
    if (!(p.spinRpm >= 0 && p.spinRpm < 4000)) problems.push(`${p.id}: spin ${p.spinRpm} out of band`);
    if (!(p.activeSpin >= 0 && p.activeSpin <= 1)) problems.push(`${p.id}: activeSpin ${p.activeSpin} not in 0..1`);
    if (Math.abs(p.ivbIn) > 30) problems.push(`${p.id}: ivbIn ${p.ivbIn} out of band`);
    if (Math.abs(p.hbIn) > 30) problems.push(`${p.id}: hbIn ${p.hbIn} out of band`);

    let theta: number;
    try {
      theta = tiltAngleRad(p.tilt);
    } catch (err) {
      problems.push(`${p.id}: ${(err as Error).message}`);
      continue;
    }

    // Sign agreement between the tilt clock and the published break, on each
    // axis where the clock commits to a direction (|component| > 0.2, i.e. more
    // than ~11° off the perpendicular) and the break is bigger than the ±1 in
    // rounding of a published league average.
    const upComp = Math.cos(theta);
    const sideComp = Math.sin(theta); // + is the 3:00 (arm-side for a RHP) side
    if (Math.abs(upComp) > 0.2 && Math.abs(p.ivbIn) > 1 && Math.sign(upComp) !== Math.sign(p.ivbIn)) {
      problems.push(`${p.id}: tilt ${p.tilt} points ${upComp > 0 ? 'up' : 'down'} but ivbIn is ${p.ivbIn}`);
    }
    if (Math.abs(sideComp) > 0.2 && Math.abs(p.hbIn) > 1 && Math.sign(sideComp) !== Math.sign(p.hbIn)) {
      problems.push(`${p.id}: tilt ${p.tilt} points ${sideComp > 0 ? 'arm' : 'glove'} side but hbIn is ${p.hbIn}`);
    }
  }
  return problems;
}

/**
 * Angle, in degrees, between the direction the tilt clock says a pitch should
 * break and the direction the published IVB/HB columns say it breaks. Zero for
 * a perfectly self-consistent row.
 *
 * This is NOT asserted tightly, and deliberately so: the two columns come from
 * different published aggregations (a mean tilt and a mean break are not the
 * tilt of the mean break), and seam-shifted wake moves a splitter's break away
 * from its spin axis by a genuinely physical amount that no spin-only model
 * reproduces. The test PRINTS this column, so a row that is 40° out is visible
 * as a data-quality fact instead of being mistaken for a physics error.
 */
export function tiltVsPublishedDeg(p: Pitch): number {
  const theta = tiltAngleRad(p.tilt);
  const published = Math.atan2(p.hbIn, p.ivbIn); // same sense: + side is 3:00
  let diff = ((published - theta) * 180) / Math.PI;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  return diff;
}
