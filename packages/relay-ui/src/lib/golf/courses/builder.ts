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
  type CircleFeature,
  type CourseHole,
  type GreenDef,
  type Pt,
} from '../terrain';
import { greenRollDecel } from '../greenPhysics';
import { GRAVITY } from '../rangeSim';
import type { GolfCourse } from './types';

// The max slope (rise/run) a resting putt can hold, derived from the REAL green
// calibration (Stimpmeter μ·g / g = μ ≈ 0.0611 at stimp 10) rather than a magic
// number — see greenPhysics.ts. A green whose tiltPct + undulation exceeds this
// would let NO putt come to rest (the green design guard, GOLF.md), so it is the
// hard cap validateHole() enforces on authored greens.
export const MU = greenRollDecel(GRAVITY) / GRAVITY;

function dist(a: { d: number; x: number }, b: { d: number; x: number }): number {
  return Math.hypot(a.d - b.d, a.x - b.x);
}

// --- Authoring helpers -----------------------------------------------------

// Default-filler for a CourseHole so the data files only spell out what makes a
// hole distinctive. Sensible defaults: tee at d=0/x=0, a 16-yd fairway half-
// width, roughHalf = fairwayHalf + 22, a 4-yd fringe collar, no hazards, no
// wind. Anything provided in `h` overrides. (roughHalf's default reads h's
// fairwayHalf, so a hole that widens/narrows the fairway still gets a sane rough
// band unless it sets roughHalf explicitly.)
export interface HoleInput {
  id: number;
  par: number;
  yards: number;
  name?: string;
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
    fringeW: 4,
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

// --- Validation ------------------------------------------------------------

// Return a list of human-readable invariant violations for one hole ([] = good).
// Encodes the terrain.ts authoring contract:
//   • tee at d=0 (world-scale convention);
//   • centerline strictly downrange-ordered (increasing d);
//   • the pin sits inside the MIN (wobbled-in) green so the cup is always on the
//     putting surface: dist(pin,green) < green.r·(1−EDGE_WOBBLE);
//   • the green holds a putt: tiltPct + undulation ≤ μ (the green design guard);
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

  if (g.tiltPct + g.undulation > MU + 1e-9) {
    errs.push(
      `${tag}: green too steep to hold a putt — tiltPct+undulation=${(g.tiltPct + g.undulation).toFixed(4)} > μ=${MU.toFixed(4)}`,
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
