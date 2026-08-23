// THE MOUND'S SLINGSHOT: a drag in CSS pixels → an INTENDED PLATE LOCATION.
//
// Pure. No React, no DOM, no `three`, no state, no clock — which is what lets
// the mapping be asserted directly instead of only through a mounted HUD with a
// synthesised pointer.
//
// ⚠ THIS IS BASEBALL'S OWN AIM MATH, AND NOT GOLF'S `pullAim`, BY DECISION.
// `CourseSim`'s private `pullAim` maps a 2-D drag onto a single AIM ANGLE for a
// ball struck from rest toward a target on a plane; it returns a scalar bearing.
// Pitching maps a drag onto a POINT IN A RECTANGLE — the plate window 60.5 ft
// away, thrown from a release point offset to the arm side — and its two axes
// have different physical meanings and different sensitivities (see
// `AIM_PULL_PX`, where the lateral and vertical feet-per-pixel differ by 27 %
// because the zone is not square). One returns a bearing, the other a location.
// Sharing them would force a lowest-common-denominator abstraction that serves
// neither and would drag golf — mid-audit — into a baseball slice for no gain.
// The bar for revisiting is a demonstration that they are the same computation
// once expressed properly, not a resemblance.
//
// ⚠ AND THE SIM TAKES NUMBERS, NOT GESTURES. Nothing about a pointer reaches
// `lib/baseball`: this file ends at `reticleToPlate`, and `duelRules.pitchLocation`
// takes the intended location plus the accuracy sweep's stop error from there.
// That is what lets `duelSim.test.ts` play a hundred games without a DOM.

import { reticleToPlate } from '../../../lib/baseball/zone';

/**
 * Pull, in CSS px, that aims one HALF-ZONE off centre (|u| or |v| = 1).
 *
 * ⚠ FEEL KNOB, labelled, and DELIBERATELY THE SAME HAND MOVEMENT AS THE BATTER'S.
 * `ZoneReticle.AIM_FT_PER_PX` is 0.010 ft/px. At 90 px per half-zone this control
 * is 0.9 ft / 90 px = **0.0100 ft/px vertically** — identical — and
 * 0.7083 ft / 90 px = **0.0079 ft/px laterally**, because the zone is 1.417 ft
 * wide and 1.8 ft tall and a normalised square is not a physical one. The two
 * controls therefore feel the same in the hand, which matters because the same
 * thumb switches between them every half-inning.
 */
export const AIM_PULL_PX = 90;

/**
 * The longest pull the control accepts, CSS px. FEEL KNOB — it is the REACH.
 *
 * A pitcher aims off the plate on purpose, so this is not clamped to the zone:
 * 144 px is 1.6 half-zones, i.e. 1.133 ft of lateral intent (5.1 in outside the
 * called corner) and 1.44 ft of vertical. Aiming further than that is not a
 * pitch, it is a wild throw, and `duelRules.pitchLocation` then adds the command
 * miss on top of wherever this lands.
 */
export const AIM_PULL_MAX_PX = 144;

/** Movement quantum, CSS px — the quantised input gate. See below. */
export const AIM_QUANT_PX = 2;

/** Reach in normalised zone half-spans. DERIVED, 1.6. */
export const AIM_REACH_UV = AIM_PULL_MAX_PX / AIM_PULL_PX;

export interface MoundAim {
  /** Normalised zone coordinates, +u right / +v up, |(u,v)| ≤ AIM_REACH_UV. */
  u: number;
  v: number;
  /** The same point in REPORT ft — what `PitchCommand.intentX/intentH` take. */
  x: number;
  h: number;
  /** Pull length as a fraction of the maximum, 0…1 — the HUD's draw indicator. */
  draw: number;
}

/**
 * A pull vector (px, screen axes: +dx right, +dy DOWN) → where the pitch is aimed.
 *
 * ⚠ IT IS A SLINGSHOT, SO BOTH AXES INVERT. Pull down-and-right and the pitch
 * goes up-and-in to the other side, exactly as drawing a catapult back does.
 * Screen +y is DOWN and height is UP, so the vertical inversion and the screen's
 * own sign flip CANCEL: `v = +dy / AIM_PULL_PX`. Written out because "one of
 * these two signs is a double negative" is precisely the kind of thing that gets
 * silently fixed in the wrong place later.
 *
 * ⚠ THE CLAMP IS RADIAL, ON THE PULL, NOT PER AXIS ON THE RESULT. A per-axis
 * clamp would let a 45° drag reach 1.41× the reach of a straight one — the
 * corners of a square being further from its centre than its edges — so a
 * diagonal aim would be strictly more powerful than a straight one for the same
 * hand movement. Clamping the gesture's own length keeps the reachable set a
 * DISC and makes every direction cost the same.
 */
export function aimFromPull(dxPx: number, dyPx: number): MoundAim {
  const len = Math.hypot(dxPx, dyPx);
  const k = len > AIM_PULL_MAX_PX ? AIM_PULL_MAX_PX / len : 1;
  const u = (-dxPx * k) / AIM_PULL_PX;
  const v = (dyPx * k) / AIM_PULL_PX;
  const { x, h } = reticleToPlate(u, v);
  return { u, v, x, h, draw: Math.min(1, len / AIM_PULL_MAX_PX) };
}

/** The default aim before the player has pulled at all: dead centre. */
export const CENTRE_AIM: MoundAim = aimFromPull(0, 0);

/**
 * Has the pull moved far enough to be worth recomputing the aim?
 *
 * ⚠ THE QUANTISED INPUT GATE, and it is here for the reason the charter names.
 * The golf audit measured `CourseGL`'s ungated per-`pointermove` work at 8–16 ms
 * on a mid-range phone — a dropped frame per event — against 0.55 ms for
 * `RangeGL`'s gated version. What hangs off this today is two divisions and a
 * `setReticle`; what obviously hangs off it next is a trajectory preview. The
 * gate goes in while it is one comparison.
 */
export const aimMoved = (dxPx: number, dyPx: number, lastDx: number, lastDy: number): boolean =>
  Math.abs(dxPx - lastDx) >= AIM_QUANT_PX || Math.abs(dyPx - lastDy) >= AIM_QUANT_PX;
