// Mini-golf course builder + hole authoring helpers + the validator that
// enforces the puttSim/puttField invariants for every authored hole. The hole
// DATA files (garden, …) call puttHole() to stay terse and definePuttCourse()
// to build the container; puttCourses.test.ts runs validatePuttCourse() as a
// HARD GATE so a mis-authored hole (cup off the green, a green too steep to hold
// a putt, a stray wall gap, a tilt/ramp/hazard/tee/cup out of bounds, a par out
// of band, or a >8-hole course) fails loudly rather than shipping.
//
// Mirrors courses/builder.ts (Course mode) at mini-golf scale.

import type { Green, Hole, Wall } from '../puttSim';
import { puttSlopeAccel, type Pt } from '../puttField';
import { CUP_R, PUTT_GRAVITY, PUTT_STATIC_HOLD } from '../tuning';
import type { PuttCourse } from './types';

// Play area inset from the 100x125 virtual bounds; every hole shares it. The
// border wall loop runs on these; tilts/ramps/hazards/cup/tee must lie inside.
export const BX0 = 8;
export const BY0 = 8;
export const BX1 = 92;
export const BY1 = 117;

// Perimeter of an axis-aligned rectangle as four wall segments. Used for the
// outer border (ball bounces off the inside) and for solid obstacle boxes (ball
// bounces off the outside) — the collision math is symmetric. `bank` marks the
// segments as banked rails.
export function rectWalls(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bank = false,
): Wall[] {
  return [
    { a: { x: x0, y: y0 }, b: { x: x1, y: y0 }, bank },
    { a: { x: x1, y: y0 }, b: { x: x1, y: y1 }, bank },
    { a: { x: x1, y: y1 }, b: { x: x0, y: y1 }, bank },
    { a: { x: x0, y: y1 }, b: { x: x0, y: y0 }, bank },
  ];
}

// A single wall segment.
export function seg(ax: number, ay: number, bx: number, by: number, bank = false): Wall {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by }, bank };
}

// The shared closed border loop and the full-board green fill (terse defaults
// so a data file only spells out what makes a hole distinctive).
export const BORDER: Wall[] = rectWalls(BX0, BY0, BX1, BY1);
export const FULL_GREEN: Green[] = [{ x: BX0, y: BY0, w: BX1 - BX0, h: BY1 - BY0, r: 6 }];

// --- Authoring helper ------------------------------------------------------

// Default-filler for a Hole so the data files only spell out what makes a hole
// distinctive: it prepends the closed BORDER loop to any extra walls, fills a
// FULL_GREEN if none given, and defaults the (empty) new schema arrays so a
// terse hole still type-checks and validates. Anything provided in `h`
// overrides. Pass `walls` for baffles/banks; the border is always added.
export interface PuttHoleInput {
  id: number;
  par: number;
  tee: Pt;
  cup: Pt;
  name?: string;
  theme?: string;
  // Extra walls beyond the always-present border (baffles, islands, banks).
  walls?: Wall[];
  greens?: Green[];
  tilts?: Hole['tilts'];
  ramps?: Hole['ramps'];
  undulation?: number;
  hazards?: Hole['hazards'];
  obstacles?: Hole['obstacles'];
}

export function puttHole(h: PuttHoleInput): Hole {
  return {
    id: h.id,
    par: h.par,
    name: h.name,
    theme: h.theme,
    tee: { x: h.tee.x, y: h.tee.y },
    cup: { c: { x: h.cup.x, y: h.cup.y }, r: CUP_R },
    walls: [...BORDER, ...(h.walls ?? [])],
    greens: h.greens ?? FULL_GREEN,
    tilts: h.tilts ?? [],
    ramps: h.ramps ?? [],
    undulation: h.undulation ?? 0,
    hazards: h.hazards ?? [],
    obstacles: h.obstacles ?? [],
  };
}

// --- Course assembly -------------------------------------------------------

// Build a PuttCourse from meta + holes, DERIVING par from the holes so the
// scorecard total can never disagree with the hole data.
export function definePuttCourse(
  meta: { id: string; name: string; theme: string },
  holes: Hole[],
): PuttCourse {
  return {
    ...meta,
    holes,
    par: holes.reduce((a, h) => a + h.par, 0),
  };
}

// --- Validation ------------------------------------------------------------

const inBounds = (x: number, y: number): boolean => x >= BX0 && x <= BX1 && y >= BY0 && y <= BY1;

function ptOnGreen(g: Green, x: number, y: number): boolean {
  return x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
}
function onAnyGreen(greens: Green[], x: number, y: number): boolean {
  return greens.some((g) => ptOnGreen(g, x, y));
}

