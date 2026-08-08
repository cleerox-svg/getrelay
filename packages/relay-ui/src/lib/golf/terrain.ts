// Course terrain + hole model — the "hole is DATA" foundation for the 9-hole
// course (GOLF.md roadmap step 3). Both the rendered terrain mesh AND the ball
// physics read ONE source of truth here: heightAt() gives the ground elevation,
// gradientAt() its slope (so the ball rolls downhill and putts break), and
// surfaceAt() the lie (fairway/green/fringe/rough/bunker/water/cartpath/tee) →
// which maps straight onto the TERRAIN materials the sim already tunes bounce
// and roll against (lib/golf/rangeSim.ts). Nothing here draws or imports three.
//
// World space matches rangeSim: d = downrange yards, x = lateral yards (+right).
// Elevation is in yards too, small (hills ±a few yd, greens raised a little), so
// it composes with the existing yard-space ballistics without rescaling.

// The lies a course point can be. 'ob' = out of bounds (past the corridor).
// The solid ones map to rangeSim's TERRAIN materials; water/ob are terminal.
export type Surface =
  | 'tee'
  | 'fairway'
  | 'green'
  | 'fringe'
  | 'rough'
  | 'bunker'
  | 'water'
  | 'cartpath'
  | 'ob';

export interface Pt {
  d: number;
  x: number;
}

// A circular feature (bunker, water carry, pond) placed on the hole. `depth`
// (yards) sinks the terrain inside it — negative for a bunker/pond basin, so the
// heightfield itself dishes out and the rendered mesh + physics agree.
export interface CircleFeature {
  kind: Extract<Surface, 'bunker' | 'water'>;
  d: number;
  x: number;
  r: number;
  depth: number;
}

// The green: a raised, mown pad with a planar TILT (tiltPct rise per yard in
// tiltDir radians, 0 = tilts toward the tee / "back-to-front") plus its own
// fine undulation. The tilt is what makes putts break — gradientAt() picks it up.
export interface GreenDef {
  d: number;
  x: number;
  r: number;
  // Elevation of the green pad above the base grade, yards.
  raise: number;
  // Slope of the putting surface: tiltPct yards of fall per yard, toward tiltDir.
  tiltPct: number;
  tiltDir: number;
  // Local undulation amplitude (yards) for interior rolls beyond the main tilt.
  undulation: number;
}

// A hole as data. The fairway is a CENTERLINE polyline with a half-width, so a
// dogleg is just bent points; everything else (green, hazards, rough, cart path)
// is placed relative to it. terrain.* shape the land: a tee→green elevation
// change plus rolling hills of `hilliness` amplitude at `hillScale` wavelength.
export interface CourseHole {
  id: number;
  par: number;
  yards: number;
  tee: Pt;
  pin: Pt;
  // Fairway centerline (downrange-ordered) + half-width in yards (the mown
  // corridor; beyond it + the fringe is rough, beyond `roughHalf` is OB).
  centerline: Pt[];
  fairwayHalf: number;
  roughHalf: number;
  green: GreenDef;
  fringeW: number;
  hazards: CircleFeature[];
  // A cart path ribbon: a polyline the ball can catch a firm bounce off.
  cartPath?: { pts: Pt[]; half: number };
  terrain: {
    seed: number;
    hilliness: number;
    hillScale: number;
    teeElev: number;
    greenElev: number;
  };
  wind: { along: number; cross: number };
}

// --- Deterministic value noise (rolling hills) -----------------------------
// A cheap hash-based 2D value noise, smoothstep-interpolated, tileable enough
// for terrain. Deterministic in (seed, d, x) so a hole looks identical every
// load and the headless harness can assert against it.
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function valueNoise(d: number, x: number, seed: number): number {
  const id = Math.floor(d);
  const ix = Math.floor(x);
  const fd = smooth(d - id);
  const fx = smooth(x - ix);
  const a = hash2(id, ix, seed);
  const b = hash2(id + 1, ix, seed);
  const c = hash2(id, ix + 1, seed);
  const e = hash2(id + 1, ix + 1, seed);
  const top = a + (b - a) * fd;
  const bot = c + (c === e ? 0 : e - c) * fd;
  return (top + (bot - top) * fx) * 2 - 1; // → [-1, 1]
}

