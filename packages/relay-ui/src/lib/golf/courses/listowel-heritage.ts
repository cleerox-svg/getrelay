// Listowel Golf Club — Heritage nine, Listowel, Ontario. Par 36.
//
// DATA CONFIDENCE:
//   • CONFIRMED: only that Heritage is a par-36 nine at Listowel.
//   • APPROXIMATED (Vintage-anchored): ALL hole pars, yardages, shapes, greens
//     and hazards below are plausible authoring, not surveyed. Pars 4,4,3,5,4,
//     4,3,5,4 = 36; total ≈ 3395 yд. Refine from a real scorecard later — no
//     code changes needed, only these numbers.
//
// Character: heathland-style with PLENTY OF WATER, larger irregularly-shaped
// greens (r ≈ 15–17). Water features are prominent — fronting par-3 greens and
// flanking several longer holes. Greenside water/bunkers use greensideHazard()
// so they always clear the wobbled fringe pad (the terrain.ts invariant).

import { defineCourse, greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

const HOLES = [
  // 1 · P4 385 — lateral pond down the right of the fairway.
  ((g: GreenDef) =>
    hole({
      id: 1,
      par: 4,
      yards: 385,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 190, x: 4 },
        { d: 377, x: 8 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [{ kind: 'water', d: 250, x: 32, r: 14, depth: -2.0 }],
      terrain: { seed: 401, hilliness: 1.8, hillScale: 34, teeElev: 8, greenElev: 8 },
    }))({ d: 377, x: 8, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 2 · P4 410 — POND left of the green.
  ((g: GreenDef) =>
    hole({
      id: 2,
      par: 4,
      yards: 410,
      pin: { d: g.d + 2, x: g.x + 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 200, x: -4 },
        { d: 402, x: -10 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: 175 })],
      terrain: { seed: 402, hilliness: 1.9, hillScale: 34, teeElev: 7, greenElev: 8 },
    }))({ d: 402, x: -10, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · P3 175 — WATER fronts the green (a forced carry).
  ((g: GreenDef) =>
    hole({
      id: 3,
      par: 3,
      yards: 175,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 85, x: 0 },
        { d: 167, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 })],
      terrain: { seed: 403, hilliness: 1.6, hillScale: 33, teeElev: 8, greenElev: 7 },
    }))({ d: 167, x: 0, r: 15, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 4 · P5 505 — water right of the green plus a fairway bunker.
  ((g: GreenDef) =>
    hole({
      id: 4,
      par: 5,
      yards: 505,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: 4 },
        { d: 497, x: 12 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 300, x: 26, r: 10, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: 30 }),
      ],
      terrain: { seed: 404, hilliness: 2.0, hillScale: 35, teeElev: 8, greenElev: 8 },
    }))({ d: 497, x: 12, r: 17, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.012 }),
  // 5 · P4 400 — greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 5,
      par: 4,
      yards: 400,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 200, x: -3 },
        { d: 392, x: -8 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 })],
      terrain: { seed: 405, hilliness: 1.9, hillScale: 34, teeElev: 7, greenElev: 9 },
    }))({ d: 392, x: -8, r: 16, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · P4 385 — lateral pond down the left.
  ((g: GreenDef) =>
    hole({
      id: 6,
      par: 4,
      yards: 385,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 190, x: 4 },
        { d: 377, x: 10 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [{ kind: 'water', d: 240, x: -32, r: 14, depth: -2.0 }],
      terrain: { seed: 406, hilliness: 1.8, hillScale: 34, teeElev: 8, greenElev: 8 },
    }))({ d: 377, x: 10, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 7 · P3 195 — WATER fronts the green.
  ((g: GreenDef) =>
    hole({
      id: 7,
      par: 3,
      yards: 195,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 95, x: 0 },
        { d: 187, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 })],
      terrain: { seed: 407, hilliness: 1.6, hillScale: 33, teeElev: 9, greenElev: 8 },
    }))({ d: 187, x: 0, r: 15, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 8 · P5 525 — POND front-left of the green.
  ((g: GreenDef) =>
    hole({
      id: 8,
      par: 5,
      yards: 525,
      pin: { d: g.d + 2, x: g.x + 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 260, x: -6 },
        { d: 517, x: -14 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: -135 })],
      terrain: { seed: 408, hilliness: 2.0, hillScale: 35, teeElev: 8, greenElev: 7 },
    }))({ d: 517, x: -14, r: 17, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.012 }),
  // 9 · P4 415 — greenside bunker plus a pond right of the green.
  ((g: GreenDef) =>
    hole({
      id: 9,
      par: 4,
      yards: 415,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 205, x: 4 },
        { d: 407, x: 8 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -140 }),
        greensideHazard(g, 4, { kind: 'water', r: 12, depth: -2.2, bearingDeg: 30 }),
      ],
      terrain: { seed: 409, hilliness: 1.9, hillScale: 34, teeElev: 8, greenElev: 9 },
    }))({ d: 407, x: 8, r: 16, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const LISTOWEL_HERITAGE = defineCourse(
  { id: 'listowel-heritage', name: 'Listowel · Heritage', location: 'Listowel, Ontario' },
  HOLES,
);
