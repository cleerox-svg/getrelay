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
import { BALL_R, CUP_R, MAX_LAUNCH_SPEED, PUTT_GRAVITY, PUTT_STATIC_HOLD } from '../tuning';
import type {
  Obstacle,
  PendulumObstacle,
  TunnelObstacle,
  WindmillObstacle,
} from '../puttObstacles';
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

// --- Moving-obstacle authoring helpers (mirror greensideHazard() in
// courses/builder.ts — terse constructors with sensible defaults). ----------

// A windmill: `bladeCount` blades of `bladeLen` pivoting at `omega` rad/s about
// `pivot`. Default 4 blades. Keep the swept disc (radius bladeLen) inside the
// bounds and clear of the cup/tee (validatePuttHole enforces it).
export function windmill(
  pivot: Pt,
  o: { bladeLen: number; bladeCount?: number; omega: number; phase0?: number },
): WindmillObstacle {
  return {
    kind: 'windmill',
    pivot: { x: pivot.x, y: pivot.y },
    bladeLen: o.bladeLen,
    bladeCount: o.bladeCount ?? 4,
    omega: o.omega,
    phase0: o.phase0,
  };
}

// A swinging gate/pendulum: an arm of `length` from `pivot` sweeping
// `centerDeg ± ampDeg` at `omega` rad/s (centerDeg defaults 90 = pointing +y,
// i.e. "down" the board). `gate:true` adds a second opposed arm.
export function pendulum(
  pivot: Pt,
  o: {
    length: number;
    ampDeg: number;
    omega: number;
    centerDeg?: number;
    phase0?: number;
    gate?: boolean;
  },
): PendulumObstacle {
  return {
    kind: 'pendulum',
    pivot: { x: pivot.x, y: pivot.y },
    length: o.length,
    centerDeg: o.centerDeg ?? 90,
    ampDeg: o.ampDeg,
    omega: o.omega,
    phase0: o.phase0,
    gate: o.gate,
  };
}

// A portal tunnel: crossing INTO mouthA re-emerges at mouthB (and vice-versa).
// Each mouth is a segment [a, b]; author it so the ball approaches from the
// mouth's outward-normal side (see puttObstacles.mouthNormal).
export function tunnel(mouthA: [Pt, Pt], mouthB: [Pt, Pt]): TunnelObstacle {
  return {
    kind: 'tunnel',
    mouthA: { a: { x: mouthA[0].x, y: mouthA[0].y }, b: { x: mouthA[1].x, y: mouthA[1].y } },
    mouthB: { a: { x: mouthB[0].x, y: mouthB[0].y }, b: { x: mouthB[1].x, y: mouthB[1].y } },
  };
}

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
const ptInRect = (r: { x0: number; y0: number; x1: number; y1: number }, x: number, y: number): boolean =>
  x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
