// The DEFENCE bench — the alignment, the acceleration ramp and the infield arc.
//
// These tests moved here bodily from `fielding.test.ts` when the rolling phase
// split the defence into three modules; the assertions did not change, because
// the geometry did not change. What is NEW is the ramp's INVERSE (`timeToCoverS`,
// which the ground race is built on) and the two reaction times, which is the one
// piece of fielder kinematics the rolling phase actually added.

import { describe, expect, it } from 'vitest';
import {
  ALIGNMENT,
  DEFENSE_SPAN,
  FIELDER_ACCEL_FPS2,
  FIELDER_GROUND_REACTION_S,
  FIELDER_RAMP_FT,
  FIELDER_REACTION_S,
  FIELDER_SPEED_FPS,
  FIELDER_TIME_TO_SPEED_S,
  INFIELD_ARC_R_FT,
  infieldDepthFt,
  nearestFielder,
  polarGapFt,
  reachMultiplier,
  sprintFt,
  timeToCoverS,
} from './fielders';
import { RUBBER_D_FT } from './zone';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

describe('how far a fielder gets', () => {
  it('accelerates rather than teleporting to sprint speed', () => {
    // ⚠ THE RAMP IS NOT COSMETIC. A fielder treated as instantly at 27 ft/s is
    // credited v·t_acc/2 = 24.3 ft too much on every play longer than the ramp,
    // which is the difference between a gap double and a routine out.
    expect(FIELDER_ACCEL_FPS2).toBeCloseTo(FIELDER_SPEED_FPS / FIELDER_TIME_TO_SPEED_S, 12);
    expect(FIELDER_RAMP_FT).toBeCloseTo(0.5 * FIELDER_SPEED_FPS * FIELDER_TIME_TO_SPEED_S, 12);
    let table = '\n[REACH — ground covered from a standing start, ft]\n  hang s   this model   instant-sprint   over-credit\n';
    for (const h of [1, 1.5, 2, 3, 4, 5, 6]) {
      const naive = FIELDER_SPEED_FPS * Math.max(0, h - FIELDER_REACTION_S);
      table += `  ${h.toFixed(1).padStart(5)}   ${sprintFt(h).toFixed(1).padStart(9)}   ${naive
        .toFixed(1)
        .padStart(13)}   ${(naive - sprintFt(h)).toFixed(1).padStart(10)}\n`;
    }
    table += `\n  Published catch-probability envelope: ~100 ft covered on a ~4 s hang is a\n  five-star play. This model: ${sprintFt(
      4,
    ).toFixed(1)} ft. The instant-sprint version gives ${(
      FIELDER_SPEED_FPS * 3.5
    ).toFixed(1)}, which would make one routine.\n`;
    log(table);

    // Nothing happens before the reaction is over, then it is smooth and
    // strictly increasing — a jump at the ramp/sprint join would be a fielder
    // teleporting mid-play.
    expect(sprintFt(FIELDER_REACTION_S)).toBe(0);
    expect(sprintFt(0.2)).toBe(0);
    const join = FIELDER_REACTION_S + FIELDER_TIME_TO_SPEED_S;
    expect(Math.abs(sprintFt(join - 1e-7) - sprintFt(join + 1e-7))).toBeLessThan(1e-4);
    expect(sprintFt(join)).toBeCloseTo(0.5 * FIELDER_SPEED_FPS * FIELDER_TIME_TO_SPEED_S, 9);
    for (let h = 0; h < 7; h += 0.05) expect(sprintFt(h + 0.05)).toBeGreaterThanOrEqual(sprintFt(h));
    expect(sprintFt(4)).toBeCloseTo(70.2, 1);
  });

  it('⚠ `timeToCoverS` is the EXACT inverse of `sprintFt`, not a second model', () => {
    // ⚠ THE PROPERTY, NOT A TABLE OF SAMPLES. The ground race asks the ramp the
    // opposite question the air lookup asks it — "how long for this far" rather
    // than "how far in this long" — and a second approximation of the same ramp
    // is precisely the fork this codebase refuses. So what is asserted is that
    // the two compose to the identity, on BOTH sides of the ramp/sprint join and
    // for BOTH reaction times.
    for (const react of [FIELDER_REACTION_S, FIELDER_GROUND_REACTION_S, 0]) {
      for (let d = 0.25; d < 160; d += 0.25) {
        const t = timeToCoverS(d, react);
        expect(sprintFt(t, react), `${d} ft, react ${react}`).toBeCloseTo(d, 9);
      }
      // Zero distance is the reaction alone — he is already standing on it.
      expect(timeToCoverS(0, react)).toBe(react);
      expect(timeToCoverS(-5, react)).toBe(react);
      // Strictly increasing, with no step at the join.
      const join = FIELDER_RAMP_FT;
      expect(Math.abs(timeToCoverS(join - 1e-6, react) - timeToCoverS(join + 1e-6, react)))
        .toBeLessThan(1e-6);
    }
    let table =
      '\n[TIME TO COVER — the ramp, read the other way]\n  dist ft   air (0.50 s read)   ground (0.20 s read)   saved\n';
    for (const d of [5, 10, 15, 20, 25, 40, 60, 100]) {
      const a = timeToCoverS(d);
      const g = timeToCoverS(d, FIELDER_GROUND_REACTION_S);
      table += `  ${String(d).padStart(7)}   ${a.toFixed(2).padStart(17)}   ${g
        .toFixed(2)
        .padStart(20)}   ${(a - g).toFixed(2).padStart(5)}\n`;
    }
    log(table);
  });

  it('⚠ the two reaction times differ by the ROUTE, and it is half a grounder', () => {
    // The ground read is cheaper than the air read because a ground ball has no
    // route to read. ⚠ THE MEASUREMENT IS WHY IT MATTERS: on a 1.0 s grounder,
    // charging the infielder the outfielder's 0.5 s route tax spends HALF the
    // play standing still, and the ground he covers in what is left is 2.3 ft
    // against a routine 25 ft gap. The 0.2 s read is not a discount for the
    // infield; it is what is left when the route is taken out.
    expect(FIELDER_GROUND_REACTION_S).toBeLessThan(FIELDER_REACTION_S);
    const air = sprintFt(1.05);
    const ground = sprintFt(1.05, FIELDER_GROUND_REACTION_S);
    log(
      `\n[REACTION] on a 1.05 s ball: air read covers ${air.toFixed(
        1,
      )} ft, ground read covers ${ground.toFixed(1)} ft.\n` +
        `  The route leg is ${(FIELDER_REACTION_S - FIELDER_GROUND_REACTION_S).toFixed(
          2,
        )} s of a one-second play.\n`,
    );
    expect(air).toBeCloseTo(2.27, 2);
    expect(ground).toBeCloseTo(5.42, 2);
    // …and the whole of the difference is the route leg, not a faster fielder.
    expect(sprintFt(1.05 - FIELDER_REACTION_S, 0)).toBeCloseTo(air, 12);
    expect(sprintFt(1.05 - FIELDER_GROUND_REACTION_S, 0)).toBeCloseTo(ground, 12);
  });

  it('the alignment is fixed data — the "no shifts" rule, expressed as a constant', () => {
    expect(ALIGNMENT).toHaveLength(8);
    expect(ALIGNMENT.map((f) => f.pos)).toEqual(['P', '3B', 'SS', '2B', '1B', 'LF', 'CF', 'RF']);
    // ⚠ THE PITCHER IS ON THE RUBBER, READ FROM `zone.ts` RATHER THAN TYPED. He
    // is in the list because a ball ROLLING up the middle passes within a few
    // feet of him; a landing-point model never needed him and this one does.
    expect(ALIGNMENT[0]).toEqual({ pos: 'P', bearingDeg: 0, distFt: RUBBER_D_FT, infield: true });
    // Exactly five infielders — the four who can be shifted about in a later
    // milestone plus the pitcher — and three outfielders. The flag is what
    // `groundBall.ts` reports; it is data, not a branch.
    expect(ALIGNMENT.filter((f) => f.infield).map((f) => f.pos)).toEqual(['P', '3B', 'SS', '2B', '1B']);
    expect(ALIGNMENT.filter((f) => !f.infield).map((f) => f.pos)).toEqual(['LF', 'CF', 'RF']);
    // Mirrored infield and outfield, so a pull-side and an oppo ball of the same
    // shape get the same defence.
    expect(nearestFielder(-19, 145).gapFt).toBeCloseTo(nearestFielder(19, 145).gapFt, 9);
    expect(nearestFielder(-29, 290).pos).toBe('LF');
    expect(nearestFielder(29, 290).pos).toBe('RF');
    expect(nearestFielder(0, 315).pos).toBe('CF');
    expect(nearestFielder(0, 315).gapFt).toBeCloseTo(0, 9);
    expect(nearestFielder(0, RUBBER_D_FT).pos).toBe('P');
  });

  it('the one defender rating spans exactly ±15 % and clamps', () => {
    expect(reachMultiplier(1) / reachMultiplier(0)).toBeCloseTo(
      (1 + DEFENSE_SPAN / 2) / (1 - DEFENSE_SPAN / 2),
      12,
    );
    expect(reachMultiplier(0.5)).toBe(1);
    expect(reachMultiplier(99)).toBe(reachMultiplier(1));
    expect(reachMultiplier(-99)).toBe(reachMultiplier(0));
  });

  it('the infield edge is the 95 ft ARC struck from the rubber, not a circle', () => {
    // ⚠ THE TEST WITH TEETH IS THE DEFINING PROPERTY, NOT THE TABLE. Any number
    // of wrong-shaped functions reproduce 155.5 ft at dead centre — the circle
    // this replaced did. What only the right one satisfies: every point of the
    // edge is EXACTLY 95 ft from the rubber. Asserted by converting the model's
    // plate-centred answer back to Cartesian and measuring it against the
    // rubber's own position, i.e. by the inverse of the derivation.
    for (let b = -90; b <= 90; b += 1.5) {
      const r = infieldDepthFt(b);
      const x = r * Math.sin((b * Math.PI) / 180);
      const y = r * Math.cos((b * Math.PI) / 180);
      expect(Math.hypot(x, y - RUBBER_D_FT), `${b}°`).toBeCloseTo(INFIELD_ARC_R_FT, 9);
    }
    // The plate is INSIDE the arc, so the discriminant can never go negative and
    // there is no clamp to hide a bug in — true at every bearing, behind the
    // plate included.
    expect(RUBBER_D_FT).toBeLessThan(INFIELD_ARC_R_FT);
    expect(infieldDepthFt(180)).toBeCloseTo(INFIELD_ARC_R_FT - RUBBER_D_FT, 9);

    let table =
      '\n[INFIELD EDGE — plate to the dirt at a bearing, ft]\n' +
      '  bearing    arc (this model)   old plate-centred circle   over-stated by\n';
    for (const b of [0, 10, 20, 29, 38, 45]) {
      const r = infieldDepthFt(b);
      table += `  ${String(b).padStart(5)}°   ${r.toFixed(1).padStart(14)}   ${(RUBBER_D_FT + 95)
        .toFixed(1)
        .padStart(23)}   ${(RUBBER_D_FT + 95 - r).toFixed(1).padStart(14)}\n`;
    }
    log(table);

    // The four figures BASEBALL.md quotes for the true arc, now the shipped ones.
    expect(infieldDepthFt(0)).toBeCloseTo(RUBBER_D_FT + 95, 9);
    expect(infieldDepthFt(20)).toBeCloseTo(149.6, 1);
    expect(infieldDepthFt(38)).toBeCloseTo(135.1, 1);
    expect(infieldDepthFt(45)).toBeCloseTo(127.6, 1);
    expect(RUBBER_D_FT + 95 - infieldDepthFt(45)).toBeCloseTo(27.9, 1);
    // Mirrored, and shrinking monotonically from centre out to the line — the
    // shape a circle cannot have.
    for (let b = 0; b < 45; b += 1) {
      expect(infieldDepthFt(-b)).toBeCloseTo(infieldDepthFt(b), 12);
      expect(infieldDepthFt(b + 1)).toBeLessThan(infieldDepthFt(b));
    }
  });

  it('`polarGapFt` is a metric — symmetric, zero on itself, never NaN', () => {
    expect(polarGapFt(0, 100, 0, 100)).toBe(0);
    expect(polarGapFt(-19, 145, 19, 145)).toBeCloseTo(2 * 145 * Math.sin((19 * Math.PI) / 180), 9);
    expect(polarGapFt(30, 200, -30, 50)).toBeCloseTo(polarGapFt(-30, 50, 30, 200), 12);
    // The `Math.max(0, …)` guard: floating point can push the radicand a hair
    // negative when two points coincide, and NaN in a gap would silently make a
    // fielder unreachable rather than perfectly placed.
    for (let d = 0; d < 400; d += 7) expect(Number.isFinite(polarGapFt(13, d, 13, d))).toBe(true);
  });
});