// The perimeter the BORDER loop must close (so a ball can never escape). A hole
// authored via puttHole() always has it; validate it explicitly so a
// hand-rolled hole (or a regression in the filler) is caught.
function hasClosedBorder(walls: Wall[]): boolean {
  const need = BORDER;
  return need.every((n) =>
    walls.some(
      (w) =>
        (w.a.x === n.a.x && w.a.y === n.a.y && w.b.x === n.b.x && w.b.y === n.b.y) ||
        (w.a.x === n.b.x && w.a.y === n.b.y && w.b.x === n.a.x && w.b.y === n.a.y),
    ),
  );
}

// Return a list of human-readable invariant violations for one hole ([] = good).
// Mirrors courses/builder.ts validateHole():
//   • par ∈ 2..3 (the mini-golf band; holePoints tuned for it);
//   • cup and tee both lie on a green rect (always a putting surface);
//   • the green under the cup can HOLD a rest — |puttSlopeAccel(cup)| ≤
//     PUTT_STATIC_HOLD (the mini analogue of "green too steep to hold a putt");
//   • the walls include the closed border loop;
//   • cup, tee, every tilt region corner, ramp endpoint and hazard region lie
//     inside the play bounds.
export function validatePuttHole(h: Hole): string[] {
  const errs: string[] = [];
  const tag = `hole ${h.id}`;

  if (h.par < 2 || h.par > 3) errs.push(`${tag}: par ${h.par} out of range (2..3)`);

  if (h.greens.length === 0) errs.push(`${tag}: no green defined`);
  if (!onAnyGreen(h.greens, h.cup.c.x, h.cup.c.y)) {
    errs.push(`${tag}: cup (${h.cup.c.x},${h.cup.c.y}) is not on a green`);
  }
  if (!onAnyGreen(h.greens, h.tee.x, h.tee.y)) {
    errs.push(`${tag}: tee (${h.tee.x},${h.tee.y}) is not on a green`);
  }

  // The cup must sit somewhere a putt can come to rest, or it can never be
  // holed cleanly (the ball trickles off forever). Same static-hold test the
  // sim's rest rule uses.
  const { ax, ay } = puttSlopeAccel(h, h.cup.c.x, h.cup.c.y, PUTT_GRAVITY);
  const cupAccel = Math.hypot(ax, ay);
  if (cupAccel > PUTT_STATIC_HOLD + 1e-6) {
    errs.push(
      `${tag}: green too steep at the cup to hold a putt — |slopeAccel|=${cupAccel.toFixed(2)} > PUTT_STATIC_HOLD=${PUTT_STATIC_HOLD.toFixed(2)}`,
    );
  }

  if (!hasClosedBorder(h.walls)) {
    errs.push(`${tag}: walls do not include the closed border loop`);
  }

  if (!inBounds(h.cup.c.x, h.cup.c.y)) errs.push(`${tag}: cup out of play bounds`);
  if (!inBounds(h.tee.x, h.tee.y)) errs.push(`${tag}: tee out of play bounds`);

  for (let i = 0; i < (h.tilts?.length ?? 0); i++) {
    const r = h.tilts![i]!.region;
    if (r.x0 >= r.x1 || r.y0 >= r.y1) errs.push(`${tag}: tilt ${i} region is empty/inverted`);
    if (!inBounds(r.x0, r.y0) || !inBounds(r.x1, r.y1)) {
      errs.push(`${tag}: tilt ${i} region out of play bounds`);
    }
  }
  for (let i = 0; i < (h.ramps?.length ?? 0); i++) {
    const rp = h.ramps![i]!;
    if (!inBounds(rp.a.x, rp.a.y) || !inBounds(rp.b.x, rp.b.y)) {
      errs.push(`${tag}: ramp ${i} endpoint out of play bounds`);
    }
    if (rp.width <= 0) errs.push(`${tag}: ramp ${i} width must be positive`);
  }
  for (let i = 0; i < (h.hazards?.length ?? 0); i++) {
    const r = h.hazards![i]!.region;
    if (r.x0 >= r.x1 || r.y0 >= r.y1) errs.push(`${tag}: hazard ${i} region is empty/inverted`);
    if (!inBounds(r.x0, r.y0) || !inBounds(r.x1, r.y1)) {
      errs.push(`${tag}: hazard ${i} region out of play bounds`);
    }
  }

  return errs;
}

// Validate every hole of a course PLUS the course-level ≤8-hole clamp (the
// worker's MAX_ROUNDS); [] = all good.
export function validatePuttCourse(c: PuttCourse): string[] {
  const errs: string[] = [];
  if (c.holes.length === 0) errs.push(`course ${c.id}: has no holes`);
  if (c.holes.length > 8) {
    errs.push(`course ${c.id}: ${c.holes.length} holes exceeds the 8-hole clamp (worker MAX_ROUNDS)`);
  }
  for (const h of c.holes) errs.push(...validatePuttHole(h));
  return errs;
}
