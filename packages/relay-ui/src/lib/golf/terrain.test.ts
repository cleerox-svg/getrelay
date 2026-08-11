// Headless harness for the course terrain + hole model (lib/golf/terrain.ts).
// Proves the pieces the rendered mesh and the (coming) course physics both rely
// on: elevation + slope sampling, lie classification, and — the point of
// "physics-coupled slopes" — that a ball rolling on a tilted surface actually
// BREAKS, a downhill grade RUNS OUT further than an uphill one, and a dead-flat
// hole reproduces slope-free roll to the yard (so wiring terrain into the sim
// can't silently move the tuned flat behavior). Tune slopes against THIS.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import {
  HOLE_1,
  heightAt,
  gradientAt,
  slopeAccel,
  surfaceAt,
  corridorHalfAt,
  corridorEdgeDist,
  fairwayEdgeDist,
  edgeRadius,
  edgeNoise,
  featureSeed,
  greenPadRadius,
  maxGreenPadRadius,
  EDGE_WOBBLE,
  type CourseHole,
} from './terrain';
import { GRAVITY, ROLL_FRICTION } from './rangeSim';

// A minimal 2D roller: friction bleed + downhill slope acceleration, integrated
// on the sim's fixed step, until it rests. Returns the path so tests can measure
// break (lateral drift) and run-out (total distance). This mirrors how a
// terrain-aware grounded step integrates — the model the course sim will use.
function roll(
  hole: CourseHole,
  start: { d: number; x: number; vd: number; vx: number },
  friction = ROLL_FRICTION,
): { d: number; x: number; dist: number; drift: number } {
  const dt = 1 / 120;
  let { d, x, vd, vx } = start;
  const x0 = x;
  let travelled = 0;
  let guard = 0;
  while (guard++ < 20000) {
    const { ad, ax } = slopeAccel(hole, d, x, GRAVITY);
    vd += ad * dt;
    vx += ax * dt;
    const decay = Math.pow(friction, dt * 60);
    vd *= decay;
    vx *= decay;
    const nd = d + vd * dt;
    const nx = x + vx * dt;
    travelled += Math.hypot(nd - d, nx - x);
    d = nd;
    x = nx;
    if (Math.hypot(vd, vx) <= 1.5) break;
  }
  return { d, x, dist: travelled, drift: x - x0 };
}

// A perfectly flat hole (no hills, no grade, no green raise/tilt) — the
// regression baseline: gradient is ~0 everywhere, so terrain must not bend it.
const FLAT: CourseHole = {
  ...HOLE_1,
  green: { ...HOLE_1.green, raise: 0, tiltPct: 0, undulation: 0 },
  hazards: [],
  terrain: { seed: 1, hilliness: 0, hillScale: 40, teeElev: 5, greenElev: 5 },
};

describe('terrain elevation + slope', () => {
  it('a back-to-front green tilts the fall line toward the front', () => {
    const g = HOLE_1.green;
    // Behind the pin sits higher than in front of it (back-to-front fall).
    const back = heightAt(HOLE_1, g.d + 8, g.x);
    const front = heightAt(HOLE_1, g.d - 8, g.x);
    expect(back).toBeGreaterThan(front);
    // The MEAN downrange gradient across the green interior is positive (uphill
    // toward the back), so a ball is pushed toward the front (−d) — the break.
    // Averaged over the surface because interior undulation makes any single
    // point legitimately noisy; it's the net tilt that breaks a putt.
    let sum = 0;
    let n = 0;
    for (let dd = -8; dd <= 8; dd += 4) {
      for (let dx = -8; dx <= 8; dx += 4) {
        sum += gradientAt(HOLE_1, g.d + dd, g.x + dx).gd;
        n++;
      }
    }
    expect(sum / n).toBeGreaterThan(0.02);
  });

  it('a bunker basin dishes the ground down and gathers toward its middle', () => {
    const b = HOLE_1.hazards.find((h) => h.kind === 'bunker')!;
    expect(heightAt(HOLE_1, b.d, b.x)).toBeLessThan(heightAt(HOLE_1, b.d, b.x + b.r + 5));
    // Inside the basin the slope points inward (toward the low middle).
    const { gx } = gradientAt(HOLE_1, b.d, b.x + b.r * 0.5);
    expect(gx).toBeGreaterThan(0); // uphill points +x (outward) → ball rolls −x, inward
  });

  it('the flat baseline hole is level (near-zero slope everywhere sampled)', () => {
    for (const [d, x] of [
      [40, 0],
      [200, -10],
      [360, 8],
      [500, 16],
    ] as [number, number][]) {
      const { gd, gx } = gradientAt(FLAT, d, x);
      expect(Math.abs(gd)).toBeLessThan(1e-6);
      expect(Math.abs(gx)).toBeLessThan(1e-6);
    }
  });
});

