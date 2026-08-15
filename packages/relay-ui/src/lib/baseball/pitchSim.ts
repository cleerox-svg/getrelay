// The pitch: from a pitcher's hand to the plate, precomputed in full at TRUE
// physical time.
//
// ⚠ THE TEMPO SEPARATION — the architectural decision this file exists to
// enforce. A pitch is simulated ONCE, to completion, at the real 120 Hz substep,
// into a sampled `PitchTrack`. The render layer then plays that array back at
// whatever `PITCH_TEMPO` the game feels good at, and the swing resolves against
// the TRUE physical state at the true physical instant. Consequences, all of
// them intended:
//
//   • `PITCH_TEMPO` is not imported by this file and cannot be. Slow motion
//     therefore cannot change a break number, because slow motion never reaches
//     the integrator. Time-scaling dt WOULD change them: gravity is linear in dt
//     while both aero terms go as v², so a 0.5× dt silently re-weights them
//     against each other and every number in the pitch table drifts.
//   • The AI, the HUD and the GL scene all read the same array. There is no
//     second trajectory computed "for the preview", so the preview cannot lie.
//   • A pitch is fully determined before the first frame is drawn, so a dropped
//     frame changes what you SEE and never what HAPPENS.
//
// No three, no Math.random, no clock, no state: give it the same arguments and
// it returns the same numbers, forever.

import {
  aeroScale,
  airDensity,
  crossingFraction,
  lerpBallState,
  stepBall,
  vLen,
  vScale,
  vec3,
} from './airPhysics';
import type { BallState, Vec3 } from './airPhysics';
import { spinVector } from './pitches';
import type { Pitch } from './pitches';
import {
  BREAK_REF_ELEV_FT,
  BREAK_REF_RH,
  BREAK_REF_TEMP_F,
  BREAK_SEGMENT_FT,
  FIXED_DT,
  GAME_ELEV_FT,
  GAME_RH,
  GAME_TEMP_F,
} from './tuning';
import { FPS_TO_MPH, FT_TO_IN, MPH_TO_FPS } from './units';
import {
  RELEASE_D_FT,
  RELEASE_H_FT,
  RELEASE_SIDE_FT,
  ZONE_CENTER,
  armSideX,
  isStrike,
  reportFromWorld,
  worldXAt,
} from './zone';
import type { Handedness } from './zone';

/** Air a pitch is thrown through. Reaches the ball only via K = ρA/2m. */
export interface AirConditions {
  elevFt: number;
  tempF: number;
  rh: number;
}

/**
 * ⚠ AIR IS A PARAMETER OF THE CALL, NOT A FIELD OF THE THROW — and deliberately
 * so. `simulatePitch` plays in GAME_AIR; `measureBreak` measures in
 * BREAK_REF_AIR, because a league-wide published break table cannot be quoted in
 * one park's weather. Those two defaults are DIFFERENT and both are correct.
 *
 * An earlier cut carried the air on `PitchThrow` as an optional field, so the
 * same object handed to the two functions silently meant two different things —
 * one interface, two defaults, and a 0.6 in discrepancy on a four-seamer with
 * nothing on screen to say why. Making it an argument puts the two defaults side
 * by side in the two signatures where a reader will actually compare them.
 */

/** The neutral game-day air (tuning.ts). Parks override it in stage 3. */
export const GAME_AIR: AirConditions = { elevFt: GAME_ELEV_FT, tempF: GAME_TEMP_F, rh: GAME_RH };

/**
 * ISA sea level — the air the BREAK REFERENCE is measured in, and only that.
 * Published break tables are league-wide, so they cannot be quoted in one
 * park's air; the same four-seamer measures 22.59 in here and 18.11 in a mile
 * up. See BASEBALL.md § induced break.
 */
export const BREAK_REF_AIR: AirConditions = {
  elevFt: BREAK_REF_ELEV_FT,
  tempF: BREAK_REF_TEMP_F,
  rh: BREAK_REF_RH,
};

/** K = ρA/2m for a set of conditions. DERIVED — the one channel air ever uses. */
export const aeroScaleFor = (air: AirConditions): number =>
  aeroScale(airDensity(air.elevFt, air.tempF, air.rh));

/**
 * What a pitcher throws. Everything optional has a published default.
 *
 * It does NOT carry the air — see the note above `GAME_AIR`.
 */
