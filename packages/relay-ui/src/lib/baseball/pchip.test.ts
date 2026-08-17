// The interpolator bench.
//
// ⚠ WHY THIS FILE EXISTS, WRITTEN DOWN SO IT IS NOT DELETED AGAIN. `pchip.ts`
// shipped with NO test of its own: the only assertion that could see the
// interpolant at all was `parks.test.ts`'s "it is not secretly linear" line, and
// a review measured how thin that was. Zeroing every INTERIOR knot slope (i.e.
// deleting Fritsch–Carlson and keeping the Hermite basis) moves Harbourfront's
// fence by up to 4.97 ft and Alpine's by 5.33; zeroing ALL of them, endpoints
// included, moves Harbourfront by 6.54 ft and Alpine's WALL HEIGHT by 2.67 ft —
// and the whole 124-test suite still passed either way. A 5 ft error in fence
// distance is a home run that isn't.
//
// So this file asserts the PROPERTIES that make Fritsch–Carlson the right choice
// and that a wrong implementation loses — interpolation, no-overshoot, locality,
// zero slope at an extremum, exact reproduction of a straight line — and then
// pins three OFF-KNOT fence distances as goldens, because every property above
// is still true of an interpolant with the wrong slopes in it.
//
// Pure numerics. The park-shaped end of it is at the bottom.

import { describe, expect, it } from 'vitest';
import { pchipAt, pchipSlopes } from './pchip';
import { ALPINE_HEIGHTS, fenceAt, HARBOURFRONT } from './parks';
import { mulberry32 } from '../golf/wind';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/** Evaluate through the public pair, the way `fenceAt` does. */
const at = (xs: number[], ys: number[], x: number) => pchipAt(xs, ys, pchipSlopes(xs, ys), x);

/**
 * The rejected alternative, computed here so the contrast is MEASURED rather
 * than asserted: the same cubic Hermite basis with UNLIMITED three-point knot
 * slopes (the Catmull–Rom rule). It interpolates every knot and is C¹ too — the
 * single thing it does not do is respect the data's envelope.
 */
function unlimitedHermite(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  const m = xs.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(n - 1, i + 1);
    return ((ys[hi] ?? 0) - (ys[lo] ?? 0)) / ((xs[hi] ?? 0) - (xs[lo] ?? 0));
  });
  return pchipAt(xs, ys, m, x);
}

// ---------------------------------------------------------------------------

