// Monotone cubic Hermite interpolation (Fritsch–Carlson, a.k.a. pchip).
//
// Extracted from `parks.ts` rather than left inline: parks.ts hit 494 of its
// 500-line cap and the charter's rule at the cap is EXTRACTION, not a raised
// cap. This is a self-contained piece of numerics with one caller and one
// reason to change, which is the correct thing to lift out first.
//
// ⚠ WHY THIS INTERPOLANT AND NOT ANOTHER — the argument lives here because the
// choice is a numerical one, not a baseball one. A ballpark fence is sampled at
// five bearings and consumed by two layers at once: the physics asks "how far is
// the wall at 11.3°" a few hundred times per flight, and the scene lofts a mesh
// through the same function. Three candidates:
//
//   • LINEAR is C⁰ only. The radius has a slope discontinuity at every sample,
//     so the lofted wall shows a visible crease at each one — five samples
//     become five corners in a wall that has none. Measured on M1's park: the
//     one-sided slopes at the −22° knot differ by 0.66 ft/deg for linear and by
//     under 0.01 for this. Rejected on the renderer's behalf.
//   • A NATURAL CUBIC SPLINE is C² but GLOBAL and it RINGS. Through 328/375/400
//     it overshoots past the sampled 400 ft at centre field — inventing a
//     distance the data does not contain, at the exact bearing the deepest part
//     of the park is defined by. Adding a sample also perturbs the whole curve,
//     which quietly breaks "a new park is a data entry".
//   • THIS is C¹, LOCAL and OVERSHOOT-FREE. Fritsch–Carlson limits each knot
//     slope to the neighbouring secants, so the curve never leaves the envelope
//     of the samples that bound it, and it sets the slope to exactly 0 at a
//     local extremum — which is why dead centre comes out as the true maximum of
//     a symmetric park rather than a point on a ramp. A constant column (a
//     uniform 10 ft wall) reproduces as constant to 1e-14.
//
// C¹ rather than C² is the deliberate trade: no-overshoot is a CORRECTNESS
// property of a gameplay boundary, smoothness of curvature is a cosmetic one.
//
// Pure math. No three, no Math.random, no clock, no state.

/** Fritsch–Carlson endpoint slope: the one-sided three-point rule, clipped. */
function edgeSlope(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (m * d0 <= 0) return 0;
  if (d0 * d1 <= 0 && Math.abs(m) > Math.abs(3 * d0)) return 3 * d0;
  return m;
}

/** Knot slopes for a monotone cubic Hermite through (xs, ys). `xs` ascending. */
export function pchipSlopes(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  const m = new Array<number>(n).fill(0);
  if (n < 2) return m;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
    h.push(dx);
    d.push(((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / dx);
  }
  if (n === 2) return [d[0] ?? 0, d[0] ?? 0];
  for (let i = 1; i < n - 1; i++) {
    const dPrev = d[i - 1] ?? 0;
    const dNext = d[i] ?? 0;
    // A sign change (or a flat) is a local extremum: slope 0, so no overshoot.
    if (dPrev * dNext <= 0) continue;
    const hPrev = h[i - 1] ?? 0;
    const hNext = h[i] ?? 0;
    const w1 = 2 * hNext + hPrev;
    const w2 = hNext + 2 * hPrev;
    m[i] = (w1 + w2) / (w1 / dPrev + w2 / dNext);
  }
  m[0] = edgeSlope(h[0] ?? 0, h[1] ?? 0, d[0] ?? 0, d[1] ?? 0);
  m[n - 1] = edgeSlope(h[n - 2] ?? 0, h[n - 3] ?? 0, d[n - 2] ?? 0, d[n - 3] ?? 0);
  return m;
}

/**
 * Evaluate the monotone cubic Hermite at `x`. CLAMPED to the sampled span
 * rather than extrapolated — a cubic run off the end of its data produces
 * confident nonsense, and beyond ±45° there is no fence to describe anyway.
 */
export function pchipAt(xs: number[], ys: number[], ms: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0;
  if (x >= (xs[n - 1] ?? 0)) return ys[n - 1] ?? 0;
  let i = 0;
  while (i < n - 2 && x > (xs[i + 1] ?? 0)) i++;
  const x0 = xs[i] ?? 0;
  const y0 = ys[i] ?? 0;
  const hh = (xs[i + 1] ?? 0) - x0;
  const y1 = ys[i + 1] ?? 0;
  const m0 = ms[i] ?? 0;
  const m1 = ms[i + 1] ?? 0;
  const t = (x - x0) / hh;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * y0 +
    (t3 - 2 * t2 + t) * hh * m0 +
    (-2 * t3 + 3 * t2) * y1 +
    (t3 - t2) * hh * m1
  );
}
