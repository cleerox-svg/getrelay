// The playing surface: foul apron, fair grass, warning track, infield dirt, the
// foul lines out to the poles, and home plate.
//
// ⚠ EVERY RADIUS IN HERE COMES FROM DATA. The grass and the warning track are
// cut to `fenceAt(park, β)` sampled degree by degree, so the turf ends exactly
// where the wall the sim resolves against stands. The infield dirt is
// `INFIELD_DEPTH_FT` — `fielding.ts`'s constant, not a second copy of it. Home
// plate is `PLATE_WIDTH_FT` / `PLATE_DEPTH_FT` from `zone.ts`. The foul lines
// are `FOUL_LINE_DEG`.
//
// ⚠ AND ONE OF THEM IS DELIBERATELY DRAWN WRONG-LOOKING. `INFIELD_DEPTH_FT` is
// `RUBBER_D_FT + 95` used as a PLATE-centred circle, which BASEBALL.md flags as
// over-stating the dirt by up to 27.9 ft down the lines — the published 95 ft
// arc is struck from the RUBBER. The renderer draws the circle the FIELDING CODE
// ACTUALLY USES rather than a prettier one, because the whole point of one
// `parks.ts`/`fielding.ts` read by physics and geometry is that a wrong shared
// number becomes visible instead of staying an internal detail. When that
// constant is fixed, this drawing changes with it and no edit here is needed.

import { DoubleSide, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry, Side } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import { INFIELD_DEPTH_FT } from '../../../lib/baseball/fielding';
import { PLATE_DEPTH_FT, PLATE_WIDTH_FT } from '../../../lib/baseball/zone';
import { at, fan, loft, polygon, quad, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';

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

/** Flat grey-box colours. M1 is deliberately untextured — see BASEBALL.md M1. */
const COLORS = {
  apron: 0x6b6b66, // foul ground / concourse
  grass: 0x3d7a3d,
  track: 0xa87b4d,
  dirt: 0x9a6a44,
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

export function buildField({ scene, track, park, quality }: StadiumCtx): FieldPart {
  const group = new Group();
  group.name = 'field';

  const step = quality.fenceStepDeg;
  const wallAt = (b: number) => fenceAt(park, b).distFt;
  const maxFenceFt = park.fence.reduce((m, s) => Math.max(m, s.distFt), 0);
  const apronRadiusFt = maxFenceFt + APRON_MARGIN_FT;

  const mat = (color: number, side: Side = FrontSide) =>
    track(new MeshLambertMaterial({ color, side }));

  const add = (geo: BufferGeometry, material: MeshLambertMaterial, name: string) => {
    const m = new Mesh(track(geo), material);
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
    mat(COLORS.apron),
    'apron',
  );

  // --- fair grass, cut to the wall less the warning track.
  add(
    fan(
      [0, Y.grass, 0],
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({
        r: Math.max(1, wallAt(b) - WARNING_TRACK_FT),
        y: Y.grass,
      })),
    ),
    mat(COLORS.grass),
    'grass',
  );

  // --- warning track: the band between the grass and the wall, same samples.
  add(
    loft(
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({
        r: Math.max(1, wallAt(b) - WARNING_TRACK_FT),
        y: Y.track,
      })),
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({ r: wallAt(b), y: Y.track })),
    ),
    mat(COLORS.track),
    'warningTrack',
  );

  // --- infield dirt. See the header: this is `fielding.ts`'s plate-centred
  // circle, flagged approximate there and drawn approximate here.
  add(
    fan(
      [0, Y.dirt, 0],
      ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, quality.bowlStepDeg, () => ({
        r: INFIELD_DEPTH_FT,
        y: Y.dirt,
      })),
    ),
    mat(COLORS.dirt),
    'infieldDirt',
  );

  // --- foul lines, plate to pole, one quad each.
  const chalk = mat(COLORS.chalk, DoubleSide);
  for (const sign of [-1, 1]) {
    const b = sign * FOUL_LINE_DEG;
    const len = wallAt(b);
    const u = at(b, 1, 0);
    // In-plane perpendicular to (ux, uz) is (−uz, ux); half a line width each way.
    const px = (-u[2] * FOUL_LINE_W_FT) / 2;
    const pz = (u[0] * FOUL_LINE_W_FT) / 2;
    add(
      quad(
        [px, Y.chalk, pz],
        [u[0] * len + px, Y.chalk, u[2] * len + pz],
        [u[0] * len - px, Y.chalk, u[2] * len - pz],
        [-px, Y.chalk, -pz],
      ),
      chalk,
      `foulLine${sign < 0 ? 'LF' : 'RF'}`,
    );
  }

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
