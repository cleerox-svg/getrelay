// "Pirate Cove" — a swashbuckling course of PORTALS and HAZARDS: barrel-tunnels
// that teleport the ball across a blocking wall, tide pools (water) that wash a
// stray putt back to where you hit it, sand traps that bog it down, plus climbing
// ramps and breaking slopes. 8 holes in the 100x125 virtual board (x right, y
// DOWN). Pure DATA — puttHole() fills the closed border + full green + empty
// schema arrays; each hole spells out only what makes it distinctive.
//
// Design rules (enforced by validatePuttHole): par ∈ 2..3; cup + tee on the
// green; the cup point holds a rest; hazards never cover the cup/tee, overlap,
// or fully wall the board off; both tunnel mouths are in bounds and reachable;
// everything inside the play bounds. Tunnels are deterministic (a pure geometry
// map on the sim's own step), hazards are region tests — vitest stays exact.

import { puttHole, definePuttCourse, seg, tunnel } from './builder';
import type { PuttCourse } from './types';

const THEME = 'cove';

export const PIRATE_COVE: PuttCourse = definePuttCourse(
  { id: 'pirate-cove', name: 'Pirate Cove', theme: THEME },
  [
    // 1 — the opener: a sand trap squats across the middle of the line. Putt
    // firmly to power THROUGH it, or thread around the side. Par 3.
    puttHole({
      id: 1,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 106 },
      cup: { x: 50, y: 26 },
      hazards: [{ kind: 'sand', region: { x0: 34, y0: 44, x1: 66, y1: 58 } }],
      tilts: [{ region: { x0: 14, y0: 62, x1: 86, y1: 100 }, gradePct: 2.5, dirDeg: 180 }],
    }),

    // 2 — the tide pool: a long water channel guards the LEFT, so hug the right
    // side to a cup up-right. Roll into the pool and you start the putt over. Par 3.
    puttHole({
      id: 2,
      par: 3,
      theme: THEME,
      tee: { x: 30, y: 106 },
      cup: { x: 70, y: 28 },
      hazards: [{ kind: 'water', region: { x0: 14, y0: 40, x1: 44, y1: 96 } }],
    }),

    // 3 — THE BARREL TUNNEL: a wall walls off the top half of the board; the only
    // way up is the barrel — roll into the low mouth and pop out above the wall,
    // still moving, on a line to the cup. Par 3.
    puttHole({
      id: 3,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 108 },
      cup: { x: 50, y: 26 },
      walls: [seg(8, 56, 92, 56)],
      obstacles: [
        tunnel(
          [
            { x: 56, y: 72 },
            { x: 44, y: 72 },
          ],
          [
            { x: 44, y: 40 },
            { x: 56, y: 40 },
          ],
        ),
      ],
    }),

    // 4 — climb + carry: ramp up onto a shelf, but a sand trap waits on the far
    // side of the crest — crest with PACE, not so much you bog in the sand. Par 3.
    puttHole({
      id: 4,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 106 },
      cup: { x: 50, y: 28 },
      ramps: [{ a: { x: 50, y: 84 }, b: { x: 50, y: 60 }, width: 40, riseHeight: 5 }],
      hazards: [{ kind: 'sand', region: { x0: 34, y0: 34, x1: 66, y1: 46 } }],
    }),

    // 5 — thread the reef: two tide pools leave only a narrow gap up the middle,
    // on a gentle helping downslope. Miss the gap and you re-putt. Par 3.
    puttHole({
      id: 5,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 108 },
      cup: { x: 50, y: 24 },
      hazards: [
        { kind: 'water', region: { x0: 14, y0: 52, x1: 46, y1: 70 } },
        { kind: 'water', region: { x0: 54, y0: 52, x1: 86, y1: 70 } },
      ],
      tilts: [{ region: { x0: 14, y0: 24, x1: 86, y1: 50 }, gradePct: 3, dirDeg: 270 }],
    }),

    // 6 — a short breather across a sand belt on a mild left break. Par 2.
    puttHole({
      id: 6,
      par: 2,
      theme: THEME,
      tee: { x: 35, y: 98 },
      cup: { x: 65, y: 42 },
      hazards: [{ kind: 'sand', region: { x0: 40, y0: 56, x1: 60, y1: 72 } }],
      tilts: [{ region: { x0: 30, y0: 38, x1: 80, y1: 90 }, gradePct: 2.5, dirDeg: 180 }],
    }),

    // 7 — the diagonal barrel: a tunnel spirits the ball from the low-left up to
    // the high-right, and a banked rail helps steer the exit toward the cup. Par 3.
    puttHole({
      id: 7,
      par: 3,
      theme: THEME,
      tee: { x: 28, y: 106 },
      cup: { x: 72, y: 28 },
      walls: [seg(60, 60, 88, 60, true)],
      obstacles: [
        tunnel(
          [
            { x: 38, y: 80 },
            { x: 26, y: 80 },
          ],
          [
            { x: 60, y: 44 },
            { x: 72, y: 44 },
          ],
        ),
      ],
    }),

    // 8 — THE COVE FINALE: ramp up off the tee, split tide pool + sand traps
    // framing a narrow crest, then a barrel through the top to a cup on a gentle
    // break. Every trick of the cove in one hole. Par 3.
    puttHole({
      id: 8,
      par: 3,
      theme: THEME,
      tee: { x: 50, y: 110 },
      cup: { x: 50, y: 22 },
      ramps: [{ a: { x: 50, y: 92 }, b: { x: 50, y: 74 }, width: 40, riseHeight: 4 }],
      hazards: [
        { kind: 'water', region: { x0: 14, y0: 44, x1: 40, y1: 64 } },
        { kind: 'sand', region: { x0: 60, y0: 44, x1: 86, y1: 64 } },
      ],
      obstacles: [
        tunnel(
          [
            { x: 56, y: 70 },
            { x: 44, y: 70 },
          ],
          [
            { x: 44, y: 34 },
            { x: 56, y: 34 },
          ],
        ),
      ],
      tilts: [{ region: { x0: 14, y0: 22, x1: 86, y1: 40 }, gradePct: 2.5, dirDeg: 0 }],
    }),
  ],
);
