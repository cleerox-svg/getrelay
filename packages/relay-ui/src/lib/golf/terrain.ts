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
//   THE CANOPY (optional):
//   bloom? { color, fraction, form? } — a FLOWERING grove. Augusta names 13 of
//                       its 18 holes after a flowering plant and every one of
//                       them used to render a plain green tree line, so bloom is
//                       authored HERE, as data, per hole:
//                         color    = the blossom hex the canopy is tinted toward;
//                         fraction = share (0..1) of this hole's BROADLEAF trees
//                                    that flower. Pines never do.
//                         form?    = 'canopy' (default) or 'understory' — see
//                                    "SEASON AND FORM" below.
//
//                       ⚠ SEASON AND FORM — the two ways a bloom goes wrong, both
//                       found by the visual gate AFTER the first blossom pass had
//                       already merged:
//                         • SEASON. Author the colour the plant carries in APRIL,
//                           which is Augusta's frame of reference — not the colour
//                           it is best known for. 15 Firethorn (pyracantha) and 17
//                           Nandina were authored from their BERRIES, which are an
//                           autumn/winter feature; both actually flower WHITE in
//                           spring. Orange and red canopies over green turf read
//                           as October, because that is what they are.
//                         • FORM. Pink survives a canopy tint because nothing in
//                           nature is a pink tree in autumn. Yellow, orange and red
//                           ARE the autumn palette, so a full tree-sized crown in
//                           one of them has no signal left that says spring, at any
//                           saturation. A warm-hued bloom therefore belongs on a
//                           plant that is not a canopy tree: 12 Golden Bell is
//                           forsythia, a 2–3 m arching SHRUB that flowers on bare
//                           wands, so its form is 'understory' — a low drift at the
//                           foot of the tree line, UNDER a crown that stays green.
//                           Green canopy above a warm mass below is a silhouette
//                           autumn cannot produce.
//
//                       Which trees flower is a SEEDED roll off each tree's own
//                       seed mixed with terrain.seed (bloomRoll below) — never
//                       Math.random, so the same trees flower on every load and
//                       the screenshot gate can still tell a regression from a
//                       reseeded grove.
//
//                       ⚠ 'canopy' IS A RENDER TINT; 'understory' IS A SOLID.
//                       This sentence used to read "a bloom is a render tint and
//                       nothing else", and it stopped being true the day the
//                       drift moved the blossom mass down to ball height:
//                         • form 'canopy' — courseTrees() copies the colour onto
//                           CourseTree.bloom and sets NOTHING else, so every
//                           value the sim reads (d, x, kind, scale, seed, ground,
//                           trunkR, height, canopyR, canopyH) is byte-identical
//                           to the same hole without the field. A canopy-flowering
//                           hole plays EXACTLY as it would plain, and holes 2, 13
//                           and 16 depend on that.
//                         • form 'understory' — the drift is a visible mass
//                           standing ON THE GROUND, so it is also a COLLIDABLE:
//                           courseTrees() emits shrubR/shrubH (see CourseTree) and
//                           courseSim brushes a ball that enters it. Nothing else
//                           moves — the tree keeps the same position, trunk and
//                           canopy it had — but this form is NOT free of the ball,
//                           and must not be authored as though it were.
//                       That is the see-what-you-play rule doing its job rather
//                       than an exception to it: art you can see at ball height
//                       has to be art the ball can feel.
//                         • OMIT IT and the grove is unchanged, down to the JSON:
//                           `bloom` is left ABSENT rather than set undefined, and
//                           so are shrubR/shrubH.
//                       Do NOT derive a colour from `name` at render time — the
//                       renderer must not parse copy text.
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

