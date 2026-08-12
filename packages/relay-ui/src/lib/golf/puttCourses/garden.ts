// "The Back Garden" — the default mini-golf course: 8 slope holes in the
// 100x125 virtual board (x right, y DOWN). This reauthors the original 6 flat
// holes and adds 2 new ones, now with PHYSICS-COUPLED slopes (tilt planes that
// break a putt), banked rails you carom the ball off, and a ramp you must climb.
// Pure DATA — puttHole() fills the closed border + full green + empty schema
// arrays so each hole spells out only what makes it distinctive.
//
// Design rules (enforced by validatePuttHole): par ∈ 2..3; cup + tee on the
// green; the green under the cup holds a rest (|slopeAccel| ≤ PUTT_STATIC_HOLD,
// i.e. grade ≲ 7.9%); everything inside the play bounds. The FUN is risk/reward:
// a tempting fast line across a break vs a safe rolled route, a ramp that rolls
// the ball back if you're timid, banked rails that reward a confident carom.

import { puttHole, definePuttCourse, seg } from './builder';
import type { PuttCourse } from './types';

const THEME = 'garden';

export const GARDEN: PuttCourse = definePuttCourse(
  { id: 'garden', name: 'The Back Garden', theme: THEME },
  [
    // 1 — gentle opener that teaches the break: a straight putt drifts RIGHT on
    // a 3% sidehill. Aim a hair left of the cup. Par 2.
    puttHole({
      id: 1,
      par: 2,
      theme: THEME,
      tee: { x: 50, y: 104 },
      cup: { x: 50, y: 24 },
      tilts: [{ region: { x0: 14, y0: 40, x1: 86, y1: 96 }, gradePct: 3, dirDeg: 0 }],
    }),

    // 2 — a left baffle forces the ball right; a banked rail on the far right
    // caroms it back up toward the cup. The bold line banks off the rail; the
    // safe line trickles around. Par 3.
    puttHole({
      id: 2,
      par: 3,
      theme: THEME,
      tee: { x: 28, y: 104 },
      cup: { x: 72, y: 26 },
      walls: [seg(8, 64, 60, 64), seg(72, 88, 86, 52, true)],
      tilts: [{ region: { x0: 40, y0: 30, x1: 86, y1: 82 }, gradePct: 2.5, dirDeg: 180 }],
    }),

    // 3 — an S: a right shelf then a left shelf, each with an OPPOSITE cross
    // break, so the ball weaves. Reading both breaks is the hole. Par 3.
    puttHole({
      id: 3,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 105 },
      cup: { x: 50, y: 24 },
      walls: [seg(34, 58, 92, 58), seg(8, 86, 58, 86)],
      tilts: [
        { region: { x0: 14, y0: 86, x1: 86, y1: 110 }, gradePct: 4, dirDeg: 0 },
        { region: { x0: 14, y0: 34, x1: 86, y1: 58 }, gradePct: 4, dirDeg: 180 },
      ],
    }),

    // 4 — THE RAMP: climb a rise onto a raised shelf where the cup sits. Too
    // timid and the ball rolls back down; commit and it crests to the flat top.
    // Par 3.
    puttHole({
      id: 4,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 106 },
      cup: { x: 50, y: 26 },
      ramps: [{ a: { x: 50, y: 80 }, b: { x: 50, y: 50 }, width: 40, riseHeight: 5 }],
    }),

    // 5 — a solid island block dead centre: putt around either side, then a
    // gentle uphill shelf near the top checks the ball toward the cup. Par 3.
    puttHole({
      id: 5,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 106 },
      cup: { x: 50, y: 24 },
      walls: [seg(40, 52, 60, 52), seg(60, 52, 60, 74), seg(60, 74, 40, 74), seg(40, 74, 40, 52)],
      tilts: [{ region: { x0: 14, y0: 28, x1: 86, y1: 50 }, gradePct: 3, dirDeg: 270 }],
    }),

    // 6 — a banked zigzag finisher for the front half: three baffles, the first
    // two banked rails you can carom off to save a stroke. Par 3.
    puttHole({
      id: 6,
      par: 3,
      theme: THEME,
      tee: { x: 70, y: 108 },
      cup: { x: 30, y: 24 },
      walls: [seg(8, 45, 60, 45, true), seg(40, 72, 92, 72, true), seg(8, 96, 52, 96)],
      tilts: [{ region: { x0: 14, y0: 30, x1: 86, y1: 45 }, gradePct: 3, dirDeg: 180 }],
    }),

    // 7 — NEW: a long left-to-right dogleg on a strong 5% sidehill. The whole
    // green tilts right, so the safe line hugs the high (left) side and lets the
    // break feed the ball down to the cup. A baffle blocks the lazy straight
    // route. Par 3.
    puttHole({
      id: 7,
      par: 3,
      theme: THEME,
      tee: { x: 22, y: 108 },
      cup: { x: 78, y: 30 },
      walls: [seg(8, 60, 54, 60)],
      tilts: [{ region: { x0: 14, y0: 34, x1: 86, y1: 100 }, gradePct: 5, dirDeg: 0 }],
    }),

    // 8 — NEW grand finale: a ramp onto a mid shelf, then a gently undulating
    // right-breaking green to a cup on a flat crown. Pace over the ramp AND a
    // break read — everything the course taught. Par 3.
    puttHole({
      id: 8,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 110 },
      cup: { x: 50, y: 22 },
      ramps: [{ a: { x: 50, y: 86 }, b: { x: 50, y: 64 }, width: 44, riseHeight: 4 }],
      tilts: [{ region: { x0: 14, y0: 30, x1: 86, y1: 60 }, gradePct: 3, dirDeg: 0 }],
      undulation: 0.25,
    }),
  ],
);
