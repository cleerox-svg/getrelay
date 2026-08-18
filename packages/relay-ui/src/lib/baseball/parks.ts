// The park as DATA — one file read by the physics AND (at stage 4's scene) by
// the geometry, so the fence you see is the fence you clear.
//
// ⚠ THE POINT OF THIS FILE IS THAT A NEW PARK IS A DATA ENTRY AND ZERO CODE.
// Everything below the data block is generic: the fence interpolation, the roof
// mechanic, the air/wind draw and the batted-ball resolution all read a `Park`
// and branch on nothing. `validatePark()` is run as a test, so bad data is a
// test failure rather than a runtime surprise on someone's phone.
//
// CATEGORY OF THE NUMBERS IN HERE. A park's dimensions are FIXED inputs to the
// physics in exactly the sense the ball's mass is: the trajectory is a function
// of them and nothing is ever fitted TO them. They are chosen by design rather
// than measured off a real park — these are original venues, not clones — which
// is a statement about where the data came from, not a fifth category. No aero
// coefficient, no calibration and no golden anywhere in this game moves when a
// fence moves.
//
// No three, no Math.random, no wall clock. Randomness is a seeded `mulberry32`
// from `lib/golf/wind.ts` (three-free), which is also where `makeWind` lives —
// there is ONE wind sampler in this repo and this file does not write a second.

import { crossingFraction, vec3 } from './airPhysics';
import type { Vec3 } from './airPhysics';
import type { BattedFlight } from './battedBallSim';
import type { AirConditions } from './pitchSim';
import { MPH_TO_FPS } from './units';
import { pchipAt, pchipSlopes } from './pchip';
import { makeWind, mulberry32, windMph } from '../golf/wind';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Roof kind. `retractable` is the only one the player may open or close. */
export type RoofKind = 'none' | 'retractable' | 'fixed';

/**
 * One sampled point on the outfield wall.
 *
 * `bearingDeg` is the SAME angle `zone.sprayAngle` reports: 0 straight to centre
 * field, −45 the left-field foul line, +45 the right-field foul line (+ is the
 * first-base side, matching REPORT +x). Distances are from the plate's rear
 * point — the WORLD origin the batted ball is launched from.
 */
export interface FenceSample {
  bearingDeg: number;
  distFt: number;
  heightFt: number;
}

/**
 * How the open-air wind is drawn. The MAGNITUDE is golf's `makeWind`; this is
 * the per-park shaping of it.
 *
 * FEEL KNOBS, all three — a park's wind rose is a real published quantity but we
 * are not modelling a real park, and nothing in the physics is calibrated
 * against these. What is NOT a feel knob is the channel: the drawn wind becomes
 * a genuine air-relative velocity in `simulateBattedBall`, so turning these up
 * moves real carry.
 *
 * ⚠ THE BEARING FIELD IS NAMED FOR WHAT IT IS, AFTER A REVIEW CAUGHT IT NOT
 * BEING. It used to be called `prevailingDeg` while being the LEAST likely
 * bearing the sampler produced: the old mapping ran golf's `windBearing`
 * (`atan2(cross, along)`) through the window, and golf damps `along` to 0.6× so
 * that `cross` dominates, which piles the mapped bearing up at ±swingDeg/2.
 * Measured over 4000 seeds at Harbourfront (window ±60°): 0° drew 3.1 % and
 * ±30° drew 7.2 % each. That bimodality was an artefact of an upstream damping
 * constant, not a choice anybody made, and a field named "prevailing" that is
 * the rarest outcome is a trap for whoever authors the next park.
 *
 * The bearing is now drawn UNIFORMLY across the window, which is a statement
 * about the WINDOW rather than a distribution this file invented — and it is the
 * honest ceiling on what one draw can express, because golf's underlying angle
 * is uniform on the full circle, so no mapping of it yields a genuine peak
 * without inventing one. `bearingCentreDeg` is therefore the centre and the mean
 * of the window; it is deliberately NOT called a prevailing wind.
 */
