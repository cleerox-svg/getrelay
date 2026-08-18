// The pitcher's mound and the rubber.
//
// ⚠ THE ONE DIMENSION THAT IS SHARED WITH THE SIM IS `RUBBER_D_FT`, imported
// from `zone.ts`. Everything else here is rule-book geometry that no physics in
// this game reads — the mound has no effect on a trajectory in the model (the
// release point is `releasePoint()`'s published Statcast average, which already
// contains the mound), so these numbers live at the point of use rather than
// bloating `tuning.ts` with render-only constants. Each is labelled with where
// it came from, which is the rule the charter actually states.
//
// If a later milestone gives the mound a physical role — a release height
// derived from mound height rather than measured — these move to `tuning.ts` and
// this file imports them. Until then, one home, and it is here.

import { Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { RUBBER_D_FT } from '../../../lib/baseball/zone';
import { at, fan, loft, planarUV, polygon, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import { buildGrainTile, grainAt } from './grain';

/** Mound circle radius, ft. PUBLISHED (rule book: an 18 ft diameter circle). */
const MOUND_RADIUS_FT = 9;

/** Mound height above home-plate level, ft. PUBLISHED (rule book: 10 in). */
const MOUND_HEIGHT_FT = 10 / 12;

/**
 * Distance from the rubber's front edge back to the mound circle's centre, ft.
 * DERIVED from two published figures: the circle is centred 59 ft from the rear
 * point of home plate and the rubber's front edge is at 60 ft 6 in, so the
 * offset is 18 in and the centre lands at `RUBBER_D_FT − 1.5` for any park.
 */
const MOUND_CENTRE_OFFSET_FT = 1.5;

/** Flat table radius on top of the mound, ft. PUBLISHED-ish: the rule book's
 * table is 5 ft × 34 in, drawn here as the inscribed 3 ft circle. */
const MOUND_TABLE_RADIUS_FT = 3;

/** Rubber, ft. PUBLISHED (rule book: 24 in × 6 in). */
const RUBBER_W_FT = 2;
const RUBBER_D_DEPTH_FT = 0.5;

// A shade off `field.ts`'s infield dirt ON PURPOSE. A 10 in rise on a flat brown
// disc is invisible from the batter camera in a flat-shaded grey box, and "the
// mound is at 60.5 ft" is a dimension the visual gate has to be able to check.
const COLORS = { dirt: 0xb07f56, rubber: 0xffffff };

/**
 * How far the mound's slope is broken up, ft per grain tile. SCENE-ONLY.
 *
 * ⚠ THE MOUND READ AS A FLAT BROWN LENS AND THE GEOMETRY WAS NEVER THE PROBLEM.
 * The visual gate measured the drawn circle correct to 4 px and still called it
 * a lens: a shallow cone (10 in over 9 ft, i.e. a 5.3° slope) lit by one
 * near-axial sun has almost no Lambert term to separate its faces with, so
 * relief has to come from the surface rather than from the light. The tile is
 * FINER than the infield clay's because the mound is the one piece of dirt the
 * `batter` camera reads at 40 ft through a 20° lens.
 */
const MOUND_GRAIN_TILE_FT = 3;

export function buildMound({ scene, track, quality }: StadiumCtx): StadiumPart {
  const group = new Group();
  group.name = 'mound';

  const centreD = RUBBER_D_FT - MOUND_CENTRE_OFFSET_FT;
  const centre = at(0, centreD, 0);
  // ⚠ ITS OWN TILE, NOT `field.ts`'s, AND THAT IS THE ONE PLACE THE "BUILD ONCE"
  // RULE IS DELIBERATELY BROKEN. Builders are `(ctx) => handle` and are not
  // handed each other's resources, so sharing one canvas would mean threading it
  // through `StadiumCtx` — i.e. giving every builder a channel to reach into
  // every other. The cost of not doing that is ONE extra canvas of the same
  // size, which is the cheaper mistake; golf's was six of them per mount.
  const grain = grainAt(buildGrainTile(quality.grainPx), 1);
  if (grain) track(grain);
  const dirt = track(
    new MeshLambertMaterial({ color: COLORS.dirt, ...(grain ? { map: grain } : {}) }),
  );

  const add = (geo: BufferGeometry, mat: MeshLambertMaterial, name: string) => {
    const m = new Mesh(track(planarUV(geo, MOUND_GRAIN_TILE_FT)), mat);
    m.name = name;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
  };

  // The mound is built about its own centre and then translated, so the two
  // rings below are plate-centred rings of the right radii — the same `ring`
  // helper the wall uses, at 9 ft instead of 400.
  const step = Math.max(2, quality.bowlStepDeg);
  const table = ring(-180, 180, step, () => ({
    r: MOUND_TABLE_RADIUS_FT,
    y: MOUND_HEIGHT_FT,
  }));
  const skirt = ring(-180, 180, step, () => ({ r: MOUND_RADIUS_FT, y: 0 }));

  add(fan([0, MOUND_HEIGHT_FT, 0], table), dirt, 'moundTable');
  add(loft(table, skirt), dirt, 'moundSkirt');

  // The rubber: a flat plate on the table, front edge exactly at RUBBER_D_FT.
  // Local z is measured from the mound centre, so the front edge sits at
  // −(RUBBER_D_FT − centreD) and the back edge half a foot further out.
  const front = -(RUBBER_D_FT - centreD);
  const backEdge = front - RUBBER_D_DEPTH_FT;
  const hw = RUBBER_W_FT / 2;
  add(
    polygon(
      // Vertices run in INCREASING bearing about the origin — the order
      // `polygon`'s winding needs for a +y normal (see geom.ts).
      [
        [-hw, backEdge],
        [hw, backEdge],
        [hw, front],
        [-hw, front],
      ],
      MOUND_HEIGHT_FT + 0.02,
    ),
    track(new MeshLambertMaterial({ color: COLORS.rubber })),
    'rubber',
  );

  group.position.set(centre[0], centre[1], centre[2]);
  scene.add(group);
  return { group };
}