describe('terrain surface classification', () => {
  it('classifies each lie of the showcase hole', () => {
    const g = HOLE_1.green;
    // Green + fringe edges are ORGANIC, so probe against the ACTUAL wobbled radii
    // at +x (angle 0): inside the green, in the collar band, then beyond it.
    const seed = featureSeed(g.d, g.x);
    const gR0 = edgeRadius(seed, 0, g.r);
    const fR0 = edgeRadius(seed, 0, g.r + HOLE_1.fringeW);
    expect(surfaceAt(HOLE_1, g.d, g.x)).toBe('green');
    expect(surfaceAt(HOLE_1, g.d, g.x + gR0 * 0.5)).toBe('green'); // well inside
    expect(surfaceAt(HOLE_1, g.d, g.x + (gR0 + fR0) / 2)).toBe('fringe'); // collar band
    expect(surfaceAt(HOLE_1, g.d, g.x + fR0 + 3)).toBe('rough'); // beyond the collar
    expect(surfaceAt(HOLE_1, 180, -6)).toBe('fairway'); // on the centerline
    expect(surfaceAt(HOLE_1, 180, -6 + HOLE_1.roughHalf - 2)).toBe('rough'); // off corridor
    expect(surfaceAt(HOLE_1, 180, 200)).toBe('ob'); // way off
    expect(surfaceAt(HOLE_1, 300, 20)).toBe('bunker'); // fairway bunker centre
    expect(surfaceAt(HOLE_1, 478, 16)).toBe('water'); // pond guarding the approach
    expect(surfaceAt(HOLE_1, 20, -30)).toBe('cartpath'); // cart path
    expect(surfaceAt(HOLE_1, 0, 0)).toBe('tee'); // tee box
  });

  it('the fringe collar always separates the green from a green-side hazard', () => {
    // Sweep a ray from the green centre out through the front-right greenside
    // bunker. Between the green and the sand there MUST be a fringe band and the
    // green must never touch the bunker directly (the crispness guarantee).
    const g = HOLE_1.green;
    const bunker = HOLE_1.hazards.find((h) => h.kind === 'bunker' && h.d > 480)!;
    const dirD = (bunker.d - g.d) / dist(g, bunker);
    const dirX = (bunker.x - g.x) / dist(g, bunker);
    let prev = 'green';
    const seen: string[] = ['green'];
    for (let r = 0; r <= dist(g, bunker) + bunker.r; r += 0.25) {
      const s = surfaceAt(HOLE_1, g.d + dirD * r, g.x + dirX * r);
      if (s !== prev) {
        seen.push(s);
        prev = s;
      }
    }
    // The lie sequence outward is green → fringe → (rough/fairway/...) → bunker,
    // and green is NEVER immediately followed by bunker.
    expect(seen[0]).toBe('green');
    expect(seen[1]).toBe('fringe');
    expect(seen).toContain('bunker');
    for (let i = 1; i < seen.length; i++) {
      if (seen[i] === 'bunker') expect(seen[i - 1]).not.toBe('green');
    }
  });

  it('the fairway corridor tapers narrower toward the green (fairwayTaper)', () => {
    // Half-width shrinks from tee (t=0) to green (t=1).
    expect(corridorHalfAt(HOLE_1, 0)).toBeCloseTo(16, 6);
    expect(corridorHalfAt(HOLE_1, 1)).toBeCloseTo(13, 6);
    // A point 14.5 yd off the spine is fairway near the tee but rough near the
    // green — the SAME offset flips because the corridor pinches.
    expect(surfaceAt(HOLE_1, 60, -2 + 14.5)).toBe('fairway'); // spine ~x=-2 near tee
    expect(surfaceAt(HOLE_1, 455, 15.57 + 14.5)).toBe('rough'); // spine ~x=15.6 near green
  });
});

