// Course builder + hole authoring helpers + the validator that enforces the
// terrain.ts invariants for every authored hole. The hole DATA files (augusta,
// listowel-*) call hole()/greensideHazard() to stay terse and defineCourse() to
// build the container; courses.test.ts runs validateCourse() as a hard gate so a
// mis-authored hole (pin off the green, green too steep to hold a putt, a hazard
// eating the fringe) fails loudly rather than shipping.

import {
  EDGE_WOBBLE,
  maxGreenPadRadius,
  corridorHalfAt,
  heightAt,
  surfaceAt,
  type CircleFeature,
  type CourseHole,
  type GreenDef,
  type HoleBloom,
  type Pt,
} from '../terrain';
import { greenRollDecel } from '../greenPhysics';
import { GRAVITY } from '../rangeSim';
import type { GolfCourse } from './types';

// The max slope (rise/run) a resting putt can hold, derived from the REAL green
// calibration (Stimpmeter μ·g / g = μ ≈ 0.0611 at stimp 10) rather than a magic
// number — see greenPhysics.ts. Where the PUTTING SURFACE is steeper than this a
// dead ball rolls off on its own (the green design guard, GOLF.md), so it is the
// hard cap validateHole() enforces — measured on the surface, see
// maxGreenGradient() below.
export const MU = greenRollDecel(GRAVITY) / GRAVITY;

function dist(a: { d: number; x: number }, b: { d: number; x: number }): number {
  return Math.hypot(a.d - b.d, a.x - b.x);
}

// --- Authoring helpers -----------------------------------------------------

// Default-filler for a CourseHole so the data files only spell out what makes a
// hole distinctive. Sensible defaults: tee at d=0/x=0, a 16-yd fairway half-
// width, roughHalf = fairwayHalf + 22, a 1-yd fringe collar, no hazards, no
// wind. Anything provided in `h` overrides. (roughHalf's default reads h's
// fairwayHalf, so a hole that widens/narrows the fairway still gets a sane rough
// band unless it sets roughHalf explicitly.)
export interface HoleInput {
  id: number;
  par: number;
  yards: number;
  name?: string;
  // Optional flowering canopy (render-only) — see terrain.ts "THE CANOPY".
  bloom?: HoleBloom;
  tee?: Pt;
  pin: Pt;
  centerline: Pt[];
  fairwayHalf?: number;
  fairwayTaper?: number;
  roughHalf?: number;
  green: GreenDef;
  fringeW?: number;
  hazards?: CircleFeature[];
  cartPath?: { pts: Pt[]; half: number };
  terrain: CourseHole['terrain'];
  wind?: { along: number; cross: number };
}

export function hole(h: HoleInput): CourseHole {
  const fairwayHalf = h.fairwayHalf ?? 16;
  return {
    tee: { d: 0, x: 0 },
    fairwayHalf,
    roughHalf: h.roughHalf ?? fairwayHalf + 22,
    fringeW: 1,
    hazards: [],
    wind: { along: 0, cross: 0 },
    ...h,
  };
}

// Place a green-side hazard (bunker or pond) at the MINIMUM safe distance from
// the green centre so it always clears the wobbled fringe pad (the terrain.ts
// invariant) with a small margin, no hand arithmetic. `bearingDeg` is where it
// sits relative to the green: 0 = right (+x), 90 = behind (+d), 180 = left (−x),
// −90 = front (toward the tee, −d). A water carry short of the green is
// bearingDeg −90; a front-right greenside bunker is −45; back-left is 135.
export function greensideHazard(
  green: GreenDef,
  fringeW: number,
  opts: {
    kind: CircleFeature['kind'];
    r: number;
    depth: number;
    bearingDeg: number;
    gap?: number;
  },
): CircleFeature {
  const minDist =
    (green.r + fringeW) * (1 + EDGE_WOBBLE) + opts.r * (1 + EDGE_WOBBLE) + (opts.gap ?? 1.5);
  const rad = (opts.bearingDeg * Math.PI) / 180;
  return {
    kind: opts.kind,
    r: opts.r,
    depth: opts.depth,
    d: green.d + Math.sin(rad) * minDist,
    x: green.x + Math.cos(rad) * minDist,
  };
}

// --- Course assembly -------------------------------------------------------

