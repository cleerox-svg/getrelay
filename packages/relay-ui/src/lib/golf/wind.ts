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

/** One random round wind. `mag` ~1..4; along is damped to 0.6× so cross dominates. */
export function makeWind(): Wind {
  const mag = 1 + Math.random() * 3;
  const ang = Math.random() * Math.PI * 2;
  return { along: Math.sin(ang) * mag * 0.6, cross: Math.cos(ang) * mag };
}
