// The hand-authored mini-golf course: 6 holes in the 100x125 virtual
// coordinate space (see lib/golf/engine.ts). Pure data — every hole is a
// border loop plus a few obstacle walls, a tee (bottom-ish) and a cup
// (top-ish), with a par of 2–4. Greens are cosmetic fairway fills.

import type { Green, Hole, Wall } from './putting';
import { CUP_R } from './tuning';

// Perimeter of an axis-aligned rectangle as four wall segments. Used for
// the outer border (ball bounces off the inside) and for solid obstacle
// boxes (ball bounces off the outside) — the collision math is symmetric.
function rectWalls(x0: number, y0: number, x1: number, y1: number): Wall[] {
  return [
    { a: { x: x0, y: y0 }, b: { x: x1, y: y0 } },
    { a: { x: x1, y: y0 }, b: { x: x1, y: y1 } },
    { a: { x: x1, y: y1 }, b: { x: x0, y: y1 } },
    { a: { x: x0, y: y1 }, b: { x: x0, y: y0 } },
  ];
}

// Play area inset from the virtual bounds; every hole shares it.
const BX0 = 8;
const BY0 = 8;
const BX1 = 92;
const BY1 = 117;

const BORDER = rectWalls(BX0, BY0, BX1, BY1);
const FULL_GREEN: Green[] = [{ x: BX0, y: BY0, w: BX1 - BX0, h: BY1 - BY0, r: 6 }];

function seg(ax: number, ay: number, bx: number, by: number): Wall {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

export interface Course {
  id: string;
  name: string;
  holes: Hole[];
}

export const COURSE: Course = {
  id: 'front9',
  name: 'The Back Garden',
  holes: [
    // 1 — a gentle straight opener.
    {
      id: 1,
      par: 2,
      tee: { x: 50, y: 104 },
      cup: { c: { x: 50, y: 24 }, r: CUP_R },
      walls: [...BORDER],
      greens: FULL_GREEN,
    },
    // 2 — a single baffle off the left wall; go around the right.
    {
      id: 2,
      par: 3,
      tee: { x: 30, y: 104 },
      cup: { c: { x: 70, y: 24 }, r: CUP_R },
      walls: [...BORDER, seg(BX0, 62, 66, 62)],
      greens: FULL_GREEN,
    },
    // 3 — an S: baffle off the right, then off the left.
    {
      id: 3,
      par: 3,
      tee: { x: 50, y: 105 },
      cup: { c: { x: 50, y: 24 }, r: CUP_R },
      walls: [...BORDER, seg(34, 55, BX1, 55), seg(BX0, 85, 58, 85)],
      greens: FULL_GREEN,
    },
    // 4 — two offset baffles, cup tucked into the far corner.
    {
      id: 4,
      par: 4,
      tee: { x: 75, y: 105 },
      cup: { c: { x: 25, y: 24 }, r: CUP_R },
      walls: [...BORDER, seg(BX0, 50, 64, 50), seg(36, 80, BX1, 80)],
      greens: FULL_GREEN,
    },
    // 5 — a solid island block dead centre; putt around either side.
    {
      id: 5,
      par: 3,
      tee: { x: 50, y: 105 },
      cup: { c: { x: 50, y: 24 }, r: CUP_R },
      walls: [...BORDER, ...rectWalls(40, 50, 60, 72)],
      greens: FULL_GREEN,
    },
    // 6 — a three-baffle zigzag to finish.
    {
      id: 6,
      par: 4,
      tee: { x: 70, y: 108 },
      cup: { c: { x: 30, y: 22 }, r: CUP_R },
      walls: [
        ...BORDER,
        seg(BX0, 45, 60, 45),
        seg(40, 70, BX1, 70),
        seg(BX0, 92, 52, 92),
      ],
      greens: FULL_GREEN,
    },
  ],
};
