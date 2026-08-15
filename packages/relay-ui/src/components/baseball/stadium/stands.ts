// The seating bowl — one lofted rake all the way round, and the function that
// says where its inner edge is.
//
// ⚠ THE BOWL'S INNER EDGE IS DERIVED, NOT DRAWN BY EYE. In fair territory it is
// the wall, `fenceAt(park, β).distFt`. Behind the foul lines it is the OFFSET
// CURVE of the fair wedge at `park.foulTerritoryFt` — the locus of points that
// far from the nearest playable ground, which is precisely what "depth of
// catchable foul ground" means. For a wedge that offset has a closed form:
//
//   • within 90° of a foul line, the nearest feature is the LINE, and the
//     perpendicular distance from a point at bearing β is `r·sin(|β| − 45)`,
//     so the boundary is `r = foulTerritoryFt / sin(|β| − 45)`;
//   • past 90° the projection onto the line runs negative, the nearest feature
//     is the APEX (the plate), and the boundary is the circle `r = foulTerritoryFt`.
//
// Clamped by the wall distance at the line, since the stands cannot be further
// out than the fence they meet. That clamp is where the two branches join and it
// is a genuine geometric corner, not a smoothing failure. The upshot is that a
// park with 28 ft of foul ground gets a backstop 28 ft behind the plate and one
// with 22 ft gets 22 — visible, and read from the same field that the fielding
// model reads.
//
// ⚠ THE ONLY RANDOMNESS IN THE SCENE LIVES HERE, and it is seeded. Per-section
// brightness jitter on the seats, drawn from `mulberry32(BOWL_SEED)` — the same
// three-free PRNG the sim uses, never `Math.random`. Two runs of the screenshot
// harness must produce byte-identical PNGs; that is a hard requirement, and one
// unseeded call anywhere in this file would break it silently.

