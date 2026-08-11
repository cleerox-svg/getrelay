// Augusta National Golf Club — Augusta, Georgia. 18 holes, par 72. The named
// holes, doglegs, elevation changes and signature hazards (Amen Corner water on
// 11/12/13, ponds on 15/16, few fairway bunkers, big fast greens) recreated as
// pure CourseHole DATA per the terrain.ts authoring contract. This is a
// procedural arcade recreation — each hole matches the real PAR, YARDAGE (world
// scale d≈yards), DOGLEG DIRECTION and SIGNATURE HAZARDS, not survey geometry.
//
// SHAPE: a hole is a CENTERLINE polyline (terrain.ts). Every hole here is a real
// dogleg — a straight drive leg from the tee, then a genuine CORNER (~20–50°)
// into the approach leg, with the green sitting at the END of that second leg
// where the fairway actually leads. Left and right doglegs and leg lengths are
// varied so no two holes read the same; the sharp signature doglegs (10 Camellia,
// 13 Azalea) bend hardest. `d` stays strictly increasing (no 90°+ switchback) so
// the model's downrange-ordered centerline invariant holds; each dogleg's default
// tee aim (bearing-to-pin) cuts the corner over OB, so keeping the drive in the
// fairway means steering down the first leg — the dogleg matters in play.
//
// Green tilt is authored within the engine's μ cap (≈stimp 10), below true
// Augusta green speeds (each green here reuses a known-good tilt/undulation and is
// only RELOCATED to the new centerline end). Greenside hazards use
// greensideHazard() so they always clear the wobbled fringe pad (the terrain.ts
// invariant) regardless of where the green moved; fairway bunkers sit on the
// INSIDE of the corner, well short of the green and cleared by the same margin.

