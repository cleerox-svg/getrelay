// Course terrain + hole model — the "hole is DATA" foundation for the 9-hole
// course (GOLF.md roadmap step 3). Both the rendered terrain mesh AND the ball
// physics read ONE source of truth here: heightAt() gives the ground elevation,
// gradientAt() its slope (so the ball rolls downhill and putts break), and
// surfaceAt() the lie (tee/fairway/rough/fringe/green/bunker/water/cartpath) →
// which maps straight onto the TERRAIN materials the sim already tunes bounce
// and roll against (lib/golf/rangeSim.ts). Nothing here draws or imports three.
//
// World space matches rangeSim: d = downrange yards, x = lateral yards (+right).
// Elevation is in yards too, small (hills ±a few yd, greens raised a little), so
// it composes with the existing yard-space ballistics without rescaling.
//
// ============================================================================
// HOW TO AUTHOR A HOLE  (the scalable surface model — read before adding holes)
// ============================================================================
// A hole is FULLY described by a `CourseHole` data object; no per-hole code is
// needed. To add hole 2..9 (or a new course) you write one more `CourseHole` and
// push it into `COURSE_HOLES`. Every field and its meaning:
//
//   id, par, yards      — bookkeeping / HUD (yards is the scorecard length).
//   tee  { d, x }       — the tee box centre. A `TEE_R`-yd disc around it is the
//                         `tee` lie. Author the tee at d=0 by convention.
//   pin  { d, x }       — the flag. MUST lie inside the MIN (wobbled-in) green so
//                         the cup is always on the putting surface: dist(pin,green)
//                         < green.r·(1−EDGE_WOBBLE). Placing it near the centre is
//                         safest.
//
//   THE CORRIDOR (fairway flanked by rough, then OB):
//   centerline Pt[]     — downrange-ordered spine of the hole; a DOGLEG is just
//                         bent points. Width is measured from THIS polyline.
//   fairwayHalf         — mown fairway half-width (yd) at the tee end. The full
//                         fairway is 2·fairwayHalf wide (~30–40 yd is realistic).
//   fairwayTaper?       — OPTIONAL linear change in half-width from tee (t=0) to
//                         green (t=1): halfWidth(t) = fairwayHalf + fairwayTaper·t.
//                         Negative pinches the corridor near the green (a tighter
//                         landing zone); positive flares it. Omit for a uniform
//                         corridor. See corridorHalfAt().
//   roughHalf           — beyond fairway (from the centerline) is ROUGH; beyond
//                         `roughHalf` is OB. Rough band width = roughHalf −
//                         fairwayHalf. Uniform along the hole (the OB line).
//
//   THE GREEN + ITS FRINGE COLLAR:
//   green { d,x,r, raise, tiltPct, tiltDir, undulation } — a raised, mown pad:
//         r          = putting-surface radius (yd), the BASE radius the organic
//                      edge wobbles around (see ORGANIC EDGES below);
//         raise      = pad elevation above the base grade (yd);
//         tiltPct    = planar fall (yd of drop per yd) — the main break. Keep
//                      tiltPct + undulation ≲ μ (~0.061 at stimp 10) or a resting
//                      putt won't hold anywhere (green design guard, GOLF.md);
//         tiltDir    = direction of the fall line (rad); π = back-to-front;
//         undulation = amplitude (yd) of gentle interior rolls beyond the tilt.
//   fringeW           — width (yd) of the FRINGE collar ring around the green.
//                       The fringe sits at green height (flush, not a cliff) and
//                       ALWAYS separates the green from whatever is beyond it, so
//                       the green never directly abuts rough/sand/water. The mown
//                       pad (green + fringe) has base radius green.r + fringeW;
//                       call greenPadRadius(hole) (and maxGreenPadRadius for its
//                       worst-case wobbled bulge).
//
//   ORGANIC EDGES (irregular, wavy outlines — see-what-you-play):
//   The green, its fringe collar, and every bunker/pond do NOT have circular
//   outlines. edgeRadius(seed, angle, baseR) perturbs each feature's radius by a
//   smooth, seeded, angle-periodic wobble (default ±EDGE_WOBBLE = ±15%), so
//   surfaceAt() classifies — and heightAt() dishes/plateaus — an organic shape,
//   not a circle. The SAME helper + seed drives the Phase 2 CourseGL overlay
//   meshes, so the outline you see is the outline you play, for any hole. Each
//   feature's seed is featureSeed(d, x) (green + fringe SHARE the green's seed so
//   the collar nests); the angle is atan2(d−centre.d, x−centre.x). Because the
//   green edge bulges to green.r·(1+EDGE_WOBBLE) and hazards to r·(1+EDGE_WOBBLE),
//   the placement invariants carry a matching (1+EDGE_WOBBLE) margin (below).
//
//   FEATURES (organic outline; DISH the heightfield so mesh + physics agree):
//   hazards CircleFeature[] — bunkers and ponds { kind, d, x, r, depth }. `r` is
//                       the BASE radius the wobble scales; depth is negative
//                       (basin). INVARIANT (wobble-safe): a hazard must sit
//                       OUTSIDE the WOBBLED green pad — its wobbled edge and the
//                       fringe's wobbled edge can never touch:
//                         dist(hazard, green) ≥ (greenPadRadius + hazard.r)·(1+EDGE_WOBBLE)
//                       i.e. maxGreenPadRadius(hole) + hazard.r·(1+EDGE_WOBBLE).
//                       The classifier still clips any accidental overlap (green
//                       and fringe outrank hazards, below), so a mis-authored
//                       feature degrades gracefully rather than eating the green.
//   cartPath? { pts, half } — a firm ribbon (polyline + half-width) the ball can
//                       catch a lively bounce off.
//
//   THE LAND + AIR:
//   terrain { seed, hilliness, hillScale, teeElev, greenElev } — base grade
//                       (teeElev→greenElev along the hole) plus deterministic
//                       value-noise hills of `hilliness` amplitude at `hillScale`
//                       wavelength. The hills are erased under the green pad so
//                       the designed tilt (not noise) is what breaks a putt.
//   wind { along, cross } — steady wind (yd/s), along = downrange, cross = +x.
//
// CLASSIFICATION PRECEDENCE (surfaceAt, highest wins — the crispness guarantee):
//   green  >  fringe  >  bunker/water  >  cartpath  >  tee  >  fairway  >  rough  >  ob
// Exactly ONE lie is returned per point. Because green and fringe outrank the
// hazards, the collar is always intact: a green-side bunker or pond borders the
// FRINGE, never the putting surface. Author features per the invariant above so
// nothing is visibly clipped; the precedence is the safety net.
// ============================================================================

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

