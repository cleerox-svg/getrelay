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
// ⚠ IT IS BUILT IN EVERY CAMERA MODE IT IS ENABLED FOR, AND IT IS LEGIBLE IN
// EXACTLY ONE. Measured against the SHIPPING cameras at the harness's 900×1600
// portrait frame, marker centred on (3.2, 3.0, −3):
//
//   pitcher  — legible, and it is now the ONLY photographic scale check.
//              52.1 ft of depth, 26° vertical frame, the box spanning 36.6 %
//              → 61.5 % of frame height (6.6° of it) at 26.3 % of frame width.
//   batter   — OFF-FRAME, horizontally, since M2c re-framed this camera. At
//              [0, 3.2, 8] → [0, 2.52, −30] the marker sits 11.0 ft deep, and a
//              40° VERTICAL fov on a 0.5625 frame is only 11.57° horizontally,
//              which admits |x| ≤ 2.25 ft at that depth. The marker's centre
//              projects to **121 % of frame width** and even its inner face to
//              104 %. Not marginal — outside. (The OLD [0, 8.5, 20] rig put it
//              at 83.6 %, which is where this file's "buys ~5° of margin" claim
//              came from; that claim was about the BASE's vertical crop, is
//              still true — 15.2° below the axis against a 20° half-frame — and
//              is now irrelevant, because the whole object left sideways.)
//   flight   — off-frame. The camera is 120 ft up at z = +90 looking out to
//              z = −380; the plate is behind and below it.
//   wide     — present, ~1 px. The camera is 1000 ft up. A 6 ft object is 1 px
//              from there and no PLACEMENT changes that; only a bigger object
//              would, and a bigger object is not a 6 ft reference.
//
// ⚠ AND THE MARKER IS NOT MOVING TO CHASE THE CAMERA. Fitting the WHOLE box
// inside the `batter` frame needs |x| ≤ 1.50 ft, at which point its inner face
// projects to 66.6 % of frame width while the rule zone spans 24.7 % → 75.3 %:
// a 6 ft magenta slab straight across the zone frame and the reticle, i.e. the
// subject that camera was re-framed to hold. Pulling it inboard also drags it
// toward the plate in `pitcher`, which is the shot that still works. A 6 ft
// reference is worth less than the zone it would cover.
//
// So the gate lost one of its two scale shots and got a different second one
// instead: `shoot-baseball.mjs` shoots `pitcher` at BOTH parks. That exercises
// the park axis the old `batter`/`pitcher` pair never did, costs one line and
// no geometry, and a scale claim about `wide`, `flight` or `batter` is made by
// measuring drawn geometry (`StadiumApi.measureFence`) rather than by eye.
//
// ⚠ AND WHAT THAT PAIR ACTUALLY SHOWS IS THE ROOF AND THE FOUL DISTANCE, NOT
// THE FENCE. This camera stands on the mound looking IN at the plate, so the
// outfield wall is 290–360 ft BEHIND it and cannot appear in either frame. The
// park difference the two PNGs carry is `roof` (282 ft retractable vs none) and
// `foulTerritoryFt` (28 vs 22, which moves the backstop and the stand foot).
// Measured: 9.63 % of pixels differ, in the roof/sky rows plus two thin bands.
// It is a park-scoped STRUCTURE check against a fixed 6 ft reference; calling it
// a wall check would be a claim no pixel in it supports.
//
// The box stays in all four modes because building it per-mode would be a
// branch in a builder for no gain, not because it can be read in all four.
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
 * the plate so it never occludes it in the `pitcher` view — which is now the
 * ONLY view it is read in — and on the same side in both parks, so the
 * park-to-park pair the harness shoots is not confused by the marker moving.
 *
 * `−z` is toward the mound, so this is the FRONT of the box rather than its
 * middle; the box is 6 ft long about the plate's centre, so 3 ft ahead of the
 * rear point is still inside it.
 *
 * ⚠ THE `batter`-FRAME JUSTIFICATION THESE TWO NUMBERS USED TO CARRY IS DEAD,
 * and it is left recorded rather than deleted so nobody re-derives it. `−3` was
 * chosen against the OLD [0, 8.5, 20] camera to keep the marker's BASE off the
 * bottom crop (0.9° of margin at −0.5 ft, ~5° at −3). Against the shipping
 * camera the marker is 121 % of frame width out to the side, so no `z` rescues
 * it and no `x` that does is worth what it covers. See the header. What these
 * two numbers are justified by TODAY is `pitcher`: 3.2 ft off the plate is
 * 26.3 % of frame width, clear of the zone and clear of the mound line.
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