function dist(a: { d: number; x: number }, b: { d: number; x: number }): number {
  return Math.hypot(a.d - b.d, a.x - b.x);
}

describe('organic feature edges (irregular outlines)', () => {
  it('edgeRadius varies with angle — the outline is NOT a circle', () => {
    const seed = featureSeed(100, 25);
    const radii: number[] = [];
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) radii.push(edgeRadius(seed, a, 10));
    const min = Math.min(...radii);
    const max = Math.max(...radii);
    // A real wobble: the radius spans a meaningful range around the base (not a
    // flat circle), yet stays within the ±EDGE_WOBBLE envelope.
    expect(max - min).toBeGreaterThan(0.5); // clearly non-circular
    expect(min).toBeGreaterThanOrEqual(10 * (1 - EDGE_WOBBLE) - 1e-9);
    expect(max).toBeLessThanOrEqual(10 * (1 + EDGE_WOBBLE) + 1e-9);
  });

  it('is deterministic and continuous/periodic (no seam at 0/2π)', () => {
    const seed = featureSeed(42, -13);
    // Same seed + angle → identical (reproducible for screenshots/tests).
    expect(edgeRadius(seed, 1.234, 8)).toBe(edgeRadius(seed, 1.234, 8));
    // Periodic: angle 0 and 2π land on the same radius (no discontinuity/seam).
    expect(edgeNoise(seed, 0)).toBeCloseTo(edgeNoise(seed, Math.PI * 2), 10);
    expect(edgeRadius(seed, 0.3, 9)).toBeCloseTo(edgeRadius(seed, 0.3 + Math.PI * 2, 9), 10);
    // Different features get different wobble (distinct seeds).
    expect(edgeNoise(featureSeed(300, 20), 0.7)).not.toBeCloseTo(
      edgeNoise(featureSeed(476, 15), 0.7),
      6,
    );
  });

  it('the green never touches a hazard even at the WORST-case wobble (margin)', () => {
    // Each green-side hazard's centre must clear the wobbled fringe by its own
    // wobbled radius: dist ≥ (greenPadRadius + hazard.r)·(1+EDGE_WOBBLE).
    const g = HOLE_1.green;
    for (const hz of HOLE_1.hazards) {
      const gap = Math.hypot(hz.d - g.d, hz.x - g.x);
      const required = maxGreenPadRadius(HOLE_1) + hz.r * (1 + EDGE_WOBBLE);
      // Fairway hazards are far; greenside ones must still clear with margin.
      if (gap < required + 50) {
        expect(gap).toBeGreaterThanOrEqual(required);
      }
    }
    // Sanity: the classifier confirms it — sweeping the whole green edge, the
    // first non-green/fringe lie encountered outward is NEVER a hazard.
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 90) {
      const dirD = Math.sin(a);
      const dirX = Math.cos(a);
      let prev: string = 'green';
      for (let r = 0; r <= greenPadRadius(HOLE_1) * (1 + EDGE_WOBBLE) + 6; r += 0.25) {
        const s = surfaceAt(HOLE_1, g.d + dirD * r, g.x + dirX * r);
        if ((s === 'bunker' || s === 'water') && prev === 'green') {
          throw new Error(`green abuts ${s} at angle ${a}`);
        }
        prev = s;
      }
    }
  });

  it('the pin sits inside the MIN (wobbled-in) green radius', () => {
    const g = HOLE_1.green;
    const gap = Math.hypot(HOLE_1.pin.d - g.d, HOLE_1.pin.x - g.x);
    expect(gap).toBeLessThan(g.r * (1 - EDGE_WOBBLE));
  });
});