export interface WindProfile {
  /** Centre of the bearing window, deg, in `FenceSample.bearingDeg`'s frame. */
  bearingCentreDeg: number;
  /** Half-width of the UNIFORM bearing window about `bearingCentreDeg`, deg. */
  swingDeg: number;
  /** Multiplier on the shared sampler's magnitude. 1.0 ⇒ roughly 1.5–10 mph. */
  gustScale: number;
}

export interface Park {
  id: string;
  name: string;
  elevationFt: number;
  roof: RoofKind;
  /** Height of the roof's underside above the field, ft. 0 iff `roof === 'none'`. */
  roofPeakFt: number;
  /** Sampled fence, −45 (LF line) … 0 (CF) … +45 (RF line), bearings ASCENDING. */
  fence: FenceSample[];
  /**
   * Depth of catchable foul ground beyond the LINES, ft. Read by `fielding.ts`.
   *
   * ⚠ THIS IS NOT THE BACKSTOP, AND CONFLATING THE TWO IS A GAMEPLAY BUG. They
   * were one field until the published profile arrived carrying both numbers,
   * and setting this to the 60 ft backstop made a 437 ft ball 5° foul down the
   * line a CATCH — because the fielding model prices foul ground as a uniform
   * band of this depth running the whole length of the line, where a real park
   * has the stands almost on the line in the corners. Two published numbers,
   * two fields.
   */
  foulTerritoryFt: number;
  /**
   * Distance from the plate's rear point to the backstop, ft. GEOMETRY ONLY —
   * nothing in the physics reads it — but it is park DATA and it lives here for
   * the same reason the fence does: one file, read by the sim and the scene, so
   * the backstop you see is the backstop the park data says it has.
   */
  backstopFt: number;
  /**
   * What stands outside the bowl. GEOMETRY ONLY, and DATA rather than a branch —
   * exactly like `roof`. A downtown park has a city on its horizon and a park at
   * 5200 ft does not, and the difference must be a row in this file rather than
   * an `if (park.id === …)` in a builder.
   */
  surroundings: 'city' | 'none';
  /** Open-roof weather. `closed` is null BECAUSE a closed roof has no wind. */
  wind: { open: WindProfile; closed: null };
}

/** The foul lines, deg. PUBLISHED (rule book: the lines are 90° apart). */
export const FOUL_LINE_DEG = 45;

// ---------------------------------------------------------------------------
// The fence between samples
// ---------------------------------------------------------------------------
//
// A ballpark wall is piecewise SMOOTH, not polygonal. The interpolant is a
// MONOTONE CUBIC HERMITE (Fritsch–Carlson / pchip) — C¹, local and
// overshoot-free — and the full argument for it against a linear and against a
// natural-cubic alternative lives in `pchip.ts`, which is where the numerics
// live. The two properties this file depends on: the wall has no crease at a
// sample bearing, and no bearing ever reports a distance outside the envelope of
// the samples that bound it.

/** The wall at a bearing: distance from the plate and height, both ft. */
export function fenceAt(park: Park, bearingDeg: number): { distFt: number; heightFt: number } {
  const xs = park.fence.map((f) => f.bearingDeg);
  const ds = park.fence.map((f) => f.distFt);
  const hs = park.fence.map((f) => f.heightFt);
  return {
    distFt: pchipAt(xs, ds, pchipSlopes(xs, ds), bearingDeg),
    heightFt: pchipAt(xs, hs, pchipSlopes(xs, hs), bearingDeg),
  };
}

// ---------------------------------------------------------------------------
// The roof — A REAL MECHANIC, NOT DECORATION
// ---------------------------------------------------------------------------
//
// CLOSED ⇒ wind is EXACTLY zero, the temperature is pinned and the humidity is
// pinned, so ρ is a constant and K is a constant and THE PARK IS DETERMINISTIC:
// the same swing gives byte-identical trajectories at every seed. That is a
// gameplay property, not a nicety — it is why ranked play defaults to a closed
// roof, and why the test asserts `=== 0` rather than a tolerance. A "wind" of
// 1e-17 is not deterministic, it is a bug that has not been noticed yet.
//
// OPEN ⇒ the same seeded draw produces a temperature, a humidity and a wind, and
// the wind is a genuine air-relative velocity in the flight (see
// `simulateBattedBall`), not a cosmetic arrow on the HUD.

