// `validatePark` — bad park data is a TEST FAILURE, not a runtime surprise on
// somebody's phone.
//
// ⚠ EXTRACTED FROM `parks.ts` AT THE 500-LINE CAP, the same way `pchip.ts` was.
// The cap is met by extraction, never by raising it, and this is the piece that
// genuinely belongs on its own: everything in here runs at AUTHORING time. It is
// called by `parks.test.ts` against a deliberately-broken park and by nothing
// the player's device ever executes, so splitting it also takes the bounds table
// and the string building out of the shipped chunk — a bundle-budget win rather
// than a filing exercise. The dependency runs one way (`parkValidate` → `parks`)
// and there is no cycle.
//
// The rule it enforces: a new park is a DATA ENTRY AND ZERO CODE, so every way
// a data entry can be wrong has to be caught here rather than by a reviewer's
// eye. The bounds are wide on purpose — this catches typos and category errors,
// never design taste.

import { FOUL_LINE_DEG } from './parks';
import type { Park } from './parks';

/** Plausibility bounds. Wide on purpose: this catches typos, not design taste. */
const BOUNDS = {
  elevFt: [-500, 12000],
  distFt: [200, 600],
  heightFt: [1, 60],
  roofPeakFt: [80, 500],
  foulFt: [5, 200],
  backstopFt: [10, 250],
} as const;

/** Every problem with a park, as human-readable strings. Empty ⇒ valid. */
export function validatePark(p: Park): string[] {
  const e: string[] = [];
  const inRange = (v: number, [lo, hi]: readonly [number, number]) =>
    Number.isFinite(v) && v >= lo && v <= hi;

  if (!p.id.trim()) e.push('id is empty');
  if (!p.name.trim()) e.push('name is empty');
  if (!inRange(p.elevationFt, BOUNDS.elevFt)) e.push(`elevationFt ${p.elevationFt} implausible`);
  if (!inRange(p.foulTerritoryFt, BOUNDS.foulFt)) {
    e.push(`foulTerritoryFt ${p.foulTerritoryFt} implausible`);
  }
  // The backstop is geometry-only, which is exactly why it needs a bound: a
  // wrong number here produces no test failure anywhere in the physics and one
  // odd-looking screenshot nobody is guaranteed to look at.
  if (!inRange(p.backstopFt, BOUNDS.backstopFt)) e.push(`backstopFt ${p.backstopFt} implausible`);
  if (p.surroundings !== 'city' && p.surroundings !== 'none') {
    e.push(`surroundings ${String(p.surroundings)} is not 'city' or 'none'`);
  }

  // roofPeak > 0 IFF roofed — both directions, because a roofless park carrying
  // a stale peak would silently enforce an invisible ceiling.
  const roofed = p.roof === 'retractable' || p.roof === 'fixed';
  if (roofed && !inRange(p.roofPeakFt, BOUNDS.roofPeakFt)) {
    e.push(`roofPeakFt ${p.roofPeakFt} implausible for a ${p.roof} roof`);
  }
  if (!roofed && p.roofPeakFt !== 0) e.push(`roofPeakFt must be 0 when roof is 'none'`);
  if (p.wind.closed !== null) e.push('wind.closed must be null — a closed roof has no wind');

  const w = p.wind.open;
  if (!Number.isFinite(w.bearingCentreDeg)) e.push('wind.open.bearingCentreDeg is not finite');
  if (!(w.swingDeg >= 0 && w.swingDeg <= 180)) e.push(`wind.open.swingDeg ${w.swingDeg} not 0..180`);
  if (!(w.gustScale >= 0)) e.push(`wind.open.gustScale ${w.gustScale} is negative`);

  if (p.fence.length < 3) e.push(`fence has ${p.fence.length} samples, needs ≥ 3`);
  const first = p.fence[0];
  const last = p.fence[p.fence.length - 1];
  if (first && first.bearingDeg !== -FOUL_LINE_DEG) {
    e.push(`fence starts at ${first.bearingDeg}°, must start at the LF line (−45°)`);
  }
  if (last && last.bearingDeg !== FOUL_LINE_DEG) {
    e.push(`fence ends at ${last.bearingDeg}°, must end at the RF line (+45°)`);
  }
  p.fence.forEach((s, i) => {
    const prev = p.fence[i - 1];
    if (prev && !(s.bearingDeg > prev.bearingDeg)) {
      e.push(`fence bearing ${s.bearingDeg}° not strictly after ${prev.bearingDeg}°`);
    }
    if (!inRange(s.distFt, BOUNDS.distFt)) e.push(`fence ${s.bearingDeg}°: distFt ${s.distFt}`);
    if (!inRange(s.heightFt, BOUNDS.heightFt)) {
      e.push(`fence ${s.bearingDeg}°: heightFt ${s.heightFt}`);
    }
  });
  return e;
}