// --- Geometry helpers ------------------------------------------------------

// Distance from (d,x) to a polyline, plus the parametric position [0..1] of the
// nearest point along it (used to fade width / place the corridor).
function distToPolyline(pts: Pt[], d: number, x: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const vd = b.d - a.d;
    const vx = b.x - a.x;
    const len2 = vd * vd + vx * vx || 1e-6;
    let t = ((d - a.d) * vd + (x - a.x) * vx) / len2;
    t = Math.max(0, Math.min(1, t));
    const cd = a.d + vd * t;
    const cx = a.x + vx * t;
    best = Math.min(best, Math.hypot(d - cd, x - cx));
  }
  return best;
}

function dist(d: number, x: number, p: { d: number; x: number }): number {
  return Math.hypot(d - p.d, x - p.x);
}

// --- Elevation -------------------------------------------------------------

// Ground elevation (yards) at a world point: base tee→green grade + rolling
// hills, then feature stamps (green pad raise + tilt + undulation, hazard
// basins). Because the physics reads THIS and its gradient, a stamped green
// tilt automatically breaks a putt and a bunker basin automatically gathers a
// ball — the look and the play can never disagree.
export function heightAt(hole: CourseHole, d: number, x: number): number {
  const t = hole.terrain;
  const end = hole.centerline[hole.centerline.length - 1] ?? hole.pin;
  const span = Math.max(1, end.d - hole.tee.d);
  const along = Math.max(0, Math.min(1, (d - hole.tee.d) / span));
  let h = t.teeElev + (t.greenElev - t.teeElev) * along;

  // Green PAD influence, computed first because it also FLATTENS the rolling
  // hills under the putting surface — a real green is graded far smoother than
  // the fairway mounds around it, so its own planar tilt (not the surrounding
  // noise) is the slope a putt breaks on. The pad is a PLATEAU: full across the
  // green interior (a flat-topped raise, not a dome), ramping to grade over a
  // gentle bank `skirt` beyond the edge so the collar isn't a cliff.
  const g = hole.green;
  const dg = dist(d, x, g);
  const skirt = 10;
  const gBlend =
    dg <= g.r ? 1 : dg < g.r + skirt ? 0.5 + 0.5 * Math.cos(((dg - g.r) / skirt) * Math.PI) : 0;

  // Rolling hills, almost entirely erased under the green pad: a real green is
  // graded far smoother than the fairway mounds, so its own planar tilt (not the
  // surrounding noise) is the slope a putt breaks on. Leaving even 10% of the
  // hills here gave the putting surface a ~0.5yd-per-6yd lateral wander that made
  // reading a break impossible; 3% keeps a whisper of movement without polluting
  // the designed tilt.
  h += t.hilliness * valueNoise(d / t.hillScale, x / t.hillScale, t.seed) * (1 - 0.97 * gBlend);

  if (gBlend > 0) {
    // Flat-topped raise + planar tilt (fall toward tiltDir) + gentle interior
    // undulation. On the interior gBlend is 1, so the raise is level and the
    // tilt is the dominant slope — exactly what breaks a putt.
    const rel = (d - g.d) * Math.cos(g.tiltDir) + (x - g.x) * Math.sin(g.tiltDir);
    const tilt = -rel * g.tiltPct;
    const undul = g.undulation * valueNoise(d / 12 + 50, x / 12 + 50, t.seed + 7);
    h += g.raise * gBlend + (tilt + undul) * gBlend;
  }

  // Hazard basins (bunker / pond): dish the ground down inside the circle.
  for (const hz of hole.hazards) {
    const dh = dist(d, x, hz);
    if (dh < hz.r) {
      const f = 0.5 + 0.5 * Math.cos((dh / hz.r) * Math.PI);
      h += hz.depth * f;
    }
  }
  return h;
}

// Slope at a world point as ∂h/∂d, ∂h/∂x (dimensionless rise/run) via a central
// difference on heightAt — so it always matches the elevation exactly, features
// included. The ball's roll adds a downhill acceleration from this.
export function gradientAt(hole: CourseHole, d: number, x: number): { gd: number; gx: number } {
  const e = 0.5;
  const gd = (heightAt(hole, d + e, x) - heightAt(hole, d - e, x)) / (2 * e);
  const gx = (heightAt(hole, d, x + e) - heightAt(hole, d, x - e)) / (2 * e);
  return { gd, gx };
}