/** Pinned indoor temperature under a closed roof, °F. FIXED (climate control). */
export const ROOF_CLOSED_TEMP_F = 72;

/** Pinned indoor humidity under a closed roof, 0..1. FIXED (climate control). */
export const ROOF_CLOSED_RH = 0.4;

/** Open-air temperature band, °F. FEEL KNOB (a mild evening ± a season). */
export const OPEN_TEMP_F = 70;
export const OPEN_TEMP_SWING_F = 12;

/** Open-air humidity band, 0..1. FEEL KNOB. */
export const OPEN_RH_MIN = 0.3;
export const OPEN_RH_MAX = 0.8;

/** Is the roof closed, given what the caller asked for? Geometry decides. */
export function roofClosed(park: Park, want: boolean): boolean {
  if (park.roof === 'fixed') return true;
  if (park.roof === 'none') return false;
  return want;
}

export interface ParkConditions {
  air: AirConditions;
  /** WORLD wind velocity, ft/s. HORIZONTAL by construction — see below. */
  windFps: Vec3;
  windSpeedMph: number;
  windBearingDeg: number;
  roofClosed: boolean;
}

/**
 * Draw a park's playing conditions from a seed.
 *
 * ⚠ ONE PRNG. `mulberry32` and `makeWind` are golf's, imported rather than
 * re-implemented; the only thing this file adds is the shaping and the UNIT
 * CONVERSION at the edge. Golf's sampler is unitless in its own arcade space, so
 * its own `windMph` reader is what turns a draw into mph — the same function the
 * golf HUD prints from, which is precisely why it is the right one to reuse
 * instead of inventing a magnitude distribution.
 *
 * ⚠ THE BEARING IS DRAWN HERE AND NOT READ OUT OF GOLF, and `WindProfile`'s note
 * says why: golf's `windBearing` carries golf's own 0.6× along-damping, which
 * made the window's EDGES the likely bearings. It is drawn from the same seeded
 * `mulberry32` stream as the temperature and the humidity — still one PRNG, one
 * seed, one reproducible draw — and uniformly across the window, which needs no
 * knowledge of golf's internals and so cannot be silently re-shaped by a golf
 * retune. `parks.test.ts` pins golf's magnitude readers as a TRIPWIRE for the
 * coupling that remains.
 *
 * ⚠ CHANGING THE DRAW ORDER OR ADDING A CALL RE-ROLLS EVERY SEED. The five draws
 * below (temperature, humidity, `makeWind`'s two, bearing) are one stream, so an
 * insertion anywhere above shifts every downstream draw. That is not a bug, but
 * it does mean the per-seed table in `parks.test.ts` is expected to move.
 *
 * ⚠ THE WIND IS HORIZONTAL, deliberately. `simulateBattedBall` integrates a
 * uniform wind as a Galilean boost into the air frame, which is EXACT for a
 * uniform wind — but only leaves the ground-crossing test unchanged if the wind
 * has no vertical component. Updrafts would need the crossing solved in the
 * boosted frame; they are not modelled and this is where that is written down.
 */
export function parkConditions(park: Park, wantClosed: boolean, seed: number): ParkConditions {
  const closed = roofClosed(park, wantClosed);
  if (closed) {
    return {
      air: { elevFt: park.elevationFt, tempF: ROOF_CLOSED_TEMP_F, rh: ROOF_CLOSED_RH },
      // Literal zeros, produced by no arithmetic at all, so `=== 0` is honest.
      windFps: vec3(0, 0, 0),
      windSpeedMph: 0,
      windBearingDeg: 0,
      roofClosed: true,
    };
  }
  const rng = mulberry32(seed);
  const tempF = OPEN_TEMP_F + (rng() * 2 - 1) * OPEN_TEMP_SWING_F;
  const rh = OPEN_RH_MIN + rng() * (OPEN_RH_MAX - OPEN_RH_MIN);
  const raw = makeWind(rng);
  const speedMph = windMph(raw.along, raw.cross) * park.wind.open.gustScale;
  // Uniform across the park's window: centre ± swing. See the note above.
  const swing = (rng() * 2 - 1) * park.wind.open.swingDeg;
  const bearingDeg = park.wind.open.bearingCentreDeg + swing;
  const b = (bearingDeg * Math.PI) / 180;
  const fps = speedMph * MPH_TO_FPS;
  return {
    air: { elevFt: park.elevationFt, tempF, rh },
    // Bearing → WORLD direction, the same mapping `launchFromAngles` uses:
    // sprayAngle = atan2(v.y, −v.x), so bearing β is (−cos β, sin β, 0).
    windFps: vec3(-Math.cos(b) * fps, Math.sin(b) * fps, 0),
    windSpeedMph: speedMph,
    windBearingDeg: bearingDeg,
    roofClosed: false,
  };
}

