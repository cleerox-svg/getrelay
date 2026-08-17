// The roof — a RING at `park.roofPeakFt`, with the SPACE-FRAME TRUSS under it.
//
// ⚠ THE HEIGHT IS THE POINT AND THE HEIGHT IS DATA. `roofPeakFt` is a real
// mechanic: `resolveFence` rules a ball that reaches it `'roof'`, so it can
// never be a home run. BASEBALL.md measures that it essentially never bites — a
// 125 mph ball at a home-run launch angle apexes 200.3 ft against a 282 ft
// ceiling — which is exactly why the scene has to show how high 282 ft is. A
// player who cannot see the ceiling cannot understand why the one pop-up a
// season that reaches it is not a home run.
//
// ⚠ AND THE UNDERSIDE IS THE PARK'S WHOLE IDENTITY. A dome's underside is a
// visible triangulated lattice, not a flat plate, and this scene drew a flat
// plate. The truss below is one merged geometry — two ring chords plus a zigzag
// web between them — so a hundred-odd cells cost ONE draw call and ~1,700
// triangles, which is nothing against a 120,000 ceiling and everything against a
// ~18-call budget. The exterior reads light grey, the underside dark with the
// truss picked out; at night the same geometry takes an emissive material and
// lights up, which is why it is a separate mesh rather than a texture.
//
// ⚠ AND A PARK WITH NO ROOF GETS NO GEOMETRY. `Alpine Heights` has
// `roof: 'none'` and `roofPeakFt: 0`; this builder returns an empty group for
// it. That is the "content is data, not a branch" rule doing its job — the
// alpine screenshot proves it by having open sky where the home park has a ring.

