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
// ⚠ IT IS OPT-IN, AND ONLY THE PREVIEW OPTS IN. `StadiumGL`'s `scaleReference`
// prop defaults to FALSE and `baseballpreview.tsx` passes it true. This file used
// to be called unconditionally, on the strength of a comment promising to delete
// it "the milestone a real batter model lands" — which costs nothing while
// nothing imports `StadiumGL`, and ships a magenta slab in the batter's box the
// first day a HUD mounts the scene. A prop now is cheaper than a bug report at
// M2, and the delete-on-supersede note below still stands.
//
// ⚠ IT IS BUILT IN EVERY CAMERA MODE IT IS ENABLED FOR, AND IT IS ONLY LEGIBLE
// IN TWO OF THEM. This file
// used to claim the first half and imply the second, on the reasoning that "a
// reference present in some shots and not others is a reference somebody will
// forget to check". The M1 visual gate measured it and the reasoning does not
// survive arithmetic:
//
//   pitcher  — legible. 55 ft away, ~6° of a 26° frame. THE reference shot.
//   batter   — legible. ~20 ft away and large; its BASE used to sit 19.1° below
//              the camera axis against a 20° half-frame, i.e. 0.9° from being
//              cropped, so the one thing a height reference must show — where it
//              meets the ground — was a rounding error away from leaving. It now
//              stands at the front of the batter's box instead of the middle,
//              which is 2.5 ft further from the camera and buys ~5° of margin.
//   flight   — off-frame. The camera is 120 ft up at z = +90 looking out to
//              z = −380; the plate is behind and below it.
//   wide     — present, ~1 px. The camera is 1000 ft up. A 6 ft object is 1 px
//              from there and no PLACEMENT changes that; only a bigger object
//              would, and a bigger object is not a 6 ft reference.
//
// So the honest statement is: `pitcher` is the scale shot and `batter` is the
// cross-check, and a scale claim about `wide` or `flight` has to be made by
// measuring drawn geometry (`StadiumApi.measureFence`) rather than by eye. The
// box stays in all four because building it per-mode would be a branch in a
// builder for no gain, not because it can be read in all four.
//
// Delete it the milestone a real batter model lands — not before, and see rule
// 10 about deleting on supersede.

import { BoxGeometry, Group, Mesh, MeshLambertMaterial } from 'three';
import { M_PER_FT } from '../../../lib/baseball/bat';
import type { StadiumCtx, StadiumPart } from './geom';

/** Reference height, m. The brief's figure: 1.83 m. Converted, never retyped. */
const FIGURE_M = 1.83;

/** Shoulder width and depth, ft. SCENE-ONLY — only the HEIGHT is the reference. */
const FIGURE_W_FT = 1.5;
const FIGURE_D_FT = 0.9;

/**
 * Where it stands: in the left-handed batter's box, on the first-base side. Off
 * the plate so it never occludes it in the `pitcher` view, and on the same side
 * in both parks so a park-to-park comparison is not confused by the marker
 * moving.
 *
 * `−z` is toward the mound, so this is the FRONT of the box rather than its
 * middle — the box is 6 ft long about the plate's centre, so 3 ft ahead of the
 * rear point is still inside it, and it is what keeps the marker's BASE inside
 * the `batter` frame. See the header: at −0.5 ft the base sat 0.9° from being
 * cropped, and a height reference whose contact with the ground is off-frame is
 * not a height reference.
 */
const STANCE_X_FT = 3.2;
const STANCE_Z_FT = -3;

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