// ---------------------------------------------------------------------------
// Where the ball ended up
// ---------------------------------------------------------------------------

export type FenceOutcome = 'homeRun' | 'offWall' | 'inPlay' | 'foul' | 'roof';

export interface FencePlay {
  outcome: FenceOutcome;
  /** Ground distance from the plate to the fence crossing, or to the landing. */
  distFt: number;
  /** Bearing at that same point, deg. */
  bearingDeg: number;
  /** Ball height at the fence plane, ft — null if it never got there. */
  heightAtFenceFt: number | null;
  fenceDistFt: number;
  fenceHeightFt: number;
  hangS: number;
  /** Did the ball reach a CLOSED roof? See the note on the deflection model. */
  hitRoof: boolean;
}

const bearingOf = (x: number, y: number): number => (Math.atan2(y, -x) * 180) / Math.PI;

/**
 * Walk a flight against a park's fence and roof.
 *
 * The crossing is solved ANALYTICALLY on g = r − fence(bearing), the same
 * `crossingFraction` every other event in this game uses: a ball arriving at the
 * wall at 70 mph covers 0.86 ft per substep, and snapping to a substep boundary
 * would quantise a home-run call by most of a foot of wall.
 *
 * ⚠ WHICH 400 A "400 FOOT HOME RUN" MEANS — stated here because this is the
 * function that decides it, and a code reader looks here before he looks at the
 * test. `fence.distFt` is compared against the ball's GROUND DISTANCE AT THE
 * FENCE PLANE, and the wall then has to be cleared in HEIGHT as a second test.
 * That is NOT the same as carry: a ball whose carry is exactly 400 ft lands at
 * the base of a 400 ft wall, and clearing a 10 ft wall at dead centre takes
 * 408.99 ft of carry. `parks.test.ts` prints both columns beside each other and
 * BASEBALL.md § "Home-run resolution" carries the same convention.
 *
 * ⚠ THE ROOF DEFLECTION MODEL, STATED PLAINLY: there isn't one. What is enforced
 * is the DIMENSION — a ball that reaches `roofPeakFt` under a closed roof cannot
 * leave the park, so it can never be scored a home run and is returned as
 * `'roof'` for the caller to play live. The ball's trajectory after the roof
 * plane is left unmodified (it would need a restitution and a panel normal we
 * have no data for), so the landing point of a roof ball is the landing point it
 * would have had — an acknowledged simplification, not an oversight. M1 needs
 * the ceiling to exist and to bite; it does.
 */
