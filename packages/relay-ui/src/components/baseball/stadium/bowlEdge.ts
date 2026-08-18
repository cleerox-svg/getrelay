// THE BOWL'S PLAN — where the seating bowl's inner edge and its front rail are,
// as a function of bearing and of PARK DATA alone.
//
// Extracted from `stands.ts` at the 500-line cap when the centre-field recess
// and the periodicity repair landed. Extraction, not a raised cap, and the seam
// is a real one: this file answers "where is the edge", `stands.ts` answers "how
// is it built". `field.ts` needs the first and not the second — the turf past
// the foul lines runs to `bowlInnerRadiusFt` so the grass ends exactly where the
// seating starts — and it was reaching into the builder's module to get it.
//
// ⚠ THE BOWL'S INNER EDGE IS DERIVED, NOT DRAWN BY EYE. In fair territory it is
// the wall, `fenceAt(park, β).distFt`. Behind the foul lines it is the OFFSET
// CURVE of the fair wedge at `park.foulTerritoryFt` — the locus of points that
// far from the nearest playable ground, which is precisely what "depth of
// catchable foul ground" means. For a wedge that offset has a closed form:
//
//   • within 90° of a foul line, the nearest feature is the LINE, and the
//     perpendicular distance from a point at bearing β is `r·sin(|β| − 45)`,
//     so the boundary is `r = foulTerritoryFt / sin(|β| − 45)`;
//   • past 90° the projection onto the line runs negative, the nearest feature
//     is the APEX (the plate), and the boundary is the circle `r = foulTerritoryFt`.
//
// Clamped by the wall distance at the line, since the stands cannot be further
// out than the fence they meet, and clamped from BELOW by `park.backstopFt`,
// because the backstop distance and the depth of foul ground down the lines are
// two different published numbers and this park's are 60 ft and 28 ft. The clamp
// crosses over at |β| ≈ 72.8°, which is exactly where a real bowl's corner turns
// behind the plate.

import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import type { Park } from '../../../lib/baseball/parks';
import { DEG } from './geom';

/** See the header: the wall in fair territory, the foul-ground offset outside it. */
export function bowlInnerRadiusFt(park: Park, bearingDeg: number): number {
  const a = Math.abs(bearingDeg);
  if (a <= FOUL_LINE_DEG) return fenceAt(park, bearingDeg).distFt;
  // ⚠ NOT BLENDED, UNLIKE `wallTopFt`, AND THE REASON IS THAT A BLEND HERE
  // CANNOT BE KILLED BY ANY INPUT. This clamp has the same `Math.sign` shape the
  // rail HEIGHT did — Alpine's two lines are 347 and 350 ft, so it is 3 ft
  // discontinuous at ±180 in principle — and a blend to the mean was written,
  // tested, and REMOVED again when the mutation would not die: the backstop
  // clamp on the next line takes over at |β| ≈ 72.8° (Harbourfront) and 75°
  // (Alpine) and holds a CONSTANT all the way to 180°, so `atLine` is not read
  // anywhere near the seam in either park. An unkillable clamp is exactly what
  // this function deleted once already (see the `Math.min` note below), and
  // adding a second one because it "looks safer" is how the first got there.
  // If a park ever ships a backstop deep enough for the offset curve to reach
  // 180°, this needs the same blend `wallTopFt` has — and `geom.ring`'s closure
  // will make it a slanted quad rather than a hole in the meantime.
  const atLine = fenceAt(park, FOUL_LINE_DEG * Math.sign(bearingDeg || 1)).distFt;
  const past = a - FOUL_LINE_DEG;
  // ⚠ ONE MIN AND ONE MAX, AND THERE USED TO BE A SECOND MIN. This read
  // `Math.min(atLine, …)` inside the offset AND again on the way out, so
  // deleting the outer one changed nothing anywhere — a mutation that cannot be
  // killed by any input, which is the shape `fielding.ts`'s unreachable
  // `Math.max(0, …)` had. The dead clamp is gone; each of the two that remain is
  // now observable, and `stands.test.ts` watches both fail.
  const offset = past >= 90 ? park.foulTerritoryFt : park.foulTerritoryFt / Math.sin(past * DEG);
  // Never further out than the wall it meets at the line, and never nearer the
  // plate than the park's own backstop — 328 ft and 60 ft here, against 28 ft of
  // foul-ground depth, which is why those last two are separate fields.
  return Math.min(atLine, Math.max(park.backstopFt, offset));
}

/**
 * Wall height at a bearing — the front rail the bowl is lofted from.
 *
 * ⚠ IT IS PERIODIC, AND THAT IS A BUG FIX WITH A MEASUREMENT BEHIND IT. This
 * used to hold the value at `FOUL_LINE_DEG * Math.sign(bearing)` outside fair
 * territory, which is discontinuous at ±180: `Math.sign(−180)` picks the LEFT
 * line and `Math.sign(+180)` the RIGHT one, and this park's two lines are 14 ft
 * 4 in and 12 ft 7 in. So the bowl's front rail met itself **1.75 ft out of
 * register** at bearing ±180 — which is directly behind the plate, i.e. the
 * middle of the `pitcher` frame, where the gate measured it as a 53 px step in
 * the bowl foot (y = 389 → 336 across x = 448 → 452, at 61.5 px/deg and 115 ft:
 * 1.7 ft, dead on). `stands.ts` had the TEXTURE mitigation for a seam at ±180
 * and no geometric one.
 *
 * The rail therefore blends from the near line's own height at ±45° to the MEAN
 * of the two at ±180°. That is continuous at the foul lines (it equals the
 * line's height there) and periodic at the back (both signs reach the same
 * mean), so the ring closes with no step at any bearing and for any park. It is
 * also the honest shape of the thing: at ±180 the two lines are equidistant, so
 * there is no "nearer" line to hold, and picking one is a coin flip that
 * happened to be resolved by a `Math.sign` at a discontinuity.
 *
 * `geom.ring` closes a full circle on its own first sample independently of
 * this, so a future non-periodic caller gets a slanted quad rather than a crack.
 * Both fixes are wanted: one removes the hole, this one removes the jog.
 */
export function wallTopFt(park: Park, bearingDeg: number): number {
  const a = Math.abs(bearingDeg);
  if (a <= FOUL_LINE_DEG) return fenceAt(park, bearingDeg).heightFt;
  const near = fenceAt(park, FOUL_LINE_DEG * Math.sign(bearingDeg || 1)).heightFt;
  const mean =
    (fenceAt(park, -FOUL_LINE_DEG).heightFt + fenceAt(park, FOUL_LINE_DEG).heightFt) / 2;
  return near + (mean - near) * ((a - FOUL_LINE_DEG) / (180 - FOUL_LINE_DEG));
}

