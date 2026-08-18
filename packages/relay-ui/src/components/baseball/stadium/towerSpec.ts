// WHERE THE LANDMARK STANDS AND WHAT SHAPE IT IS — data, and the argument for
// every number in it.
//
// ⚠ IT IS A SEPARATE FILE FOR THE REASON `centrefieldSpec.ts` IS ONE: the
// 500-line builder cap, and a seam that was already there. `tower.ts` is
// GEOMETRY and LIGHTING — shells, strips, a chase texture, an animation — and it
// hit the cap the moment this file's placement argument acquired its third
// measured table. At a cap the charter's answer is EXTRACTION, never a raised
// cap. Data on one side, geometry on the other; the same split `parks.ts` makes
// for the fence.
//
// ⚠ AND THE SEAM IS LOAD-BEARING RATHER THAN COSMETIC. Three modules want these
// numbers and none of them wants a shell: `skyline.ts` merges the tower's
// concrete into the city at this anchor, `tower.ts` builds the shells and the
// LED strips against this profile, and `camera.test.ts` asserts the `flight`
// frame's COMPOSITION against this silhouette. A test that typed the tower's
// coordinates instead would pass forever after somebody moved the landmark,
// which is exactly the failure the framing assertion exists to prevent.
//
// ⚠ ARCHITECTURE IS NOT A MARK. A tapered concrete communications tower with an
// observation pod near the top is a building TYPOLOGY; no name appears anywhere,
// and every vertex is generated from the profile below. `ip.test.ts` scans this
// file like every other.

import { DEG } from './geom';

/**
 * Bearing of the tower, deg, in the park's own frame. SCENE-ONLY.
 *
 * ⚠⚠ **+12, NOT −12 — AN OWNER CORRECTION, AND THE SIGN IS THE WHOLE CONTENT.**
 * This shipped at −12° with a comment claiming that was "where it sits in the
 * reference photography". It is not. The owner is a fan of the club, has been to
 * the venue, and looked at `night-homerun.png`: *"The CN tower is on the right
 * side not the left."* Their reference photographs agree — from the stands at
 * night and from field level at dusk, the tower stands to the **RIGHT** of the
 * centre-field structure with the dome roof sweeping away to the left. Scene +x
 * is the first-base side, which is the right-hand side of any frame shot toward
 * centre field (`geom.ts`), so right of the board is a POSITIVE bearing.
 *
 * ⚠ NOTHING BUT THIS NUMBER MOVED, AND THAT IS THE POINT OF IT BEING DATA. No
 * geometry is mirrored, no profile is edited, no camera is re-aimed.
 *
 * ⚠ AND THE MAGNITUDE HAD TO MOVE WITH THE SIGN — 14°, NOT 12°, AND A RENDER IS
 * WHAT SAID SO. The `flight` camera stands at x = −40 and is therefore NOT
 * symmetric about dead centre, so mirroring a bearing does not mirror what the
 * camera sees. Measured from that camera (horizontal half-FOV 16.3°, frame top
 * 20.2° of elevation):
 *
 *     bearing  dist    off-axis            mast tip
 *      −12°   1500 ft   9.9°  (61 % out)    —          ← what shipped, on the LEFT
 *      +12°   1500 ft  12.7°  (78 % out)   22.8°       ← mirrored: CROPPED
 *      +14°   1900 ft  14.5°  (89 % out)   18.5°       ← ships
 *
 * The +12° row is the trap: 12.73° is **exactly** the angle of the centre-field
 * structure's own right edge from that camera, so the mirrored tower emerged
 * from behind the building rather than standing beside it — and its mast ran
 * 2.6° off the top of the frame. Pushing it to 14° and 1900 ft clears the
 * building by 1.8° and the frame's top by 1.7°. Distance is the lever for the
 * VERTICAL crop and bearing for the horizontal, and they are nearly independent:
 * moving a landmark further away does not move it sideways.
 *
 * ⚠⚠ **CLOSED — AND THE CAMERA MOVED, NOT THE TOWER.** The escalation said: at
 * 14° the landmark sat at **89 % of the `flight` frame's half-width**, hard
 * against the right edge with its pod cropped, and the usable window on that
 * side was only 12.73° (the building's own edge) to 16.3° (the frame's) —
 * because `CAMERAS.flight` stood at **x = −40**, chosen to favour the PULL
 * corner back when the landmark was on the left. The owner took the decision;
 * `camera.ts`'s `flight` row carries the whole derivation and the trade it
 * costs. What it did:
 *
 *   • the stand moved to x = −12, which drops the structure's own right edge
 *     from 12.6° to 9.5° and so widens this bearing's usable window from 3.7°
 *     to 6.8°;
 *   • the static `look` was decoupled from the stand and yawed 5.55° toward
 *     this side, which is what actually re-composes the frame.
 *
 * Result, measured in that frame: the tower's axis sits at **50 % of the
 * half-width** (u 0.953 → 0.750), both pod edges are inside it (u 0.712…0.795,
 * where they used to run off the right at 1.004), the mast tip clears the top
 * at v 0.031, and there are 0.09 frame widths of open sky between the
 * building's right edge and the tower's left flank.
 *
 * **`TOWER_BEARING_DEG` DID NOT MOVE, AND THAT IS THE POINT.** The owner
 * corrected this number off their own photographs; it is data. A camera framing
 * problem is fixed by the camera, and the widened window means the data no
 * longer has to be bent to fit a lens.
 */