// The tee box is a disc of this radius (yd) around hole.tee.
export const TEE_R = 5;

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
// is placed relative to it. See the "HOW TO AUTHOR A HOLE" block above for every
// field's meaning, the classification precedence, and the invariants.
export interface CourseHole {
  id: number;
  par: number;
  yards: number;
  // OPTIONAL human name for the hole (e.g. Augusta's "Tea Olive"). Additive and
  // read-only on the `hole` object, so it is safe against the CourseSnapshot
  // guard (which excludes the static `hole`). HOLE_1 leaves it undefined.
  name?: string;
  tee: Pt;
  pin: Pt;
  centerline: Pt[];
  // Mown fairway half-width (yd) at the tee end of the corridor.
  fairwayHalf: number;
  // Optional linear taper of the fairway half-width from tee (0) to green (1).
  fairwayTaper?: number;
  // Beyond the fairway is rough; beyond roughHalf (from the centerline) is OB.
  roughHalf: number;
  green: GreenDef;
  // Width (yd) of the fringe collar ring around the green.
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

// --- Organic edge noise (irregular feature outlines) -----------------------
// Real bunkers, ponds and greens have wavy, irregular outlines — not perfect
// circles. edgeRadius() perturbs a feature's base radius by a smooth, seeded,
// angle-PERIODIC wobble so a "circular" feature classifies (and renders) as an
// organic shape. Because BOTH surfaceAt()/heightAt() (the played + baked model)
// and the CourseGL overlay meshes (Phase 2) call the SAME edgeRadius with the
// SAME seed + angle convention, the outline you see is exactly the outline you
// play (see-what-you-play), for any hole, from shared code.
//
// PROPERTIES (all required): deterministic (seeded, no Math.random), continuous
// and 2π-periodic in angle (integer sine harmonics → no seam at 0/2π), and
// bounded to [baseR·(1−amp), baseR·(1+amp)] (the weights sum to 1) so a wobbled
// radius is never negative and never self-intersects.

// Default wobble amplitude — a natural ±15% of the radius. Tunable per call;
// the invariants below (maxGreenPadRadius, the hazard-clearance rule) are all
// expressed in terms of THIS so they hold at the worst-case bulge.
export const EDGE_WOBBLE = 0.15;

// Integer angular frequencies (cycles around the circle) and their weights.
// Low, coprime-ish frequencies give a few gentle lobes (an organic blob), not a
// spiky star. Weights sum to 1 so the summed noise stays in [-1, 1].
const EDGE_FREQS = [2, 3, 5];
const EDGE_WEIGHTS = [0.55, 0.3, 0.15];

// A stable, seed+index-keyed phase in [0, 2π) — reuses the terrain hash so the
// wobble is reproducible across loads and in the headless harness.
function seededPhase(seed: number, k: number): number {
  return hash2(seed, k, 0x9e3779b9 | 0) * Math.PI * 2;
}

// Smooth, seeded, 2π-periodic noise around a circle, in [-1, 1].
export function edgeNoise(seed: number, angleRad: number): number {
  let v = 0;
  for (let i = 0; i < EDGE_FREQS.length; i++) {
    v += EDGE_WEIGHTS[i]! * Math.sin(EDGE_FREQS[i]! * angleRad + seededPhase(seed, i + 1));
  }
  return v; // sum of weights = 1 → bounded to [-1, 1]
}

// The organic radius (yd) of a feature at a given angle: the base radius scaled
// by a seeded wobble. Bounded to [baseR·(1−amp), baseR·(1+amp)], so with the
// default amp it stays within ±15% of baseR and is always positive.
export function edgeRadius(
  seed: number,
  angleRad: number,
  baseR: number,
  amp: number = EDGE_WOBBLE,
): number {
  return baseR * (1 + amp * edgeNoise(seed, angleRad));
}

// A stable integer seed for a feature, derived from its centre (d, x). Distinct
// features get distinct seeds so their wobbles differ; a given feature's seed is
// identical every load. Quantized to 1/16 yd so tiny float drift can't reseed.
export function featureSeed(d: number, x: number): number {
  return (Math.round(d * 16) * 73856093 + Math.round(x * 16) * 19349663) | 0;
}

// The world-space angle (rad) of a point relative to a feature centre, in the
// convention edgeRadius consumers must all share: cos(angle) → the +x offset,
// sin(angle) → the +d offset. Phase 2's polar meshes step this same angle so
// their vertices land on the classified outline.
function featureAngle(cd: number, cx: number, d: number, x: number): number {
  return Math.atan2(d - cd, x - cx);
}

// --- Geometry helpers ------------------------------------------------------

// Distance from (d,x) to a polyline (nearest point on any segment).
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

// Nearest point on a polyline PLUS the normalized arc-length position [0..1] of
// that nearest point (0 = tee end, 1 = green end). The parameter drives the
// fairway taper — the corridor can pinch/flare along its length.
function nearestOnPolyline(pts: Pt[], d: number, x: number): { dist: number; t: number } {
  let total = 0;
  const segLen: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
    segLen.push(l);
    total += l;
  }
  const inv = total > 0 ? 1 / total : 0;
  let best = Infinity;
  let bestT = 0;
  let acc = 0;
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
    const dd = Math.hypot(d - cd, x - cx);
    if (dd < best) {
      best = dd;
      bestT = (acc + t * segLen[i]!) * inv;
    }
    acc += segLen[i]!;
  }
  return { dist: best, t: bestT };
}

