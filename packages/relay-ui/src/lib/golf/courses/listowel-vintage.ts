// Listowel Golf Club — Vintage nine, Listowel, Ontario. Par 36.
//
// DATA CONFIDENCE:
//   • CONFIRMED (Gold tees): the par and yardage of all nine holes below —
//     1 P5 531, 2 P3 190, 3 P4 337, 4 P4 440, 5 P5 521, 6 P4 363, 7 P4 334,
//     8 P3 180, 9 P4 470 (par 36, 3366 yд).
//   • APPROXIMATED: dogleg shape, green placement, bunkering and elevation are
//     plausible authoring, not surveyed — refine later without code changes.
//
// SHAPE: every par 4/5 is a real dogleg — a straight drive leg then a genuine
// corner into the approach leg, with the green at the end of that leg. Leg 2 is
// scaled so the along-fairway path length ≈ the CONFIRMED card yardage; doglegs
// vary left/right and in angle. The two par 3s stay near-straight. `d` stays
// strictly increasing (model invariant). Fairway bunkers sit INSIDE each corner.
//
// Character: tree-lined parkland, NO water, small greens (r ≈ 13–14) with a few
// bunkers. Greenside bunkers use greensideHazard() so they clear the fringe pad.

import { defineCourse, greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

const HOLES = [
  // 1 · P5 531 (CONFIRMED) — dogleg RIGHT ~30°.
  ((g: GreenDef) =>
    hole({
      id: 1,
      par: 5,
      yards: 531,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: 6 },
        { d: 493, x: 141 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -45 })],
      terrain: { seed: 301, hilliness: 1.8, hillScale: 34, teeElev: 6, greenElev: 8 },
    }))({ d: 493, x: 141, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 2 · P3 190 (CONFIRMED) — straight.
  ((g: GreenDef) =>
    hole({
      id: 2,
      par: 3,
      yards: 190,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 95, x: 0 },
        { d: 190, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -90 })],
      terrain: { seed: 302, hilliness: 1.6, hillScale: 33, teeElev: 8, greenElev: 7 },
    }))({ d: 190, x: 0, r: 14, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · P4 337 (CONFIRMED) — dogleg LEFT ~34°.
  ((g: GreenDef) =>
    hole({
      id: 3,
      par: 4,
      yards: 337,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 175, x: -4 },
        { d: 307, x: -98 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 160 })],
      terrain: { seed: 303, hilliness: 1.8, hillScale: 34, teeElev: 7, greenElev: 8 },
    }))({ d: 307, x: -98, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 4 · P4 440 (CONFIRMED) — dogleg RIGHT ~40°.
  ((g: GreenDef) =>
    hole({
      id: 4,
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 235, x: 6 },
        { d: 389, x: 142 },
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
    }))({ d: 389, x: 142, r: 14, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 5 · P5 521 (CONFIRMED) — dogleg LEFT ~28°; fairway bunker inside the corner.
  ((g: GreenDef) =>
    hole({
      id: 5,
      par: 5,
      yards: 521,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 260, x: -6 },
        { d: 488, x: -134 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [
        // Inside-left fairway bunker guarding the corner-cut (~18 yd left of the
        // centerline, on the fairway edge).
        { kind: 'bunker', d: 250, x: -24, r: 9, depth: -1.6 },
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 20 }),
      ],
      terrain: { seed: 305, hilliness: 1.9, hillScale: 34, teeElev: 9, greenElev: 7 },
    }))({ d: 488, x: -134, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · P4 363 (CONFIRMED) — dogleg RIGHT ~26°.
  ((g: GreenDef) =>
    hole({
      id: 6,
      par: 4,
      yards: 363,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 185, x: 4 },
        { d: 343, x: 85 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -50 })],
      terrain: { seed: 306, hilliness: 1.8, hillScale: 33, teeElev: 6, greenElev: 8 },
    }))({ d: 343, x: 85, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 7 · P4 334 (CONFIRMED) — SHARP dogleg LEFT ~45° (signature short par 4).
  ((g: GreenDef) =>
    hole({
      id: 7,
      par: 4,
      yards: 334,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 170, x: -4 },
        { d: 283, x: -123 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 37,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 160 })],
      terrain: { seed: 307, hilliness: 1.7, hillScale: 33, teeElev: 7, greenElev: 7 },
    }))({ d: 283, x: -123, r: 13, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 8 · P3 180 (CONFIRMED) — near-straight, angled RIGHT ~4.4°.
  // ⚠ A par 3's centerline must be COLLINEAR tee→pin: the tee shot aims down
  // centerline[0] → centerline[1] (driveHeading), so a mid-vertex off the pin line
  // aims the default shot off the green — this one was at x 2, pointing 3.2° and
  // 10 yd left of the flag. On the ray: 90 · (14/181) = 6.96. Pinned by a test in
  // courseSim.test.ts over every par 3 of every course.
  ((g: GreenDef) =>
    hole({
      id: 8,
      par: 3,
      yards: 180,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 6.96 },
        { d: 179, x: 16 },
      ],
      fairwayHalf: 13,
      roughHalf: 31,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: -120 })],
      terrain: { seed: 308, hilliness: 1.6, hillScale: 33, teeElev: 9, greenElev: 7 },
    }))({ d: 179, x: 16, r: 14, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 9 · P4 470 (CONFIRMED) — dogleg LEFT ~36°.
  ((g: GreenDef) =>
    hole({
      id: 9,
      par: 4,
      yards: 470,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 245, x: -6 },
        { d: 424, x: -143 },
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
    }))({ d: 424, x: -143, r: 14, raise: 2.4, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const LISTOWEL_VINTAGE = defineCourse(
  { id: 'listowel-vintage', name: 'Listowel · Vintage', location: 'Listowel, Ontario' },
  HOLES,
);
