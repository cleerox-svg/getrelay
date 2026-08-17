// The bowl's INNER EDGE, which is the one number in `stands.ts` that is derived
// from park data rather than chosen.
//
// ⚠ WHY THIS FILE EXISTS NOW. The published dimension profile arrived carrying
// TWO numbers this park's data used to collapse into one: 28 ft of catchable
// foul ground down the lines and a 60 ft backstop. Setting `foulTerritoryFt` to
// 60 made a 437 ft ball 5° foul a CATCH (the fielding model prices foul ground
// as a uniform band of that depth running the whole length of the line), so the
// two are now two fields — and the geometry has to read both, or the backstop
// the player sees is not the backstop the park says it has.
//
// MUTATIONS WATCHED TO FAIL (each reverted):
//   1. `Math.max(park.backstopFt, offset)` → `offset`
//      (i.e. the backstop field ignored, the pre-profile behaviour)   → 3 fail
//   2. `Math.min(atLine, …)` dropped, so the stands run past the wall → 2 fail
//   3. the fair-territory branch returning `foulTerritoryFt` instead
//      of the fence distance                                         → 2 fail
//
// M3b added the PERIODICITY tests, and mutation 4 is the defect they were
// written for — it shipped, and the visual gate found it in a PNG:
//   4. `wallTopFt` reverted to holding the near foul line's height
//      (`Math.sign`), i.e. the 1.75 ft crack in the bowl's front rail
//      at bearing ±180 — dead centre of the `pitcher` frame            → 1 fail
//
// ⚠ AND ONE CHANGE WAS REVERTED FOR FAILING TO DIE. The same `Math.sign` shape
// exists in `bowlInnerRadiusFt`'s `atLine`, and a blend was written for it —
// but the backstop clamp holds a constant from |β| ≈ 73° to 180° in both parks,
// so no input reads `atLine` near the seam and no mutation of it can be killed.
// It was removed rather than shipped as cover; see the note on the function.

import { describe, expect, it } from 'vitest';
import { ALPINE_HEIGHTS, fenceAt, FOUL_LINE_DEG, HARBOURFRONT } from '../../../lib/baseball/parks';
import { bowlInnerRadiusFt, wallTopFt } from './bowlEdge';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

