// Down-range 2.5D perspective projection for the Golf driving-range mode.
//
// The camera sits just behind the tee looking straight downrange. World
// space is three scalars: `d` = downrange distance in yards (0..RANGE_YD),
// `x` = lateral offset in yards (0 = centre line, +right), `h` = height in
// yards above the ground plane.
//
// A single perspective factor `scale = FOCAL / (FOCAL + d)` does all the
// work: it is 1 at the tee and shrinks toward 0 as things recede, so it
// (a) raises distant ground toward the vanishing point, (b) converges the
// lateral axis with depth, and (c) scales object sizes and heights. Output
// coords are in the engine's 100x125 virtual space (VW x VH); the caller
// maps them to CSS pixels through the letterbox `fit` (toScreen).
//
// Pure and allocation-light — trivially unit-testable in isolation.

import { VW } from './engine';

// --- Tunable projection constants (virtual-space anchors) ---

// Total range depth in yards. Grass 0..100, water 100..390, lip+fence
// 390..400 (see rangeTargets / range.ts).
export const RANGE_YD = 400;

// Virtual y of the ground directly under the tee (d = 0): near the bottom.
export const GROUND_Y = 122;

// Virtual y of the vanishing point (ground at d = infinity): the horizon.
// Everything above this is sky. Ground at any finite d lands between the
// horizon and GROUND_Y.
export const HORIZON_Y = 46;

// Perspective focal length in yards. Larger = gentler foreshortening.
// Tuned so 0..400yd spreads readably between GROUND_Y and HORIZON_Y.
export const FOCAL = 155;

// Lateral spread: one yard of `x` at the tee is LAT_K virtual units wide.
export const LAT_K = 1.35;

// Height gain: one yard of `h` at the tee lifts a point HEIGHT_K virtual
// units up the screen (scaled down with distance by `scale`).
export const HEIGHT_K = 1.15;

export interface Proj {
  // Virtual-space screen coordinates (feed to toScreen(fit, {x,y})).
  sx: number;
  sy: number;
  // Perspective factor at this depth — reuse for sizing sprites/markers.
  scale: number;
}

// Perspective factor at downrange distance `d`. Clamped at d>=0 so a ball
// that briefly integrates behind the tee can't blow up.
export function scaleAt(d: number): number {
  return FOCAL / (FOCAL + Math.max(0, d));
}

// The ground projection of (d, x) — i.e. height 0. This is also exactly
// where the ball's SHADOW is drawn; the gap between shadow and ball sells
// the height.
export function projectGround(d: number, x: number): Proj {
  const scale = scaleAt(d);
  const sy = HORIZON_Y + (GROUND_Y - HORIZON_Y) * scale;
  const sx = VW / 2 + x * LAT_K * scale;
  return { sx, sy, scale };
}

// A point at height `h` above the ground: the ground projection lifted up
// the screen by h*scale*HEIGHT_K (near things lift more than far things).
export function projectPoint(d: number, x: number, h: number): Proj {
  const g = projectGround(d, x);
  return { sx: g.sx, sy: g.sy - h * g.scale * HEIGHT_K, scale: g.scale };
}