export function resolveFence(flight: BattedFlight, park: Park, closed: boolean): FencePlay {
  const { t, x, y, z } = flight.track;
  const hitRoof = closed && park.roofPeakFt > 0 && flight.apexFt >= park.roofPeakFt;

  for (let i = 1; i < t.length; i++) {
    const x0 = x[i - 1] ?? 0;
    const y0 = y[i - 1] ?? 0;
    const x1 = x[i] ?? 0;
    const y1 = y[i] ?? 0;
    const r0 = Math.hypot(x0, y0);
    const r1 = Math.hypot(x1, y1);
    // Skip the first foot off the bat: r ≈ 0 makes the bearing meaningless, and
    // no fence is within a foot of the plate anyway.
    if (r1 < 1) continue;
    const g0 = r0 - fenceAt(park, bearingOf(x0, y0)).distFt;
    const g1 = r1 - fenceAt(park, bearingOf(x1, y1)).distFt;
    const f = g0 < 0 ? crossingFraction(g0, g1, 0) : null;
    if (f === null) continue;

    const px = x0 + (x1 - x0) * f;
    const py = y0 + (y1 - y0) * f;
    const pz = (z[i - 1] ?? 0) + ((z[i] ?? 0) - (z[i - 1] ?? 0)) * f;
    const bearing = bearingOf(px, py);
    const wall = fenceAt(park, bearing);
    const base = {
      distFt: Math.hypot(px, py),
      bearingDeg: bearing,
      heightAtFenceFt: pz,
      fenceDistFt: wall.distFt,
      fenceHeightFt: wall.heightFt,
      hangS: (t[i - 1] ?? 0) + ((t[i] ?? 0) - (t[i - 1] ?? 0)) * f,
      hitRoof,
    };
    if (Math.abs(bearing) > FOUL_LINE_DEG) return { ...base, outcome: 'foul' };
    if (hitRoof) return { ...base, outcome: 'roof' };
    return { ...base, outcome: pz > wall.heightFt ? 'homeRun' : 'offWall' };
  }

  const bearing = bearingOf(flight.landing.x, flight.landing.y);
  const wall = fenceAt(park, bearing);
  const foul = Math.abs(bearing) > FOUL_LINE_DEG;
  return {
    outcome: foul ? 'foul' : hitRoof ? 'roof' : 'inPlay',
    distFt: Math.hypot(flight.landing.x, flight.landing.y),
    bearingDeg: bearing,
    heightAtFenceFt: null,
    fenceDistFt: wall.distFt,
    fenceHeightFt: wall.heightFt,
    hangS: flight.hangS,
    hitRoof,
  };
}

// ---------------------------------------------------------------------------
// The parks — DATA. Add a row, add a park.
// ---------------------------------------------------------------------------

/**
 * ⚠ THE DISPLAY NAME LIVES IN ONE CONSTANT, ON PURPOSE.
 *
 * `SkyDome` is the former official name of a real venue. The trademark risk was
 * raised with the owner — registrations of that mark have historically been
 * maintained and residual goodwill attaches to it — and the owner considered it
 * and decided to ship the name anyway (2026-08-17). It is their product and
 * their risk to price, and this file's job is to make the decision RECORDED and
 * CHEAP TO REVERSE rather than to re-litigate it: reverting is this one line.
 *
 * `ip.test.ts` carries the other half. The guard's real-park list did not
 * mention this name at all, which would have let the NEXT legacy name through
 * silently; it is now listed as banned WITH a dated, owner-signed exception, so
 * a future reader sees a decision instead of an oversight.
 *
 * ⚠ THE PARK ID DOES NOT MOVE. `id: 'harbourfront'` is a persistence key —
 * leaderboards, saved sessions and `?park=` URLs are all written against it —
 * so only the display name changes. That is also why the exported symbol below
 * is still `HARBOURFRONT`.
 */
export const SKYDOME_NAME = 'SkyDome';

