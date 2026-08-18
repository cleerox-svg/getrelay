// The playing surface: foul apron, mown fair grass, warning track, the SKINNED
// infield with its grass cutouts, the foul lines out to the poles, and home
// plate.
//
// ⚠ EVERY RADIUS IN HERE COMES FROM DATA. The grass and the warning track are
// cut to `fenceAt(park, β)` sampled degree by degree, so the turf ends exactly
// where the wall the sim resolves against stands. The infield dirt's outer edge
// is `infieldDepthFt(β)` — `fielders.ts`'s own function, not a second copy of
// it. (It lived in `fielding.ts` until the rolling phase split the defence into
// three modules along a real seam; the function is character-identical, the
// geometry did not move, and one import line did.) Home plate is
// `PLATE_WIDTH_FT` / `PLATE_DEPTH_FT` from `zone.ts`. The foul
// lines are `FOUL_LINE_DEG`. A builder that hard-codes a distance is a bug the
// visual gate is meant to catch.
//
// ⚠ THE DIRT USED TO BE DRAWN WRONG-LOOKING BECAUSE IT WAS COMPUTED WRONG, AND
// THAT LOOP HAS NOW CLOSED. The fielder model shipped a plate-centred 155.5 ft
// circle where the real 95 ft arc is struck from the RUBBER; this file drew that
// circle rather than a prettier one, on the principle that a wrong shared number
// should become visible instead of staying an internal detail. It did: the M1
// visual gate inverted the render back to world feet, measured the dirt/grass
// boundary at 155.6 ft, and the geometry — not the renderer — was fixed.
//
// ⚠ AND THE OTHER HALF OF THAT FINDING IS CLOSED HERE. The M1 gate blamed the
// batter's-eye "dirt lot" on the arc RADIUS and was wrong — at that camera's
// 23.2° horizontal FOV the arc moves by ≤2.2 ft. The real cause was that the
// infield was ONE SOLID FAN with no grass in it, roughly 7,000 ft² of a real
// infield's ~15,800 being turf. It is now an ANNULUS between the base-path
// diamond and the arc, plus a dirt circle at the plate, so the grass underneath
// shows through exactly where a groundskeeper leaves it.
//
// ⚠ AND THE TURF IS MOWN. Alternating light/dark bands are the single biggest
// surface in every wide shot, and they are FREE: the grass is built as
// concentric strips (unshared vertices, so the seam is crisp rather than a
// gradient) merged into ONE geometry with ONE material and ONE draw call.
//
// ⚠ M3b: THE INFIELD IS NO LONGER MOWN AS A SUNBURST. It used to carry radial
// WEDGES inside the 95 ft arc, on the claim that "that is what a real infield
// mow looks like". It is not: no groundskeeper cuts spokes radiating from home
// plate, and the visual gate's verdict on the render was that it read as a
// dartboard. There is now ONE rule — concentric arcs — asked of every cell, and
// `MOW_WEDGE_DEG` and its half-wedge phase offset are gone with it. Deleting a
// pattern is a smaller file, not a bigger one.
//
// ⚠ M3b: AND THE GROUND HAS GRAIN. Measured before: infield clay 0.0000 levels
// of high-frequency detail over a 400×150 px patch — literally one colour —
// against golf's 3.43 on fairway. Every ground surface now samples ONE seeded
// noise tile (`stadium/grain.ts`) through UVs derived from its own world
// position (`geom.planarUV`), cloned per surface with a different `repeat`. One
// canvas, four textures, no new draw call, and byte-identical between runs.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshLambertMaterial,
} from 'three';
import type { CanvasTexture, Side } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import { infieldDepthFt } from '../../../lib/baseball/fielders';
import { PLATE_DEPTH_FT, PLATE_WIDTH_FT } from '../../../lib/baseball/zone';
import { at, fan, loft, mergeGeometries, planarUV, polygon, quad, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import { buildGrainTile, grainAt } from './grain';
import { bowlInnerRadiusFt } from './bowlEdge';

/**
 * Warning-track width, ft. SCENE-ONLY: nothing in the physics reads it (the
 * fielder model has no track), so it is not a physics constant of any category —
 * it is the customary 10–16 ft band, drawn at 15 so the wall reads as a wall.
 */
const WARNING_TRACK_FT = 15;

/** Painted foul-line width, ft. SCENE-ONLY, the customary 4 in of chalk. */
const FOUL_LINE_W_FT = 4 / 12;

/**
 * How far the ground plane runs past the deepest fence, ft. SCENE-ONLY: it only
 * has to reach under the seating bowl so the horizon is not a hole.
 */
const APRON_MARGIN_FT = 170;

/**
 * Base-path length, ft. FIXED — rule book, 90 ft between bases. It is here
 * rather than in `zone.ts` because nothing in the physics uses it: the fielding
 * model is a landing-point lookup and never asks where a base is. It defines the
 * infield GRASS, which is why this file needs it.
 */
const BASE_FT = 90;

/**
 * How far inside the base line the infield grass starts, ft. SCENE-ONLY. The
 * customary skinned strip either side of the path.
 */
const BASEPATH_INSET_FT = 8;

/** Radius of the skinned circle around home plate, ft. SCENE-ONLY (customary 13). */
const HOME_CIRCLE_FT = 13;

/** Width of one mowing stripe, ft. SCENE-ONLY (a real mow is 15–24). */
const MOW_BAND_FT = 22;

/**
 * The chalk, ft. FIXED — rule book. The batter's box is 6 ft × 4 ft with its
 * inner edge 6 in from the plate; the catcher's box is 43 in wide and 8 ft deep,
 * running back from the rear line of the batter's boxes.
 *
 * ⚠ THESE ARE HERE FOR THE SAME REASON `BASE_FT` IS: nothing in the physics
 * reads them (there is no catcher and no check-swing rule), so they are not
 * `zone.ts` constants — but they are RULE-BOOK dimensions, not chosen ones, and
 * they are the difference between a plate area that reads as a plate area and
 * one that reads as a flat brown lot. That was 30.5 % of the primary batting
 * frame in a single colour.
 */
const BOX_LEN_FT = 6;
const BOX_WIDTH_FT = 4;
const BOX_GAP_FT = 0.5;
const CATCHER_BOX_W_FT = 43 / 12;
const CATCHER_BOX_LEN_FT = 8;

/**
 * Ground feet per grain tile, per surface. SCENE-ONLY, and the ONLY thing that
 * differs between the four clones of `grain.ts`'s single canvas.
 *
 * ⚠ THE CLAY IS THE FINEST AND THAT IS DELIBERATE. It is read from 20 ft in the
 * `batter` frame where the turf is read from 100+; a tile that looks right on
 * grass at that range is invisible on clay. Chosen so all four subtend roughly
 * the same angle in the shot each is actually judged in.
 */
const GRAIN_TILE_FT = { grass: 26, track: 9, dirt: 4.5 };

/**
 * Flat colours. M1 was deliberately untextured; the art pass keeps that (no
 * image assets, ever) and buys its structure from banding instead.
 *
 * ⚠ THE TRACK AND THE INFIELD ARE NO LONGER THE SAME BROWN, and that was one of
 * the two things the batter's-eye frame most needed. A warning track is a
 * distinctly redder crushed-brick red; infield clay is a browner tan. They were
 * 0xa87b4d and 0x9a6a44 — two shades of the same thing, which at distance is one
 * undifferentiated fan covering 39.6 % of the primary batting frame.
 */
const COLORS = {
  grassA: 0x2f6b33, // the dark mow band
  grassB: 0x428a41, // the light one
  track: 0xa8562f, // crushed brick — REDDER than the clay, on purpose
  dirt: 0x9c7048, // infield clay
  chalk: 0xf0f0ec,
  plate: 0xffffff,
};

/**
 * Vertical stacking of the coplanar ground layers, ft. Z-FIGHTING, NOT DESIGN —
 * and the gaps are 0.06 ft rather than the 0.02 they started at because the
 * `wide` camera reads them from 1200 ft. Even so the real fix was the per-mode
 * near plane in StadiumGL; this only buys margin.
 */
const Y = { apron: 0, grass: 0.06, track: 0.12, dirt: 0.18, chalk: 0.24, plate: 0.3 };

export interface FieldPart extends StadiumPart {
  /** Radius of the ground plane, ft — the bowl and roof build outside this. */
  apronRadiusFt: number;
  /** Deepest sampled fence distance, ft. */
  maxFenceFt: number;
}

/**
 * The base-path diamond in POLAR form: the plate-centred distance to the
 * 1B–2B (or 2B–3B) edge at a bearing.
 *
 * DERIVED, not drawn. With the plate at the origin, `+y` toward centre and `+x`
 * toward first, 1B sits at `(90/√2, 90/√2)` and 2B at `(0, 90√2)`, so the edge
 * between them is the line `x + y = 90√2`. Substituting `x = r sin β`,
 * `y = r cos β` gives the closed form below, which returns exactly 90√2 at dead
 * centre and exactly 90 at either foul line — both checkable by eye, which is
 * why it is written this way rather than as a clipped polygon.
 */
const diamondEdgeFt = (bearingDeg: number): number => {
  const b = (Math.abs(bearingDeg) * Math.PI) / 180;
  return (BASE_FT * Math.SQRT2) / (Math.sin(b) + Math.cos(b));
};

/**
 * The mown turf — fair AND foul — as ONE geometry and ONE draw call.
 *
 * ⚠ EVERY CELL HAS ITS OWN FOUR VERTICES, AND THAT IS THE WHOLE TRICK. Vertex
 * colours INTERPOLATE across a shared edge, so a shared-vertex grid would draw
 * the mow as a smooth gradient — which is not what a mow looks like and is not
 * what makes the outfield read as a surface with a scale to it. Unshared corners
 * cost 4 vertices per cell instead of ~1 and buy a hard seam on both axes at
 * once, which is what lets the INFIELD carry a different pattern (radial wedges)
 * from the outfield (concentric arcs) inside the same buffer.
 *
 * ⚠ THE RADIAL LEVELS ARE ABSOLUTE, NOT FRACTIONS OF THE LOCAL RADIUS, and the
 * first version got that wrong. A cell row at `outer(β)·k/n` moves in and out
 * with the wall, so a stripe boundary walks up to a whole band radially as the
 * bearing sweeps — a mow that ripples. Levels at `k · MOW_BAND_FT` clipped to
 * `outer(β)` make every stripe an exact 22 ft arc, and the cells that fall past
 * the wall collapse to zero area, which costs index entries and draws nothing.
 *
 * 18 levels × 240 angular cells = 8,640 triangles for the whole playing surface.
 * Triangles are the budget with six figures of headroom; draw calls are the one
 * with ~18, and this spends one.
 */
function mownGrass(
  outerAt: (bearingDeg: number) => number,
  maxOuterFt: number,
  stepDeg: number,
): BufferGeometry {
  const cols = Math.max(1, Math.ceil(360 / stepDeg));
  const bands = Math.max(2, Math.ceil(maxOuterFt / MOW_BAND_FT));
  const dark = new Color(COLORS.grassA);
  const light = new Color(COLORS.grassB);
  const pos = new Float32Array(bands * cols * 4 * 3);
  const col = new Float32Array(bands * cols * 4 * 3);
  const idx = new Uint32Array(bands * cols * 6);
  const bearing = (j: number) => -180 + (360 * j) / cols;
  let v = 0;
  let t = 0;
  for (let k = 0; k < bands; k++) {
    for (let j = 0; j < cols; j++) {
      const b0 = bearing(j);
      const b1 = bearing(j + 1);
      const r = (b: number, level: number) => Math.min(outerAt(b), level * MOW_BAND_FT);
      const corners: Array<[number, number]> = [
        [b0, r(b0, k)],
        [b1, r(b1, k)],
        [b1, r(b1, k + 1)],
        [b0, r(b0, k + 1)],
      ];
      // ⚠ ONE PATTERN RULE FOR THE WHOLE SURFACE: concentric arcs, "is this
      // radial band even". The infield used to get radial WEDGES instead, on
      // the claim that a real infield is mown that way. It is not — a spoke
      // pattern converging on home plate is not a mow any groundskeeper cuts,
      // and the render read as a dartboard. Two rules also needed a fair-
      // territory test and a half-wedge phase offset to stop the sunburst
      // wrapping round the backstop and to keep a seam off dead centre; one
      // rule needs neither, which is why deleting the second one made this
      // function shorter rather than longer.
      const c = k % 2 === 0 ? dark : light;
      const base = v;
      for (const [b, rad] of corners) {
        const p = at(b, rad, Y.grass);
        pos[v * 3] = p[0];
        pos[v * 3 + 1] = p[1];
        pos[v * 3 + 2] = p[2];
        col[v * 3] = c.r;
        col[v * 3 + 1] = c.g;
        col[v * 3 + 2] = c.b;
        v++;
      }
      // ⚠ WINDING, DERIVED AND NOT GUESSED — AND THE FIRST GUESS WAS WRONG.
      // Corners are (near-CW, near-CCW, far-CCW, far-CW) in increasing bearing.
      // With `at(β, r) = (r sinβ, y, −r cosβ)`, the triangle (0, 1, 3) has edges
      // (r·εsinβ, 0, 0) and (0, 0, −Δr), whose cross product is +y — so this is
      // `loft`'s ordering (a0, a1, b0 / a1, b1, b0) with a = the near edge. The
      // reversed order renders a FrontSide grass mesh face-down, i.e. invisible,
      // and the first render of this file showed the grey apron through it
      // across the whole field.
      idx[t++] = base;
      idx[t++] = base + 1;
      idx[t++] = base + 3;
      idx[t++] = base + 1;
      idx[t++] = base + 2;
      idx[t++] = base + 3;
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('color', new BufferAttribute(col, 3));
  g.setIndex(new BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function buildField({ scene, track, park, quality, daylight }: StadiumCtx): FieldPart {
  const group = new Group();
  group.name = 'field';

  const step = quality.fenceStepDeg;
  const wallAt = (b: number) => fenceAt(park, b).distFt;
  const maxFenceFt = park.fence.reduce((m, s) => Math.max(m, s.distFt), 0);
  const apronRadiusFt = maxFenceFt + APRON_MARGIN_FT;

  // ONE grain canvas for the whole ground, cloned per surface — see `grain.ts`.
  // `null` at the `low` tier and with no DOM, in which case every surface ships
  // its flat authored colour and nothing else about the scene changes.
  const grainTile = buildGrainTile(quality.grainPx);
  if (grainTile) track(grainTile);

  const mat = (color: number, side: Side = FrontSide) =>
    track(new MeshLambertMaterial({ color, side }));

  /**
   * A GRAINED ground surface: planar UVs at `tileFt`, its own clone of the one
   * grain tile, one Lambert material. The UV scale and the texture are set
   * together here so they cannot drift apart in two places.
   */
  const grained = (color: number, tileFt: number, vertexColors = false) => {
    const map = grainAt(grainTile, 1);
    if (map) track(map);
    return {
      tileFt,
      material: track(
        new MeshLambertMaterial({
          ...(vertexColors ? { vertexColors: true } : { color }),
          side: FrontSide,
          ...(map ? { map } : {}),
        }),
      ),
    };
  };

  const add = (
    geo: BufferGeometry,
    material: MeshLambertMaterial,
    name: string,
    tileFt?: number,
  ) => {
    const m = new Mesh(track(tileFt === undefined ? geo : planarUV(geo, tileFt)), material);
    m.name = name;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  // --- the apron: everything that is not fair territory, including foul ground.
  // A full disc rather than a cut-out, because the fair surfaces sit on top of
  // it; `foulTerritoryFt` is what pushes the SEATING back off it (see stands.ts).
  add(
    fan(
      [0, Y.apron, 0],
      ring(-180, 180, quality.bowlStepDeg, () => ({ r: apronRadiusFt, y: Y.apron })),
    ),
    // ⚠ THE ONE GROUND COLOUR THAT IS A LIGHTING ROW AND NOT A CONSTANT. It is
    // the only surface here OUTSIDE the bowl, so it is the only one the night
    // rig does not light — and an up-facing surface under an overhead rig it is
    // not standing in reads BRIGHTER at night than by day unless its
    // reflectance says otherwise. `daylightSpec.ts`'s `apronHex` has the
    // measurement; the day value is this file's own former `COLORS.apron`,
    // moved there verbatim.
    mat(daylight.apronHex),
    'apron',
  );

  // --- the turf, MOWN — fair AND foul.
  //
  // ⚠ FOUL GROUND IS TURF HERE, NOT CONCOURSE, and that was a real defect. The
  // apron disc is a concrete grey standing in for the concourse OUTSIDE the
  // bowl, and it was showing through everywhere inside the bowl that was not
  // fair territory — so in `wide` the whole wedge between the foul lines and
  // the stands read as a car park. Past the lines the turf therefore runs to
  // `bowlInnerRadiusFt`, which is the foot of the stands: the same offset curve
  // the bowl is built on, so the turf ends exactly where the seating starts and
  // the two cannot drift apart.
  const grassOuter = (b: number) =>
    Math.abs(b) <= FOUL_LINE_DEG
      ? Math.max(1, wallAt(b) - WARNING_TRACK_FT)
      : Math.max(1, bowlInnerRadiusFt(park, b));
  const grass = grained(0, GRAIN_TILE_FT.grass, true);
  add(mownGrass(grassOuter, maxFenceFt, step), grass.material, 'grass', grass.tileFt);

  // --- warning track: the band between the grass and the wall, same samples.
  const trackSurface = grained(COLORS.track, GRAIN_TILE_FT.track);
  add(
    loft(
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({ r: grassOuter(b), y: Y.track })),
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({ r: wallAt(b), y: Y.track })),
    ),
    trackSurface.material,
    'warningTrack',
    trackSurface.tileFt,
  );

  // --- the SKINNED INFIELD. Two pieces, merged into one draw call: the annulus
  // between the inner edge of the base paths and the 95 ft arc struck from the
  // rubber, and the circle around home plate. Everything between them is the
  // mown grass above, showing through — which is the whole point (see header).
  const dirtInner = ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({
    r: Math.max(HOME_CIRCLE_FT, diamondEdgeFt(b) - BASEPATH_INSET_FT),
    y: Y.dirt,
  }));
  const dirtOuter = ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({
    r: infieldDepthFt(b),
    y: Y.dirt,
  }));
  const homeCircle = fan(
    [0, Y.dirt, 0],
    // Past the foul lines too — the skinned circle at the plate is not fair/foul.
    ring(-100, 100, quality.bowlStepDeg, () => ({ r: HOME_CIRCLE_FT, y: Y.dirt })),
  );
  const skin = loft(dirtInner, dirtOuter);
  const dirtGeo = mergeGeometries([skin, homeCircle]);
  skin.dispose();
  homeCircle.dispose();
  const clay = grained(COLORS.dirt, GRAIN_TILE_FT.dirt);
  add(dirtGeo, clay.material, 'infieldDirt', clay.tileFt);

  // --- ALL THE CHALK, IN ONE GEOMETRY AND ONE DRAW CALL: two foul lines, two
  // batter's boxes and the catcher's box.
  //
  // ⚠ THE BOXES ARE NEW IN M3b AND THEY ARE THE REAL ANSWER TO "THE PLATE AREA
  // IS A FLAT BROWN LOT". The 13 ft skinned circle is ~26 % of the primary
  // batting frame and carried nothing at all — no chalk, no lines, one colour.
  // Camera work can shrink that band (and did, by a fifth); only marks on it can
  // make it read as the plate area rather than as an unfinished surface. They
  // cost NO draw call, because merging them with the two foul lines that were
  // already two separate meshes takes the chalk from 2 calls to 1.
  const stripe = (
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    w = FOUL_LINE_W_FT,
  ): BufferGeometry => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz) || 1;
    // In-plane perpendicular to (dx, dz) is (−dz, dx); half a width each way.
    const px = ((-dz / len) * w) / 2;
    const pz = ((dx / len) * w) / 2;
    return quad(
      [x0 + px, Y.chalk, z0 + pz],
      [x1 + px, Y.chalk, z1 + pz],
      [x1 - px, Y.chalk, z1 - pz],
      [x0 - px, Y.chalk, z0 - pz],
    );
  };
  /** The four sides of an axis-aligned rectangle, as outline stripes. */
  const outline = (xa: number, xb: number, za: number, zb: number): BufferGeometry[] => [
    stripe(xa, za, xb, za),
    stripe(xa, zb, xb, zb),
    stripe(xa, za, xa, zb),
    stripe(xb, za, xb, zb),
  ];
  const chalkParts: BufferGeometry[] = [];
  for (const sign of [-1, 1]) {
    const b = sign * FOUL_LINE_DEG;
    const len = wallAt(b);
    const u = at(b, 1, 0);
    chalkParts.push(stripe(0, 0, u[0] * len, u[2] * len));
    // The batter's box: 6 ft × 4 ft, inner edge 6 in off the plate, centred on
    // the plate's own front-to-back midpoint (which is `−PLATE_DEPTH_FT/2`,
    // NOT the rear point the WORLD origin sits on).
    const inner = sign * (PLATE_WIDTH_FT / 2 + BOX_GAP_FT);
    const zMid = -PLATE_DEPTH_FT / 2;
    chalkParts.push(
      ...outline(
        inner,
        inner + sign * BOX_WIDTH_FT,
        zMid - BOX_LEN_FT / 2,
        zMid + BOX_LEN_FT / 2,
      ),
    );
  }
  // The catcher's box: 43 in wide, 8 ft deep, running BACK from the rear line of
  // the batter's boxes. Three sides — its front edge is that shared rear line.
  const cbFront = -PLATE_DEPTH_FT / 2 + BOX_LEN_FT / 2;
  const cbHalf = CATCHER_BOX_W_FT / 2;
  chalkParts.push(
    stripe(-cbHalf, cbFront, -cbHalf, cbFront + CATCHER_BOX_LEN_FT),
    stripe(cbHalf, cbFront, cbHalf, cbFront + CATCHER_BOX_LEN_FT),
    stripe(-cbHalf, cbFront + CATCHER_BOX_LEN_FT, cbHalf, cbFront + CATCHER_BOX_LEN_FT),
  );
  const chalkGeo = mergeGeometries(chalkParts);
  for (const g of chalkParts) g.dispose();
  add(chalkGeo, mat(COLORS.chalk, DoubleSide), 'chalk');

  // --- home plate. Rear point at the WORLD origin (d = 0), 17 in across the
  // front edge, 8.5 in of parallel sides, 12 in converging edges — the rule-book
  // pentagon, laid out from `zone.ts`'s two published dimensions. `−d` is `+z`
  // toward the backstop, so the front edge (toward the mound) is at −PLATE_DEPTH.
  const hw = PLATE_WIDTH_FT / 2;
  const side = PLATE_DEPTH_FT - hw; // 17 in − 8.5 in of taper = the parallel run
  add(
    polygon(
      // Increasing bearing from the rear point, which is the winding `polygon`
      // needs for a +y normal (see geom.ts).
      [
        [0, 0],
        [-hw, -side],
        [-hw, -PLATE_DEPTH_FT],
        [hw, -PLATE_DEPTH_FT],
        [hw, -side],
      ],
      Y.plate,
    ),
    mat(COLORS.plate, DoubleSide),
    'homePlate',
  );

  scene.add(group);
  return { group, apronRadiusFt, maxFenceFt };
}
