// The batted ball's flight — on stage 1's integrator, unmodified.
//
// ⚠ THERE IS NO SECOND INTEGRATOR AND NO SECOND SET OF COEFFICIENTS. This file
// calls the same `stepBall`, at the same `FIXED_DT`, with the same `C_D`, the
// same `C_L(S)` and the same per-substep gyro projection that `pitchSim` uses.
// That is deliberate and it is load-bearing: the moment a fly ball gets "its
// own, simpler" aerodynamics, the fence you clear on screen stops being the
// fence the physics cleared, and every carry number in the game becomes a
// statement about a model nobody calibrated.
//
// ⚠ THE CARRY EXPERIMENT, AND HOW IT WAS RESOLVED. The published carry ladder is
// an INDEPENDENT test of a coefficient pair fitted in a completely different
// regime — a pitch is 0.4 s at 72–94 mph with S ≈ 0.2, a fly ball is 5 s of
// continuous deceleration from 100 mph to ~45. Stage 3 ran it and the aero core
// over-carried by +58.3 ft mean, uniformly positive, and correctly showed that
// no CONSTANT C_D repairs it (0.385 fits the level, flattens the slope the wrong
// way and breaks stage 1's plate speed by 2.2 mph).
//
// Stage 3b took the one further step that fixes it: a REYNOLDS-dependent C_D —
// the drag crisis, which a real seamed ball has and which `dragCoef(speedFps, S)`
// has anticipated since stage 1. The residual falls to +7.7 ft mean (RMS 9.5),
// inside the ±15 ft corroboration bar, WITHOUT touching the pitch regime (the
// four-seamer crosses the plate at 86.287 mph against 86.288 before). The same change fixes
// a second symptom stage 3 had recorded separately and wrongly — the launch-angle
// optimum at 90 mph, which was 31.0° against a briefed 25–30° and is now 28.5°.
// They were one defect. STILL NO carry factor, no per-regime coefficient and no
// launch-angle correction. The tables are printed by `battedBallSim.test.ts` and
// the write-up is BASEBALL.md § "The carry experiment".
//
// No three, no Math.random, no clock, no state.

import {
  crossingFraction,
  lerpBallState,
  stepBall,
  vAdd,
  vLen,
  vScale,
  vSub,
  vec3,
} from './airPhysics';
import type { BallState, Vec3 } from './airPhysics';
import { aeroScaleFor, GAME_AIR } from './pitchSim';
import type { AirConditions } from './pitchSim';
import { FIXED_DT } from './tuning';
import { FPS_TO_MPH, MPH_TO_FPS, RPM_TO_RADS } from './units';
import { sprayAngle } from './zone';

/**
 * Height of the contact point above the ground, ft. FIXED — 3.0 ft is the
 * league-average contact height and the height every published carry table is
 * quoted from, so carry measured to `z = 0` from here is comparable to them.
 */
export const CONTACT_HEIGHT_FT = 3.0;

/**
 * Longest flight the integrator will follow, s. A 500 ft fly hangs ~6 s, so 12 s
 * only ever bites on a ball that is not coming down (an absurd spin input), and
 * then it bites instead of looping forever.
 */
const MAX_FLIGHT_S = 12;

/** The launch state: WORLD position, velocity and spin at the instant of contact. */
export interface BattedLaunch {
  p: Vec3;
  v: Vec3;
  omega: Vec3;
}

/**
 * The sampled flight, in WORLD feet, one entry per substep plus one final entry
 * interpolated EXACTLY onto the ground plane.
 *
 * Parallel arrays for the same reason `PitchTrack` uses them: the render layer
 * reads the whole flight once, and the fielding lookup searches it.
 */
export interface BattedTrack {
  t: number[];
  x: number[];
  y: number[];
  z: number[];
}

export interface BattedFlight {
  /** Ground distance from the contact point to the landing point, ft. */
  carryFt: number;
  /** Time from contact to landing, s. */
  hangS: number;
  /** Peak height above the ground, ft. */
  apexFt: number;
  /** WORLD landing point (z = 0 exactly, by interpolation). */
  landing: Vec3;
  /** Speed on landing, mph — what the fielding model reads. */
  landingSpeedMph: number;
  evMph: number;
  laDeg: number;
  sprayDeg: number;
  track: BattedTrack;
}

/**
 * Build a launch state from the numbers published tables use: exit velocity,
 * launch angle, spray angle and a backspin/sidespin pair.
 *
 * The spin is assembled from the SAME axis definitions `batSim.decomposeSpin`
 * reads back, so `launchFromAngles(...)` and `swingContact(...)` are two ways
 * of producing one kind of object and a test asserts the round trip. Backspin is
 * about `v̂ × ẑ` (+ lifts), sidespin about the up axis (+ deflects toward third
 * base), and there is deliberately no gyro term: a bat cannot impart spin about
 * the ball's line of flight in this model.
 */
