// THE MOUND'S AIM MATH — a drag in pixels becomes a point on the plate.
//
// It is pure, so it is asserted directly rather than through a synthesised
// pointer on a mounted HUD. What is at stake is small and total: four signs, one
// scale and one clamp, and every one of them is invisible to a type-check and to
// every printed physics table. A flipped sign is a game in which the ball goes
// the wrong way and nothing anywhere fails.
//
// ⚠ THE COMPOSITION IS ASSERTED, NOT JUST THE MAPPING. The last test drives the
// output through `duelRules.pitchLocation` — the sim's own command map — because
// "the HUD produced a number" and "the number meant what the sim thinks it
// means" are two claims, and only the second one is the game.

import { describe, expect, it } from 'vitest';
import { pitchLocation } from '../../../lib/baseball/duelRules';
import {
  CALL_ZONE,
  PLATE_WIDTH_FT,
  ZONE_BOTTOM_FT,
  ZONE_TOP_FT,
  isStrike,
} from '../../../lib/baseball/zone';
import {
  AIM_PULL_MAX_PX,
  AIM_PULL_PX,
  AIM_QUANT_PX,
  AIM_REACH_UV,
  aimFromPull,
  aimMoved,
} from './moundAim';

const CENTRE_H = (ZONE_BOTTOM_FT + ZONE_TOP_FT) / 2;

describe('moundAim — the slingshot', () => {
  it('no pull aims dead centre', () => {
    const a = aimFromPull(0, 0);
    // `toBeCloseTo`, not `toBe`: `-dx * k` at dx = 0 is NEGATIVE zero, which is
    // numerically identical and `Object.is`-distinct. The claim is about the
    // aim, not about the sign bit of a zero.
    expect(a.u).toBeCloseTo(0, 12);
    expect(a.v).toBeCloseTo(0, 12);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.h).toBeCloseTo(CENTRE_H, 12);
    expect(a.draw).toBe(0);
  });

  it('⚠ BOTH AXES INVERT — pull right/down, the pitch goes left/up', () => {
    // The two signs that no type and no table can see. Each is checked on its
    // own axis with the other held at zero, so a single flipped sign cannot be
    // masked by the other.
    const right = aimFromPull(40, 0);
    const left = aimFromPull(-40, 0);
    const down = aimFromPull(0, 40);
    const up = aimFromPull(0, -40);

    expect(right.x).toBeLessThan(0);
    expect(left.x).toBeGreaterThan(0);
    // ⚠ SCREEN +y IS DOWN AND HEIGHT IS UP, so the slingshot's inversion and the
    // screen's own flip CANCEL: pulling DOWN aims HIGH.
    expect(down.h).toBeGreaterThan(CENTRE_H);
    expect(up.h).toBeLessThan(CENTRE_H);
    // …and the mirror is exact, so nothing has crept into one direction only.
    expect(right.x).toBeCloseTo(-left.x, 12);
    expect(down.h - CENTRE_H).toBeCloseTo(CENTRE_H - up.h, 12);
  });

  it('AIM_PULL_PX of pull is exactly one half-zone, on both axes', () => {
    // The SCALE, tied to `zone.ts` rather than to a number typed here: a full
    // pull left lands on the right edge of the DRAWN plate, and a full pull up
    // lands on the bottom of the drawn zone.
    const lateral = aimFromPull(-AIM_PULL_PX, 0);
    const vertical = aimFromPull(0, -AIM_PULL_PX);
    expect(lateral.u).toBeCloseTo(1, 12);
    expect(lateral.x).toBeCloseTo(PLATE_WIDTH_FT / 2, 12);
    expect(vertical.v).toBeCloseTo(-1, 12);
    expect(vertical.h).toBeCloseTo(ZONE_BOTTOM_FT, 12);

    // eslint-disable-next-line no-console
    console.log(
      `\n[MOUND AIM — feet per CSS pixel]\n` +
        `  lateral  ${(PLATE_WIDTH_FT / 2 / AIM_PULL_PX).toFixed(4)} ft/px  (plate ${PLATE_WIDTH_FT.toFixed(3)} ft wide)\n` +
        `  vertical ${((ZONE_TOP_FT - ZONE_BOTTOM_FT) / 2 / AIM_PULL_PX).toFixed(4)} ft/px  (zone ${(ZONE_TOP_FT - ZONE_BOTTOM_FT).toFixed(2)} ft tall)\n` +
        `  reach    ${AIM_REACH_UV.toFixed(2)} half-zones = ${(AIM_REACH_UV * PLATE_WIDTH_FT) / 2} ft lateral\n` +
        `  ⚠ ZoneReticle's batter aim is 0.0100 ft/px — the vertical axis matches.\n`,
    );
  });

  it('⚠ THE CLAMP IS RADIAL: a diagonal pull reaches no further than a straight one', () => {
    // A per-axis clamp would make the corners of a square reachable — 1.414×
    // the reach of a straight pull for the same hand movement, i.e. a diagonal
    // aim strictly more powerful than a level one. The reachable set must be a
    // DISC, so every direction costs the same.
    const straight = aimFromPull(1000, 0);
    const diagonal = aimFromPull(1000, 1000);
    const shallow = aimFromPull(1000, 400);
    const r = (a: { u: number; v: number }) => Math.hypot(a.u, a.v);

    expect(r(straight)).toBeCloseTo(AIM_REACH_UV, 12);
    expect(r(diagonal)).toBeCloseTo(AIM_REACH_UV, 12);
    expect(r(shallow)).toBeCloseTo(AIM_REACH_UV, 12);
    // And the direction survives the clamp — it scales the vector, it does not
    // square it off. A 45° pull must stay at 45°.
    expect(Math.abs(diagonal.u)).toBeCloseTo(Math.abs(diagonal.v), 12);
    expect(Math.abs(shallow.v / shallow.u)).toBeCloseTo(0.4, 12);
  });

  it('an unclamped pull is untouched, and `draw` saturates at 1', () => {
    const inside = aimFromPull(30, -20);
    expect(inside.u).toBeCloseTo(-30 / AIM_PULL_PX, 12);
    expect(inside.v).toBeCloseTo(-20 / AIM_PULL_PX, 12);
    expect(inside.draw).toBeCloseTo(Math.hypot(30, 20) / AIM_PULL_MAX_PX, 12);
    expect(aimFromPull(AIM_PULL_MAX_PX, 0).draw).toBeCloseTo(1, 12);
    expect(aimFromPull(9999, 9999).draw).toBe(1);
  });

  it('the quantised input gate: below the quantum, nothing recomputes', () => {
    // The charter's rule, and the golf audit's 8–16 ms per move event on a
    // mid-range phone is why it is here before anything expensive hangs off it.
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
    const aim = aimFromPull(-30, 25);
    const perfect = pitchLocation({ x: aim.x, h: aim.h }, 0, 'R');
    expect(perfect.x).toBeCloseTo(aim.x, 12);
    expect(perfect.h).toBeCloseTo(aim.h, 12);

    // And the reach is a real one: an aim at the edge of the control is off the
    // plate, which is what a pitcher does on purpose, while dead centre stays a
    // strike through the worst legal command miss (`duelRules`'s derived
    // full-corner miss).
    const edge = aimFromPull(AIM_PULL_MAX_PX, 0);
    expect(isStrike(edge.x, edge.h)).toBe(false);
    expect(Math.abs(edge.x)).toBeGreaterThan(CALL_ZONE.right);
    const worstMiss = pitchLocation({ x: 0, h: CENTRE_H }, 1, 'R');
    expect(isStrike(worstMiss.x, worstMiss.h)).toBe(true);
  });
});
