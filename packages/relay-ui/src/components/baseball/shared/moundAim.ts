// THE MOUND'S AIM MATH: a POINT ON THE PANEL → an INTENDED PLATE LOCATION.
//
// Pure. No React, no DOM, no `three`, no state, no clock — which is what lets
// the mapping be asserted directly instead of only through a mounted HUD with a
// synthesised pointer.
//
// ⚠ IT IS ABSOLUTE PLACEMENT NOW, NOT A SLINGSHOT, AND THAT IS A BUG FIX.
// The slingshot (`aimFromPull`, deleted) mapped a PULL DELTA from wherever the
// finger went down. Its own header carried the consequence — a release with no
// pull was still a release, and it aimed dead centre — so the owner, who tapped
// the way every shipping mobile baseball game trains you to, threw middle-middle
// every single pitch and reported that the aim step "doesn't seem to do high low
// or anything". A gesture whose zero-effort default is the most hittable pitch
// in baseball is the wrong grammar, not a wrong number. So: a point in the drawn
// zone panel IS the intent, there is no origin to pull from, and every gesture
// that reaches this function carries a real location.
//
// ⚠ ONE MAPPING, TWO GESTURES. `MoundControl` samples this function on a tap or
// continuously through a drag (`prefs.MoundGesture`, an A/B that is scheduled
// for deletion — see there). Both call `aimAtPoint` with the same arguments and
// mean the same thing by them; the sampling is the entire difference. A second
// mapping per gesture is how the two arms of an experiment stop being comparable.
//
// ⚠ THIS IS BASEBALL'S OWN AIM MATH, AND NOT GOLF'S `pullAim`, BY DECISION.
// `CourseSim`'s private `pullAim` maps a 2-D drag onto a single AIM ANGLE for a
// ball struck from rest toward a target on a plane; it returns a scalar bearing.
// Pitching maps a gesture onto a POINT IN A RECTANGLE — the plate window 60.5 ft
// away — and its two axes have different physical meanings and different pixel
// extents (`ZONE_HALF_W_PX` and `ZONE_HALF_H_PX` differ by 27 % because the zone
// is not square). One returns a bearing, the other a location. Sharing them
// would force a lowest-common-denominator abstraction that serves neither and
// would drag golf — mid-audit — into a baseball slice for no gain.
//
// ⚠ AND THE SIM TAKES NUMBERS, NOT GESTURES. Nothing about a pointer reaches
// `lib/baseball`: this file ends at `reticleToPlate`, and `duelRules.pitchLocation`
// takes the intended location plus the accuracy sweep's stop error from there.
// That is what lets `duelSim.test.ts` play a hundred games without a DOM.

import { PLATE_WIDTH_FT, ZONE_BOTTOM_FT, ZONE_TOP_FT, reticleToPlate } from '../../../lib/baseball/zone';

/**
 * Feet of plate per CSS pixel of panel. The ONE scale knob in this file.
 *
 * ⚠ FEEL KNOB, labelled, and DELIBERATELY THE SAME SCALE AS THE BATTER'S.
 * `ZoneReticle`'s `AIM_FT_PER_PX` is 0.010 ft/px, so a foot of plate is the same
 * hand movement whichever end of the battery the player is at — which matters
 * because the same thumb switches between them every half-inning. At 0.010 the
 * drawn zone is 141.7 × 180 px: about a thumb's comfortable reach on a phone,
 * and big enough that the four corners are four distinct targets rather than one
 * fat one.
 *
 * ⚠ AND IT IS THE PANEL'S SCALE, NOT THE SCENE'S. The panel is drawn by this
 * HUD at this scale, so the pixel→plate map cannot disagree with what is on
 * screen. `ZoneReticle`'s header rejects absolute mapping for the BATTER for
 * exactly the reason that does not apply here: it would have had to claim a
 * screen rectangle for the zone's 3-D projection, which moves with the camera,
 * the aspect and the FOV. Nothing below claims anything about the projection.
 */
export const AIM_FT_PER_PX = 0.01;

/** Half the drawn zone's width, px. DERIVED from `zone.ts`: 70.83. */
export const ZONE_HALF_W_PX = PLATE_WIDTH_FT / 2 / AIM_FT_PER_PX;

/** Half the drawn zone's height, px. DERIVED from `zone.ts`: 90. */
export const ZONE_HALF_H_PX = (ZONE_TOP_FT - ZONE_BOTTOM_FT) / 2 / AIM_FT_PER_PX;

/**
 * How far outside the zone the control lets a pitcher aim, in half-zones.
 *
 * ⚠ FEEL KNOB — it is the REACH, and it is the slingshot's reach KEPT. A pitcher
 * aims off the plate on purpose, so this is not clamped to the zone: 1.6
 * half-zones is 1.133 ft of lateral intent (5.1 in outside the called corner)
 * and 1.44 ft of vertical. Aiming further than that is not a pitch, it is a wild
 * throw, and `duelRules.pitchLocation` then adds the command miss on top of
 * wherever this lands.
 */
export const AIM_REACH_UV = 1.6;

/** Movement quantum, CSS px — the quantised input gate. See `aimMoved`. */
export const AIM_QUANT_PX = 2;

