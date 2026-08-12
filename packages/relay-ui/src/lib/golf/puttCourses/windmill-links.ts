// "Windmill Links" — a classic seaside mini-put with signature TIMING holes:
// windmills and swinging gates you must read the beat of, banked rails you carom
// off, and risk/reward gaps (a tempting fast line through a spinning windmill vs
// a safe slow route around). 8 holes in the 100x125 virtual board (x right, y
// DOWN). Pure DATA — puttHole() fills the closed border + full green + empty
// schema arrays; each hole spells out only what makes it distinctive.
//
// Design rules (enforced by validatePuttHole): par ∈ 2..3; cup + tee on the
// green; the cup point holds a rest; every obstacle's SWEPT disc fits the bounds
// and clears the cup/tee; everything inside the play bounds. All motion is a pure
// function of the sim's simTime (puttObstacles.ts), so play is deterministic.

import { puttHole, definePuttCourse, seg, windmill, pendulum } from './builder';
import type { PuttCourse } from './types';

const THEME = 'links';

export const WINDMILL_LINKS: PuttCourse = definePuttCourse(
  { id: 'windmill-links', name: 'Windmill Links', theme: THEME },
  [
    // 1 — the teaching windmill: a lone 4-blade windmill dead centre on a
    // straight line to the cup. Learn its beat and roll through a gap. Par 3.
    puttHole({
      id: 1,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 106 },
      cup: { x: 50, y: 24 },
      obstacles: [windmill({ x: 50, y: 64 }, { bladeLen: 16, bladeCount: 4, omega: 2.2 })],
    }),

    // 2 — carom + timing: a left baffle pushes the ball toward a banked rail on
    // the right that feeds it up-board, but a slow windmill guards the top. Time
    // the carom to the gap. Par 3.
    puttHole({
      id: 2,
      par: 3,
      theme: THEME,
      tee: { x: 28, y: 106 },
      cup: { x: 66, y: 26 },
      walls: [seg(8, 70, 52, 70), seg(78, 92, 88, 54, true)],
      obstacles: [windmill({ x: 54, y: 46 }, { bladeLen: 14, bladeCount: 3, omega: 1.9 })],
    }),

    // 3 — THE GATE: a swinging bar (two-armed gate) sweeps across the middle,
    // guarding the only clean line. Wait for it to swing clear, then commit. Par 3.
    puttHole({
      id: 3,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 108 },
      cup: { x: 50, y: 24 },
      obstacles: [
        pendulum({ x: 50, y: 70 }, { length: 22, ampDeg: 55, omega: 2.5, centerDeg: 90, gate: true }),
      ],
    }),

    // 4 — the double: two counter-rotating windmills stacked on the centre line.
    // Their beats interfere — thread both in one confident roll. Par 3.
    puttHole({
      id: 4,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 110 },
      cup: { x: 50, y: 22 },
      obstacles: [
        windmill({ x: 50, y: 80 }, { bladeLen: 13, bladeCount: 4, omega: 2.0 }),
        windmill({ x: 50, y: 46 }, { bladeLen: 13, bladeCount: 4, omega: -2.4, phase0: 1 }),
      ],
    }),

    // 5 — RISK/REWARD: a fast windmill sits on the SHORT diagonal line to the cup
    // (dash the gap for a birdie look) while a banked rail offers a longer, safer
    // carom around it. Bold vs safe — the heart of mini-put. Par 3.
    puttHole({
      id: 5,
      par: 3,
      theme: THEME,
      tee: { x: 30, y: 108 },
      cup: { x: 70, y: 26 },
      walls: [seg(14, 84, 44, 84, true), seg(60, 60, 88, 60, true)],
      obstacles: [windmill({ x: 55, y: 66 }, { bladeLen: 16, bladeCount: 4, omega: 3.0 })],
    }),

    // 6 — a short banked dogleg for a breather: carom off two rails to a cup
    // tucked up-right, on a gentle 3% helping tilt. Par 2.
    puttHole({
      id: 6,
      par: 2,
      theme: THEME,
      tee: { x: 30, y: 100 },
      cup: { x: 70, y: 40 },
      walls: [seg(8, 70, 50, 70, true), seg(56, 52, 92, 52, true)],
      tilts: [{ region: { x0: 40, y0: 34, x1: 86, y1: 74 }, gradePct: 3, dirDeg: 0 }],
    }),

    // 7 — windmill on a sidehill: the whole green tilts right at 4%, so the ball
    // drifts as it waits for the blade — read the break AND the beat together.
    // Par 3.
    puttHole({
      id: 7,
      par: 3,
      theme: THEME,
      tee: { x: 24, y: 108 },
      cup: { x: 74, y: 30 },
      tilts: [{ region: { x0: 14, y0: 34, x1: 86, y1: 100 }, gradePct: 4, dirDeg: 0 }],
      obstacles: [windmill({ x: 50, y: 66 }, { bladeLen: 15, bladeCount: 4, omega: 2.6 })],
    }),

    // 8 — GRAND FINALE: a swinging gate low, a counter-spinning windmill high, and
    // banked rails down the sides. Everything the links taught — carom, gate
    // timing, windmill timing — in one roll to a crowned cup. Par 3.
    puttHole({
      id: 8,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 110 },
      cup: { x: 50, y: 22 },
      walls: [seg(16, 96, 16, 40, true), seg(84, 96, 84, 40, true)],
      obstacles: [
        pendulum({ x: 50, y: 78 }, { length: 18, ampDeg: 50, omega: 2.4, centerDeg: 90, gate: true }),
        windmill({ x: 50, y: 44 }, { bladeLen: 13, bladeCount: 4, omega: -2.8 }),
      ],
    }),
  ],
);
