// Listowel Golf Club — Vintage nine, Listowel, Ontario. Par 36.
//
// DATA CONFIDENCE:
//   • CONFIRMED (Gold tees): the par and yardage of all nine holes below —
//     1 P5 531, 2 P3 190, 3 P4 337, 4 P4 440, 5 P5 521, 6 P4 363, 7 P4 334,
//     8 P3 180, 9 P4 470 (par 36, 3366 yд).
//   • APPROXIMATED: dogleg shape, green placement, bunkering and elevation are
//     plausible authoring, not surveyed — refine later without code changes.
//
// Character: tree-lined parkland, NO water, small greens (r ≈ 13–14) with a few
// bunkers. Greenside bunkers use greensideHazard() so they clear the fringe pad.

import { defineCourse, greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

const HOLES = [
  // 1 · P5 531 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 1,
      par: 5,
      yards: 531,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 260, x: 4 },
        { d: 523, x: 10 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -45 })],
      terrain: { seed: 301, hilliness: 1.8, hillScale: 34, teeElev: 6, greenElev: 8 },
    }))({ d: 523, x: 10, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 2 · P3 190 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 2,
      par: 3,
      yards: 190,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 95, x: 0 },
        { d: 182, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -90 })],
      terrain: { seed: 302, hilliness: 1.6, hillScale: 33, teeElev: 8, greenElev: 7 },
    }))({ d: 182, x: 0, r: 14, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · P4 337 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 3,
      par: 4,
      yards: 337,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 170, x: -4 },
        { d: 329, x: -8 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 160 })],
      terrain: { seed: 303, hilliness: 1.8, hillScale: 34, teeElev: 7, greenElev: 8 },
    }))({ d: 329, x: -8, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 4 · P4 440 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 4,
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: 6 },
        { d: 432, x: 12 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -60 }),
      ],
      terrain: { seed: 304, hilliness: 2.0, hillScale: 34, teeElev: 8, greenElev: 9 },
    }))({ d: 432, x: 12, r: 14, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 5 · P5 521 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 5,
      par: 5,
      yards: 521,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -6 },
        { d: 513, x: -14 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [
        { kind: 'bunker', d: 300, x: -26, r: 9, depth: -1.6 },
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 20 }),
      ],
      terrain: { seed: 305, hilliness: 1.9, hillScale: 34, teeElev: 9, greenElev: 7 },
    }))({ d: 513, x: -14, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · P4 363 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 6,
      par: 4,
      yards: 363,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 180, x: 3 },
        { d: 355, x: 6 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -50 })],
      terrain: { seed: 306, hilliness: 1.8, hillScale: 33, teeElev: 6, greenElev: 8 },
    }))({ d: 355, x: 6, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 7 · P4 334 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 7,
      par: 4,
      yards: 334,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 165, x: -2 },
        { d: 326, x: -6 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 160 })],
      terrain: { seed: 307, hilliness: 1.7, hillScale: 33, teeElev: 7, greenElev: 7 },
    }))({ d: 326, x: -6, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 8 · P3 180 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 8,
      par: 3,
      yards: 180,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 2 },
        { d: 172, x: 4 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -120 })],
      terrain: { seed: 308, hilliness: 1.6, hillScale: 33, teeElev: 9, greenElev: 7 },
    }))({ d: 172, x: 4, r: 14, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 9 · P4 470 (CONFIRMED par/yards)
  ((g: GreenDef) =>
    hole({
      id: 9,
      par: 4,
      yards: 470,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 230, x: -4 },
        { d: 462, x: -12 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -60 }),
      ],
      terrain: { seed: 309, hilliness: 2.0, hillScale: 34, teeElev: 7, greenElev: 9 },
    }))({ d: 462, x: -12, r: 14, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const LISTOWEL_VINTAGE = defineCourse(
  { id: 'listowel-vintage', name: 'Listowel · Vintage', location: 'Listowel, Ontario' },
  HOLES,
);