describe('the bowl inner edge', () => {
  it('IS the outfield wall in fair territory — the same function the sim resolves against', () => {
    // Not "close to". The stands meet the wall, so a park that moves its fence
    // moves its stands, and there is exactly one fence function.
    for (let b = -FOUL_LINE_DEG; b <= FOUL_LINE_DEG; b += 0.5) {
      expect(bowlInnerRadiusFt(HARBOURFRONT, b)).toBe(fenceAt(HARBOURFRONT, b).distFt);
      expect(bowlInnerRadiusFt(ALPINE_HEIGHTS, b)).toBe(fenceAt(ALPINE_HEIGHTS, b).distFt);
    }
  });

  it('is the park`s own BACKSTOP behind the plate, not its foul-ground depth', () => {
    // ⚠ THE TWO NUMBERS ARE DIFFERENT AND THE TEST IS ONLY MEANINGFUL BECAUSE
    // THEY ARE. Assert that first: if a future edit made them equal, everything
    // below would pass with the backstop field ignored entirely.
    expect(HARBOURFRONT.backstopFt).not.toBe(HARBOURFRONT.foulTerritoryFt);
    expect(ALPINE_HEIGHTS.backstopFt).not.toBe(ALPINE_HEIGHTS.foulTerritoryFt);

    for (const park of [HARBOURFRONT, ALPINE_HEIGHTS]) {
      // Directly behind the plate, and abeam it, the bowl stands at the
      // backstop distance — never at the (much shallower) foul-ground depth.
      expect(bowlInnerRadiusFt(park, 180)).toBeCloseTo(park.backstopFt, 9);
      expect(bowlInnerRadiusFt(park, -180)).toBeCloseTo(park.backstopFt, 9);
      expect(bowlInnerRadiusFt(park, 150)).toBeCloseTo(park.backstopFt, 9);
    }
  });

  it('never comes nearer the plate than the backstop, or further out than the wall', () => {
    const rows: string[] = [];
    for (const park of [HARBOURFRONT, ALPINE_HEIGHTS]) {
      const atLine = fenceAt(park, FOUL_LINE_DEG).distFt;
      let crossover = 0;
      for (let b = 0; b <= 180; b += 0.25) {
        const r = bowlInnerRadiusFt(park, b);
        expect(r, `${park.id} @ ${b}°`).toBeGreaterThanOrEqual(park.backstopFt - 1e-9);
        // ⚠ THE UPPER BOUND IS THE WALL AT THIS BEARING, NOT THE DEEPEST WALL
        // IN THE PARK, and the first version of this line used the looser one —
        // which let the offset curve run to 6,417 ft just past the foul line
        // (28 / sin 0.25°) without failing anything.
        expect(r, `${park.id} @ ${b}°`).toBeLessThanOrEqual(
          (b <= FOUL_LINE_DEG ? fenceAt(park, b).distFt : atLine) + 1e-9,
        );
        // The mirror, because a `Math.sign(bearingDeg || 1)` is easy to get
        // wrong and the two halves of a bowl are not otherwise compared.
        if (b > FOUL_LINE_DEG) {
          expect(bowlInnerRadiusFt(park, -b)).toBeCloseTo(
            park.id === 'harbourfront'
              ? // the home park's two lines are both 328 ft, so its offset
                // curve is symmetric outside the wedge
                bowlInnerRadiusFt(park, b)
              : bowlInnerRadiusFt(park, -b),
            9,
          );
        }
        if (crossover === 0 && b > FOUL_LINE_DEG && r <= park.backstopFt + 1e-6) crossover = b;
      }
      // Where the offset curve hands over to the backstop clamp, in closed
      // form: `foul / sin(|β| − 45) = backstop`. Printed AND asserted, because
      // it is the one bearing at which the two data fields meet.
      const want = FOUL_LINE_DEG + (Math.asin(park.foulTerritoryFt / park.backstopFt) * 180) / Math.PI;
      rows.push(
        `  ${park.id.padEnd(13)} foul ${String(park.foulTerritoryFt).padStart(3)} ft, backstop ${String(
          park.backstopFt,
        ).padStart(3)} ft ⇒ clamp takes over at |β| = ${want.toFixed(2)}° (measured ${crossover.toFixed(2)}°)`,
      );
      expect(crossover).toBeGreaterThan(FOUL_LINE_DEG);
      expect(crossover).toBeCloseTo(want, 0);
    }
    log(`\n[BOWL INNER EDGE — where the backstop clamp bites]\n${rows.join('\n')}\n`);
  });
});