// Downhill roll acceleration (yd/s² per axis) from the slope at a point. Gravity
// pulls a rolling ball down the fall line: for a small slope, a ≈ g·sin(θ) ≈
// g·slope, directed DOWNHILL — i.e. opposite the (uphill-pointing) gradient. A
// terrain-aware sim adds this to the grounded ball each substep, and it's what
// makes a putt break and a downhill fairway run out further than an uphill one.
// `gravity` is passed in so the course sim reuses rangeSim's tuned constant.
export function slopeAccel(
  hole: CourseHole,
  d: number,
  x: number,
  gravity: number,
): { ad: number; ax: number } {
  const { gd, gx } = gradientAt(hole, d, x);
  return { ad: -gravity * gd, ax: -gravity * gx };
}

// --- Surface classification ------------------------------------------------

// Point-in-corridor: is (d,x) within a polyline half-width, and past the tee /
// before the green? Uses the same polyline distance as the elevation blend.
function onFairway(hole: CourseHole, d: number, x: number): boolean {
  return distToPolyline(hole.centerline, d, x) <= hole.fairwayHalf;
}

// The lie at a world point, in priority order (green/hazards win over fairway,
// fairway over rough, rough over OB). This is the SINGLE classifier the physics
// material lookup and the terrain texture blend both call.
export function surfaceAt(hole: CourseHole, d: number, x: number): Surface {
  // Water/bunker circles first — they cut through everything they overlap.
  for (const hz of hole.hazards) {
    if (dist(d, x, hz) <= hz.r) return hz.kind;
  }
  // Cart path ribbon.
  if (hole.cartPath && distToPolyline(hole.cartPath.pts, d, x) <= hole.cartPath.half) {
    return 'cartpath';
  }
  // Green + its fringe collar.
  const dg = dist(d, x, hole.green);
  if (dg <= hole.green.r) return 'green';
  if (dg <= hole.green.r + hole.fringeW) return 'fringe';
  // Tee box.
  if (dist(d, x, hole.tee) <= 4) return 'tee';
  // Fairway corridor, else rough, else out of bounds.
  if (onFairway(hole, d, x)) return 'fairway';
  if (distToPolyline(hole.centerline, d, x) <= hole.roughHalf) return 'rough';
  return 'ob';
}

// --- Showcase hole #1 ------------------------------------------------------
// A gentle dogleg-right par 5 that shows every piece: a downhill tee shot into a
// rising fairway, a fairway bunker on the inside of the dogleg, a cart path down
// the left, rough off the corridor, a pond short-right of a RAISED, back-to-
// front-tilted green with a greenside bunker. Distances in yards.
export const HOLE_1: CourseHole = {
  id: 1,
  par: 5,
  yards: 520,
  tee: { d: 0, x: 0 },
  pin: { d: 512, x: 18 },
  centerline: [
    { d: 0, x: 0 },
    { d: 180, x: -6 },
    { d: 320, x: 4 },
    { d: 460, x: 16 },
    { d: 512, x: 18 },
  ],
  fairwayHalf: 20,
  roughHalf: 46,
  green: { d: 512, x: 18, r: 15, raise: 3.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.08 },
  fringeW: 3,
  hazards: [
    { kind: 'bunker', d: 300, x: 20, r: 12, depth: -1.6 }, // fairway bunker, inside the dogleg
    { kind: 'bunker', d: 500, x: 34, r: 9, depth: -1.8 }, // greenside bunker right
    { kind: 'water', d: 496, x: 2, r: 13, depth: -2.2 }, // pond short-right of the green
  ],
  cartPath: {
    pts: [
      { d: 20, x: -30 },
      { d: 260, x: -34 },
      { d: 470, x: -26 },
    ],
    half: 2.2,
  },
  terrain: { seed: 1337, hilliness: 2.4, hillScale: 34, teeElev: 6, greenElev: 9 },
  wind: { along: 0, cross: 0 },
};

export const COURSE_HOLES: CourseHole[] = [HOLE_1];
