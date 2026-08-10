// Augusta National Golf Club — Augusta, Georgia. 18 holes, par 72. The named
// holes, doglegs, elevation changes and signature hazards (Amen Corner water on
// 11/12/13, ponds on 15/16, few fairway bunkers, big fast greens) recreated as
// pure CourseHole DATA per the terrain.ts authoring contract. This is a
// procedural arcade recreation — each hole matches the real PAR, YARDAGE (world
// scale d≈yards), DOGLEG DIRECTION and SIGNATURE HAZARDS, not survey geometry.
// Green tilt is authored within the engine's μ cap (≈stimp 10), below true
// Augusta green speeds. Greenside hazards use greensideHazard() so they always
// clear the wobbled fringe pad (the terrain.ts invariant); fairway bunkers are
// placed well short of the green and cleared by the same margin.

import { defineCourse } from './builder';
import { greensideHazard, hole } from './builder';
import type { GreenDef } from '../terrain';

// −x = dogleg left, +x = dogleg right. Greens are big (r 15–18). Elevation
// (teeElev→greenElev) reflects the up/downhill notes.

const HOLES = [
  // 1 · Tea Olive — P4 445, slight dogleg right, uphill; fairway bunker right.
  hole({
    id: 1,
    name: 'Tea Olive',
    par: 4,
    yards: 445,
    pin: { d: 439, x: 16 },
    centerline: [
      { d: 0, x: 0 },
      { d: 220, x: 6 },
      { d: 437, x: 18 },
    ],
    fairwayHalf: 17,
    fairwayTaper: -3,
    roughHalf: 39,
    green: { d: 437, x: 18, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 },
    hazards: [{ kind: 'bunker', d: 315, x: 30, r: 10, depth: -1.6 }],
    terrain: { seed: 201, hilliness: 2.2, hillScale: 34, teeElev: 6, greenElev: 11 },
  }),
  // 2 · Pink Dogwood — P5 585, dogleg left, downhill; bunkers.
  ((g: GreenDef) =>
    hole({
      id: 2,
      name: 'Pink Dogwood',
      par: 5,
      yards: 585,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 280, x: -10 },
        { d: 470, x: -28 },
        { d: 577, x: -30 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 300, x: -32, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -135 }),
      ],
      terrain: { seed: 202, hilliness: 2.6, hillScale: 36, teeElev: 12, greenElev: 5 },
    }))({ d: 577, x: -30, r: 17, raise: 2.4, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · Flowering Peach — P4 350, short; bunkers left.
  ((g: GreenDef) =>
    hole({
      id: 3,
      name: 'Flowering Peach',
      par: 4,
      yards: 350,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 180, x: -6 },
        { d: 342, x: -12 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.7, bearingDeg: 160 })],
      terrain: { seed: 203, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 9 },
    }))({ d: 342, x: -12, r: 15, raise: 2.4, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.012 }),
  // 4 · Flowering Crab Apple — P3 240, long par 3; bunker.
  ((g: GreenDef) =>
    hole({
      id: 4,
      name: 'Flowering Crab Apple',
      par: 3,
      yards: 240,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 120, x: 0 },
        { d: 232, x: 0 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -90 })],
      terrain: { seed: 204, hilliness: 1.8, hillScale: 34, teeElev: 10, greenElev: 8 },
    }))({ d: 232, x: 0, r: 16, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 5 · Magnolia — P4 495, dogleg left uphill; two deep fairway bunkers left.
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
        { d: 420, x: -22 },
        { d: 487, x: -24 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        { kind: 'bunker', d: 300, x: -28, r: 10, depth: -1.9 },
        { kind: 'bunker', d: 332, x: -30, r: 9, depth: -1.9 },
      ],
      terrain: { seed: 205, hilliness: 2.4, hillScale: 35, teeElev: 7, greenElev: 12 },
    }))({ d: 487, x: -24, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · Juniper — P3 180, downhill; tiered green.
  ((g: GreenDef) =>
    hole({
      id: 6,
      name: 'Juniper',
      par: 3,
      yards: 180,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 3 },
        { d: 172, x: 6 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -45 })],
      terrain: { seed: 206, hilliness: 1.8, hillScale: 33, teeElev: 14, greenElev: 6 },
    }))({ d: 172, x: 6, r: 16, raise: 2.4, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.012 }),
  // 7 · Pampas — P4 450, narrow tree-lined; greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 7,
      name: 'Pampas',
      par: 4,
      yards: 450,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: 2 },
        { d: 442, x: 8 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 32,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -125 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -55 }),
      ],
      terrain: { seed: 207, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 11 },
    }))({ d: 442, x: 8, r: 15, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 8 · Yellow Jasmine — P5 570, uphill dogleg left; no water.
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
        { d: 460, x: -24 },
        { d: 562, x: -26 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 300, x: 26, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: 160 }),
      ],
      terrain: { seed: 208, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 562, x: -26, r: 17, raise: 2.6, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 9 · Carolina Cherry — P4 460, dogleg left; downhill then uphill green.
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
        { d: 452, x: -20 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 209, hilliness: 2.4, hillScale: 35, teeElev: 10, greenElev: 12 },
    }))({ d: 452, x: -20, r: 16, raise: 3.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 10 · Camellia — P4 495, sharp dogleg left, big downhill; greenside bunker.
  ((g: GreenDef) =>
    hole({
      id: 10,
      name: 'Camellia',
      par: 4,
      yards: 495,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 240, x: -12 },
        { d: 420, x: -36 },
        { d: 487, x: -40 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 9, depth: -2.0, bearingDeg: 20 })],
      terrain: { seed: 210, hilliness: 2.8, hillScale: 36, teeElev: 14, greenElev: 4 },
    }))({ d: 487, x: -40, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 11 · White Dogwood — P4 520, downhill; POND left of green (water).
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
        { d: 512, x: -14 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: 175 })],
      terrain: { seed: 211, hilliness: 2.4, hillScale: 35, teeElev: 12, greenElev: 5 },
    }))({ d: 512, x: -14, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 12 · Golden Bell — P3 155, Rae's Creek WATER fronts a shallow, wide green.
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
        { d: 147, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 90 }),
      ],
      terrain: { seed: 212, hilliness: 1.6, hillScale: 32, teeElev: 8, greenElev: 7 },
    }))({ d: 147, x: 0, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 13 · Azalea — P5 545, sharp dogleg left; Rae's Creek tributary WATER fronts.
  ((g: GreenDef) =>
    hole({
      id: 13,
      name: 'Azalea',
      par: 5,
      yards: 545,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -10 },
        { d: 440, x: -30 },
        { d: 537, x: -34 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: -90 })],
      terrain: { seed: 213, hilliness: 2.6, hillScale: 36, teeElev: 9, greenElev: 8 },
    }))({ d: 537, x: -34, r: 16, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 14 · Chinese Fir — P4 440, NO bunkers at all; heavily contoured green.
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
        { d: 432, x: 10 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [],
      terrain: { seed: 214, hilliness: 2.4, hillScale: 34, teeElev: 8, greenElev: 11 },
    }))({ d: 432, x: 10, r: 17, raise: 2.8, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.014 }),
  // 15 · Firethorn — P5 550, POND fronts the green (water).
  ((g: GreenDef) =>
    hole({
      id: 15,
      name: 'Firethorn',
      par: 5,
      yards: 550,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: 4 },
        { d: 542, x: 8 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.4, bearingDeg: -90 })],
      terrain: { seed: 215, hilliness: 2.4, hillScale: 36, teeElev: 10, greenElev: 9 },
    }))({ d: 542, x: 8, r: 16, raise: 2.0, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 16 · Redbud — P3 170, played entirely over a POND (water carry to green).
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
        { d: 162, x: 0 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 15, depth: -2.2, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 20 }),
      ],
      terrain: { seed: 216, hilliness: 1.6, hillScale: 32, teeElev: 9, greenElev: 8 },
    }))({ d: 162, x: 0, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 17 · Nandina — P4 440, uphill; greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 17,
      name: 'Nandina',
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: -2 },
        { d: 432, x: -6 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 217, hilliness: 2.2, hillScale: 34, teeElev: 7, greenElev: 12 },
    }))({ d: 432, x: -6, r: 16, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 18 · Holly — P4 465, dogleg right uphill; two fairway bunkers left.
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
        { d: 457, x: 22 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [
        { kind: 'bunker', d: 280, x: -24, r: 10, depth: -1.8 },
        { kind: 'bunker', d: 310, x: -26, r: 9, depth: -1.8 },
      ],
      terrain: { seed: 218, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 457, x: 22, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const AUGUSTA = defineCourse(
  { id: 'augusta', name: 'Augusta National', location: 'Augusta, Georgia' },
  HOLES,
);