/**
 * M1's home park. A downtown retractable-roof stadium.
 *
 * ⚠ THE FENCE IS ASYMMETRIC AND EVERY NUMBER IN IT IS PUBLISHED DATA — seven
 * stations of distance AND wall height, plus a 60 ft backstop. A published
 * dimension is a FACT, the same category as the ball's mass, and nothing in the
 * physics is ever fitted to one. BASEBALL.md § "The park" carries the profile
 * table, the argument for the bearings and the gameplay consequence.
 *
 * ⚠ **REFERENCE UNVERIFIED — and this flag is owed on the repo's own standard.**
 * `C_L`'s lift fit, `C_D`'s subcritical branch, the fielder reaction time and
 * the 95 ft infield arc all carry a "reference unverified" note, because this
 * repo's rule is that a number promoted to FACT names where it came from. This
 * profile does not, and it is worth flagging twice over:
 *
 *   • no citation is attached to it anywhere, so "published data" is currently a
 *     claim about provenance that nothing in the tree supports;
 *   • it is NOT the profile usually quoted for the venue whose name this park
 *     carries. The commonly-quoted asymmetric figures are 328 / 368 / 381 / 400
 *     / 372 / 359 / 328 with 8 ft at dead centre and 14 ft 4 in on the left
 *     line — which is what is written above, so if that IS the intended source
 *     the discrepancy is nil and only the citation is missing; and if it is not,
 *     the whole column needs a source before anyone calls it a fact.
 *
 * Nothing here is CHANGED on the strength of that: these numbers are inputs to
 * the physics exactly as the ball's mass is, `parks.test.ts` pins golden fence
 * distances against them, and moving one to chase an unverified reference would
 * be the exact mistake `BREAK_SEGMENT_FT`'s note exists to prevent. The flag is
 * the fix. Confirm the source before publication.
 *
 * ⚠ THE BEARINGS ARE OURS, THE DISTANCES ARE NOT. The profile names positions
 * ("LC alley"), not angles, so the seven are placed at EVEN 15° intervals in
 * the order the profile lists them — no invented precision. What the ORDER does
 * fix is that the distances are monotone on each half with dead centre the
 * strict maximum, so Fritsch–Carlson's zero slope at an extremum puts the
 * park's deepest point exactly on the published 400 ft.
 *
 * ⚠ THE HEIGHT COLUMN INVERTS THE USUAL ASSUMPTION — dead centre is the LOWEST
 * wall on the field (8 ft) while both corners are over 12 and left is over 14 —
 * and it is the first park that makes `pchip.ts` earn its keep: every knot used
 * to carry a uniform 10 ft, so the height interpolant was reproducing a
 * constant. Four local extrema in this column is the case Fritsch–Carlson was
 * chosen for, and `parks.test.ts` asserts no bearing reports a wall outside the
 * envelope of the two knots bounding it.
 */
export const HARBOURFRONT: Park = {
  id: 'harbourfront',
  name: SKYDOME_NAME,
  elevationFt: 250,
  roof: 'retractable',
  roofPeakFt: 282,
  // Heights written as ft + in/12 so the published inches stay legible in the
  // source rather than surviving only as a decimal somebody has to reverse.
  fence: [
    { bearingDeg: -45, distFt: 328, heightFt: 14 + 4 / 12 }, // LF line
    { bearingDeg: -30, distFt: 368, heightFt: 11 + 2 / 12 }, // LC
    { bearingDeg: -15, distFt: 381, heightFt: 12 + 9 / 12 }, // LC alley
    { bearingDeg: 0, distFt: 400, heightFt: 8 }, // CF
    { bearingDeg: 15, distFt: 372, heightFt: 10 + 9 / 12 }, // RC alley
    { bearingDeg: 30, distFt: 359, heightFt: 14 + 4 / 12 }, // RC
    { bearingDeg: 45, distFt: 328, heightFt: 12 + 7 / 12 }, // RF line
  ],
  // Little foul ground down the lines (28 ft) but a deep 60 ft backstop — the
  // two published numbers this park's data used to collapse into one.
  foulTerritoryFt: 28,
  backstopFt: 60,
  surroundings: 'city',
  wind: { open: { bearingCentreDeg: 0, swingDeg: 60, gustScale: 1 }, closed: null },
};

/**
 * The altitude park — deliberately in the data set so that ALTITUDE IS DERIVED
 * and can be measured. Thin air reaches the ball through ρ → K and nothing else;
 * there is no park factor here and there must never be one. Deeper fences and a
 * higher wall because that is what a park at 5200 ft has to do, not because
 * anything in the physics knows where it is.
 */
export const ALPINE_HEIGHTS: Park = {
  id: 'alpine',
  name: 'Alpine Heights',
  elevationFt: 5200,
  roof: 'none',
  roofPeakFt: 0,
  fence: [
    { bearingDeg: -45, distFt: 347, heightFt: 8 },
    { bearingDeg: -20, distFt: 390, heightFt: 16 },
    { bearingDeg: 0, distFt: 415, heightFt: 8 },
    { bearingDeg: 20, distFt: 375, heightFt: 8 },
    { bearingDeg: 45, distFt: 350, heightFt: 8 },
  ],
  foulTerritoryFt: 22,
  backstopFt: 44,
  surroundings: 'none',
  wind: { open: { bearingCentreDeg: 10, swingDeg: 90, gustScale: 1.2 }, closed: null },
};

export const PARKS: Park[] = [HARBOURFRONT, ALPINE_HEIGHTS];

export const parkById = (id: string): Park | undefined => PARKS.find((p) => p.id === id);
