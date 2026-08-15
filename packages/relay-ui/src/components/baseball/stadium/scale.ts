// The SCALE REFERENCE — a 6 ft box at the plate.
//
// ⚠ THIS IS A MEASURING STICK, NOT SET DRESSING, and it is deliberately the
// least pretty object in the scene. The visual gate's first job in M1 is that
// the stadium is at the right SCALE: a 400 ft fence and a 282 ft roof are
// numbers nobody can eyeball, but "is that box about a third the height of the
// outfield wall?" is a question a human answers in one glance from a PNG. It is
// 1.83 m = 6.00 ft, the figure height the M1 brief names, converted here through
// `bat.ts`'s exact `M_PER_FT` rather than typed as a decimal — the bat model is
// the other place in this game that crosses the SI boundary, and there is one
// international foot in this repo, not two.
//
// It is drawn in every camera mode rather than only in `wide` and `batter`,
// because a reference that is present in some shots and not others is a
// reference somebody will forget to check. Delete it the milestone a real
// batter model lands — not before, and see rule 10 about deleting on supersede.

import { BoxGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import { M_PER_FT } from '../../../lib/baseball/bat';
import type { StadiumCtx, StadiumPart } from './geom';

/** Reference height, m. The brief's figure: 1.83 m. Converted, never retyped. */
const FIGURE_M = 1.83;

/** Shoulder width and depth, ft. SCENE-ONLY — only the HEIGHT is the reference. */
const FIGURE_W_FT = 1.5;
const FIGURE_D_FT = 0.9;

/**
 * Where it stands: in the left-handed batter's box, 2.5 ft off the plate on the
 * first-base side and half a foot in front of the rear point. Off the plate so
 * it never occludes it in the `pitcher` view, and on the same side both parks
 * so a park-to-park comparison is not confused by the marker moving.
 */
const STANCE_X_FT = 3.2;
const STANCE_Z_FT = -0.5;

/** Magenta: no natural surface in a ballpark is this colour. That is the point. */
const COLOR = 0xff2ea6;

export function buildScaleReference({ scene, track }: StadiumCtx): StadiumPart {
  const group = new Group();
  group.name = 'scaleReference';

  const h = FIGURE_M / M_PER_FT;
  const mesh = new Mesh(
    track(new BoxGeometry(FIGURE_W_FT, h, FIGURE_D_FT)),
    track(new MeshLambertMaterial({ color: COLOR })),
  );
  mesh.name = 'sixFootReference';
  mesh.position.set(STANCE_X_FT, h / 2, STANCE_Z_FT);
  mesh.castShadow = true;
  group.add(mesh);

  scene.add(group);
  return { group };
}