export function launchFromAngles(
  evMph: number,
  laDeg: number,
  sprayDeg: number,
  backspinRpm: number,
  sidespinRpm = 0,
  p: Vec3 = vec3(0, 0, CONTACT_HEIGHT_FT),
): BattedLaunch {
  const speed = evMph * MPH_TO_FPS;
  const la = (laDeg * Math.PI) / 180;
  const spray = (sprayDeg * Math.PI) / 180;
  // sprayAngle() is atan2(v.y, −v.x), so the inverse carries the −x.
  const v = vec3(
    -speed * Math.cos(la) * Math.cos(spray),
    speed * Math.cos(la) * Math.sin(spray),
    speed * Math.sin(la),
  );
  const vHat = vScale(v, 1 / speed);
  // Backspin axis: v̂ × ẑ, normalised. Its cross product with v̂ points up.
  const lift = vec3(vHat.y, -vHat.x, 0);
  const liftMag = Math.hypot(lift.x, lift.y);
  // Up axis: the part of ẑ perpendicular to v̂.
  const up = vec3(-vHat.x * vHat.z, -vHat.y * vHat.z, 1 - vHat.z * vHat.z);
  const upMag = vLen(up);
  const b = (backspinRpm * RPM_TO_RADS) / (liftMag > 1e-9 ? liftMag : 1);
  const s = (sidespinRpm * RPM_TO_RADS) / (upMag > 1e-9 ? upMag : 1);
  return {
    p,
    v,
    omega: vec3(lift.x * b + up.x * s, lift.y * b + up.y * s, lift.z * b + up.z * s),
  };
}

/** No wind. The default, and the exact object the zero-wind fast path tests. */
export const NO_WIND: Vec3 = vec3(0, 0, 0);

/**
 * Fly a batted ball from contact to the ground.
 *
 * `air` is an explicit argument with no same-shaped alternative default — the
 * stage-2 lesson about `measureBreak`'s air. Carry moves 2–4 ft between ISA and
 * game-day sea level and 40+ ft at altitude, so a carry number without its air
 * means nothing.
 *
 * The ground crossing is resolved ANALYTICALLY (`crossingFraction` +
 * `lerpBallState`), never snapped to a substep: a ball descending at 60 mph
 * covers 0.73 ft per substep, which is a foot of carry and a full inch of
 * landing-point error for the fielding lookup.
 *
 * ⚠ WIND IS A GALILEAN BOOST, NOT A SECOND INTEGRATOR — and that is a derivation,
 * not a shortcut. Both aero forces depend on the AIR-RELATIVE velocity and
 * gravity is invariant under a uniform translation, so in a frame moving with a
 * uniform wind `w` the equations of motion are EXACTLY the ones `stepBall`
 * already solves. Integrate from `v − w`, then add `w·t` back to every sampled
 * position. Stage 1's integrator, stage 1's coefficients, no copy, no new
 * approximation — and the equivalence is an identity a test can assert to the
 * last bit, which "add a wind acceleration term" would not be.
 *
 * Two conditions come with it and both are enforced or stated:
 *   • `w` must be HORIZONTAL. The ground crossing is solved on z, and z is
 *     frame-invariant only while `w.z = 0`. `w.z` is ignored, not silently
 *     integrated; `parks.parkConditions` never produces one.
 *   • `w` must be UNIFORM and CONSTANT. A gust that varies over the flight is a
 *     different problem and is not modelled.
 * With `w = (0,0,0)` the boost is skipped entirely, so every stage 1–3 golden is
 * byte-identical rather than merely equal to within a rounding of zero.
 */
