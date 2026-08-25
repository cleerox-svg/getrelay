// THE MOUND'S AIM MATH — a point on the panel becomes a point on the plate.
//
// It is pure, so it is asserted directly rather than through a synthesised
// pointer on a mounted HUD. What is at stake is small and total: two signs, two
// scales and one clamp, and every one of them is invisible to a type-check and
// to every printed physics table. A flipped sign is a game in which the ball
// goes the wrong way and nothing anywhere fails.
//
// ⚠ THE SIGNS ARE ASSERTED AS BASEBALL, NOT AS ARITHMETIC. "u is negative" is a
// claim no reader can check against the complaint this control was rewritten
// for; "the top corner of the panel on the batter's side is HIGH AND INSIDE to
// the duel's right-handed batter" is the same claim in the language the owner
// used, and it is the one below.
//
// ⚠ THE COMPOSITION IS ASSERTED TOO, NOT JUST THE MAPPING. One test drives the
// output through `duelRules.pitchLocation` — the sim's own command map — because
// "the HUD produced a number" and "the number meant what the sim thinks it
// means" are two claims, and only the second one is the game.

import { describe, expect, it } from 'vitest';
import { pitchLocation } from '../../../lib/baseball/duelRules';
import {
  CALL_ZONE,
  PLATE_WIDTH_FT,
  RULE_ZONE,
  ZONE_BOTTOM_FT,
  ZONE_TOP_FT,
  isStrike,
} from '../../../lib/baseball/zone';
import {
  AIM_FT_PER_PX,
  AIM_QUANT_PX,
  AIM_REACH_UV,
  CENTRE_AIM,
  VIEW_MIRROR,
  ZONE_HALF_H_PX,
  ZONE_HALF_W_PX,
  aimAtPoint,
  aimMoved,
  pointOfAim,
} from './moundAim';

const CENTRE_H = (ZONE_BOTTOM_FT + ZONE_TOP_FT) / 2;

/**
 * Inside, to the duel's batter, in REPORT feet.
 *
 * ⚠ `duelRules` DEFAULTS `batterHand` TO 'R', and a right-handed batter stands
 * on the THIRD-BASE side — REPORT −x, the same side `zone.ts`'s `armSideX('R')`
 * puts a right-handed pitcher's release on. So inside = x < 0, and under the
 * `pitcher` camera the panel is mirrored (`VIEW_MIRROR`), which puts that side
 * on the RIGHT of the panel. Both halves of that are what the corner test says.
 */
const insideToRhb = (x: number) => x < 0;

