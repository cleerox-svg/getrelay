// Island / pin layout for the driving range, plus a deterministic target
// spawner for the Target Challenge.
//
// The range's LANDING AREA is now selectable — three data-driven RangeLayouts
// share one source of truth here (surfaceAt / islandAt / the pin sets / the
// renderer all key off the active layout, and the mode where it matters):
//
//   'lane'         Center-lane causeway: water 100..390 with a central grass
//                  lane (±FAIRWAY_HALF_W) in BOTH practice and challenge, so an
//                  online shot always lands on turf and runs out. Islands poke
//                  out of the flanking water. (The original behaviour.)
//   'practiceLane' Identical to 'lane' in PRACTICE, but the causeway is GONE in
//                  CHALLENGE (full water + islands) so scoring still demands aim.
//   'fairway'      Grass is the BASE; a WATER CROSSING HAZARD band sits in a gap
//                  between club carries (FAIRWAY_WATER_START..END). Most clubs
//                  land on the near fairway and roll; the long clubs carry the
//                  hazard to a far fairway. Island greens sit in the band; green
//                  targets sit on the near + far fairway.
//
// Coordinates are world-space (d = downrange yards, x = lateral yards, +right).
// Radius is the grass patch / catch radius in yards.

// Total range depth in yards: grass 0..100, water 100..390, back lip+fence
// 390..400. The 3D scene (RangeGL) and the headless sim (rangeSim) both read
// this as the downrange extent.
export const RANGE_YD = 400;

export type PinKind = 'grass' | 'island' | 'lip';

export interface Pin {
  id: string;
  // Island / patch centre in world space; the flag sits here.
  d: number;
  x: number;
  // Grass-patch radius in yards (also the "on the island" catch radius).
  r: number;
  kind: PinKind;
}

// The three selectable landing-area designs. Threaded through surfaceAt /
// islandAt / spawnTarget / RangeSim / RangeGL so the whole scene is a function
// of the active layout (and, for practiceLane, the practice-vs-challenge mode).
export type RangeLayout = 'lane' | 'practiceLane' | 'fairway';

// Picker metadata (id/label/blurb) surfaced to the in-app Range-layout control.
export interface LayoutMeta {
  id: RangeLayout;
  label: string;
  blurb: string;
}
export const RANGE_LAYOUTS: readonly LayoutMeta[] = [
  {
    id: 'lane',
    label: 'Center lane',
    blurb: 'Grass lane down the middle over the water — land & roll every swing.',
  },
  {
    id: 'practiceLane',
    label: 'Practice lane',
    blurb: 'Lane while practising; full water in the challenge so aim still counts.',
  },
  {
    id: 'fairway',
    label: 'Fairway',
    blurb: 'Grass fairways split by a crossing water hazard — carry it with the long clubs.',
  },
];

// Default landing area + where the picker persists its choice.
export const DEFAULT_LAYOUT: RangeLayout = 'fairway';
export const LAYOUT_STORAGE_KEY = 'relay.golf.rangeLayout';

export function readStoredLayout(): RangeLayout {
  try {
    const v = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (v === 'lane' || v === 'practiceLane' || v === 'fairway') return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_LAYOUT;
}

export function writeStoredLayout(layout: RangeLayout): void {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, layout);
  } catch {
    /* ignore */
  }
}

// Grass 0..100, water 100..390, lip+fence 390..400 (lane / practiceLane).
export const GRASS_END = 100;
export const WATER_END = 390;

// 'lane' / 'practiceLane' causeway half-width in yards each side of centre (a
// 2*FAIRWAY_HALF_W-wide grass lane over the water). Water flanks it and
// surrounds the outer islands, so an off-line shot still finds the hazard.
export const FAIRWAY_HALF_W = 16;

// 'fairway' CROSSING WATER HAZARD band (downrange yards). Tuned against the
// neutral bag (harness). The band starts just past the 5-Iron's TOTAL (~245) so
// SW..5-Iron rest on the NEAR fairway, and is wide enough that a club landing
// short can't BOUNCE across it — with this bag a thin band gets hopped, so a
// credible crossing that actually swallows the mid clubs must be ~38yd deep:
//   SW..5-Iron  → near fairway (total < START);
//   Hybrid (lands 243, releases in) & 3-Wood (carry 260, lands in) → SPLASH
//                 unless aimed at an island — the risk/reward carry clubs;
//   Driver (carry 291 > END) → carries clean to the FAR fairway, rolling ~348.
// Island greens sit inside this band; a straight bomb still can't trivially
// score the challenge (targets are islands/greens you must be near).
export const FAIRWAY_WATER_START = 247;
export const FAIRWAY_WATER_END = 285;

// The rendered island green is drawn at pin.r * ISLAND_SURFACE_SCALE (the green
// cap radius in RangeGL). Physics classification and the renderer share this
// constant so a ball resting on the visible green counts as 'island', not
// 'water' — the edge no longer swallows shots that clearly landed on the green.
// Slightly generous vs. pin.r (the scoring catch radius) on purpose.
export const ISLAND_SURFACE_SCALE = 1.2;

// The solid green radius of an island (yards) — the collision/containment edge.
export function islandSurfaceR(p: Pin): number {
  return p.r * ISLAND_SURFACE_SCALE;
}

export type Surface = 'grass' | 'island' | 'water' | 'fence';

// --- Per-layout pin sets ---------------------------------------------------

