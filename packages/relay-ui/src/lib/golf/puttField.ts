// Mini-golf slope field — the mini-scale analogue of terrain.ts's field
// helpers, for the 100x125 virtual putting board (x right, y DOWN; the PuttGL
// renderer lays it flat onto the ground plane, X = x, Z = y). PURE MATH: no
// three, no canvas, no sim state — safe to import from the sim, the course
// builder/validator, or (lazily) the renderer.
//
// A mini-golf hole's ground is assembled DETERMINISTICALLY (seeded value-noise,
// NO Math.random) from a tiny per-hole slope schema:
//   • tilt planes  — an axis-aligned region tilted at a constant grade % in a
//                    compass direction (the break / run-out term);
//   • ramps        — a banded steep grade between two points that also RAISES
//                    the elevation, so a ball loses speed climbing it and gains
//                    speed descending (a vertical feature);
//   • undulation   — optional gentle seeded value-noise wobble over the whole
//                    board (subtle, must stay under the rest-hold grade).
//
// puttHeightAt() sums those contributions; puttGradientAt() is its central
// difference; puttSlopeAccel() = -gravity * gradient (SAME sign convention as
// terrain.slopeAccel — the acceleration points DOWNHILL, opposite the uphill-
// pointing gradient, so a grounded sim adds it each substep to break/run a putt).

// A point on the board (x right, y down). Kept local so this module and the
// Hole schema it feeds stay free of any sim-state import cycle.
export interface Pt {
  x: number;
  y: number;
}

// An axis-aligned region of the board (virtual units). x0<x1, y0<y1.
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// A tilt plane: the ground inside `region` falls at a CONSTANT `gradePct`
// (rise/run, in PERCENT — 5 = a 5% grade) toward `dirDeg`. `dirDeg` is the
// DOWNHILL bearing in the board plane, degrees clockwise from +x (right): 0 =
// downhill toward +x (right), 90 = downhill toward +y (DOWN, i.e. toward the
// bottom/tee), 180 = toward -x (left), 270 = toward -y (up, toward a top cup).
// Height is measured relative to the region CENTRE and CLAMPED at the region
// bounds (the ground is held flat beyond the region), so puttHeightAt stays
// continuous — no cliff at the edge, no spurious gradient spike.
export interface SlopePlane {
  region: Rect;
  gradePct: number;
  dirDeg: number;
}

// A ramp: a raised band running from `a` to `b`, `width` wide, climbing from
// ground at `a` to `riseHeight` at `b` (and holding that height as a raised
// plateau beyond `b`). Smooth (smoothstep) along its length and across its
// width so the ball can climb, crest, roll back, or bank off the sloped sides.
export interface Ramp {
  a: Pt;
  b: Pt;
  width: number;
  riseHeight: number;
}

// The subset of a Hole this module reads. The full Hole (puttSim.ts) is
// structurally assignable — these are its optional slope-schema fields plus the
// id used to seed the undulation noise.
export interface PuttFieldHole {
  id?: number;
  tilts?: SlopePlane[];
  ramps?: Ramp[];
  // Amplitude (height units) of the gentle board-wide value-noise undulation.
  // Keep small — its gradient must stay under the rest-hold grade or a ball
  // never settles (the builder validates the cup point).
  undulation?: number;
}

// Value-noise scale (virtual units per noise cell) for the undulation term.
const NOISE_SCALE = 22;
// Central-difference epsilon for the gradient (virtual units). Matches the
// resolution of the slope schema without over-smoothing a ramp edge.
const GRAD_EPS = 0.5;

// --- Seeded value noise (deterministic; mirrors terrain.ts's approach) ------
function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const e = hash2(ix + 1, iy + 1, seed);
  const top = a + (b - a) * fx;
  const bot = c + (e - c) * fx;
  return (top + (bot - top) * fy) * 2 - 1; // → [-1, 1]
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// Height contribution of one tilt plane at (x,y). The query point is CLAMPED to
// the region, so beyond the region the ground is flat at the boundary value
// (continuous, no cliff). Downhill (toward dirDeg) LOSES height.
function tiltHeight(t: SlopePlane, x: number, y: number): number {
  const { x0, y0, x1, y1 } = t.region;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const qx = clamp(x, x0, x1);
  const qy = clamp(y, y0, y1);
  const rad = (t.dirDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Distance along the downhill direction from the centre; height falls that way.
  const along = (qx - cx) * dx + (qy - cy) * dy;
  return -(t.gradePct / 100) * along;
}

// Height contribution of one ramp at (x,y): a raised band climbing a→b.
function rampHeight(r: Ramp, x: number, y: number): number {
  const abx = r.b.x - r.a.x;
  const aby = r.b.y - r.a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-9) return 0;
  // Param along the axis (unclamped) and perpendicular distance.
  const t = ((x - r.a.x) * abx + (y - r.a.y) * aby) / len2;
  const px = r.a.x + abx * clamp(t, 0, 1);
  const py = r.a.y + aby * clamp(t, 0, 1);
  const perp = Math.hypot(x - px, y - py);
  const halfW = r.width / 2;
  if (perp >= halfW) return 0;
  // Across the width: full in the middle, smoothstep to 0 at the sloped edges.
  const edge = Math.min(halfW * 0.5, 3);
  const across = perp <= halfW - edge ? 1 : 1 - smooth((perp - (halfW - edge)) / edge);
  // Along the length: rises 0→1 over [0,1], holds 1 as a plateau for t>1, 0 for t<0.
  const along = t <= 0 ? 0 : t >= 1 ? 1 : smooth(t);
  return r.riseHeight * along * across;
}

// The board elevation (height units) at (x,y): tilt planes + ramps + optional
// seeded undulation. Allocation-free on the hot path.
export function puttHeightAt(hole: PuttFieldHole, x: number, y: number): number {
  let h = 0;
  const tilts = hole.tilts;
  if (tilts) for (let i = 0; i < tilts.length; i++) h += tiltHeight(tilts[i]!, x, y);
  const ramps = hole.ramps;
  if (ramps) for (let i = 0; i < ramps.length; i++) h += rampHeight(ramps[i]!, x, y);
  if (hole.undulation) {
    h += hole.undulation * valueNoise(x / NOISE_SCALE, y / NOISE_SCALE, (hole.id ?? 1) * 131 + 7);
  }
  return h;
}

// Height GRADIENT (∂h/∂x, ∂h/∂y) by central difference — the local uphill slope
// vector, same shape as terrain.gradientAt.
export function puttGradientAt(hole: PuttFieldHole, x: number, y: number): { gx: number; gy: number } {
  const e = GRAD_EPS;
  const gx = (puttHeightAt(hole, x + e, y) - puttHeightAt(hole, x - e, y)) / (2 * e);
  const gy = (puttHeightAt(hole, x, y + e) - puttHeightAt(hole, x, y - e)) / (2 * e);
  return { gx, gy };
}

// Downhill roll acceleration (virtual units/s² per axis) from the slope at
// (x,y). a ≈ -gravity·gradient, directed DOWNHILL (opposite the uphill-pointing
// gradient) — SAME sign convention as terrain.slopeAccel. A grounded sim adds
// this to the ball each substep: it is the break, the downhill run-out, and the
// uphill check all in one term.
export function puttSlopeAccel(
  hole: PuttFieldHole,
  x: number,
  y: number,
  gravity: number,
): { ax: number; ay: number } {
  const { gx, gy } = puttGradientAt(hole, x, y);
  return { ax: -gravity * gx, ay: -gravity * gy };
}