export const TOWER_BEARING_DEG = 14;

/**
 * How far out the tower stands, ft. SCENE-ONLY.
 *
 * ⚠ PUSHED OUT TWICE, AND BOTH TIMES FOR A CROP RATHER THAN A LOOK. 1150 → 1500
 * because the visual gate measured the observation pod CLIPPED AT y = 0 in
 * `homerun`: the follow camera tips up to hold a ball near its apex, and a
 * 790 ft tower 1150 ft out subtends 34.5° of elevation against a 55° frame.
 * 1500 → 1900 when the tower moved to the RIGHT of the board, because the
 * `flight` camera's asymmetry put the mast 2.6° off the top of the frame on that
 * side — see `TOWER_BEARING_DEG` for the measured table.
 *
 * It is the honest fix as well as the cheap one: a downtown landmark reads as a
 * landmark by being FAR, and shortening the tower to fit a frustum would have
 * been fitting the world to the camera. 1900 ft is well inside the 6000 ft far
 * plane and outside the 3000 ft sky dome's near side.
 */
export const TOWER_DIST_FT = 1900;

/** Sides on the tower's shell. 12 reads round at this distance and costs 24 tris a band. */
export const TOWER_SIDES = 12;

/**
 * The tower's silhouette, as DATA: half-width against height, ft. Original
 * geometry from a silhouette — a tapered shaft, an observation pod two thirds of
 * the way up, a short upper shaft and a mast. SCENE-ONLY, every row.
 */
export const TOWER_PROFILE: Array<{ y: number; r: number }> = [
  { y: 0, r: 52 },
  { y: 120, r: 34 },
  { y: 340, r: 24 },
  { y: 560, r: 19 },
  { y: 596, r: 19 },
  { y: 604, r: 44 }, // pod, underside
  { y: 628, r: 47 },
  { y: 652, r: 44 },
  { y: 660, r: 22 }, // pod, top
  { y: 700, r: 17 },
  { y: 706, r: 6 }, // mast
  { y: 790, r: 3 },
];


/**
 * Where the tower stands and how big it is, scene ft. Read by the city so both
 * agree, and by `camera.test.ts` so the FRAMING claim in `camera.ts`'s `flight`
 * row is asserted against the tower's own numbers rather than against a copy of
 * them typed into a test — the "one implementation per concept" rule applied to
 * a dimension that two files care about.
 *
 * `topFt` and `halfWidthFt` are read off `TOWER_PROFILE` rather than typed, so a
 * re-profiled tower moves the assertion with it.
 */
export function towerAnchor(): {
  tx: number;
  tz: number;
  topFt: number;
  halfWidthFt: number;
} {
  const b = TOWER_BEARING_DEG * DEG;
  return {
    tx: Math.sin(b) * TOWER_DIST_FT,
    tz: -Math.cos(b) * TOWER_DIST_FT,
    topFt: Math.max(...TOWER_PROFILE.map((p) => p.y)),
    halfWidthFt: Math.max(...TOWER_PROFILE.map((p) => p.r)),
  };
}