describe('pchip: the properties the choice rests on', () => {
  it('interpolates every knot exactly, and CLAMPS outside the sampled span', () => {
    const xs = [-45, -22, 0, 22, 45];
    const ys = [328, 375, 400, 375, 328];
    for (let i = 0; i < xs.length; i++) {
      expect(at(xs, ys, xs[i] ?? 0)).toBe(ys[i]);
    }
    // Clamped, not extrapolated — a cubic run off the end of its data produces
    // confident nonsense, and there is no fence out there to describe anyway.
    expect(at(xs, ys, -1000)).toBe(328);
    expect(at(xs, ys, 1000)).toBe(328);
    expect(at(xs, ys, -45.0001)).toBe(328);
  });

  it('reproduces a STRAIGHT LINE exactly — the property a wrong knot slope loses', () => {
    // On collinear data every secant is equal, so Fritsch–Carlson's weighted
    // harmonic mean must return that same slope at every interior knot and the
    // three-point endpoint rule must return it at both ends. Any interpolant
    // that gets a knot slope wrong — including the one that sets them all to
    // zero — puts a visible wobble through data that has none.
    const xs = [-45, -22, 0, 22, 45];
    const line = (x: number) => 300 + 1.5 * x;
    const ys = xs.map(line);
    const ms = pchipSlopes(xs, ys);
    for (const m of ms) expect(m).toBeCloseTo(1.5, 12);
    let worst = 0;
    for (let x = -45; x <= 45; x += 0.1) worst = Math.max(worst, Math.abs(at(xs, ys, x) - line(x)));
    log(`\n[PCHIP] a straight line through 5 knots is reproduced to ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-12);

    // ...and unequal spacing must not break it either: the weights are in `h`.
    const ux = [-45, -30, -7, 3, 45];
    const uy = ux.map(line);
    for (const m of pchipSlopes(ux, uy)) expect(m).toBeCloseTo(1.5, 12);
    for (let x = -45; x <= 45; x += 0.1) expect(at(ux, uy, x)).toBeCloseTo(line(x), 10);
  });

  it('NEVER OVERSHOOTS the data, where an unlimited Hermite does', () => {
    // The correctness property of a gameplay boundary: on every interval the
    // curve stays inside the envelope of the two samples that bound it, so no
    // bearing ever reports a distance the data does not contain.
    const check = (xs: number[], ys: number[]) => {
      for (let i = 0; i < xs.length - 1; i++) {
        const lo = Math.min(ys[i] ?? 0, ys[i + 1] ?? 0);
        const hi = Math.max(ys[i] ?? 0, ys[i + 1] ?? 0);
        for (let t = 0; t <= 1; t += 0.02) {
          const x = (xs[i] ?? 0) + ((xs[i + 1] ?? 0) - (xs[i] ?? 0)) * t;
          const y = at(xs, ys, x);
          expect(y).toBeGreaterThanOrEqual(lo - 1e-12);
          expect(y).toBeLessThanOrEqual(hi + 1e-12);
        }
      }
    };

    // A step with flat shoulders — the shape that makes an unlimited slope ring.
    const xs = [0, 1, 2, 3];
    const ys = [0, 0, 1, 1];
    check(xs, ys);
    let under = 0;
    for (let x = 0; x <= 1; x += 0.01) under = Math.min(under, unlimitedHermite(xs, ys, x));
    log(
      `[PCHIP] 0,0,1,1: pchip stays in [0,1]; the unlimited Hermite dips to ${under.toFixed(4)} ` +
        `— a wall with a hole in it\n`,
    );
    expect(under).toBeLessThan(-0.02);

    // ...and it holds for arbitrary data, not just the shape that was picked.
    // Seeded, so this is a property test and not a flake.
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const rx = [0];
      for (let i = 1; i < 6; i++) rx.push((rx[i - 1] ?? 0) + 0.5 + rng()); // strictly ascending
      check(rx, rx.map(() => rng() * 100));
    }
  });

  it('sets the slope to EXACTLY 0 at a local extremum — dead centre is the true max', () => {
    // This is why a symmetric park's deepest point is centre field rather than a
    // point on a ramp, and it is the same clause that forbids the overshoot.
    const xs = [-45, -22, 0, 22, 45];
    const ys = [328, 375, 400, 375, 328];
    const ms = pchipSlopes(xs, ys);
    expect(ms[2]).toBe(0);
    expect(at(xs, ys, 0)).toBe(400);
    for (const dx of [0.01, 0.1, 1, 5]) {
      expect(at(xs, ys, dx)).toBeLessThan(400);
      expect(at(xs, ys, -dx)).toBeLessThan(400);
    }
    // A flat interior run is an extremum too (the secant is 0 on one side).
    expect(pchipSlopes([0, 1, 2, 3], [5, 7, 7, 9])[1]).toBe(0);
    expect(pchipSlopes([0, 1, 2, 3], [5, 7, 7, 9])[2]).toBe(0);
    // A CONSTANT column comes back constant to 1e-14 — every slope is exactly
    // 0 and what is left is the Hermite basis summing to 1, so the residual is
    // a rounding error rather than the dip a ringing interpolant would put in a
    // uniform wall.
    const flat = [10, 10, 10, 10, 10];
    for (const m of pchipSlopes(xs, flat)) expect(m).toBe(0);
    for (let x = -45; x <= 45; x += 1) expect(Math.abs(at(xs, flat, x) - 10)).toBeLessThan(1e-14);
  });

  it('is LOCAL: one moved sample cannot move the curve past its second neighbour', () => {
    // The property that makes "a new park is a data entry" true. A natural cubic
    // spline is global — moving one sample perturbs the whole curve — so adding
    // a fence sample there would quietly move fence distances 60° away.
    const xs = [0, 1, 2, 3, 4, 5, 6];
    const ys = [10, 12, 15, 15, 13, 12, 10];
    const moved = ys.map((y, i) => (i === 3 ? y + 1 : y));
    let touchedOutside = 0;
    for (let x = 0; x <= 1; x += 0.05) {
      touchedOutside = Math.max(touchedOutside, Math.abs(at(xs, ys, x) - at(xs, moved, x)));
    }
    for (let x = 5; x <= 6; x += 0.05) {
      touchedOutside = Math.max(touchedOutside, Math.abs(at(xs, ys, x) - at(xs, moved, x)));
    }
    const inside = Math.abs(at(xs, ys, 3.5) - at(xs, moved, 3.5));
    log(
      `[PCHIP] moving one knot by 1.0: the curve moves ${inside.toFixed(4)} beside it and ` +
        `${touchedOutside.toExponential(1)} beyond its second neighbour\n`,
    );
    expect(touchedOutside).toBe(0);
    expect(inside).toBeGreaterThan(0.5);
  });

  it('degenerate inputs do not throw and do not invent data', () => {
    expect(pchipSlopes([], [])).toEqual([]);
    expect(pchipSlopes([1], [7])).toEqual([0]);
    expect(pchipAt([], [], [], 3)).toBe(0);
    expect(pchipAt([1], [7], [0], 3)).toBe(7);
    // Two knots is the linear case, exactly: both slopes are the one secant.
    expect(pchipSlopes([0, 10], [5, 25])).toEqual([2, 2]);
    for (let x = 0; x <= 10; x += 0.5) expect(at([0, 10], [5, 25], x)).toBeCloseTo(5 + 2 * x, 12);
  });
});

// ---------------------------------------------------------------------------

describe('the goldens that make a wrong knot slope FAIL', () => {
  it('⚠ GOLDEN: off-knot fence distances, to 1e-6 ft', () => {
    // ⚠ EVERY PROPERTY ABOVE IS ALSO TRUE OF AN INTERPOLANT WITH THE WRONG
    // SLOPES IN IT — zeroed interior slopes still interpolate, still never
    // overshoot, still peak at dead centre and are still local. What they are
    // not is THIS curve. These are model output frozen (GOLDEN), not published
    // data: their only job is that a change to `pchipSlopes` shows up as a diff
    // in the one quantity the game reads. They are quoted at OFF-KNOT bearings
    // because on a knot every interpolant in the world agrees.
    //
    // Measured cost of the mutations these kill, RE-MEASURED against the
    // published seven-knot wall (the old figures were the symmetric five-knot
    // one and did not survive the data change): zeroing the interior slopes
    // moves the home park's fence by up to 2.91 ft (at −35.00°) and its wall
    // HEIGHT by 0.46 ft, and Alpine's fence by 5.33; zeroing every slope moves
    // the home park 6.66 ft / 0.82 ft of height and Alpine's height 2.67 ft.
    //
    // ⚠ THE HEIGHT COLUMN NOW MOVES AT THE HOME PARK AT ALL, which it could not
    // before — a uniform 10 ft wall reproduces itself under any slopes, which is
    // why the height half of these goldens used to be the literal 10 in every
    // row and proved nothing. Seven published heights with four local extrema
    // is the first data in this repo that the height interpolant can get wrong.
    const rows: Array<[string, number, number, number]> = [
      ['harbourfront', -33, 363.040302, 11.318667],
      ['harbourfront', -12, 384.952, 12.256],
      ['harbourfront', 12, 377.18478, 10.065684],
      ['alpine', -33, 369.327781, 14.096384],
      ['alpine', -12, 402.9454, 13.184],
      ['alpine', 12, 392.968, 8],
    ];
    let table = '\n[GOLDEN OFF-KNOT FENCE]\n  park          bearing     dist ft    height ft\n';
    for (const [id, bearing, dist, height] of rows) {
      const park = id === 'harbourfront' ? HARBOURFRONT : ALPINE_HEIGHTS;
      const w = fenceAt(park, bearing);
      table += `  ${id.padEnd(14)}${String(bearing).padStart(5)}°  ${w.distFt
        .toFixed(6)
        .padStart(11)}  ${w.heightFt.toFixed(6).padStart(11)}\n`;
      expect(w.distFt, `${id} @ ${bearing}°`).toBeCloseTo(dist, 6);
      expect(w.heightFt, `${id} @ ${bearing}° height`).toBeCloseTo(height, 6);
    }
    log(table);
  });
});