/**
 * WHERE a hole's blossom sits in the tree line. See "SEASON AND FORM" in the
 * contract header — this is the lever that keeps a warm-hued bloom out of the
 * autumn palette.
 *
 * - `canopy` (default) — the historical behaviour: the crowns of the flowering
 *   broadleaves are tinted toward the blossom colour and gain flower clusters.
 *   Correct for a flowering TREE (dogwood, redbud, azalea planted as understory
 *   but read at crown height here, crab apple, peach, magnolia…).
 * - `understory` — the crowns stay GREEN and the blossom is a low drift of
 *   flowering shrub at the foot of the tree. Correct for a plant that is a shrub
 *   (forsythia, pyracantha, nandina all top out at 2–3 m), and the only form in
 *   which yellow/orange/red can read as spring: a green canopy standing over a
 *   warm mass is a silhouette autumn cannot make, because in autumn the canopy
 *   turns first.
 *
 * ⚠ The two forms differ in one more way, and it is not cosmetic: `canopy` puts
 * the blossom where nothing was ever collidable, so it stays a pure tint;
 * `understory` puts a solid-looking mass at BALL height, so it emits a collider
 * (CourseTree.shrubR/shrubH) and the ball feels it. Choosing `understory` is
 * therefore choosing to put an obstacle on the hole.
 */
export type BloomForm = 'canopy' | 'understory';