const rectsOverlap = (
  a: { x0: number; y0: number; x1: number; y1: number },
  b: { x0: number; y0: number; x1: number; y1: number },
): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// Point-in-rounded-rect, mirroring how PuttGL draws the green footprint (a
// rounded-rect with corner radius g.r): inside the axis-aligned rect AND, in the
// four corner quadrants, within g.r of the corner arc centre. So the validator
// is exactly as permissive as the rendered/played surface — a cup or tee tucked
// into a clipped corner is correctly rejected, not waved through by a plain rect
// test.
function ptOnGreen(g: Green, x: number, y: number): boolean {
  if (x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
  const r = Math.min(g.r, g.w / 2, g.h / 2);
  if (r <= 0) return true;
  // Nearest point of the inset core rect (corner-arc centres live on its border).
  const cx = x < g.x + r ? g.x + r : x > g.x + g.w - r ? g.x + g.w - r : x;
  const cy = y < g.y + r ? g.y + r : y > g.y + g.h - r ? g.y + g.h - r : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
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
  const hazards = h.hazards ?? [];
  for (let i = 0; i < hazards.length; i++) {
    const r = hazards[i]!.region;
    if (r.x0 >= r.x1 || r.y0 >= r.y1) errs.push(`${tag}: hazard ${i} region is empty/inverted`);
    if (!inBounds(r.x0, r.y0) || !inBounds(r.x1, r.y1)) {
      errs.push(`${tag}: hazard ${i} region out of play bounds`);
    }
    // A hazard must not swallow the cup or tee, nor wall the board off with no
    // way past (best-effort "the only path isn't fully blocked" — mirrors the
    // spirit of courses/builder's fringe-clearance guard). Mini-golf is
    // ground-only, so a full-span hazard truly blocks (no carry over it).
    if (ptInRect(r, h.cup.c.x, h.cup.c.y)) errs.push(`${tag}: hazard ${i} covers the cup`);
    if (ptInRect(r, h.tee.x, h.tee.y)) errs.push(`${tag}: hazard ${i} covers the tee`);
    if (r.x0 <= BX0 && r.x1 >= BX1) errs.push(`${tag}: hazard ${i} spans the full width (blocks the only path)`);
    if (r.y0 <= BY0 && r.y1 >= BY1) errs.push(`${tag}: hazard ${i} spans the full height (blocks the only path)`);
    // Overlapping hazards are ambiguous (hazardKindAt takes the first match).
    for (let j = i + 1; j < hazards.length; j++) {
      if (rectsOverlap(r, hazards[j]!.region)) errs.push(`${tag}: hazards ${i} and ${j} overlap`);
    }
  }

  for (let i = 0; i < (h.obstacles?.length ?? 0); i++) {
    errs.push(...validateObstacle(h, h.obstacles![i]!, i, tag));
  }

  return errs;
}

// Per-obstacle invariants ([] = good):
//   • windmill/pendulum: pivot in bounds; the SWEPT DISC (radius = bladeLen /
//     arm length) fits inside the bounds and clears the cup and the tee (a blade
//     must never sit permanently over either);
//   • tunnel: both mouths' endpoints in bounds and each mouth's midpoint on a
//     green (both ends reachable).
function validateObstacle(h: Hole, ob: Obstacle, i: number, tag: string): string[] {
  const errs: string[] = [];
  if (ob.kind === 'windmill' || ob.kind === 'pendulum') {
    const p = ob.pivot;
    const reach = ob.kind === 'windmill' ? ob.bladeLen : ob.length;
    if (reach <= 0) errs.push(`${tag}: obstacle ${i} has non-positive reach`);
    if (ob.kind === 'windmill' && ob.bladeCount < 1) errs.push(`${tag}: obstacle ${i} needs ≥1 blade`);
    if (!inBounds(p.x, p.y)) errs.push(`${tag}: obstacle ${i} pivot out of play bounds`);
    if (p.x - reach < BX0 || p.x + reach > BX1 || p.y - reach < BY0 || p.y + reach > BY1) {
      errs.push(`${tag}: obstacle ${i} swept area extends out of play bounds`);
    }
    const dCup = Math.hypot(h.cup.c.x - p.x, h.cup.c.y - p.y);
    const dTee = Math.hypot(h.tee.x - p.x, h.tee.y - p.y);
    if (dCup <= reach + h.cup.r) errs.push(`${tag}: obstacle ${i} swept area overlaps the cup`);
    if (dTee <= reach + BALL_R) errs.push(`${tag}: obstacle ${i} swept area overlaps the tee`);
    // Bound the blade/arm TIP SPEED below the tunnelling-safe launch ceiling so a
    // future course can't author an obstacle that sweeps PAST the ball within one
    // 1/120s substep (a fast blade skipping a wall / passing through the ball).
    // Windmill tip speed = |omega|·bladeLen; a pendulum's PEAK tip speed is
    // ampRad·|omega|·length (its max angular velocity ampRad·omega, at the swing
    // centre, times the arm). The sim also clamps post-hit speed (puttSim), but
    // rejecting the bad authoring here fails loudly with a clear message.
    const tipSpeed =
      ob.kind === 'windmill'
        ? Math.abs(ob.omega) * ob.bladeLen
        : ((ob.ampDeg * Math.PI) / 180) * Math.abs(ob.omega) * ob.length;
    if (tipSpeed > MAX_LAUNCH_SPEED) {
      errs.push(
        `${tag}: obstacle ${i} tip speed ${tipSpeed.toFixed(1)} exceeds the tunnelling-safe MAX_LAUNCH_SPEED=${MAX_LAUNCH_SPEED}`,
      );
    }
  } else {
    const mouths: [string, TunnelObstacle['mouthA']][] = [
      ['A', ob.mouthA],
      ['B', ob.mouthB],
    ];
    for (const [nm, m] of mouths) {
      if (!inBounds(m.a.x, m.a.y) || !inBounds(m.b.x, m.b.y)) {
        errs.push(`${tag}: obstacle ${i} tunnel mouth ${nm} out of play bounds`);
      }
      const mx = (m.a.x + m.b.x) / 2;
      const my = (m.a.y + m.b.y) / 2;
      if (!onAnyGreen(h.greens, mx, my)) {
        errs.push(`${tag}: obstacle ${i} tunnel mouth ${nm} not reachable (off the green)`);
      }
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
