// Per-round wind generation, promoted out of RangeGame so both the Range and
// (a later pass) the Course can share ONE wind model. Deliberately three-free
// and sim-free so the non-lazy HUD wrappers (RangeGame / CourseGame) can import
// it without pulling `three` into the main bundle.
//
// Values are yd/s^2 accelerations in the sim's world space: `cross` moves the
// ball L/R in flight (+right), `along` is a head/tail component (+downrange).
// Both RangeGame and CourseGame import makeWind from here (one wind model).

export interface Wind {
  along: number;
  cross: number;
}

/**
 * One round wind. `mag` ~1..4; along is damped to 0.6× so cross dominates.
 * Takes an optional RNG (`() => number` in [0,1)) so a Course round can be
 * driven off a DETERMINISTIC seed — two players in an async challenge derive
 * the SAME wind. Defaults to Math.random for the existing random behaviour, so
 * this is fully backward-compatible.
 */
export function makeWind(rng: () => number = Math.random): Wind {
  const mag = 1 + rng() * 3;
  const ang = rng() * Math.PI * 2;
  return { along: Math.sin(ang) * mag * 0.6, cross: Math.cos(ang) * mag };
}

/**
 * Turn a numeric seed into a deterministic RNG (`() => number` in [0,1)).
 * A tiny mulberry32 — three-free / sim-free, so this file stays importable by
 * the non-lazy HUD wrappers without pulling `three` into the main bundle.
 * (terrain.ts is seeded too but exports no `() => number` generator to reuse,
 * so we keep a local one here.)
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
