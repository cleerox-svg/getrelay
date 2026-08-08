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
    expect(surfaceAt(HOLE_1, g.d, g.x)).toBe('green');
    expect(surfaceAt(HOLE_1, g.d, g.x + g.r + 1.5)).toBe('fringe'); // collar
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