describe('slope-coupled roll (the point of physics-coupled terrain)', () => {
  it('a putt across a tilted green BREAKS toward the low side', () => {
    const g = HOLE_1.green;
    // Roll straight across the green (in +x) from the low front-left quadrant; a
    // back-to-front tilt should pull the ball toward the front (−d) as it goes.
    const r = roll(HOLE_1, { d: g.d, x: g.x - 8, vd: 0, vx: 9 }, 0.985);
    // It curved downhill (its downrange position moved toward the front, −d).
    expect(r.d).toBeLessThan(g.d - 0.5);
  });

  it('a downhill grade runs out further than the same shot uphill', () => {
    // HOLE_1 rises tee→green (teeElev 6 → greenElev 9). Roll the same speed
    // DOWN the grade (−d, toward the tee) vs UP it (+d) on the fairway, away from
    // features, and compare distance travelled.
    const downhill = roll(HOLE_1, { d: 240, x: -2, vd: -26, vx: 0 });
    const uphill = roll(HOLE_1, { d: 240, x: -2, vd: 26, vx: 0 });
    expect(downhill.dist).toBeGreaterThan(uphill.dist);
  });

  it('flat terrain adds no break or run bias (regression guard)', () => {
    // On the flat baseline, a straight roll stays straight and up/down are equal.
    const straight = roll(FLAT, { d: 240, x: 0, vd: 24, vx: 0 });
    expect(Math.abs(straight.drift)).toBeLessThan(1e-6);
    const down = roll(FLAT, { d: 240, x: 0, vd: -24, vx: 0 });
    const up = roll(FLAT, { d: 240, x: 0, vd: 24, vx: 0 });
    expect(Math.abs(down.dist - up.dist)).toBeLessThan(1e-6);
  });
});

// ---------------------------------------------------------------------------
// Corner bevel — the fairway corridor is bevel-clamped at interior centerline
// vertices so the OUTSIDE of a dogleg no longer balloons (the round distance-to-
// polyline cap). These guard the invariants: straight holes byte-identical, the
// perpendicular width stays ~constant through a bend, and the INSIDE of the bend
// never gaps. See fairwayEdgeDist() in terrain.ts.
// ---------------------------------------------------------------------------

// The plain (pre-bevel) corridor rule, replicated here so a test can prove a
// point that USED to be fairway (round cap) is now rough — a real before/after.
function plainNearest(pts: { d: number; x: number }[], d: number, x: number) {
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
    segLen.push(l);
    total += l;
  }
  const inv = total > 0 ? 1 / total : 0;
  let best = Infinity;
  let bestT = 0;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const vd = b.d - a.d;
    const vx = b.x - a.x;
    const len2 = vd * vd + vx * vx || 1e-6;
    let t = ((d - a.d) * vd + (x - a.x) * vx) / len2;
    t = Math.max(0, Math.min(1, t));
    const cd = a.d + vd * t;
    const cx = a.x + vx * t;
    const dd = Math.hypot(d - cd, x - cx);
    if (dd < best) {
      best = dd;
      bestT = (acc + t * segLen[i]!) * inv;
    }
    acc += segLen[i]!;
  }
  return { dist: best, t: bestT };
}

// A STRAIGHT (collinear) hole — centerline straight down +d — with a taper, no
// hazards/cart path, green + tee well clear of the sampled corridor region.
const STRAIGHT: CourseHole = {
  ...HOLE_1,
  tee: { d: 0, x: 0 },
  pin: { d: 320, x: 0 },
  centerline: [
    { d: 0, x: 0 },
    { d: 160, x: 0 },
    { d: 320, x: 0 },
  ],
  fairwayHalf: 16,
  fairwayTaper: -3,
  roughHalf: 40,
  green: { ...HOLE_1.green, d: 320, x: 0 },
  hazards: [],
  cartPath: undefined,
};

// A sharp ~45° dogleg-LEFT with a UNIFORM corridor (no taper) so half-widths are
// exactly the base 16 and the corner geometry is clean to measure. Corner at
// V=(220,0); leg 2 heads down-left at 45°.
const DOGLEG: CourseHole = {
  ...HOLE_1,
  tee: { d: 0, x: 0 },
  pin: { d: 430, x: -210 },
  centerline: [
    { d: 0, x: 0 },
    { d: 220, x: 0 },
    { d: 430, x: -210 },
  ],
  fairwayHalf: 16,
  fairwayTaper: 0,
  roughHalf: 44,
  green: { ...HOLE_1.green, d: 430, x: -210 },
  hazards: [],
  cartPath: undefined,
};