// Build a GolfCourse from meta + holes, DERIVING par and yards from the holes so
// the scorecard totals can never disagree with the hole data.
export function defineCourse(
  meta: { id: string; name: string; location?: string },
  holes: CourseHole[],
): GolfCourse {
  return {
    ...meta,
    holes,
    par: holes.reduce((a, h) => a + h.par, 0),
    yards: holes.reduce((a, h) => a + h.yards, 0),
  };
}

// --- The green design guard (measured, not arithmetic) ---------------------

// Samples per green RADIUS along each axis of the sampling grid. 20 gives a
// ~0.75 yd grid on a 15 yd green — an order finer than the 12 yd wavelength of
// the interior undulation field and far finer than the yards-wide pad overruns
// this exists to catch. Grid count is scale-invariant: the on-surface sample
// count is ≈ π·GREEN_SAMPLES_PER_R² ≈ 1256 on every green, whatever its radius.
const GREEN_SAMPLES_PER_R = 20;

// Below this many on-surface samples the measurement is not a measurement. A
// green that lands here has degenerate geometry (or the sampler has rotted) and
// must fail rather than pass with nothing checked.
const MIN_GREEN_SAMPLES = 400;

// The central-difference half-step (yd) the slope is measured over. Deliberately
// the SAME 0.5 that terrain.gradientAt uses, because that is the slope the ball
// actually feels each grounded substep — this guard must measure the physics'
// own view of the surface, not a sharper idealisation of it.
const GRAD_EPS = 0.5;

/**
 * The steepest slope (rise/run) anywhere on a hole's PUTTING SURFACE, plus where
 * it is and how many points were actually measured.
 *
 * ⚠ WHY THIS IS WRITTEN OUT LONGHAND. It replaces `tiltPct + undulation ≤ μ`,
 * which was a units error (a gradient added to a YARD amplitude) and, worse,
 * never looked at the surface: it over-charged an author ~4× for undulation
 * while completely missing a greenside pond whose grading skirt ran onto the
 * green and left a 0.26 slope on the putting surface — 4× μ, i.e. ground a dead
 * ball cannot rest on.
 *
 * So the measure is stated INDEPENDENTLY of the height model's own internals:
 * the mask is `surfaceAt(...) === 'green'` (the lie the player is actually
 * given, whose green test is its own radius comparison), and the slope is a
 * central difference on `heightAt` written out here rather than imported. In
 * particular it must NOT be expressed in terms of whatever blend `heightAt` uses
 * to fade its pads — if the guard and the pad shared that helper, a wrong pad
 * and a wrong assertion would agree by construction and a sign error in either
 * would pass. `checked` is returned for the same reason: an empty sweep is the
 * one way this rots silently, so callers assert on it.
 */
export function maxGreenGradient(h: CourseHole): {
  slope: number;
  at: Pt;
  checked: number;
} {
  const g = h.green;
  // ⚠ BAIL BEFORE DIVIDING BY THE RADIUS. The step below is g.r/N, so the exact
  // degenerate green MIN_GREEN_SAMPLES exists to catch — r ≤ 0 — is the one that
  // makes the step zero and the loop never terminate. A guard that HANGS the
  // suite instead of failing it is not a guard, so return the empty measurement
  // and let the caller report `checked = 0`.
  if (!(g.r > 0)) return { slope: 0, at: { d: g.d, x: g.x }, checked: 0 };
  // The green edge is organic, so sweep the bounding box of its WORST-case
  // outward bulge and let the classifier decide what is green.
  const reach = g.r * (1 + EDGE_WOBBLE);
  const step = g.r / GREEN_SAMPLES_PER_R;
  let slope = 0;
  let at: Pt = { d: g.d, x: g.x };
  let checked = 0;
  for (let dd = -reach; dd <= reach; dd += step) {
    for (let dx = -reach; dx <= reach; dx += step) {
      const d = g.d + dd;
      const x = g.x + dx;
      if (surfaceAt(h, d, x) !== 'green') continue;
      const gd = (heightAt(h, d + GRAD_EPS, x) - heightAt(h, d - GRAD_EPS, x)) / (2 * GRAD_EPS);
      const gx = (heightAt(h, d, x + GRAD_EPS) - heightAt(h, d, x - GRAD_EPS)) / (2 * GRAD_EPS);
      const m = Math.hypot(gd, gx);
      checked++;
      if (m > slope) {
        slope = m;
        at = { d, x };
      }
    }
  }
  return { slope, at, checked };
}