// 'lane' / 'practiceLane': islands spread through the flanking water, plus a
// couple of near-grass pins and the back lip hero target. Hand-placed,
// staggered in depth and side so the challenge never spawns two on top of each
// other and the perspective reads cleanly.
const LANE_PINS: Pin[] = [
  { id: 'g1', d: 55, x: -16, r: 7, kind: 'grass' },
  { id: 'g2', d: 82, x: 14, r: 6.5, kind: 'grass' },
  { id: 'i1', d: 130, x: 18, r: 9, kind: 'island' },
  { id: 'i2', d: 165, x: -14, r: 8, kind: 'island' },
  { id: 'i3', d: 205, x: 8, r: 7.5, kind: 'island' },
  { id: 'i4', d: 245, x: -20, r: 7, kind: 'island' },
  { id: 'i5', d: 285, x: 16, r: 6.5, kind: 'island' },
  { id: 'i6', d: 330, x: -8, r: 6, kind: 'island' },
  { id: 'i7', d: 365, x: 10, r: 5.5, kind: 'island' },
  { id: 'l1', d: 396, x: 0, r: 6, kind: 'lip' },
];

// 'fairway': green targets on the near fairway (before the band) and the far
// fairway (beyond it), with island greens sitting IN the crossing-hazard band
// (d in [FAIRWAY_WATER_START, FAIRWAY_WATER_END]). Islands are laterally spread
// so an off-aim shot at one splashes in the surrounding water.
const FAIRWAY_PINS: Pin[] = [
  // Near fairway greens (short/medium clubs land here).
  { id: 'g1', d: 70, x: -14, r: 7, kind: 'grass' },
  { id: 'g2', d: 150, x: 16, r: 6.5, kind: 'grass' },
  { id: 'g3', d: 210, x: -8, r: 6.5, kind: 'grass' },
  // Island greens spread through the water crossing (band d 247..285). Kept
  // OFF-CENTRE (|x| well over the green radius) so the middle of the band stays
  // water — a straight full-power club that lands short releases INTO the hazard
  // instead of rolling across a centred stepping-stone.
  { id: 'i1', d: 256, x: -20, r: 5.5, kind: 'island' },
  { id: 'i2', d: 268, x: 16, r: 5.5, kind: 'island' },
  { id: 'i3', d: 278, x: -13, r: 5, kind: 'island' },
  // Far fairway greens (the long carry clubs finish here).
  { id: 'g4', d: 300, x: 12, r: 7, kind: 'grass' },
  { id: 'g5', d: 340, x: -16, r: 7, kind: 'grass' },
  { id: 'l1', d: 380, x: 0, r: 6.5, kind: 'grass' },
];

// The pin set backing a layout. LANE_PINS is also exported as PINS for
// backward-compatible imports.
export function pinsFor(layout: RangeLayout): Pin[] {
  return layout === 'fairway' ? FAIRWAY_PINS : LANE_PINS;
}

// Back-compat: the default (lane) pin set.
export const PINS: Pin[] = LANE_PINS;

// Return the island pin whose green a world point sits on, else null. Islands
// are the raised greens of the active layout; a point is "on" one when it lies
// within its green radius.
export function islandAt(d: number, x: number, layout: RangeLayout): Pin | null {
  for (const p of pinsFor(layout)) {
    if (p.kind !== 'island') continue;
    const dd = d - p.d;
    const dx = x - p.x;
    const r = islandSurfaceR(p);
    if (dd * dd + dx * dx <= r * r) return p;
  }
  return null;
}

// Whether the grass causeway is present for this layout+mode. Always for
// 'lane'; for 'practiceLane' only while practising (challenge = full water).
function hasCauseway(layout: RangeLayout, isChallenge: boolean): boolean {
  return layout === 'lane' || (layout === 'practiceLane' && !isChallenge);
}

// Is a world point on solid ground (grass, an island patch, or the back lip)
// rather than in the water? The range physics calls this to decide
// bounce-vs-splash at the landing point and along the roll. Layout (and, for
// practiceLane, the challenge flag) select the surface map.
export function surfaceAt(
  d: number,
  x: number,
  layout: RangeLayout,
  isChallenge: boolean,
): Surface {
  if (d >= RANGE_YD) return 'fence';

  if (layout === 'fairway') {
    // Grass base with a single crossing water band; island greens poke out.
    if (islandAt(d, x, layout)) return 'island';
    if (d >= FAIRWAY_WATER_START && d <= FAIRWAY_WATER_END) return 'water';
    return 'grass';
  }

  // lane / practiceLane: grass tee + back lip, water 100..390 with islands and
  // (mode-dependent) a central grass causeway.
  if (d < GRASS_END) return 'grass';
  if (d > WATER_END) return 'grass'; // back lip is grass
  if (islandAt(d, x, layout)) return 'island';
  if (hasCauseway(layout, isChallenge) && Math.abs(x) < FAIRWAY_HALF_W) return 'grass';
  return 'water';
}

// Small deterministic PRNG (mulberry32) so a given (seed, shotIndex) always
// spawns the same target — handy for reproducible challenges and tests.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Pick the Target Challenge pin for a given shot from the active layout's pin
// set. Varies by shot index (and optional seed); avoids repeating the
// immediately previous pin so back-to-back shots always change target.
export function spawnTarget(
  shotIndex: number,
  seed = 1,
  prevId?: string,
  layout: RangeLayout = DEFAULT_LAYOUT,
): Pin {
  const all = pinsFor(layout);
  const r = rng(seed * 1000 + shotIndex * 7 + 13);
  let pool = all;
  if (prevId) pool = all.filter((p) => p.id !== prevId);
  if (pool.length === 0) pool = all;
  const pick = pool[Math.floor(r() * pool.length)] ?? all[0]!;
  return pick;
}