import { defineCourse } from './builder';
import { greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

// −x = dogleg left, +x = dogleg right. Greens are big (r 15–17). Elevation
// (teeElev→greenElev) reflects the up/downhill notes. Each hole's green is passed
// into an IIFE so the pin can reference it (pin sits just inside the green).

const HOLES = [
  // 1 · Tea Olive — P4 445, dogleg RIGHT ~30°, uphill; fairway bunker inside right.
  ((g: GreenDef) =>
    hole({
      id: 1,
      name: 'Tea Olive',
      par: 4,
      yards: 445,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 235, x: 2 },
        { d: 417, x: 107 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [{ kind: 'bunker', d: 255, x: 30, r: 10, depth: -1.6 }],
      terrain: { seed: 201, hilliness: 2.2, hillScale: 34, teeElev: 6, greenElev: 11 },
    }))({ d: 417, x: 107, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 2 · Pink Dogwood — P5 585, dogleg LEFT ~33°, downhill; fairway + greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 2,
      name: 'Pink Dogwood',
      par: 5,
      yards: 585,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 285, x: -10 },
        { d: 532, x: -181 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 305, x: -42, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -135 }),
      ],
      terrain: { seed: 202, hilliness: 2.6, hillScale: 36, teeElev: 12, greenElev: 5 },
    }))({ d: 532, x: -181, r: 17, raise: 2.4, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · Flowering Peach — P4 350, short dogleg LEFT ~26°; bunkers left.
  ((g: GreenDef) =>
    hole({
      id: 3,
      name: 'Flowering Peach',
      par: 4,
      yards: 350,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 180, x: -4 },
        { d: 331, x: -83 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        { kind: 'bunker', d: 200, x: -28, r: 8, depth: -1.5 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.7, bearingDeg: 160 }),
      ],
      terrain: { seed: 203, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 9 },
    }))({ d: 331, x: -83, r: 15, raise: 2.4, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.012 }),
  // 4 · Flowering Crab Apple — P3 240, long par 3, gently angled LEFT ~9°; bunker.
  ((g: GreenDef) =>
    hole({
      id: 4,
      name: 'Flowering Crab Apple',
      par: 3,
      yards: 240,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 115, x: -6 },
        { d: 238, x: -25 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -90 })],
      terrain: { seed: 204, hilliness: 1.8, hillScale: 34, teeElev: 10, greenElev: 8 },
    }))({ d: 238, x: -25, r: 16, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 5 · Magnolia — P4 495, dogleg LEFT ~41° uphill; two deep fairway bunkers inside left.
  ((g: GreenDef) =>
    hole({
      id: 5,
      name: 'Magnolia',
      par: 4,
      yards: 495,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -8 },
        { d: 428, x: -176 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        // Two staggered bunkers on the INSIDE (left) of the corner, guarding the
        // corner-cutting line — both sit in the left of the fairway, ~8 and ~11 yd
        // left (perpendicular) of the centerline as it swings hard left to the green.
        { kind: 'bunker', d: 270, x: -38, r: 10, depth: -1.9 },
        { kind: 'bunker', d: 295, x: -66, r: 9, depth: -1.9 },
      ],
      terrain: { seed: 205, hilliness: 2.4, hillScale: 35, teeElev: 7, greenElev: 12 },
    }))({ d: 428, x: -176, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · Juniper — P3 180, downhill, angled RIGHT ~15°; tiered green.
  ((g: GreenDef) =>
    hole({
      id: 6,
      name: 'Juniper',
      par: 3,
      yards: 180,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 4 },
        { d: 176, x: 30 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -45 })],
      terrain: { seed: 206, hilliness: 1.8, hillScale: 33, teeElev: 14, greenElev: 6 },
    }))({ d: 176, x: 30, r: 16, raise: 2.4, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.012 }),
  // 7 · Pampas — P4 450, narrow tree-lined dogleg RIGHT ~32°; greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 7,
      name: 'Pampas',
      par: 4,
      yards: 450,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 230, x: 4 },
        { d: 415, x: 124 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 32,
      green: g,
      hazards: [
        { kind: 'bunker', d: 250, x: 32, r: 9, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -125 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -55 }),
      ],
      terrain: { seed: 207, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 11 },
    }))({ d: 415, x: 124, r: 15, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 8 · Yellow Jasmine — P5 570, uphill dogleg LEFT ~32°; fairway + greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 8,
      name: 'Yellow Jasmine',
      par: 5,
      yards: 570,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: -8 },
        { d: 519, x: -176 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 295, x: -42, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: 160 }),
      ],
      terrain: { seed: 208, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 519, x: -176, r: 17, raise: 2.6, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 9 · Carolina Cherry — P4 460, dogleg LEFT ~39°; downhill then uphill green.
  ((g: GreenDef) =>
    hole({
      id: 9,
      name: 'Carolina Cherry',
      par: 4,
      yards: 460,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 240, x: -6 },
        { d: 407, x: -149 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        { kind: 'bunker', d: 260, x: -36, r: 9, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 209, hilliness: 2.4, hillScale: 35, teeElev: 10, greenElev: 12 },
    }))({ d: 407, x: -149, r: 16, raise: 3.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 10 · Camellia — P4 495, SHARP dogleg LEFT ~49° (signature), big downhill; bunker.
  ((g: GreenDef) =>
    hole({
      id: 10,
      name: 'Camellia',
      par: 4,
      yards: 495,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 245, x: -10 },
        { d: 402, x: -204 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [
        // Fairway bunker on the INSIDE (left) fairway edge of the sharp corner
        // (~14 yd left, perpendicular, of the centerline), tempting the aggressive
        // corner-cutting drive.
        { kind: 'bunker', d: 268, x: -60, r: 9, depth: -1.9 },
        greensideHazard(g, 4, { kind: 'bunker', r: 9, depth: -2.0, bearingDeg: 20 }),
      ],
      terrain: { seed: 210, hilliness: 2.8, hillScale: 36, teeElev: 14, greenElev: 4 },
    }))({ d: 402, x: -204, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 11 · White Dogwood — P4 520, downhill dogleg LEFT ~29°; POND left of green (water).
  ((g: GreenDef) =>
    hole({
      id: 11,
      name: 'White Dogwood',
      par: 4,
      yards: 520,
      pin: { d: g.d + 2, x: g.x + 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 260, x: -6 },
        { d: 483, x: -139 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: 175 })],
      terrain: { seed: 211, hilliness: 2.4, hillScale: 35, teeElev: 12, greenElev: 5 },
    }))({ d: 483, x: -139, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 12 · Golden Bell — P3 155, Rae's Creek WATER fronts a shallow, wide green; near-straight.
  ((g: GreenDef) =>
    hole({
      id: 12,
      name: 'Golden Bell',
      par: 3,
      yards: 155,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 80, x: 0 },
        { d: 155, x: -9 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 90 }),
      ],
      terrain: { seed: 212, hilliness: 1.6, hillScale: 32, teeElev: 8, greenElev: 7 },
    }))({ d: 155, x: -9, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 13 · Azalea — P5 545, SHARP dogleg LEFT ~47° (signature); Rae's Creek WATER fronts.
  ((g: GreenDef) =>
    hole({
      id: 13,
      name: 'Azalea',
      par: 5,
      yards: 545,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -12 },
        { d: 441, x: -236 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: -40 })],
      terrain: { seed: 213, hilliness: 2.6, hillScale: 36, teeElev: 9, greenElev: 8 },
    }))({ d: 441, x: -236, r: 16, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 14 · Chinese Fir — P4 440, dogleg RIGHT ~30°, NO bunkers; heavily contoured green.
  ((g: GreenDef) =>
    hole({
      id: 14,
      name: 'Chinese Fir',
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: 4 },
        { d: 409, x: 117 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [],
      terrain: { seed: 214, hilliness: 2.4, hillScale: 34, teeElev: 8, greenElev: 11 },
    }))({ d: 409, x: 117, r: 17, raise: 2.8, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.014 }),
  // 15 · Firethorn — P5 550, dogleg RIGHT ~27°; POND fronts the green (water).
  ((g: GreenDef) =>
    hole({
      id: 15,
      name: 'Firethorn',
      par: 5,
      yards: 550,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: 6 },
        { d: 517, x: 138 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.4, bearingDeg: -125 })],
      terrain: { seed: 215, hilliness: 2.4, hillScale: 36, teeElev: 10, greenElev: 9 },
    }))({ d: 517, x: 138, r: 16, raise: 2.0, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 16 · Redbud — P3 170, played over a POND (water carry), angled RIGHT ~8°.
  ((g: GreenDef) =>
    hole({
      id: 16,
      name: 'Redbud',
      par: 3,
      yards: 170,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 0 },
        { d: 169, x: 11 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 15, depth: -2.2, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 20 }),
      ],
      terrain: { seed: 216, hilliness: 1.6, hillScale: 32, teeElev: 9, greenElev: 8 },
    }))({ d: 169, x: 11, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 17 · Nandina — P4 440, uphill dogleg RIGHT ~28°; fairway + greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 17,
      name: 'Nandina',
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 225, x: 2 },
        { d: 413, x: 106 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        { kind: 'bunker', d: 245, x: 30, r: 9, depth: -1.8 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 217, hilliness: 2.2, hillScale: 34, teeElev: 7, greenElev: 12 },
    }))({ d: 413, x: 106, r: 16, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 18 · Holly — P4 465, dogleg RIGHT ~37° (signature) uphill; two fairway bunkers inside right.
  ((g: GreenDef) =>
    hole({
      id: 18,
      name: 'Holly',
      par: 4,
      yards: 465,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 230, x: 8 },
        { d: 413, x: 156 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [
        { kind: 'bunker', d: 250, x: 36, r: 10, depth: -1.8 },
        { kind: 'bunker', d: 285, x: 46, r: 9, depth: -1.8 },
      ],
      terrain: { seed: 218, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 413, x: 156, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const AUGUSTA = defineCourse(
  { id: 'augusta', name: 'Augusta National', location: 'Augusta, Georgia' },
  HOLES,
);