// --- Validation ------------------------------------------------------------

// Return a list of human-readable invariant violations for one hole ([] = good).
// Encodes the terrain.ts authoring contract:
//   • tee at d=0 (world-scale convention);
//   • centerline strictly downrange-ordered (increasing d);
//   • the pin sits inside the MIN (wobbled-in) green so the cup is always on the
//     putting surface: dist(pin,green) < green.r·(1−EDGE_WOBBLE);
//   • the green holds a putt: the MEASURED max |gradient| anywhere on the
//     putting surface ≤ μ (the green design guard — see maxGreenGradient);
//   • every hazard clears the wobbled green pad: dist(hazard,green) ≥
//     maxGreenPadRadius(hole) + hazard.r·(1+EDGE_WOBBLE);
//   • plus a few structural sanity checks (rough wider than fairway, etc).
export function validateHole(h: CourseHole): string[] {
  const errs: string[] = [];
  const tag = `hole ${h.id}`;

  if (h.tee.d !== 0) errs.push(`${tag}: tee.d must be 0 (got ${h.tee.d})`);

  if (h.centerline.length < 2) {
    errs.push(`${tag}: centerline needs at least 2 points`);
  } else {
    for (let i = 1; i < h.centerline.length; i++) {
      if (h.centerline[i]!.d <= h.centerline[i - 1]!.d) {
        errs.push(
          `${tag}: centerline must be strictly downrange-ordered (point ${i} d=${h.centerline[i]!.d} ≤ ${h.centerline[i - 1]!.d})`,
        );
      }
    }
  }

  const g = h.green;
  const pinGap = dist(h.pin, g);
  if (pinGap >= g.r * (1 - EDGE_WOBBLE)) {
    errs.push(
      `${tag}: pin must be inside the min wobbled green — dist(pin,green)=${pinGap.toFixed(2)} ≥ green.r·(1−EDGE_WOBBLE)=${(g.r * (1 - EDGE_WOBBLE)).toFixed(2)}`,
    );
  }

  // THE GREEN DESIGN GUARD, measured on the actual putting surface (see
  // maxGreenGradient). Everything that shapes the green's height is in this
  // number — the planar tilt, the interior undulation, the surviving whisper of
  // hills, and any hazard/pad grading that reaches the surface.
  const gm = maxGreenGradient(h);
  if (gm.checked < MIN_GREEN_SAMPLES) {
    errs.push(
      `${tag}: green slope guard measured only ${gm.checked} on-surface samples (< ${MIN_GREEN_SAMPLES}) — the green is degenerate or unclassifiable`,
    );
  } else if (gm.slope > MU + 1e-9) {
    errs.push(
      `${tag}: green too steep to hold a putt — max |gradient| on the putting surface=${gm.slope.toFixed(4)} > μ=${MU.toFixed(4)} at d=${gm.at.d.toFixed(1)} x=${gm.at.x.toFixed(1)} (${gm.checked} samples)`,
    );
  }

  const maxPad = maxGreenPadRadius(h);
  for (let i = 0; i < h.hazards.length; i++) {
    const hz = h.hazards[i]!;
    const required = maxPad + hz.r * (1 + EDGE_WOBBLE);
    const gap = dist(hz, g);
    if (gap < required) {
      errs.push(
        `${tag}: hazard ${i} (${hz.kind}) too close to green — dist=${gap.toFixed(2)} < required=${required.toFixed(2)}`,
      );
    }
  }

  // Structural sanity.
  if (g.r <= 0) errs.push(`${tag}: green.r must be positive`);
  if (h.fringeW <= 0) errs.push(`${tag}: fringeW must be positive`);
  if (h.roughHalf <= corridorHalfAt(h, 1) || h.roughHalf <= corridorHalfAt(h, 0)) {
    errs.push(`${tag}: roughHalf must exceed the fairway half-width along the corridor`);
  }
  if (h.par < 3 || h.par > 5) errs.push(`${tag}: par ${h.par} out of range (3..5)`);
  if (h.yards <= 0) errs.push(`${tag}: yards must be positive`);

  return errs;
}

// Validate every hole of a course; [] = all good.
export function validateCourse(c: GolfCourse): string[] {
  return c.holes.flatMap((h) => validateHole(h));
}