export interface PitchThrow {
  pitch: Pitch;
  hand: Handedness;
  /** Aim point at the plate, REPORT frame (ft). Defaults to the zone's centre. */
  target?: { x: number; h: number };
  /** Release speed override, mph — the hook every card/stamina modulator uses. */
  veloMph?: number;
  /** Spin-rate override, rpm — likewise. Break scales with it, as it should. */
  spinRpm?: number;
}

/**
 * The precomputed flight, sampled every substep in the REPORT frame, plus one
 * final sample interpolated EXACTLY onto the plate.
 *
 * Parallel arrays rather than an array of objects: this is read once per frame
 * by the render layer for the whole flight, and it is the thing the swing
 * searches for the contact instant. `t` is TRUE physical seconds since release —
 * playback scales the clock that indexes this array, never the array itself.
 */
export interface PitchTrack {
  t: number[];
  d: number[];
  x: number[];
  h: number[];
}

/** The state at the plate, interpolated analytically to d = 0 exactly. */
export interface PlateCrossing {
  t: number;
  x: number;
  h: number;
  /** Full WORLD velocity there — stage 3's bat impact needs the vector. */
  v: Vec3;
  speedMph: number;
  strike: boolean;
}

export interface PitchResult {
  track: PitchTrack;
  plate: PlateCrossing;
  releaseSpeedMph: number;
  flightTimeS: number;
  /** WORLD release state and spin — everything needed to replay it exactly. */
  release: BallState;
  omega: Vec3;
  /** Residual of the aim solve, ft. Asserted tiny; a growing value is a bug. */
  aimResidualFt: number;
}

// ---------------------------------------------------------------------------
// The one integration loop
// ---------------------------------------------------------------------------

/**
 * Fly from `start` to WORLD x = `targetX`, using stage 1's RK4 `stepBall` at the
 * shared substep, and land EXACTLY on the target plane with `crossingFraction` +
 * `lerpBallState` instead of snapping to a substep boundary. At 94 mph the ball
 * covers 1.15 ft per substep against a 1.66 ft wide called zone, so snapping
 * would quantise the ball/strike call by two thirds of a zone width.
 *
 * `onSample` receives every whole substep (never the interpolated end), so the
 * track builder can append the exact crossing itself and know it is last.
 *
 * There is no second integrator anywhere in this game: `battedBallSim` will call
 * the same `stepBall`, so a fix to the aerodynamics reaches the pitch and the
 * batted ball in the same commit or it reaches neither.
 */