describe('moundAim — the panel maps to the plate', () => {
  it('the centre of the panel is dead centre of the zone', () => {
    const a = aimAtPoint(0, 0);
    // `toBeCloseTo`, not `toBe`: `VIEW_MIRROR * 0` is NEGATIVE zero, which is
    // numerically identical and `Object.is`-distinct. The claim is about the
    // aim, not about the sign bit of a zero.
    expect(a.u).toBeCloseTo(0, 12);
    expect(a.v).toBeCloseTo(0, 12);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.h).toBeCloseTo(CENTRE_H, 12);
    expect(CENTRE_AIM.x).toBeCloseTo(0, 12);
    expect(CENTRE_AIM.h).toBeCloseTo(CENTRE_H, 12);
  });

  it('⚠ THE BUG: a single tap off centre is NOT a middle-middle pitch', () => {
    // The whole reason this control was rewritten. The slingshot it replaced
    // took a PULL DELTA, so a tap — one `pointerdown`, no movement — was a
    // zero-length pull and aimed dead centre every time, which is what the owner
    // played and reported. Absolute placement has no origin to be zero against:
    // ONE point, on its own, already carries a location.
    const tap = aimAtPoint(40, -55);
    expect(Math.abs(tap.x)).toBeGreaterThan(0.25);
    expect(Math.abs(tap.h - CENTRE_H)).toBeGreaterThan(0.4);
    // …and it is a genuinely different pitch: outside the middle third on BOTH
    // axes, i.e. not a cosmetic nudge inside the fat part of the zone.
    expect(Math.abs(tap.x)).toBeGreaterThan(RULE_ZONE.right / 3);
    expect(Math.abs(tap.h - CENTRE_H)).toBeGreaterThan((ZONE_TOP_FT - ZONE_BOTTOM_FT) / 6);
  });

  it('⚠ THE FOUR CORNERS: upper-right of the panel is HIGH AND INSIDE', () => {
    // The two signs that no type and no table can see, stated in the language of
    // the complaint. `ZONE_HALF_*_PX` from the panel's centre is the drawn zone's
    // own corner, so these are the four pitches a player is aiming at when they
    // tap a corner of the box.
    const highIn = aimAtPoint(+ZONE_HALF_W_PX, -ZONE_HALF_H_PX);
    const highOut = aimAtPoint(-ZONE_HALF_W_PX, -ZONE_HALF_H_PX);
    const lowIn = aimAtPoint(+ZONE_HALF_W_PX, +ZONE_HALF_H_PX);
    const lowOut = aimAtPoint(-ZONE_HALF_W_PX, +ZONE_HALF_H_PX);

    // HIGH: the top of the panel is the top of the zone. Screen +y is DOWN and
    // height is UP — the one vertical sign in the file.
    expect(highIn.h).toBeCloseTo(ZONE_TOP_FT, 12);
    expect(highOut.h).toBeCloseTo(ZONE_TOP_FT, 12);
    expect(lowIn.h).toBeCloseTo(ZONE_BOTTOM_FT, 12);
    expect(lowOut.h).toBeCloseTo(ZONE_BOTTOM_FT, 12);

    // INSIDE: the right of the panel is the third-base side, because the panel
    // is drawn over the PITCHER camera and that camera is mirrored against
    // `zone.ts`'s umpire-facing convention.
    expect(insideToRhb(highIn.x)).toBe(true);
    expect(insideToRhb(lowIn.x)).toBe(true);
    expect(insideToRhb(highOut.x)).toBe(false);
    expect(insideToRhb(lowOut.x)).toBe(false);
    expect(highIn.x).toBeCloseTo(-PLATE_WIDTH_FT / 2, 12);
    expect(highOut.x).toBeCloseTo(+PLATE_WIDTH_FT / 2, 12);

    // All four are on the black and all four are strikes — a corner of the drawn
    // box is a corner of the CALLED box, which is only true because both come
    // from `zone.ts`.
    for (const a of [highIn, highOut, lowIn, lowOut]) expect(isStrike(a.x, a.h)).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `\n[MOUND PANEL — the four corners, ${AIM_FT_PER_PX} ft/px]\n` +
        `  panel ${(2 * ZONE_HALF_W_PX).toFixed(1)} × ${(2 * ZONE_HALF_H_PX).toFixed(1)} px zone` +
        `, reach ${AIM_REACH_UV} half-zones, mirror ${VIEW_MIRROR}\n` +
        [
          ['tap upper-right', highIn],
          ['tap upper-left ', highOut],
          ['tap lower-right', lowIn],
          ['tap lower-left ', lowOut],
        ]
          .map(
            ([label, a]) =>
              `  ${label as string}  x ${(a as { x: number }).x.toFixed(3)} ft  h ${(a as { h: number }).h.toFixed(3)} ft` +
              `  ${insideToRhb((a as { x: number }).x) ? 'inside ' : 'outside'} to a RHB\n`,
          )
          .join(''),
    );
  });

  it('one half-zone of panel is one half-zone of plate, on both axes', () => {
    // The SCALE, tied to `zone.ts` rather than to a number typed here.
    const lateral = aimAtPoint(ZONE_HALF_W_PX, 0);
    const vertical = aimAtPoint(0, ZONE_HALF_H_PX);
    expect(lateral.u).toBeCloseTo(-1, 12);
    expect(lateral.x).toBeCloseTo(-PLATE_WIDTH_FT / 2, 12);
    expect(vertical.v).toBeCloseTo(-1, 12);
    expect(vertical.h).toBeCloseTo(ZONE_BOTTOM_FT, 12);
    // …and the scale is the BATTER's, so the same hand movement means the same
    // foot of plate at either end of the battery. `ZoneReticle`'s AIM_FT_PER_PX.
    expect(AIM_FT_PER_PX).toBeCloseTo(0.01, 12);
    expect(ZONE_HALF_W_PX).toBeCloseTo(PLATE_WIDTH_FT / 2 / AIM_FT_PER_PX, 12);
    expect(ZONE_HALF_H_PX).toBeCloseTo((ZONE_TOP_FT - ZONE_BOTTOM_FT) / 2 / AIM_FT_PER_PX, 12);
  });

  it('⚠ THE CLAMP IS RADIAL: a diagonal aim reaches no further than a straight one', () => {
    // A per-axis clamp would make the corners of a square reachable — 1.414×
    // the reach of a straight aim — i.e. a corner strictly more powerful than an
    // edge. The reachable set must be a DISC in (u, v), so every direction costs
    // the same. It is the slingshot's rule with the origin moved to the zone.
    const straight = aimAtPoint(1000, 0);
    const diagonal = aimAtPoint(1000, 1000);
    const shallow = aimAtPoint(1000, 400);
    const r = (a: { u: number; v: number }) => Math.hypot(a.u, a.v);

    expect(r(straight)).toBeCloseTo(AIM_REACH_UV, 12);
    expect(r(diagonal)).toBeCloseTo(AIM_REACH_UV, 12);
    expect(r(shallow)).toBeCloseTo(AIM_REACH_UV, 12);
    // And the direction survives the clamp — it scales the vector, it does not
    // square it off. A tap on the panel's diagonal must stay on that diagonal.
    expect(Math.abs(diagonal.u / diagonal.v)).toBeCloseTo(ZONE_HALF_H_PX / ZONE_HALF_W_PX, 12);
    expect(Math.abs(shallow.v / shallow.u)).toBeCloseTo(
      (400 / ZONE_HALF_H_PX) / (1000 / ZONE_HALF_W_PX),
      12,
    );
    // A point INSIDE the reach is untouched — the clamp is a bound, not a scale.
    const inside = aimAtPoint(30, -20);
    expect(inside.u).toBeCloseTo(-30 / ZONE_HALF_W_PX, 12);
    expect(inside.v).toBeCloseTo(20 / ZONE_HALF_H_PX, 12);
    // …and the four DRAWN corners are inside it, so every corner of the box the
    // player can see is a corner they can actually ask for. hypot(1,1) < 1.6.
    expect(r(aimAtPoint(ZONE_HALF_W_PX, ZONE_HALF_H_PX))).toBeCloseTo(Math.SQRT2, 12);
  });

  it('⚠ `pointOfAim` IS THE EXACT INVERSE — the mark is drawn where it was placed', () => {
    // The marker's position is not re-derived in JSX; it round-trips through
    // this. If the two ever disagree the drawn spot and the thrown spot part
    // company, which is the failure the whole slice exists to end.
    for (const [dx, dy] of [
      [0, 0],
      [40, -55],
      [-ZONE_HALF_W_PX, ZONE_HALF_H_PX],
      [17.5, 129],
      [-3, -1],
    ]) {
      const back = pointOfAim(aimAtPoint(dx!, dy!));
      expect(back.dxPx).toBeCloseTo(dx!, 10);
      expect(back.dyPx).toBeCloseTo(dy!, 10);
    }
    // Beyond the reach the round trip lands on the CLAMPED point, not the raw
    // one — the mark sits where the pitch is going, which is the whole contract.
    const far = pointOfAim(aimAtPoint(400, 0));
    expect(far.dxPx).toBeCloseTo(AIM_REACH_UV * ZONE_HALF_W_PX, 10);
    expect(far.dxPx).toBeLessThan(400);
  });

  it('the quantised input gate: below the quantum, nothing recomputes', () => {
    // The charter's rule, and the golf audit's 8–16 ms per move event on a
    // mid-range phone is why it is here before anything expensive hangs off it.
    // Only the `drag` arm reaches it; a tap samples once.
    expect(aimMoved(10, 10, 10, 10)).toBe(false);
    expect(aimMoved(10 + AIM_QUANT_PX - 0.01, 10, 10, 10)).toBe(false);
    expect(aimMoved(10, 10 + AIM_QUANT_PX - 0.01, 10, 10)).toBe(false);
    // …and either axis crossing it is enough. A gate that needed BOTH would
    // discard a purely horizontal drag entirely.
    expect(aimMoved(10 + AIM_QUANT_PX, 10, 10, 10)).toBe(true);
    expect(aimMoved(10, 10 + AIM_QUANT_PX, 10, 10)).toBe(true);
    expect(aimMoved(10, 10 - AIM_QUANT_PX, 10, 10)).toBe(true);
  });

  it('⚠ THE OUTPUT IS IN THE SIM’S UNITS — it composes with `pitchLocation`', () => {
    // The claim the HUD makes when it hands these two numbers to `servePitch`:
    // they are REPORT feet, they are the INTENDED location, and a perfect
    // release delivers them unchanged.
    const aim = aimAtPoint(-30, 25);
    const perfect = pitchLocation({ x: aim.x, h: aim.h }, 0, 'R');
    expect(perfect.x).toBeCloseTo(aim.x, 12);
    expect(perfect.h).toBeCloseTo(aim.h, 12);

    // And the reach is a real one: an aim at the edge of the control is off the
    // plate, which is what a pitcher does on purpose, while dead centre stays a
    // strike through the worst legal command miss (`duelRules`'s derived
    // full-corner miss).
    const edge = aimAtPoint(-1000, 0);
    expect(isStrike(edge.x, edge.h)).toBe(false);
    expect(Math.abs(edge.x)).toBeGreaterThan(CALL_ZONE.right);
    const worstMiss = pitchLocation({ x: 0, h: CENTRE_H }, 1, 'R');
    expect(isStrike(worstMiss.x, worstMiss.h)).toBe(true);
  });
});