/**
 * Panel-x → plate-x sign. **DERIVED, −1**, from the camera this control sits on.
 *
 * ⚠ THE PANEL IS THE PITCHER'S VIEW, SO IT IS MIRRORED AGAINST `zone.ts`'s
 * convention, and this is the one line in the file that a type cannot check.
 * `zone.ts` fixes REPORT +x as the umpire's right (the first-base side), which
 * is screen-right under the `batter` camera — that camera sits at z = +19.5
 * looking to z = −30, so its right-hand basis vector is cross(up, eye−target)
 * = +x, and `ZoneReticle` maps screen-right to +x accordingly.
 *
 * `CAMERA_POSES.pitcher` sits at z = −55 looking back at the plate at z = 0. The
 * same cross product runs the other way — cross((0,1,0), (0, +0.06, −1)) = −x —
 * so under the camera this control is drawn over, screen-right is REPORT −x, the
 * THIRD-BASE side, which is inside to the duel's right-handed batter. Tap the
 * right of the panel and the ring at the plate must move right on screen; the
 * two would disagree without this sign, and the disagreement would look exactly
 * like the aim being ignored, which is the complaint this slice is fixing.
 *
 * (The constant is not imported from `stadium/camera.ts` because that module
 * imports `three`, and a HUD file that imports it drags the 560 kB renderer into
 * the Games hub chunk — `budget.test.ts` scans `shared/*` for precisely that.)
 */
export const VIEW_MIRROR = -1;

export interface MoundAim {
  /** Normalised zone coordinates, +u right / +v up, |(u,v)| ≤ AIM_REACH_UV. */
  u: number;
  v: number;
  /** The same point in REPORT ft — what `PitchCommand.intentX/intentH` take. */
  x: number;
  h: number;
}

/**
 * A point on the panel, in px from its CENTRE (+dx right, +dy DOWN) → the aim.
 *
 * ⚠ ONE SIGN PER AXIS, AND NEITHER IS A SLINGSHOT INVERSION. Laterally the flip
 * is the camera's (`VIEW_MIRROR`, argued above). Vertically it is the screen's
 * alone — screen +y is DOWN and height is UP — so tapping the top of the panel
 * aims HIGH. Written out because "one of these signs is a double negative" is
 * precisely the kind of thing that gets silently fixed in the wrong place later.
 *
 * ⚠ THE CLAMP IS RADIAL, AROUND THE ZONE'S CENTRE, NOT PER AXIS. A per-axis
 * clamp would let a diagonal aim reach 1.41× the reach of a straight one — the
 * corners of a square being further from its centre than its edges — so aiming
 * at a corner would be strictly more powerful than aiming at an edge. Clamping
 * the radius keeps the reachable set an ELLIPSE ON SCREEN (a DISC in the
 * normalised (u, v) the sim thinks in) and makes every direction cost the same.
 * It is the slingshot's rule with the origin moved from the finger to the zone.
 */
export function aimAtPoint(dxPx: number, dyPx: number): MoundAim {
  const uRaw = (VIEW_MIRROR * dxPx) / ZONE_HALF_W_PX;
  const vRaw = -dyPx / ZONE_HALF_H_PX;
  const r = Math.hypot(uRaw, vRaw);
  const k = r > AIM_REACH_UV ? AIM_REACH_UV / r : 1;
  const u = uRaw * k;
  const v = vRaw * k;
  const { x, h } = reticleToPlate(u, v);
  return { u, v, x, h };
}

/**
 * The EXACT INVERSE of `aimAtPoint`, for the marker the panel draws.
 *
 * ⚠ IT EXISTS SO THE MARKER IS NOT A SECOND COPY OF THE MAPPING. The whole
 * complaint being fixed is that the aim step looked like it did nothing, so the
 * chosen spot is now drawn — and a marker positioned by re-deriving px from
 * (u, v) in JSX would be a place for the two to drift, with the drawn dot
 * agreeing with the tap while the sim got something else. `moundAim.test.ts`
 * asserts the round trip instead.
 */
export function pointOfAim(aim: MoundAim): { dxPx: number; dyPx: number } {
  return { dxPx: VIEW_MIRROR * aim.u * ZONE_HALF_W_PX, dyPx: -aim.v * ZONE_HALF_H_PX };
}

/** Dead centre of the zone — what the panel draws before anything is placed. */
export const CENTRE_AIM: MoundAim = aimAtPoint(0, 0);

/**
 * Has the finger moved far enough to be worth recomputing the aim?
 *
 * ⚠ THE QUANTISED INPUT GATE, and it is here for the reason the charter names.
 * The golf audit measured `CourseGL`'s ungated per-`pointermove` work at 8–16 ms
 * on a mid-range phone — a dropped frame per event — against 0.55 ms for
 * `RangeGL`'s gated version. What hangs off this today is two divisions, a
 * `setState` and a `setReticle`; what obviously hangs off it next is a
 * trajectory preview. The gate goes in while it is one comparison.
 *
 * ⚠ ONLY THE `drag` GESTURE REACHES IT. A tap samples once, so it has nothing to
 * gate — which is one of the two arms' real costs, and worth remembering when
 * the preview lands.
 */
export const aimMoved = (dxPx: number, dyPx: number, lastDx: number, lastDy: number): boolean =>
  Math.abs(dxPx - lastDx) >= AIM_QUANT_PX || Math.abs(dyPx - lastDy) >= AIM_QUANT_PX;