// A flowering canopy for a hole. The hole is named after a plant; this is where
// that plant's colour is AUTHORED, so the renderer never has to parse the display
// name to know a hole flowers. Render-only at form 'canopy'; an obstacle too at
// form 'understory' (see BloomForm).
export interface HoleBloom {
  // Blossom colour (hex) — the colour this plant carries in APRIL. Not its
  // berry, not its autumn leaf: see "SEASON AND FORM" in the contract header.
  color: number;
  // Share (0..1) of this hole's BROADLEAF trees that flower. Not 1: a uniformly
  // pink grove reads as paint, where a fraction reads as accent trees.
  fraction: number;
  // Optional; defaults to 'canopy'. Omitted rather than set, so the holes that
  // shipped before this existed are unchanged down to the JSON.
  form?: BloomForm;
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
  // OPTIONAL flowering canopy — a render tint only, see HoleBloom and the
  // "THE CANOPY" block of the contract header. Omit for a plain green grove.
  bloom?: HoleBloom;
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

// --- Corner bevel (removes the outside-of-dogleg fairway bulge) --------------
// The corridor is `distToPolyline(centerline) ≤ corridorHalfAt`. At an INTERIOR
// centerline vertex the distance field rounds the OUTSIDE of the bend with a cap
// of radius = half-width, so the perpendicular corridor width swells from 2·half
// on a straight leg to ~2·half/sin(θ/2) across the mitre — the ~32→48 yd bulge
// on a sharp dogleg. fairwayEdgeDist() BEVELS each interior vertex: in the
// vertex's OUTSIDE wedge (the round-cap region, where the point projects PAST the
// incoming leg and BEFORE the outgoing leg) it clips the corridor with the bevel
// chord — the straight line tangent to both legs' outer edges. That trims the
// overhang back so the width stays ~constant through the bend, WITHOUT touching
// the legs (the bevel never fires on leg points) or the INSIDE of the bend (the
// inside is a segment's Voronoi cell, never the vertex wedge, so no fairway gap).
// On a collinear (straight) hole/leg the cross product is 0, the wedge is empty,
// and the bevel never fires — classification is byte-identical. This is the ONE
// shared corridor test read by BOTH surfaceAt (physics lie) and corridorEdgeDist
// (render feather), so drawn == played.

// Cross-product magnitude below which a vertex is treated as collinear (no bend →
// no bevel). Guarantees straight legs/holes are byte-identical.
const BEVEL_MIN_CROSS = 1e-9;

// Signed distance (yd) to the mown FAIRWAY edge, WITH the interior-vertex bevel
// clamp. NEGATIVE inside the corridor, 0 on the edge, POSITIVE in the rough.
// Equals the plain `distToPolyline − corridorHalfAt` everywhere the bevel does
// not fire (all straight legs and collinear holes), so it is a strict, additive
// tightening of only the outside-corner overhang.
export function fairwayEdgeDist(hole: CourseHole, d: number, x: number): number {
  return fairwayEdgeFromNear(hole, d, x, nearestOnPolyline(hole.centerline, d, x));
}

// Same as fairwayEdgeDist but takes a PRE-COMPUTED nearestOnPolyline result, so a
// caller that already needs `near` (surfaceAt uses it for the rough/OB test too)
// pays the polyline cost ONCE. Kept internal (the public API stays d,x only).
function fairwayEdgeFromNear(
  hole: CourseHole,
  d: number,
  x: number,
  near: { dist: number; t: number },
): number {
  const pts = hole.centerline;
  const half = corridorHalfAt(hole, near.t);
  let edge = near.dist - half;
  // Bevel each INTERIOR vertex whose outside wedge contains the point.
  for (let i = 1; i < pts.length - 1; i++) {
    const A = pts[i - 1]!;
    const V = pts[i]!;
    const B = pts[i + 1]!;
    // NEAREST-FEATURE GUARD: only clip when THIS vertex is the point's actual
    // nearest centreline feature (|P−V| === near.dist inside a true wedge). On a
    // fold-back / S-curve / hairpin centreline a legit fairway point on a LATER
    // leg can stray into an earlier vertex's outer wedge; without this guard its
    // bevel would punch that point to rough. A no-op for the shipped single
    // doglegs (and for straight holes the wedge is empty anyway).
    if (Math.hypot(d - V.d, x - V.x) > near.dist + 1e-6) continue;
    // Unclamped projection params: tin=1 at V (incoming A→V), tout=0 at V
    // (outgoing V→B). The vertex's outside wedge (the round-cap region) is
    // exactly tin ≥ 1 AND tout ≤ 0 — inside-of-bend points fall in a segment's
    // cell (tin<1 or tout>0), so the bevel never punches an inside gap.
    const iad = V.d - A.d;
    const iax = V.x - A.x;
    const iL2 = iad * iad + iax * iax || 1e-6;
    const tin = ((d - A.d) * iad + (x - A.x) * iax) / iL2;
    if (tin < 1) continue;
    const obd = B.d - V.d;
    const obx = B.x - V.x;
    const oL2 = obd * obd + obx * obx || 1e-6;
    const tout = ((d - V.d) * obd + (x - V.x) * obx) / oL2;
    if (tout > 0) continue;
    // Unit leg dirs + turn sign.
    const iLen = Math.sqrt(iL2);
    const oLen = Math.sqrt(oL2);
    const ud = iad / iLen;
    const ux = iax / iLen;
    const wd = obd / oLen;
    const wx = obx / oLen;
    const cross = ud * wx - ux * wd;
    if (Math.abs(cross) <= BEVEL_MIN_CROSS) continue; // collinear → no bevel
    const s = cross > 0 ? 1 : -1;
    // Outward leg normals = −s · rot90(dir), rot90(v)=(−v.x, v.d) in (d,x).
    const oud = -s * -ux; // = s*ux
    const oux = -s * ud;
    const owd = -s * -wx; // = s*wx
    const owx = -s * wd;
    // Outward bisector (unit) and the bevel chord offset along it.
    let bd = oud + owd;
    let bx = oux + owx;
    const bl = Math.hypot(bd, bx) || 1;
    bd /= bl;
    bx /= bl;
    const cosPhi = oud * bd + oux * bx; // = owd·b too (symmetric)
    const chord = V.d * bd + V.x * bx + half * cosPhi;
    const beyond = d * bd + x * bx - chord; // >0 = past the bevel (overhang)
    if (beyond > edge) edge = beyond; // intersect: max of the two signed edges
  }
  return edge;
}

// Signed distance (yd) from a point to the FAIRWAY edge: NEGATIVE inside the
// mown corridor, 0 exactly on the edge, POSITIVE out in the rough — the
// bevel-clamped corridor edge (fairwayEdgeDist), so the painted "first cut"
// transition band tracks the SAME beveled corridor the ball plays (drawn ==
// played). Renderers use it to feather the fairway→rough seam. On a straight
// hole/leg this is exactly `distToPolyline − corridorHalfAt` (the bevel is inert).
export function corridorEdgeDist(hole: CourseHole, d: number, x: number): number {
  return fairwayEdgeDist(hole, d, x);
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

  // WATER PAD — the same construction logic as the green pad, for the same
  // reason. A pond's surface is LEVEL, so its rim must be too: with the rolling
  // hills left running through a hazard the basin rim rode 1.3–2.7 yd higher on
  // one side than the other (measured across the course's ponds) while the dish
  // itself is only ~2.2 yd deep, so any level water plane either floated over
  // the low bank or left the high bank towering — the pond read as a crater, and
  // the renderer's old workaround (bending the water skin to follow the terrain)
  // is exactly why it looked like tinted ground rather than water.
  //
  // So a real course grades a pond's surround level, and so do we: erase the
  // hills inside the hazard outline, ramping back to grade over a skirt derived
  // from the basin depth (same raised-cosine profile the green skirt uses, so
  // the bank shoulder stays a natural grade). The tee→green grade is NOT erased,
  // so a pond still sits at the right elevation on the hole.
  //
  // BUNKERS are deliberately excluded: sand genuinely follows the ground it sits
  // in, and the sand cap is drawn on the dished bowl. Only water needs a level lip.
  let waterPad = 0;
  let waterPlateau = 0;
  for (const hz of hole.hazards) {
    if (hz.kind !== 'water') continue;
    const dh = dist(d, x, hz);
    const hzR = edgeRadius(featureSeed(hz.d, hz.x), featureAngle(hz.d, hz.x, d, x), hz.r);
    const skirt = Math.min(22, Math.max(10, Math.abs(hz.depth) * 6));
    const b =
      dh <= hzR
        ? 1
        : dh < hzR + skirt
          ? 0.5 + 0.5 * Math.cos(((dh - hzR) / skirt) * Math.PI)
          : 0;
    if (b > waterPad) {
      waterPad = b;
      // The level the surround grades to: the hole's BASE elevation at the
      // pond's centre. Both the hills AND the tee→green grade are erased inside
      // the pad — on a short hole the grade alone tilts a 26 yd pond by over a
      // yard, which is as bad for a level waterline as the hills were.
      const alongHz = Math.max(0, Math.min(1, (hz.d - hole.tee.d) / span));
      waterPlateau = t.teeElev + (t.greenElev - t.teeElev) * alongHz;
    }
  }

  // Rolling hills, almost entirely erased under the green pad: a real green is
  // graded far smoother than the fairway mounds, so its own planar tilt (not the
  // surrounding noise) is the slope a putt breaks on. Leaving even 10% of the
  // hills here gave the putting surface a ~0.5yd-per-6yd lateral wander that made
  // reading a break impossible; 3% keeps a whisper of movement without polluting
  // the designed tilt.
  h +=
    t.hilliness *
    valueNoise(d / t.hillScale, x / t.hillScale, t.seed) *
    (1 - 0.97 * gBlend) *
    (1 - waterPad);

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

  // Grade the water surround to its level plateau. Applied AFTER the green pad
  // (so a greenside pond blends smoothly off the pad's skirt) and BEFORE the
  // basin dish, so the dish is excavated out of level ground and the rim is one
  // height all the way round — which is what lets the surface be a single level
  // plane with a shoreline only a few inches of bank wide.
  if (waterPad > 0) h += (waterPlateau - h) * waterPad;

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

// How far (yd) a pond's waterline sits below the LOWEST point of its rim, so a
// little damp bank always shows and the level surface can never spill over the
// low side of the basin.
//
// Deliberately TINY. The basin is a raised cosine, so its shoulders are nearly
// flat at the rim: dropping the water even a quarter-yard pulls the shoreline a
// long way inward and leaves a wide ring of exposed bed (which is exactly what a
// first attempt at this looked like — a crater with a puddle in it). At 0.05 the
// waterline lands at ~94% of the basin radius, i.e. a shoreline a few inches of
// bank wide, which is what a pond edge actually looks like.
export const WATER_LIP = 0.02;

/**
 * The world y of a water hazard's LEVEL surface.
 *
 * Water is level, so the renderer needs ONE height for the whole pond, and it
 * must be low enough to sit inside the basin at every angle. Sampling the
 * minimum rim height around the hazard's organic outline guarantees that — and
 * because heightAt now grades the hills level around a water hazard (the water
 * pad above), the rim barely varies, so the exposed bank is a shoreline rather
 * than a crater wall.
 *
 * Lives here, next to heightAt, so the surface the ball is classified against
 * and the surface that gets drawn are derived from the same source. The renderer
 * subtracts this from heightAt per vertex to get water DEPTH, which is what
 * shades the shallows and fades the shoreline.
 */
export function waterLevelAt(hole: CourseHole, hz: CircleFeature): number {
  const seed = featureSeed(hz.d, hz.x);
  let lo = Infinity;
  const N = 72;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = edgeRadius(seed, a, hz.r);
    const y = heightAt(hole, hz.d + Math.sin(a) * r, hz.x + Math.cos(a) * r);
    if (y < lo) lo = y;
  }
  return lo - WATER_LIP;
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
  // 6–8. Fairway corridor (taperable + corner-BEVELED so the outside of a dogleg
  // doesn't balloon), else rough (plain distance — an unbeveled rough bulge at a
  // corner is unnoticed and beveling it risks an OB notch), else out of bounds.
  // The fairway test is the beveled edge; the rough test uses the raw distance.
  // nearestOnPolyline is computed ONCE and shared by both tests (the majority of
  // baked texels are rough/OB, so this halves their polyline cost).
  const near = nearestOnPolyline(hole.centerline, d, x);
  if (fairwayEdgeFromNear(hole, d, x, near) <= 0) return 'fairway';
  if (near.dist <= hole.roughHalf) return 'rough';
  return 'ob';
}

// --- Showcase hole #1 ------------------------------------------------------
// A gentle dogleg-right par 5 that shows every piece of the surface model: a
// downhill tee shot into a rising fairway (a 2·16 = 32-yd mown corridor pinching
// to 26 yd at the green via fairwayTaper), flanked by a wide ROUGH band out to
// the OB line at 40 yd; a fairway bunker on the inside of the dogleg; a cart path
// down the left; a raised, back-to-front-tilted green ringed by a 2-yd FRINGE
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
  fringeW: 1,
  hazards: [
    { kind: 'bunker', d: 300, x: 20, r: 12, depth: -1.6 }, // fairway bunker, inside the dogleg
    // Greenside bunker front-right. Pushed out so its WOBBLED edge still clears
    // the WOBBLED fringe: dist(bunker,green)=33.6 ≥ (padR 17 + r 8)·1.15 = 28.75.
    { kind: 'bunker', d: 495, x: 47, r: 8, depth: -1.8 },
    // Pond guarding the approach short of the green — likewise cleared of the
    // wobbled fringe: dist(water,green)=36.1 ≥ (padR 17 + r 11)·1.15 = 32.2.
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

// --- Trees (deterministic data: rendered AND collided) ---------------------
// Trees are DATA derived from the hole, so the trunk the player SEES (CourseGL
// renders from courseTrees) is exactly the trunk the ball HITS (courseSim
// collides against the SAME list) — the see-what-you-play rule extended to
// obstacles. A tree is a vertical TRUNK cylinder (trunkR, from the ground up to
// `height`) the ball ricochets off, wearing a CANOPY sphere (canopyR at canopyH
// above the base) whose leaves lightly brush — slow — a ball passing through it.
// Placement lines the corridor just beyond the OB edge (roughHalf + a margin),
// exactly reproducing the inline grove CourseGL used to build, so the visual is
// unchanged. Pure data (no three, no Math.random) → both consumers agree and the
// screenshot harness stays reproducible.
export interface CourseTree {
  d: number;
  x: number;
  kind: 'pine' | 'broadleaf';
  scale: number; // render scale (feeds the shared tree kit)
  seed: number; // render RNG seed (feeds the shared tree kit)
  ground: number; // ground elevation (yd) at the base — convenience for the renderer
  trunkR: number; // trunk cylinder radius (yd) — the ricochet surface
  height: number; // trunk-top height (yd above the base) up to which a trunk hit reflects
  canopyR: number; // canopy sphere radius (yd)
  canopyH: number; // canopy-sphere centre height (yd above the base)
  // The blossom colour for a flowering tree (hole.bloom), or ABSENT. A COLOUR and
  // nothing else: nothing in the sim reads it.
  bloom?: number;
  // The flowering UNDERSTORY DRIFT, when this tree blooms under a hole whose
  // bloom.form is 'understory' — otherwise BOTH ABSENT. A half-ellipsoid standing
  // on the ground at the trunk, radius shrubR and height shrubH (yd), which the
  // renderer fills with blossom blobs and the sim brushes a ball through.
  //
  // ⚠ TWO TREES OF IDENTICAL GEOMETRY CAN CARRY DIFFERENT COLLIDERS, and that is
  // deliberate: only a seeded FRACTION of a hole's broadleaves flower, so two
  // trees at the same scale, one flowering and one not, differ by exactly this
  // pair of fields. Read them off the tree, never off the hole.
  //
  // These exist because the drift is a SOLID-LOOKING MASS AT BALL HEIGHT. The
  // crown-tint form needed nothing like this — its blossom sits up where nothing
  // was collidable anyway — but moving the mass down moved it into the one height
  // band the collision model ignored, and for two holes a ball rolled through
  // eight yards of apparent flowering shrub and felt nothing. The numbers are
  // deliberately the SAME numbers the renderer sizes the drift from
  // (foliage.ts `groveFromCourseTrees`), so the drawn mass cannot grow past the
  // collidable one again without someone changing the value the sim reads.
  shrubR?: number;
  shrubH?: number;
}

// A seeded [0,1) roll deciding whether one tree flowers: mulberry32's first
// output for the tree's seed mixed with the hole's terrain seed. The hole seed
// is in the mix because the TREE seeds are a function of `d` alone (5000+d,
// 9000+d) and so are the same on every hole — without it, all 13 flowering holes
// would bloom at the identical downrange stations, which reads as a repeat over
// a round. The extra constant keeps this stream distinct from foliage.ts's
// per-tree render jitter, which is seeded from the same numbers.
function bloomRoll(seed: number, holeSeed: number): number {
  const a = ((seed ^ Math.imul(holeSeed, 0x9e3779b1)) + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The framed downrange extent CourseGL meshes to — MUST match the renderer so a
// tree at the far end lands at the same d (renderer: dMax = max(pin.d, centerline
// max d) + MARGIN(30) + 80). Kept here so the tree loop is self-contained.
function treeSpanMaxD(hole: CourseHole): number {
  let clMaxD = hole.pin.d;
  for (const p of hole.centerline) clMaxD = Math.max(clMaxD, p.d);
  return Math.max(hole.pin.d, clMaxD) + 30 + 80;
}

// Centerline x at downrange d (linear between vertices; clamped past the ends).
function centerlineXAt(hole: CourseHole, d: number): number {
  const cl = hole.centerline;
  for (let s = 0; s < cl.length - 1; s++) {
    const a = cl[s]!;
    const b = cl[s + 1]!;
    if (d >= a.d && d <= b.d) return a.x + ((b.x - a.x) * (d - a.d)) / (b.d - a.d || 1);
  }
  return cl[cl.length - 1]!.x;
}

// The understory drift envelope, in LOCAL tree units (multiplied by the tree's
// render scale, exactly like trunkR/canopyR/canopyH above). It is a half-ellipsoid
// standing on the ground at the trunk: radius SHRUB_R, height SHRUB_H.
//
// Both numbers are answers to a measurement, not guesses:
//   • SHRUB_R 3.2 sits just INSIDE the canopy's 3.4, so a drift can no longer be
//     wider than the tree it grows under. The first pass was 4.55 (7.5–9.9 yd at
//     course scales) against a 5.6–7.4 yd crown, which is why the near clumps read
//     as boulders rather than as planting.
//   • SHRUB_H 1.6 is 2.6–3.5 yd at course scales — 2.4–3.2 m, which is what a
//     mature forsythia/pyracantha/nandina actually is. The first pass stood
//     4.3–5.7 yd tall, roughly double the plant.
const SHRUB_R = 3.2;
const SHRUB_H = 1.6;

// The tree grove for a hole. Deterministic in the hole (integer d steps, no RNG).
export function courseTrees(hole: CourseHole): CourseTree[] {
  const out: CourseTree[] = [];
  const dMax = treeSpanMaxD(hole);
  const off = hole.roughHalf + 8;
  const bloom = hole.bloom;
  const push = (kind: 'pine' | 'broadleaf', x: number, d: number, scale: number, seed: number) => {
    // Per-species trunk/canopy dimensions (yd), scaled with the render scale so the
    // collision volumes track the DRAWN tree (see-what-you-play). Trunk radius ≈
    // the tree kit's trunk-cylinder base radius (scenery.ts: broadleaf 0.45→0.85,
    // pine 0.32→0.6). The ricochet cylinder tops out at the DRAWN trunk-top height
    // — the tree kit centres each trunk mesh at local y 2.5, so a broadleaf trunk
    // (height 5.5) tops at 2.5 + 5.5/2 = 5.25·scale and a pine trunk (height 5) at
    // 2.5 + 5/2 = 5.0·scale — so a carom only happens where the visible trunk is.
    // The canopy sphere (canopyH) covers the leaves ABOVE that.
    const trunkR = (kind === 'pine' ? 0.55 : 0.8) * scale;
    const canopyR = (kind === 'pine' ? 2.9 : 3.4) * scale;
    const canopyH = 7 * scale;
    const height = (kind === 'pine' ? 5.0 : 5.25) * scale;
    const tree: CourseTree = {
      d,
      x,
      kind,
      scale,
      seed,
      ground: heightAt(hole, d, x),
      trunkR,
      height,
      canopyR,
      canopyH,
    };
    // Bloom is set LAST and only when it applies, so a hole without `bloom`
    // produces the byte-identical object (and JSON) it always did — and so does a
    // hole whose bloom is a 'canopy' tint, which is what keeps 2, 13 and 16
    // pixel-identical.
    if (bloom && kind === 'broadleaf' && bloomRoll(seed, hole.terrain.seed) < bloom.fraction) {
      tree.bloom = bloom.color;
      // …and ONLY the understory form adds a collidable. This is the one place a
      // bloom becomes visible to the sim.
      if (bloom.form === 'understory') {
        tree.shrubR = SHRUB_R * scale;
        tree.shrubH = SHRUB_H * scale;
      }
    }
    out.push(tree);
  };
  for (let d = 20; d < dMax - 20; d += 26) {
    const cx = centerlineXAt(hole, d);
    const lx = cx - off - (d % 3) * 2;
    const ld = d + (d % 7) - 3;
    const rx = cx + off + (d % 4) * 2;
    const rd = d + (d % 5) - 2;
    // Front line: broadleaves, every third step a pine for variety (same as the
    // old inline grove so the look is byte-for-byte unchanged).
    push(d % 3 === 0 ? 'pine' : 'broadleaf', lx, ld, 1.7 + (d % 5) * 0.12, 5000 + d);
    push(d % 3 === 1 ? 'pine' : 'broadleaf', rx, rd, 1.65 + (d % 4) * 0.14, 9000 + d);
    // A receding, still-sizable pine further out each side for a layered line.
    if (d % 2 === 0) {
      const ox = off + 14;
      push('pine', cx - ox, ld - 6, 1.35, 3000 + d);
      push('pine', cx + ox, rd + 6, 1.4, 4000 + d);
    }
  }
  return out;
}