function flyToX(
  start: BallState,
  omega: Vec3,
  K: number,
  targetX: number,
  onSample?: (s: BallState, t: number) => void,
): { state: BallState; t: number } | null {
  // 6 s at 120 Hz — a pitch takes ~0.4 s, so this only ever bites on a ball that
  // is not going to arrive at all (a backwards or stalled release).
  const MAX_STEPS = 720;
  let s = start;
  let t = 0;
  onSample?.(s, t);
  for (let i = 0; i < MAX_STEPS; i++) {
    const next = stepBall(s, omega, K, FIXED_DT);
    const f = crossingFraction(s.p.x, next.p.x, targetX);
    if (f !== null) {
      return { state: lerpBallState(s, next, f), t: t + f * FIXED_DT };
    }
    s = next;
    t += FIXED_DT;
    onSample?.(s, t);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Aim
// ---------------------------------------------------------------------------

/**
 * Number of aim iterations. FEEL KNOB only in the sense that it trades CPU for
 * precision — physically it is "enough that the residual is not a source of
 * error we might mistake for aerodynamics". Each pass costs one ~50-step
 * integration; the residual falls by ~2 orders of magnitude per pass, so 8 lands
 * at machine noise and the test asserts < 1e-6 ft (1.2e-5 in).
 */
const AIM_ITERS = 8;

/** Release velocity from a speed and two angles. +elev is up, +azim toward 1B. */
function velocityFrom(speedFps: number, elevRad: number, azimRad: number): Vec3 {
  const c = Math.cos(elevRad);
  return vec3(speedFps * c * Math.cos(azimRad), speedFps * c * Math.sin(azimRad), speedFps * Math.sin(elevRad));
}

/**
 * Solve the release direction that puts the pitch through `target` at the plate.
 *
 * Deliberately a damped fixed-point iteration and not a closed form: there is no
 * closed form, because the spin axis itself depends on the release direction
 * (`spinVector` builds its basis from v̂), so aim and break are coupled. One
 * Newton step per axis with the small-angle gain dh/dθ ≈ D is enough — the
 * coupling is a second-order correction and the iteration eats it.
 *
 * It is also why this is the ONLY place a pitch's release velocity is computed.
 * A "close enough" release built by hand elsewhere would put the ball a few
 * inches off the aim point, which is the difference between a strike and a ball.
 */
function solveRelease(
  th: PitchThrow,
  K: number,
): { release: BallState; omega: Vec3; residual: number } {
  const speedFps = (th.veloMph ?? th.pitch.veloMph) * MPH_TO_FPS;
  const target = th.target ?? ZONE_CENTER;
  const p0 = vec3(0, armSideX(th.hand) * RELEASE_SIDE_FT, RELEASE_H_FT);
  const flightX = worldXAt(0) - p0.x;

  // First guess: the straight line to the target, with no gravity and no break.
  let elev = Math.atan2(target.h - p0.z, flightX);
  let azim = Math.atan2(target.x - p0.y, flightX);
  let omega = vec3(0, 0, 0);
  let residual = Infinity;

  const pitch = th.spinRpm === undefined ? th.pitch : { ...th.pitch, spinRpm: th.spinRpm };

  for (let i = 0; i < AIM_ITERS; i++) {
    const v0 = velocityFrom(speedFps, elev, azim);
    omega = spinVector(pitch, th.hand, vScale(v0, 1 / speedFps));
    const hit = flyToX({ p: p0, v: v0 }, omega, K, worldXAt(0));
    if (!hit) break;
    const eh = hit.state.p.z - target.h;
    const ex = hit.state.p.y - target.x;
    elev -= eh / flightX;
    azim -= ex / flightX;
  }

  // Rebuild at the converged angles so the returned state, spin and residual all
  // describe the SAME pitch — returning the last iterate's state with the new
  // angles would be a quiet inconsistency of exactly the size of the residual.
  const v0 = velocityFrom(speedFps, elev, azim);
  omega = spinVector(pitch, th.hand, vScale(v0, 1 / speedFps));

  // ⚠ AND MEASURE THE RESIDUAL OF *THAT* PITCH, with one extra flight, rather
  // than reusing the last iterate's error. The loop's error is computed BEFORE
  // its own angle update, so reporting it would describe the previous iterate —
  // a number that is conservative (it is larger) but is not about the trajectory
  // this function returns, which is exactly the sort of half-truth a residual
  // exists to rule out. One more ~50-step integration out of nine, once per
  // pitch, buys a number that means what it says.
  const check = flyToX({ p: p0, v: v0 }, omega, K, worldXAt(0));
  if (check) {
    residual = Math.hypot(check.state.p.z - target.h, check.state.p.y - target.x);
  }
  return { release: { p: p0, v: v0 }, omega, residual };
}

// ---------------------------------------------------------------------------
// The pitch
// ---------------------------------------------------------------------------

/**
 * Simulate one pitch to the plate, in the air the GAME is played in. Pure: same
 * arguments in, byte-identical numbers out, whatever the frame rate, the tempo
 * or the machine.
 *
 * `air` defaults to GAME_AIR — the neutral park. `measureBreak` below defaults
 * to BREAK_REF_AIR instead, and that difference is deliberate: see the note
 * above `GAME_AIR`.
 */
export function simulatePitch(th: PitchThrow, air: AirConditions = GAME_AIR): PitchResult {
  const K = aeroScaleFor(air);
  const { release, omega, residual } = solveRelease(th, K);

  const track: PitchTrack = { t: [], d: [], x: [], h: [] };
  const push = (s: BallState, t: number) => {
    // The WORLD → REPORT mapping is zone.ts's, called — never re-derived here.
    const r = reportFromWorld(s.p);
    track.t.push(t);
    track.d.push(r.d);
    track.x.push(r.x);
    track.h.push(r.h);
  };

  const hit = flyToX(release, omega, K, worldXAt(0), push);
  if (!hit) throw new Error('pitch never reached the plate');
  push(hit.state, hit.t);

  const speedFps = vLen(hit.state.v);
  return {
    track,
    plate: {
      t: hit.t,
      x: hit.state.p.y,
      h: hit.state.p.z,
      v: hit.state.v,
      speedMph: speedFps * FPS_TO_MPH,
      strike: isStrike(hit.state.p.y, hit.state.p.z),
    },
    releaseSpeedMph: vLen(release.v) * FPS_TO_MPH,
    flightTimeS: hit.t,
    release,
    omega,
    aimResidualFt: residual,
  };
}

/**
 * Sample the track at a true physical time `t` (seconds since release), linearly
 * between substeps. This is what the render layer calls with
 * `elapsedWallSeconds × PITCH_TEMPO`, and what the swing calls with the true
 * contact time — the SAME function, so what is drawn and what is hit cannot
 * disagree. Clamped at both ends.
 */
export function sampleTrack(track: PitchTrack, t: number): { d: number; x: number; h: number } {
  const n = track.t.length;
  if (n === 0) throw new Error('empty track');
  const at = (i: number) => {
    const d = track.d[i];
    const x = track.x[i];
    const h = track.h[i];
    const time = track.t[i];
    // Parallel arrays are only safe if they stay parallel; a ragged track would
    // otherwise read as `undefined` and silently become NaN three layers later.
    if (d === undefined || x === undefined || h === undefined || time === undefined) {
      throw new Error(`ragged track at ${i}`);
    }
    return { d, x, h, t: time };
  };

  const first = at(0);
  const last = at(n - 1);
  if (t <= first.t) return { d: first.d, x: first.x, h: first.h };
  if (t >= last.t) return { d: last.d, x: last.x, h: last.h };

  let i = 1;
  while (i < n - 1 && at(i).t < t) i++;
  const a = at(i - 1);
  const b = at(i);
  const f = (t - a.t) / (b.t - a.t);
  return {
    d: a.d + (b.d - a.d) * f,
    x: a.x + (b.x - a.x) * f,
    h: a.h + (b.h - a.h) * f,
  };
}

// ---------------------------------------------------------------------------
// Induced break — the measurement, on the pinned convention
// ---------------------------------------------------------------------------

/**
 * Measure a pitch's induced break, in inches, on the convention pinned in
 * BASEBALL.md and `tuning.ts`:
 *
 *   • fly the real pitch, in ISA sea-level air (NOT the game's air);
 *   • take its state exactly `segmentFt` before the plate — position AND
 *     velocity, interpolated analytically, not snapped to a substep;
 *   • fly a REFERENCE from that same state with the spin set to zero and
 *     everything else — drag, gravity, air — identical;
 *   • report the difference in position at the plate.
 *
 * Because drag and gravity are shared by both trajectories, the difference is
 * exactly the Magnus term's contribution and nothing else. IVB is the vertical
 * part; HB is the lateral part, returned BOTH in the game's REPORT frame
 * (`hbIn`, + toward first base) and on the published display convention
 * (`hbArmSideIn`, + toward the arm side) so the caller cannot pick up the wrong
 * one by accident.
 *
 * ⚠ `segmentFt` is the game's single fitted number. It is fitted ONCE, globally,
 * against all sixteen published targets at once (see pitchSim.test.ts's sweep).
 * A per-pitch segment would be a per-pitch fudge factor.
 *
 * ⚠ `air` defaults to BREAK_REF_AIR — ISA sea level — and NOT to the game-day
 * air `simulatePitch` uses. Published break tables are league-wide averages, so
 * quoting one in a particular park's weather is a category error worth 0.6 in on
 * a four-seamer. Passing a park's air here is legitimate (the altitude test
 * does), but it is then a measurement of that park, not of the published table.
 */
export function measureBreak(
  th: PitchThrow,
  segmentFt: number = BREAK_SEGMENT_FT,
  air: AirConditions = BREAK_REF_AIR,
): { ivbIn: number; hbIn: number; hbArmSideIn: number } {
  const K = aeroScaleFor(air);
  const { release, omega } = solveRelease(th, K);

  // A segment at or beyond the release distance starts AT the release point —
  // `crossingFraction` is half-open at 0 and would never report a crossing on
  // the plane the ball is already sitting on, so this case is handled here
  // rather than returning a silent null from a 54 ft sweep candidate.
  const segStart =
    segmentFt >= RELEASE_D_FT
      ? { state: release, t: 0 }
      : flyToX(release, omega, K, worldXAt(segmentFt));
  const spun = flyToX(release, omega, K, worldXAt(0));
  if (!segStart || !spun) throw new Error('pitch never reached the plate');

  const reference = flyToX(segStart.state, vec3(0, 0, 0), K, worldXAt(0));
  if (!reference) throw new Error('break reference never reached the plate');

  const dz = spun.state.p.z - reference.state.p.z;
  const dy = spun.state.p.y - reference.state.p.y;
  return {
    ivbIn: dz * FT_TO_IN,
    hbIn: dy * FT_TO_IN,
    hbArmSideIn: dy * FT_TO_IN * armSideX(th.hand),
  };
}