import { Color, DoubleSide, Group, Mesh, MeshLambertMaterial } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import type { Park } from '../../../lib/baseball/parks';
import { mulberry32 } from '../../../lib/golf/wind';
import { DEG, loft, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';

/** Horizontal run of the seating rake, ft. SCENE-ONLY (no physics reads it). */
const DECK_DEPTH_FT = 130;

/** Height of the back of the rake above field level, ft. SCENE-ONLY. */
const DECK_TOP_FT = 130;

/** Clearance the deck keeps below a roof, ft. SCENE-ONLY. */
const ROOF_CLEARANCE_FT = 40;

/** Seat-section brightness jitter, ±fraction. SCENE-ONLY (a feel knob). */
const SECTION_JITTER = 0.1;

/** Angular width of one seating section, deg. SCENE-ONLY. */
const SECTION_DEG = 7.5;

/** Fixed seed for the section jitter. Determinism is the point — see header. */
const BOWL_SEED = 20260815;

/** How far behind the outfield wall the bowl skirt stands, ft. SCENE-ONLY. */
const SKIRT_BEHIND_FT = 1.5;

const COLORS = { seats: 0x9aa0ab, apronBase: 0x9aa0aa };

export interface StandsPart extends StadiumPart {
  /** Inner edge of the bowl at a bearing, ft. Also the roof ring's inner edge. */
  innerRadiusFt(bearingDeg: number): number;
  /** Outer edge of the bowl at a bearing, ft. */
  outerRadiusFt(bearingDeg: number): number;
  /** Height of the back of the rake, ft. */
  deckTopFt: number;
}

/** See the header: the wall in fair territory, the foul-ground offset outside it. */
export function bowlInnerRadiusFt(park: Park, bearingDeg: number): number {
  const a = Math.abs(bearingDeg);
  if (a <= FOUL_LINE_DEG) return fenceAt(park, bearingDeg).distFt;
  const atLine = fenceAt(park, FOUL_LINE_DEG * Math.sign(bearingDeg || 1)).distFt;
  const past = a - FOUL_LINE_DEG;
  if (past >= 90) return park.foulTerritoryFt;
  return Math.min(atLine, park.foulTerritoryFt / Math.sin(past * DEG));
}

/** Wall height at a bearing, held at the foul-line value outside fair territory. */
function wallTopFt(park: Park, bearingDeg: number): number {
  const a = Math.abs(bearingDeg);
  const b = a <= FOUL_LINE_DEG ? bearingDeg : FOUL_LINE_DEG * Math.sign(bearingDeg || 1);
  return fenceAt(park, b).heightFt;
}

export function buildStands({ scene, track, park, quality }: StadiumCtx): StandsPart {
  const group = new Group();
  group.name = 'stands';

  const deckTopFt =
    park.roofPeakFt > 0
      ? Math.min(DECK_TOP_FT, park.roofPeakFt - ROOF_CLEARANCE_FT)
      : DECK_TOP_FT;
  const innerRadiusFt = (b: number) => bowlInnerRadiusFt(park, b);
  // The bowl stands `SKIRT_BEHIND_FT` behind its inner edge so that in fair
  // territory it sits BEHIND the outfield wall instead of z-fighting with it.
  const footRadiusFt = (b: number) => innerRadiusFt(b) + SKIRT_BEHIND_FT;
  const outerRadiusFt = (b: number) => footRadiusFt(b) + DECK_DEPTH_FT;

  const step = quality.bowlStepDeg;
  const front = ring(-180, 180, step, (b) => ({ r: footRadiusFt(b), y: wallTopFt(park, b) }));
  const back = ring(-180, 180, step, (b) => ({ r: outerRadiusFt(b), y: deckTopFt }));

  // Seeded per-section brightness. One geometry, one draw call, one material —
  // the variation is in a vertex-colour attribute, not in N materials.
  const count = front.length / 3;
  const rng = mulberry32(BOWL_SEED);
  const sections = Math.ceil(360 / SECTION_DEG);
  const shade = Array.from({ length: sections }, () => 1 + (rng() * 2 - 1) * SECTION_JITTER);
  const colors = new Float32Array(count * 2 * 3);
  // ⚠ THROUGH `Color`, NOT BY UNPACKING THE HEX BYTES. A vertex-colour
  // attribute is consumed in the renderer's LINEAR working space, while a hex
  // literal is sRGB. Dividing the bytes by 255 hands three an sRGB number as if
  // it were linear, which brightens 0x8b (0.545 sRGB ≈ 0.25 linear) by more than
  // a factor of two — the first render of this scene came out a blown-out white
  // cone for exactly that reason. `Color` applies the conversion.
  const base = new Color(COLORS.seats);
  for (let i = 0; i < count; i++) {
    const b = -180 + (360 * i) / (count - 1);
    const s = shade[Math.min(sections - 1, Math.floor((b + 180) / SECTION_DEG))] ?? 1;
    for (const v of [i, count + i]) {
      colors[v * 3] = base.r * s;
      colors[v * 3 + 1] = base.g * s;
      colors[v * 3 + 2] = base.b * s;
    }
  }

  const rake = new Mesh(
    track(loft(front, back, colors)),
    track(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide })),
  );
  rake.name = 'seatingRake';
  rake.castShadow = true;
  rake.receiveShadow = true;
  group.add(rake);

  // A skirt from field level up to the front of the rake, so the bowl reads as
  // solid from inside the park rather than as a floating ribbon. Behind the
  // lines this IS the backstop and the side walls; in fair territory it hides
  // behind the outfield wall. Same loft primitive again.
  const foot = ring(-180, 180, step, (b) => ({ r: footRadiusFt(b), y: 0 }));
  const skirt = new Mesh(
    track(loft(foot, front)),
    track(new MeshLambertMaterial({ color: COLORS.apronBase, side: DoubleSide })),
  );
  skirt.name = 'bowlSkirt';
  skirt.receiveShadow = true;
  group.add(skirt);

  scene.add(group);
  return { group, innerRadiusFt, outerRadiusFt, deckTopFt };
}