function dist(d: number, x: number, p: { d: number; x: number }): number {
  return Math.hypot(d - p.d, x - p.x);
}

// --- Corridor + green helpers (exported for renderers / feature placement) --

// The fairway half-width (yd) at normalized corridor position t∈[0,1]: the base
// half-width plus the optional linear taper.
export function corridorHalfAt(hole: CourseHole, t: number): number {
  return hole.fairwayHalf + (hole.fairwayTaper ?? 0) * t;
}

// Signed distance (yd) from a point to the FAIRWAY edge: NEGATIVE inside the
// mown corridor, 0 exactly on the edge, POSITIVE out in the rough — measured to
// the taper-aware corridor half-width at the nearest centreline point. This is a
// pure read helper (surfaceAt's hard classification is UNCHANGED); renderers use
// it to paint a smooth "first cut" transition band across the corridor edge so
// the fairway→rough seam reads as a gradient, not a hard line. Scales to any
// hole via corridorHalfAt.
export function corridorEdgeDist(hole: CourseHole, d: number, x: number): number {
  const near = nearestOnPolyline(hole.centerline, d, x);
  return near.dist - corridorHalfAt(hole, near.t);
}

// Arc-length position (yd) ALONG the centerline of the nearest point to (d,x),
// measured from the tee end (centerline[0]). Renderers band mow stripes on THIS
// instead of raw downrange d: stripe boundaries then run PERPENDICULAR to the
// LOCAL fairway direction and wrap around a dogleg, so a diagonal/bent corridor
// reads as an even ribbon (stripes no longer cut across it at an angle). On a
// straight hole (centerline running down d from the tee) the arc-length ≈ d, so
// the stripe spacing/phase is essentially unchanged. Pure read helper (physics
// classification is UNCHANGED); scales to any hole.
export function centerlineArcYd(hole: CourseHole, d: number, x: number): number {
  const pts = hole.centerline;
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += Math.hypot(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
  }
  return nearestOnPolyline(pts, d, x).t * total;
}