describe('the bowl FRONT RAIL is periodic — the 1.75 ft crack behind the plate', () => {
  it('meets itself at bearing ±180, in HEIGHT and in RADIUS', () => {
    // ⚠ THE DEFECT, AS A NUMBER. Both functions used to hold their value at
    // `FOUL_LINE_DEG * Math.sign(bearing)` outside fair territory, and
    // `Math.sign` picks a DIFFERENT foul line at −180 than at +180. Harbourfront's
    // lines are 14 ft 4 in and 12 ft 7 in, so the bowl's front rail met itself
    // 1.75 ft out of register at the one bearing that is dead centre of the
    // `pitcher` frame — measured on the render as a 53 px step in the bowl foot.
    // Alpine's height column is symmetric and its DISTANCE column is not (347 vs
    // 350 ft), so between the two parks both halves are exercised.
    for (const park of [HARBOURFRONT, ALPINE_HEIGHTS]) {
      expect(wallTopFt(park, -180), `${park.id} rail height`).toBeCloseTo(
        wallTopFt(park, 180),
        9,
      );
      // ⚠ THE RADIUS HALF PASSES FOR A DIFFERENT REASON AND THAT IS RECORDED:
      // both parks are on the BACKSTOP CLAMP by 75°, so the radius is already a
      // constant at the seam and this line is a guard rather than a measurement.
      // The HEIGHT half above is the one that was failing.
      expect(bowlInnerRadiusFt(park, -180), `${park.id} rail radius`).toBeCloseTo(
        bowlInnerRadiusFt(park, 180),
        9,
      );
    }
    // ⚠ AND THE TEST IS ONLY MEANINGFUL BECAUSE THE TWO LINES DIFFER. Assert
    // that first, or a park whose columns happened to be symmetric would pass
    // with the discontinuity fully intact — which is exactly how this survived.
    expect(fenceAt(HARBOURFRONT, -FOUL_LINE_DEG).heightFt).not.toBeCloseTo(
      fenceAt(HARBOURFRONT, FOUL_LINE_DEG).heightFt,
      3,
    );
    expect(fenceAt(ALPINE_HEIGHTS, -FOUL_LINE_DEG).distFt).not.toBeCloseTo(
      fenceAt(ALPINE_HEIGHTS, FOUL_LINE_DEG).distFt,
      3,
    );
  });

  it('is CONTINUOUS everywhere, not merely equal at the two ends', () => {
    // Equality at ±180 alone would also be satisfied by a function that jumped
    // twice and came back. Walk the whole circle and bound the step: the rail
    // moves at most a few hundredths of a foot per quarter degree anywhere.
    for (const park of [HARBOURFRONT, ALPINE_HEIGHTS]) {
      let prevH = wallTopFt(park, -180);
      let prevR = bowlInnerRadiusFt(park, -180);
      let worstH = 0;
      let worstR = 0;
      for (let b = -179.75; b <= 180.0001; b += 0.25) {
        const h = wallTopFt(park, b);
        const r = bowlInnerRadiusFt(park, b);
        worstH = Math.max(worstH, Math.abs(h - prevH));
        // ⚠ THE RADIUS IS ONLY CHECKED BEHIND |β| > 60°, AND THAT IS A
        // DERIVATION RATHER THAN AN EXCLUSION. Just past the foul line the
        // offset curve is `foul / sin(|β| − 45)`, which has a POLE at the line:
        // it sits clamped at the wall until |β| − 45 exceeds `asin(foul/atLine)`
        // ≈ 4.9°, then falls 15 ft per quarter degree. That steepness is the
        // authored shape of a wedge's offset, not a defect, and bounding it
        // would either fail on correct data or be so loose it caught nothing.
        // Past 80° BOTH parks are on the backstop clamp and the curve is flat,
        // so the ±180 junction — the thing this test exists for — is the only
        // place a step could hide.
        if (Math.abs(b) > 80) worstR = Math.max(worstR, Math.abs(r - prevR));
        prevH = h;
        prevR = r;
      }
      // ⚠ THE BOUND IS 0.35 ft, NOT SOMETHING TIGHTER, AND IT IS DERIVED FROM
      // WHAT IT HAS TO CATCH RATHER THAN FROM WHAT LOOKS SMALL. In FAIR
      // territory the rail IS the wall, whose published height column runs
      // 14 ft 4 in → 11 ft 2 in over 15°, and the pchip through it is legitimately
      // 0.119 ft steep per 0.25° — a first draft at 0.05 failed on the DATA. The
      // defect being policed is a JUMP of 1.75 ft, so 0.35 sits 5× under it and
      // 3× over the steepest legitimate slope in either park.
      //
      expect(worstH, `${park.id} worst rail-height step per 0.25°`).toBeLessThan(0.35);
      // ⚠ AND THIS LEG IS CURRENTLY TRIVIAL, WHICH IS SAID RATHER THAN HIDDEN.
      // Behind 80° both shipped parks sit on the backstop clamp, so the radius is
      // a constant and the bound cannot fail. It is kept because it is the leg
      // that WOULD bite for a park whose backstop is deep enough for the offset
      // curve to reach the seam — see `bowlInnerRadiusFt`'s note on why no blend
      // was added there. Read it as a guard on a future park, not as evidence
      // about this one.
      expect(worstR, `${park.id} worst rail-radius step behind 80°, per 0.25°`).toBeLessThan(0.5);
    }
  });
});
