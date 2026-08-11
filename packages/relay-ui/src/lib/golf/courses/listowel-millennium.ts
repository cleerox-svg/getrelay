// Listowel Golf Club — Millennium nine, Listowel, Ontario. Par 36.
//
// DATA CONFIDENCE:
//   • CONFIRMED: only that Millennium is the club's newest par-36 nine.
//   • APPROXIMATED: ALL hole pars, yardages, shapes, greens and hazards below
//     are plausible authoring, not surveyed. Pars 5,4,4,3,5,4,3,4,4 = 36; total
//     ≈ 3445 yд. Refine from a real scorecard later — no code changes needed,
//     only these numbers.
//
// SHAPE: every par 4/5 is a real dogleg — a straight drive leg then a genuine
// corner into the approach leg, the green at that leg's end, and leg 2 scaled so
// the along-fairway path length ≈ the card yardage; doglegs vary left/right and
// in angle. The two par 3s stay near-straight. `d` strictly increasing.
//
// Character: the newest nine — natural ROLLING HILLS (higher hilliness), long
// fairways, and a couple of water holes. Greenside hazards use greensideHazard()
// so they always clear the wobbled fringe pad (the terrain.ts invariant).

import { defineCourse, greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

const HOLES = [
  // 1 · P5 530 — dogleg RIGHT ~31°, rolling downhill; fairway bunker inside the corner.
  ((g: GreenDef) =>
    hole({
      id: 1,
      par: 5,
      yards: 530,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 265, x: 6 },
        { d: 489, x: 148 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        // Inside-right fairway bunker at the corner edge.
        { kind: 'bunker', d: 285, x: 36, r: 10, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -50 }),
      ],
      terrain: { seed: 501, hilliness: 3.2, hillScale: 34, teeElev: 10, greenElev: 6 },
    }))({ d: 489, x: 148, r: 16, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 2 · P4 405 — dogleg LEFT ~32°, uphill; greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 2,
      par: 4,
      yards: 405,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 200, x: -4 },
        { d: 372, x: -116 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 })],
      terrain: { seed: 502, hilliness: 3.0, hillScale: 32, teeElev: 6, greenElev: 11 },
    }))({ d: 372, x: -116, r: 15, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 3 · P4 400 — dogleg RIGHT ~37°, rolling; greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 3,
      par: 4,
      yards: 400,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 195, x: 5 },
        { d: 355, x: 132 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 })],
      terrain: { seed: 503, hilliness: 2.8, hillScale: 36, teeElev: 9, greenElev: 7 },
    }))({ d: 355, x: 132, r: 16, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 4 · P3 200 — straight; WATER fronts the green.
  ((g: GreenDef) =>
    hole({
      id: 4,
      par: 3,
      yards: 200,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 100, x: 0 },
        { d: 200, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 })],
      terrain: { seed: 504, hilliness: 2.5, hillScale: 34, teeElev: 8, greenElev: 8 },
    }))({ d: 200, x: 0, r: 15, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 5 · P5 520 — SHARP dogleg LEFT ~47° (signature), rolling downhill; pond inside the corner.
  ((g: GreenDef) =>
    hole({
      id: 5,
      par: 5,
      yards: 520,
      pin: { d: g.d + 2, x: g.x + 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 255, x: -6 },
        { d: 431, x: -204 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        // Pond lapping the inside (left) of the sharp corner — a corner-cut carry.
        { kind: 'water', d: 268, x: -48, r: 14, depth: -2.0 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: 20 }),
      ],
      terrain: { seed: 505, hilliness: 3.4, hillScale: 34, teeElev: 11, greenElev: 6 },
    }))({ d: 431, x: -204, r: 16, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 6 · P4 410 — dogleg RIGHT ~29°, uphill; greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 6,
      par: 4,
      yards: 410,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 205, x: 4 },
        { d: 382, x: 107 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -50 })],
      terrain: { seed: 506, hilliness: 3.0, hillScale: 32, teeElev: 7, greenElev: 10 },
    }))({ d: 382, x: 107, r: 15, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 7 · P3 185 — straight; WATER fronts the green.
  ((g: GreenDef) =>
    hole({
      id: 7,
      par: 3,
      yards: 185,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 0 },
        { d: 185, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.0, bearingDeg: -90 })],
      terrain: { seed: 507, hilliness: 2.6, hillScale: 34, teeElev: 9, greenElev: 7 },
    }))({ d: 185, x: 0, r: 15, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 8 · P4 400 — dogleg LEFT ~39°, uphill; greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 8,
      par: 4,
      yards: 400,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 195, x: -3 },
        { d: 352, x: -134 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 })],
      terrain: { seed: 508, hilliness: 3.1, hillScale: 32, teeElev: 8, greenElev: 10 },
    }))({ d: 352, x: -134, r: 15, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
  // 9 · P4 395 — dogleg RIGHT ~34°; greenside bunker plus water short of the green.
  ((g: GreenDef) =>
    hole({
      id: 9,
      par: 4,
      yards: 395,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 195, x: 4 },
        { d: 358, x: 119 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 12, depth: -2.2, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: 30 }),
      ],
      terrain: { seed: 509, hilliness: 3.0, hillScale: 34, teeElev: 9, greenElev: 8 },
    }))({ d: 358, x: 119, r: 16, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.012 }),
];

export const LISTOWEL_MILLENNIUM = defineCourse(
  { id: 'listowel-millennium', name: 'Listowel · Millennium', location: 'Listowel, Ontario' },
  HOLES,
);