export function simulateBattedBall(
  launch: BattedLaunch,
  air: AirConditions = GAME_AIR,
  wind: Vec3 = NO_WIND,
): BattedFlight {
  const K = aeroScaleFor(air);
  const w = vec3(wind.x, wind.y, 0);
  const windy = w.x !== 0 || w.y !== 0;
  const track: BattedTrack = { t: [], x: [], y: [], z: [] };
  // Air frame → ground frame: p_ground = p_air + w·t. Applied on the way into
  // the track so every consumer (the fence walk, the fielding lookup, the
  // renderer) reads ground-frame feet and never has to know the boost happened.
  const push = (s: BallState, t: number) => {
    track.t.push(t);
    track.x.push(s.p.x + w.x * t);
    track.y.push(s.p.y + w.y * t);
    track.z.push(s.p.z);
  };

  let s: BallState = { p: launch.p, v: windy ? vSub(launch.v, w) : launch.v };
  let t = 0;
  let apex = s.p.z;
  push(s, t);

  const steps = Math.ceil(MAX_FLIGHT_S / FIXED_DT);
  let end = s;
  for (let i = 0; i < steps; i++) {
    const next = stepBall(s, launch.omega, K, FIXED_DT);
    if (next.p.z > apex) apex = next.p.z;
    const f = crossingFraction(s.p.z, next.p.z, 0);
    if (f !== null) {
      end = lerpBallState(s, next, f);
      t += f * FIXED_DT;
      push(end, t);
      break;
    }
    s = next;
    t += FIXED_DT;
    push(s, t);
    end = s;
  }

  const speed = vLen(launch.v);
  const endP = windy ? vAdd(end.p, vScale(w, t)) : end.p;
  const endV = windy ? vAdd(end.v, w) : end.v;
  return {
    carryFt: Math.hypot(endP.x - launch.p.x, endP.y - launch.p.y),
    hangS: t,
    apexFt: apex,
    landing: endP,
    landingSpeedMph: vLen(endV) * FPS_TO_MPH,
    evMph: speed * FPS_TO_MPH,
    laDeg: (Math.atan2(launch.v.z, Math.hypot(launch.v.x, launch.v.y)) * 180) / Math.PI,
    sprayDeg: (sprayAngle(launch.v) * 180) / Math.PI,
    track,
  };
}

/**
 * The launch angle that maximises carry at a given exit velocity and backspin,
 * and the carry there.
 *
 * ⚠ This searches the ARGMAX rather than sampling a nominal angle, because the
 * optimum angle is itself a physical result worth asserting: backspin generating
 * lift is exactly why the optimum sits near 27–31° instead of the 45° a
 * drag-free projectile would want, and why it FALLS as exit velocity rises (a
 * faster ball spends less time at the low speeds where lift is cheap). A model
 * that only checked one angle would pass with the Magnus term deleted.
 *
 * Coarse-then-fine so the sweep is cheap enough to run inside a test loop.
 */
export function maxCarry(
  evMph: number,
  backspinRpm: number,
  air: AirConditions = GAME_AIR,
  loDeg = 10,
  hiDeg = 50,
): { laDeg: number; carryFt: number; hangS: number; apexFt: number } {
  let best = { laDeg: loDeg, carryFt: -1, hangS: 0, apexFt: 0 };
  const scan = (lo: number, hi: number, stepDeg: number) => {
    for (let la = lo; la <= hi + 1e-9; la += stepDeg) {
      const r = simulateBattedBall(launchFromAngles(evMph, la, 0, backspinRpm), air);
      if (r.carryFt > best.carryFt) {
        best = { laDeg: la, carryFt: r.carryFt, hangS: r.hangS, apexFt: r.apexFt };
      }
    }
  };
  scan(loDeg, hiDeg, 1);
  scan(Math.max(loDeg, best.laDeg - 1), Math.min(hiDeg, best.laDeg + 1), 0.25);
  return best;
}

/**
 * Ground distance at which the flight reaches a given height on the way DOWN,
 * interpolated analytically. This is what `parks.ts` intersects against a fence
 * height, so the fence you see is the fence you clear; returns null if the ball
 * never gets that high.
 *
 * ⚠ THIS — NOT `carryFt` — IS WHAT "A 400 FOOT HOME RUN" MEANS in this game.
 * Carry is measured to z = 0, so a 400 ft carry lands at the BASE of a 400 ft
 * wall; clearing a 10 ft wall at Harbourfront's dead centre takes 408.99 ft of
 * carry, i.e. `distanceAtHeight(flight, 10) = 400`. The two differ by more than
 * a wall's worth and the difference is a home run. Same note on
 * `parks.resolveFence`, which is the other end of the same convention.
 */
export function distanceAtHeight(flight: BattedFlight, heightFt: number): number | null {
  const { t, x, y, z } = flight.track;
  for (let i = 1; i < t.length; i++) {
    const a = z[i - 1];
    const b = z[i];
    if (a === undefined || b === undefined) continue;
    if (a >= heightFt && b <= heightFt) {
      const f = crossingFraction(a, b, heightFt);
      if (f === null) continue;
      const x0 = x[i - 1] ?? 0;
      const y0 = y[i - 1] ?? 0;
      const x1 = x[i] ?? 0;
      const y1 = y[i] ?? 0;
      const px = x0 + (x1 - x0) * f;
      const py = y0 + (y1 - y0) * f;
      const sx = x[0] ?? 0;
      const sy = y[0] ?? 0;
      return Math.hypot(px - sx, py - sy);
    }
  }
  return null;
}