import { Color, DoubleSide, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import { at, bearingOf, loft, mergeGeometries, quad, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import type { StandsPart } from './stands';

/** Depth of the roof's inner lip, ft. SCENE-ONLY: it makes the height READ. */
const LIP_DROP_FT = 14;

/** How far in from the top of the bowl the roof reaches, ft. SCENE-ONLY. */
const ROOF_BAND_FT = 120;

/**
 * Minimum band width, ft. SCENE-ONLY.
 *
 * ⚠ RAISED FROM 5 TO 30, AND IT CLOSES AN M2 FINDING. At 5 ft the ring
 * degenerated behind the plate and along the sides into a sliver that projected
 * from the `wide` camera (1000 ft up) as a 2 px dark wire across the field and
 * read as a rendering artifact rather than as a roof — the M2 list records it,
 * and the roofless Alpine shot having no such line is what proved it was the
 * roof. 30 ft at 282 ft up subtends enough of that frame to read as a rim. It is
 * a floor on a MINIMUM, so it cannot make the band over the outfield any wider.
 */
const MIN_BAND_FT = 30;

/** Thickness of the roof plate itself, ft. SCENE-ONLY: it gives the rim an edge. */
const ROOF_THICK_FT = 1.2;

/**
 * How far the space frame hangs below the roof plate, ft. SCENE-ONLY.
 *
 * ⚠ NOT ZERO, AND NOT BECAUSE IT LOOKS BETTER. A lattice drawn IN the plate is
 * coplanar with it and z-fights; hung 9 ft below it reads as structure from the
 * two cameras that can see the underside at all (`flight` and the three follow
 * scenes, where the roof is the dark band across the top of frame).
 */
const TRUSS_DEPTH_FT = 9;

/** Width of a truss member as drawn, ft. SCENE-ONLY. */
const TRUSS_MEMBER_FT = 2.2;

/**
 * ⚠ THE UNDERSIDE IS DARK, NOT BLACK, AND THE FIRST RENDER WAS BLACK. It faces
 * DOWN, so the only light reaching it is the hemisphere's GROUND colour at
 * roughly half weight — 0x2a2e36 under that is indistinguishable from 0x000000
 * and the roof read as a hole punched in the sky. These are the values that
 * survive being lit from one side only. The truss stays the darkest thing in
 * the group, because "picked out against the underside" is the whole effect.
 */
const COLORS = { deck: 0x969ba2, under: 0x6b727c };

export interface RoofPart extends StadiumPart {
  /**
   * Peak height and the two radii of the DRAWN roof at a bearing, read back out
   * of the built geometry. `null` for a park with no roof.
   *
   * ⚠ THIS IS THE OTHER HALF OF `fence.sample`, AND ITS ABSENCE WAS A HOLE THE
   * VISUAL GATE NAMED. The fence's distance AND height are measured out of the
   * drawn vertex buffer and differenced against `parks.ts`, so a wall drawn from
   * the five knots instead of the pchip shows up as a delta and a non-zero exit
   * code. The ROOF had no equivalent: the harness printed `roofPeak 282 ft`
   * straight out of `parks.ts`, i.e. it printed its own input, which is exactly
   * the tautology `checkBall`'s note warns about. `roofPeakFt` is a real
   * MECHANIC — `resolveFence` rules a ball that reaches it `'roof'` — so a roof
   * drawn at the wrong height is a gameplay dimension the player cannot see is
   * wrong. It is now measured the same way the wall is.
   */
  sample(bearingDeg: number): { peakFt: number; innerFt: number; outerFt: number } | null;
}

export function buildRoof(
  { scene, track, park, quality, daylight }: StadiumCtx,
  stands: StandsPart,
): RoofPart {
  const group = new Group();
  group.name = 'roof';
  scene.add(group);

  // Data, not a branch: no roof in the park ⇒ no roof in the scene.
  if (!(park.roofPeakFt > 0)) return { group, sample: () => null };

  const step = quality.bowlStepDeg;
  const y = park.roofPeakFt;

  // ⚠ THE RING HANGS ON THE TOP OF THE BOWL AND NEVER REACHES THE INFIELD, and
  // the first render is why. Following the bowl's INNER edge put roof panels at
  // 282 ft directly over home plate — geometrically defensible (the bowl's inner
  // edge behind home is the backstop, 60 ft) and useless, because it hid the
  // field from every elevated camera and made the `wide` shot a photograph of a
  // lid. The inner edge is therefore the OUTFIELD WALL (`fenceAt`, clamped
  // outside the foul lines, so a park's own dimensions still set it), pulled no
  // further in than `ROOF_BAND_FT` from the top of the bowl and never past it.
  // The result is widest over the outfield seats and a rim behind home — which
  // is both what a retractable roof's parked panels look like and what leaves a
  // 400 ft opening for a ball to be watched through.
  const outerR = (b: number) => stands.outerRadiusFt(b);
  const innerR = (b: number) => {
    const o = outerR(b);
    const wall = fenceAt(park, Math.max(-FOUL_LINE_DEG, Math.min(FOUL_LINE_DEG, b))).distFt;
    return Math.min(o - MIN_BAND_FT, Math.max(wall, o - ROOF_BAND_FT));
  };

  const inner = ring(-180, 180, step, (b) => ({ r: innerR(b), y }));
  const outer = ring(-180, 180, step, (b) => ({ r: outerR(b), y }));
  const lip = ring(-180, 180, step, (b) => ({ r: innerR(b), y: y - LIP_DROP_FT }));
  const innerLow = ring(-180, 180, step, (b) => ({ r: innerR(b), y: y - ROOF_THICK_FT }));
  const outerLow = ring(-180, 180, step, (b) => ({ r: outerR(b), y: y - ROOF_THICK_FT }));

  // ⚠ TWO SINGLE-SIDED SHEETS, NOT ONE DOUBLE-SIDED ONE. A `DoubleSide` ring
  // shows the SAME colour from above and below; the whole point is that the
  // exterior is pale and the underside is dark, so the extra draw call buys the
  // contrast the reference photography is entirely about.
  //
  // ⚠ AND THE TOP HAS PANEL LINES NOW. Measured before: 0.06 levels of detail
  // over a 400×80 px patch of the roof's upper surface — the 18-level range in
  // it was ENTIRELY Lambert curvature, i.e. the shape of the ring and nothing
  // else. A whole space frame was authored on the underside while `wide`, the
  // only camera that sees the top, got a flat sheet. `deckColors` costs no draw
  // call and no triangle: it is a per-column vertex colour on a loft that was
  // already there.
  const deckGeo = track(loft(inner, outer, { colors: deckColors(inner.length / 3) }));
  const deck = new Mesh(
    deckGeo,
    track(new MeshLambertMaterial({ vertexColors: true, side: FrontSide })),
  );
  deck.name = 'roofRing';
  deck.castShadow = true;
  group.add(deck);

  // ⚠ THE UNDERSIDE AND THE TRUSS CARRY AN EMISSIVE AT NIGHT, AND IT IS NOT A
  // FLOURISH. Both face DOWN, so an overhead night rig reaches neither and the
  // whole roof renders black — which loses the element that frames the tower in
  // the one shot `homerun` and `flight` are composing. The alternative is a
  // second light pointing up, which the shadow budget refuses. See
  // `daylight.trussHex`.
  const under = new Mesh(
    track(loft(outerLow, innerLow)),
    track(
      new MeshLambertMaterial({
        color: COLORS.under,
        emissive: daylight.roofEmissiveHex,
        side: FrontSide,
      }),
    ),
  );
  under.name = 'roofUnderside';
  group.add(under);

  // ⚠ THE LEADING EDGE IS THE BUILDING'S NIGHT SIGNATURE. See
  // `daylight.roofEdgeHex`: in every night photograph this arc is a thick bright
  // BLUE band and it is the most identifiable thing about the roof from outside.
  // It is also the arc `homerun`, `flight` and the three `follow-*` scenes
  // compose the celebration against, so it is the highest-value surface in the
  // night palette. In daylight it keeps the dark rim it always had.
  const fascia = new Mesh(
    track(loft(lip, inner)),
    track(
      new MeshLambertMaterial({
        color: daylight.roofEdgeHex,
        emissive: daylight.roofEdgeEmissiveHex,
        side: DoubleSide,
      }),
    ),
  );
  fascia.name = 'roofLip';
  group.add(fascia);

  const truss = buildTruss(innerR, outerR, y - TRUSS_DEPTH_FT, quality.trussCells);
  if (truss) {
    const mesh = new Mesh(
      track(truss),
      track(
        new MeshLambertMaterial({
          color: daylight.trussHex,
          emissive: daylight.roofEmissiveHex,
          side: DoubleSide,
        }),
      ),
    );
    mesh.name = 'roofTruss';
    group.add(mesh);
  }

  return { group, sample: (deg) => sampleDeck(deckGeo, deg) };
}

/**
 * Read the roof deck back out of its own vertex buffer.
 *
 * `loft` lays the INNER ring down first and the outer ring second, so vertex `i`
 * and `i + count` are the inner and outer edge of the same panel. Bearings run
 * monotonically −180 → +180, which the closing sample repeats, so a bracket scan
 * is enough. The height is read from the buffer rather than from `park`, which
 * is the whole point.
 */
function sampleDeck(
  geo: BufferGeometry,
  bearingDeg: number,
): { peakFt: number; innerFt: number; outerFt: number } | null {
  const pos = geo.getAttribute('position');
  const count = pos.count / 2;
  for (let i = 0; i + 1 < count; i++) {
    const b0 = bearingOf(pos.getX(i), pos.getZ(i));
    const b1 = bearingOf(pos.getX(i + 1), pos.getZ(i + 1));
    // The closing segment wraps −180 → +180 and cannot bracket anything.
    if (Math.abs(b1 - b0) > 180) continue;
    if (bearingDeg < Math.min(b0, b1) - 1e-9 || bearingDeg > Math.max(b0, b1) + 1e-9) continue;
    const t = b1 === b0 ? 0 : (bearingDeg - b0) / (b1 - b0);
    const lerp = (a: number, b: number) => a + (b - a) * t;
    return {
      peakFt: lerp(pos.getY(i), pos.getY(i + 1)),
      innerFt: lerp(
        Math.hypot(pos.getX(i), pos.getZ(i)),
        Math.hypot(pos.getX(i + 1), pos.getZ(i + 1)),
      ),
      outerFt: lerp(
        Math.hypot(pos.getX(count + i), pos.getZ(count + i)),
        Math.hypot(pos.getX(count + i + 1), pos.getZ(count + i + 1)),
      ),
    };
  }
  return null;
}

/**
 * Per-column colours for the roof's TOP surface: alternating panel bays, plus
 * two darker columns where a retractable roof's moving panels part.
 *
 * ⚠ THE SPLIT IS AT ±`ROOF_SPLIT_DEG`, WHICH IS DATA-SHAPED BUT NOT DATA. A
 * retractable roof parts somewhere, and where is an authoring choice, not a
 * published dimension — so it is a SCENE-ONLY constant and is labelled one. It
 * is placed over the outfield rather than over the plate because the only camera
 * that sees the top is `wide`, whose subject is the field.
 */
const ROOF_PANEL_DEG = 7.5;
const ROOF_SPLIT_DEG = 55;
const ROOF_SEAM_HALF_DEG = 1.6;

function deckColors(count: number): Float32Array {
  const arr = new Float32Array(count * 2 * 3);
  const c = new Color();
  for (let i = 0; i < count; i++) {
    const b = -180 + (360 * i) / (count - 1 || 1);
    const bay = Math.floor((b + 180) / ROOF_PANEL_DEG) % 2 === 0 ? 1 : 0.955;
    const onSeam = [-ROOF_SPLIT_DEG, ROOF_SPLIT_DEG].some(
      (s) => Math.abs(b - s) < ROOF_SEAM_HALF_DEG,
    );
    c.set(COLORS.deck).multiplyScalar(onSeam ? 0.72 : bay);
    for (const v of [i, count + i]) {
      arr[v * 3] = c.r;
      arr[v * 3 + 1] = c.g;
      arr[v * 3 + 2] = c.b;
    }
  }
  return arr;
}

/**
 * The space frame, as flat ribbons just under the roof plane: an inner chord, an
 * outer chord and a zigzag web that alternates inner→outer→inner between them.
 * That zigzag is what makes it read as TRIANGULATED rather than as a grid, and
 * it is the one thing the eye actually picks out of a dome underside.
 *
 * Merged into one geometry, so `cells` is free up to the triangle ceiling and
 * costs exactly one draw call. `cells = 0` (the low tier) returns null and the
 * roof is simply a dark plate — the cheap tier loses detail, never structure.
 */
function buildTruss(
  innerR: (b: number) => number,
  outerR: (b: number) => number,
  y: number,
  cells: number,
): BufferGeometry | null {
  if (cells <= 0) return null;
  const parts: BufferGeometry[] = [];
  const w = TRUSS_MEMBER_FT / 2;
  // A ribbon between two (bearing, radius) points, widened along the radius so
  // it is visible from below whatever its direction. `quad` is the ground-plane
  // primitive and every member here is horizontal, so this is exactly it.
  const member = (b0: number, r0: number, b1: number, r1: number) => {
    const a = at(b0, r0, y);
    const c = at(b1, r1, y);
    const dx = c[0] - a[0];
    const dz = c[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * w;
    const nz = (dx / len) * w;
    parts.push(
      quad(
        [a[0] + nx, y, a[2] + nz],
        [c[0] + nx, y, c[2] + nz],
        [c[0] - nx, y, c[2] - nz],
        [a[0] - nx, y, a[2] - nz],
      ),
    );
  };
  for (let i = 0; i < cells; i++) {
    const b0 = -180 + (360 * i) / cells;
    const b1 = -180 + (360 * (i + 1)) / cells;
    member(b0, innerR(b0), b1, innerR(b1)); // inner chord
    member(b0, outerR(b0), b1, outerR(b1)); // outer chord
    // The web: alternate the diagonal's sense so consecutive cells share a
    // vertex and the pattern is a row of triangles rather than a row of Vs.
    if (i % 2 === 0) member(b0, innerR(b0), b1, outerR(b1));
    else member(b0, outerR(b0), b1, innerR(b1));
    // …plus the radial post that closes each triangle pair.
    member(b0, innerR(b0), b0, outerR(b0));
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}