// Fairway half-width (yd) from a centerline point C, cast PERPENDICULAR to the
// local direction `dir`, on side `sign` (+1 / −1 of the left normal). The first
// r where fairwayEdgeDist crosses out of the corridor.
function perpHalfWidth(
  hole: CourseHole,
  c: { d: number; x: number },
  dir: { d: number; x: number },
  sign: number,
): number {
  const nd = -dir.x * sign; // rot90(dir) * sign  (left normal, flipped by sign)
  const nx = dir.d * sign;
  let last = 0;
  for (let r = 0; r <= hole.roughHalf; r += 0.1) {
    if (fairwayEdgeDist(hole, c.d + nd * r, c.x + nx * r) <= 0) last = r;
    else break;
  }
  return last;
}

describe('terrain corridor — corner bevel', () => {
  it('STRAIGHT holes are byte-identical (bevel is inert on a collinear centerline)', () => {
    // (a) The signed edge equals the plain distance-to-polyline − half everywhere.
    // (b) surfaceAt fairway/rough/ob labels match the pre-bevel rule exactly.
    for (let d = 15; d <= 250; d += 5) {
      for (let x = -45; x <= 45; x += 2.5) {
        const near = plainNearest(STRAIGHT.centerline, d, x);
        const half = corridorHalfAt(STRAIGHT, near.t);
        const plainEdge = near.dist - half;
        // (a) edge distance identical to the plain formula (no bevel contribution).
        expect(fairwayEdgeDist(STRAIGHT, d, x)).toBeCloseTo(plainEdge, 9);
        // (b) classification identical to the plain corridor rule.
        const ref = plainEdge <= 0 ? 'fairway' : near.dist <= STRAIGHT.roughHalf ? 'rough' : 'ob';
        expect(surfaceAt(STRAIGHT, d, x)).toBe(ref);
      }
    }
    // corridorEdgeDist (the render feather) tracks the same identical value.
    expect(corridorEdgeDist(STRAIGHT, 120, 10)).toBeCloseTo(fairwayEdgeDist(STRAIGHT, 120, 10), 9);
  });

  it('a slightly-angled leg (no bend at a vertex) is still unbeveled on the legs', () => {
    // Points on the interior of a leg (not in any vertex wedge) are unchanged: the
    // bevel only fires in the outside wedge of a bent vertex.
    for (let d = 20; d <= 180; d += 10) {
      for (const x of [-14, -8, 0, 8, 14]) {
        const near = plainNearest(DOGLEG.centerline, d, x);
        // On leg 1 (straight down d, before the corner) the nearest point is a
        // segment interior, so the edge equals the plain value.
        expect(fairwayEdgeDist(DOGLEG, d, x)).toBeCloseTo(near.dist - 16, 9);
      }
    }
  });

  it('the OUTSIDE-of-corner overhang that was fairway is now rough (the bulge is gone)', () => {
    // Scan the OUTSIDE of the bend (+x, past V=(220,0)) for points that the plain
    // round-cap rule classified as FAIRWAY (dist ≤ half) but the bevel now trims
    // to rough. There must be a real band of them, and every one must be rough.
    let flipped = 0;
    for (let d = 221; d <= 240; d += 0.5) {
      for (let x = 6; x <= 16; x += 0.5) {
        const wasFairway = plainNearest(DOGLEG.centerline, d, x).dist <= 16;
        const nowFairway = fairwayEdgeDist(DOGLEG, d, x) <= 0;
        if (wasFairway && !nowFairway) {
          flipped++;
          // The classifier agrees it is rough (not a hazard/green here).
          expect(surfaceAt(DOGLEG, d, x)).toBe('rough');
        }
      }
    }
    // The overhang was substantial — many texels flip fairway→rough.
    expect(flipped).toBeGreaterThan(20);
  });

  it('perpendicular fairway width stays ~constant through the bend (no balloon)', () => {
    // Sample centerline points spanning the corner; measure the perpendicular
    // half-width on BOTH sides. Every side stays within a tight band around the
    // base 16 — before the bevel the OUTSIDE side ballooned past the cap here.
    const half = 16;
    const samples: { c: { d: number; x: number }; dir: { d: number; x: number } }[] = [
      { c: { d: 120, x: 0 }, dir: { d: 1, x: 0 } }, // leg 1
      { c: { d: 200, x: 0 }, dir: { d: 1, x: 0 } }, // leg 1, near corner
      { c: { d: 215, x: 0 }, dir: { d: 1, x: 0 } }, // leg 1, right at corner
      { c: { d: 250, x: -30 }, dir: { d: 1, x: -1 } }, // leg 2, near corner
      { c: { d: 300, x: -80 }, dir: { d: 1, x: -1 } }, // leg 2
    ];
    for (const s of samples) {
      const dl = Math.hypot(s.dir.d, s.dir.x);
      const dir = { d: s.dir.d / dl, x: s.dir.x / dl };
      // With rot90(dir)=(−dir.x, dir.d), +1 is the LEFT normal. For this left
      // dogleg the OUTSIDE of the bend is +x, which is the +1 (left-normal) side.
      const wOutside = perpHalfWidth(DOGLEG, s.c, dir, +1);
      const wInside = perpHalfWidth(DOGLEG, s.c, dir, -1);
      // The OUTSIDE never balloons past the base half-width (the fix): before the
      // bevel the round cap pushed it well past 16 near the corner.
      expect(wOutside).toBeLessThanOrEqual(half + 0.5);
      // Neither side pinches to nothing through the bend (guardrail 3). The INSIDE
      // may exceed `half` — that's the natural elbow fill, not a bulge — but it is
      // bounded (never runs off toward OB).
      expect(wOutside).toBeGreaterThan(half * 0.6);
      expect(wInside).toBeGreaterThan(half * 0.6);
      expect(wInside).toBeLessThanOrEqual(half / Math.sin(Math.PI / 8) + 1); // < ~42.8
    }
  });

  it('a RIGHT dogleg (cross>0) bevels its OUTSIDE the same way (sign mirror)', () => {
    // Mirror of the left-dogleg overhang + width checks. Corner V=(220,0); leg 2
    // heads down-RIGHT at 45°, so the OUTSIDE of the bend is −x.
    const DR: CourseHole = {
      ...DOGLEG,
      pin: { d: 430, x: 210 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: 0 },
        { d: 430, x: 210 },
      ],
      green: { ...HOLE_1.green, d: 430, x: 210 },
    };
    // Overhang on −x (outside) that WAS fairway (round cap) is now rough.
    let flipped = 0;
    for (let d = 221; d <= 240; d += 0.5) {
      for (let x = -16; x <= -6; x += 0.5) {
        const wasFairway = plainNearest(DR.centerline, d, x).dist <= 16;
        const nowFairway = fairwayEdgeDist(DR, d, x) <= 0;
        if (wasFairway && !nowFairway) {
          flipped++;
          expect(surfaceAt(DR, d, x)).toBe('rough');
        }
      }
    }
    expect(flipped).toBeGreaterThan(20);
    // Perpendicular width band: the OUTSIDE (−x) never balloons; inside not pinched.
    const half = 16;
    const samples: { c: { d: number; x: number }; dir: { d: number; x: number } }[] = [
      { c: { d: 200, x: 0 }, dir: { d: 1, x: 0 } }, // leg 1, near corner
      { c: { d: 215, x: 0 }, dir: { d: 1, x: 0 } }, // leg 1, right at corner
      { c: { d: 250, x: 30 }, dir: { d: 1, x: 1 } }, // leg 2, near corner
    ];
    for (const s of samples) {
      const dl = Math.hypot(s.dir.d, s.dir.x);
      const dir = { d: s.dir.d / dl, x: s.dir.x / dl };
      // For a RIGHT bend the outside is −x, which is the −1 (right-normal) side.
      const wOutside = perpHalfWidth(DR, s.c, dir, -1);
      const wInside = perpHalfWidth(DR, s.c, dir, +1);
      expect(wOutside).toBeLessThanOrEqual(half + 0.5);
      expect(wOutside).toBeGreaterThan(half * 0.6);
      expect(wInside).toBeGreaterThan(half * 0.6);
    }
  });

  it('the nearest-feature guard keeps a later leg fairway in an earlier vertex wedge', () => {
    // A synthetic HAIRPIN whose 3rd leg loops back into the OUTER WEDGE of the
    // FIRST corner V1=(200,0). A point on leg 3 there is genuinely fairway (leg 3
    // is its nearest feature), but it also satisfies V1's wedge test — without the
    // nearest-feature guard V1's bevel would punch it to rough (a fairway hole in
    // an unrelated spot). The guard (|P−V1| > near.dist ⇒ skip) prevents that.
    const HAIRPIN: CourseHole = {
      ...DOGLEG,
      pin: { d: 260, x: -30 },
      centerline: [
        { d: 0, x: 0 },
        { d: 200, x: 0 }, // V1
        { d: 200, x: 80 }, // V2 (leg 2 goes +x)
        { d: 260, x: -30 }, // leg 3 loops back down across V1's outer wedge (d>200, x<0)
      ],
      green: { ...HOLE_1.green, d: 260, x: -30, r: 10 },
      hazards: [],
    };
    const V1 = HAIRPIN.centerline[1]!;
    // P sits on leg 3, inside V1's outer wedge (d>200, x<0), far from V1.
    const P = { d: 250, x: -15 };
    const near = plainNearest(HAIRPIN.centerline, P.d, P.x);
    // (i) It IS in V1's outer wedge: tin≥1 (past leg1 end) and tout≤0 (before leg2).
    expect(P.d / 200).toBeGreaterThanOrEqual(1); // tin on leg1 (0,0)->(200,0)
    expect(P.x / 80).toBeLessThanOrEqual(0); // tout on leg2 (200,0)->(200,80)
    // (ii) V1 is NOT the nearest feature — leg 3 is much closer, so the guard fires.
    expect(Math.hypot(P.d - V1.d, P.x - V1.x)).toBeGreaterThan(near.dist + 1e-6);
    // (iii) …so the point stays FAIRWAY (guard suppressed V1's spurious bevel).
    expect(near.dist).toBeLessThanOrEqual(16); // genuinely within the corridor
    expect(fairwayEdgeDist(HAIRPIN, P.d, P.x)).toBeLessThanOrEqual(0);
    expect(surfaceAt(HAIRPIN, P.d, P.x)).toBe('fairway');
    // CONTROL: a real overhang whose nearest feature IS V1 is still beveled to
    // rough — the guard only suppresses spurious FAR-vertex clips, not real ones.
    const Q = { d: 212, x: -10 };
    expect(plainNearest(HAIRPIN.centerline, Q.d, Q.x).dist).toBeLessThanOrEqual(16);
    expect(fairwayEdgeDist(HAIRPIN, Q.d, Q.x)).toBeGreaterThan(0);
  });

  it('the corridor stays CONTINUOUS along the centerline (no inside gap)', () => {
    // Walk the centerline tee→green; every point is fairway (the bevel never
    // punches a hole in the corridor, in particular not on the inside of the bend).
    const pts = DOGLEG.centerline;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      for (let t = 0; t <= 1; t += 0.02) {
        const d = a.d + (b.d - a.d) * t;
        const x = a.x + (b.x - a.x) * t;
        // Skip the very ends (tee disc / green pad own those points).
        if (d < 8 || d > 420) continue;
        expect(fairwayEdgeDist(DOGLEG, d, x)).toBeLessThan(0);
      }
    }
    // The INSIDE of the elbow (−x side of a left bend, toward the turn) stays
    // filled — no fairway→rough→fairway gap on a perpendicular scan across it.
    const inside: { d: number; x: number }[] = [];
    for (let x = -2; x >= -30; x -= 1) inside.push({ d: 232, x });
    let sawRough = false;
    let roughThenFairway = false;
    for (const p of inside) {
      const isFair = fairwayEdgeDist(DOGLEG, p.d, p.x) <= 0;
      if (!isFair) sawRough = true;
      else if (sawRough) roughThenFairway = true; // fairway AFTER rough = a gap
    }
    expect(roughThenFairway).toBe(false);
  });
});