// Radius (yd) of the mown pad = putting surface + fringe collar, at its BASE
// (un-wobbled) size. The organic green + fringe edges wobble around this.
export function greenPadRadius(hole: CourseHole): number {
  return hole.green.r + hole.fringeW;
}

// Worst-case mown-pad radius: the fringe collar can bulge out to here once the
// organic edge is applied (greenPadRadius · (1+EDGE_WOBBLE)). A green-side
// hazard's centre must sit at least this far from the green centre PLUS the
// hazard's own wobbled radius — i.e. dist(hazard, green) ≥ (greenPadRadius +
// hazard.r)·(1+EDGE_WOBBLE) — so the wobbled fringe can never touch the wobbled
// hazard. Renderers also use this to frame the scene around the green.
export function maxGreenPadRadius(hole: CourseHole): number {
  return greenPadRadius(hole) * (1 + EDGE_WOBBLE);
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
  // noise) is the slope a putt breaks on. The pad is a PLATEAU that spans the
  // green AND its fringe collar (padR): full and level-with-the-green across
  // both (so the collar is FLUSH, not a cliff), then ramping to grade over a
  // gentle bank `skirt` beyond the fringe.
  const g = hole.green;
  const dg = dist(d, x, g);
  // The pad boundary is ORGANIC: the plateau (green + fringe) reaches out to a
  // seeded, angle-dependent radius so the mesh edge matches the classified/played
  // outline exactly — no mismatch between the height and the lie. Same seed +
  // angle convention as surfaceAt() below, so height and classification agree.
  const gSeed = featureSeed(g.d, g.x);
  const gAngle = featureAngle(g.d, g.x, d, x);
  const padOuter = edgeRadius(gSeed, gAngle, g.r + hole.fringeW);
  // The pad SKIRT is the bank that ramps the raised pad down to the surrounding
  // grade beyond the fringe. Its length is DERIVED from the raise (not a fixed
  // 10 yd) so the steepest part of the raised-cosine bank stays a gentle,
  // natural grade — max slope of the profile is raise·π/(2·skirt), so scaling
  // skirt with raise holds that ~0.26 (a soft mound shoulder) regardless of how
  // high the pad sits. A short fixed skirt made a tall pad read as a "table" on
  // a steep dark wall. Clamped so a nearly-flat pad still eases in and a very
  // tall one doesn't sprawl. This is a pure GEOMETRY change: surfaceAt() (lie
  // boundaries) is unchanged — only the height of the bank beyond the fringe.
  const skirt = Math.min(26, Math.max(14, g.raise * 6));
  const gBlend =
    dg <= padOuter
      ? 1
      : dg < padOuter + skirt
        ? 0.5 + 0.5 * Math.cos(((dg - padOuter) / skirt) * Math.PI)
        : 0;

  // Rolling hills, almost entirely erased under the green pad: a real green is
  // graded far smoother than the fairway mounds, so its own planar tilt (not the
  // surrounding noise) is the slope a putt breaks on. Leaving even 10% of the
  // hills here gave the putting surface a ~0.5yd-per-6yd lateral wander that made
  // reading a break impossible; 3% keeps a whisper of movement without polluting
  // the designed tilt.
  h += t.hilliness * valueNoise(d / t.hillScale, x / t.hillScale, t.seed) * (1 - 0.97 * gBlend);

  if (gBlend > 0) {
    // Flat-topped raise + planar tilt (fall toward tiltDir) + gentle interior
    // undulation. Across the green AND fringe gBlend is 1, so the raise is level
    // and the tilt is the dominant slope — exactly what breaks a putt, and the
    // fringe collar sits flush at the same height.
    const rel = (d - g.d) * Math.cos(g.tiltDir) + (x - g.x) * Math.sin(g.tiltDir);
    const tilt = -rel * g.tiltPct;
    const undul = g.undulation * valueNoise(d / 12 + 50, x / 12 + 50, t.seed + 7);
    h += g.raise * gBlend + (tilt + undul) * gBlend;
  }

  // Hazard basins (bunker / pond): dish the ground down inside the ORGANIC
  // outline — the basin edge follows the same seeded radius surfaceAt() uses to
  // classify the hazard, so sand/water look and play as the same wavy shape.
  for (const hz of hole.hazards) {
    const dh = dist(d, x, hz);
    const hzR = edgeRadius(
      featureSeed(hz.d, hz.x),
      featureAngle(hz.d, hz.x, d, x),
      hz.r,
    );
    if (dh < hzR) {
      const f = 0.5 + 0.5 * Math.cos((dh / hzR) * Math.PI);
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

// The lie at a world point, in strict PRECEDENCE order (see the block at the top
// of this file). Exactly one lie is returned. Green and fringe outrank the
// hazards, so the fringe collar always separates the putting surface from
// bunker/water — the crispness guarantee. This is the SINGLE classifier the
// physics material lookup and the terrain texture blend both call.
export function surfaceAt(hole: CourseHole, d: number, x: number): Surface {
  // 1–2. Green interior, then the fringe collar ring around it. Highest
  // precedence so a green-side hazard can never bleed into the green: it borders
  // the fringe instead. BOTH edges are ORGANIC — the green reaches out to a
  // seeded, angle-dependent radius and the fringe to the same wobble applied to
  // the pad radius, so the collar (green.r→green.r+fringeW, scaled by the same
  // factor) never vanishes and the outline is wavy, not a circle.
  const g = hole.green;
  const dg = dist(d, x, g);
  const gSeed = featureSeed(g.d, g.x);
  const gAngle = featureAngle(g.d, g.x, d, x);
  if (dg <= edgeRadius(gSeed, gAngle, g.r)) return 'green';
  if (dg <= edgeRadius(gSeed, gAngle, g.r + hole.fringeW)) return 'fringe';
  // 3. Bunker / water circles — organic outlines too (each with its own seed),
  // cutting through the corridor they overlap but sitting OUTSIDE the fringe
  // (checked after green/fringe).
  for (const hz of hole.hazards) {
    const hzR = edgeRadius(
      featureSeed(hz.d, hz.x),
      featureAngle(hz.d, hz.x, d, x),
      hz.r,
    );
    if (dist(d, x, hz) <= hzR) return hz.kind;
  }
  // 4. Cart path ribbon.
  if (hole.cartPath && distToPolyline(hole.cartPath.pts, d, x) <= hole.cartPath.half) {
    return 'cartpath';
  }
  // 5. Tee box.
  if (dist(d, x, hole.tee) <= TEE_R) return 'tee';
  // 6–8. Fairway corridor (taperable), else rough, else out of bounds.
  const near = nearestOnPolyline(hole.centerline, d, x);
  if (near.dist <= corridorHalfAt(hole, near.t)) return 'fairway';
  if (near.dist <= hole.roughHalf) return 'rough';
  return 'ob';
}

// --- Showcase hole #1 ------------------------------------------------------
// A gentle dogleg-right par 5 that shows every piece of the surface model: a
// downhill tee shot into a rising fairway (a 2·16 = 32-yd mown corridor pinching
// to 26 yd at the green via fairwayTaper), flanked by a wide ROUGH band out to
// the OB line at 40 yd; a fairway bunker on the inside of the dogleg; a cart path
// down the left; a raised, back-to-front-tilted green ringed by a 4-yd FRINGE
// collar; a pond guarding the approach short of the green and a greenside bunker
// front-right — both sitting OUTSIDE the fringe so the green never abuts them
// (they border the collar). Distances in yards.
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
  fairwayHalf: 16,
  fairwayTaper: -3, // pinch to 13-yd half (26-yd fairway) at the green
  roughHalf: 40,
  green: { d: 512, x: 18, r: 15, raise: 3.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.08 },
  fringeW: 4,
  hazards: [
    { kind: 'bunker', d: 300, x: 20, r: 12, depth: -1.6 }, // fairway bunker, inside the dogleg
    // Greenside bunker front-right. Pushed out so its WOBBLED edge still clears
    // the WOBBLED fringe: dist(bunker,green)=33.6 ≥ (padR 19 + r 8)·1.15 = 31.1.
    { kind: 'bunker', d: 495, x: 47, r: 8, depth: -1.8 },
    // Pond guarding the approach short of the green — likewise cleared of the
    // wobbled fringe: dist(water,green)=36.1 ≥ (padR 19 + r 11)·1.15 = 34.5.
    { kind: 'water', d: 476, x: 15, r: 11, depth: -2.2 },
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
