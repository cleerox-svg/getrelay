// The derby's readout copy, asserted directly rather than through a mounted HUD.
//
// ⚠ WHY THIS FILE EXISTS AT ALL. `DerbyGame.test.tsx` can only see a string by
// pumping a 24-pitch session at a hand-cranked clock until the outcome it wants
// happens to occur, which means the outcomes it does NOT reach are untested —
// and "in play, 405 ft, +86" is precisely the outcome M2 shipped as
// `'In play — out'` with no number on it. A pure `SwingResult → string` function
// can be driven at every outcome in a millisecond, so it is.
//
// FOUR MUTATIONS WERE WATCHED TO FAIL — each applied, this file run, then
// reverted. Observed counts:
//
//   1. `describeSwing` reverted to M2's `'In play — out'` /
//      `'Off the wall'` / `'Foul ball'` (no distance, no payout)  → 2 fail
//   2. `coachSwing`'s `distFt < clearFt` guard flipped to `>`     → 2 fail
//   3. `coachSwing` fires on a home run too (outcome check
//      dropped) — i.e. the line stops being self-extinguishing    → 1 fail
//   4. `parkCopyNumbers` reads the FOUL-LINE samples as the gaps
//      (the `< FOUL_LINE_DEG` filter dropped), so the copy
//      coaches the player at a 328 ft wall he can only hook foul  → 2 fail

import { describe, expect, it } from 'vitest';
import { ALPINE_HEIGHTS, FOUL_LINE_DEG, HARBOURFRONT } from '../../../lib/baseball/parks';
import type { SwingResult } from '../../../lib/baseball/derbyState';
import { coachSwing, describeSwing, parkCopyNumbers } from './swingCopy';

/** A `SwingResult` with only the fields the copy reads set to anything real. */
function swing(over: Partial<SwingResult>): SwingResult {
  return {
    outcome: 'inPlay',
    points: 0,
    timingErrorS: 0,
    undercutIn: 0,
    lateralIn: 0,
    contactZM: 0.72,
    evMph: 100,
    laDeg: 27,
    sprayDeg: 0,
    distFt: 0,
    hangS: 5,
    apexFt: 100,
    barrel: false,
    fence: 'inPlay',
    fenceDistFt: 400,
    flight: null,
    pitchId: 'ff',
    plateX: 0,
    plateH: 2.5,
    plateSpeedMph: 92,
    strike: true,
    ...over,
  };
}

describe('derby copy — every scoring outcome shows its payout', () => {
  it('a well-struck ball that stayed in the park no longer reads like a whiff', () => {
    // ⚠ THE DEFECT, IN ONE ASSERTION. M2's string for this swing was
    // `'In play — out'`: no distance, no points, identical in information to
    // `'Swing and a miss'` — for a 405 ft fly ball that the payout now pays 87
    // points for. The player hit it well and the game said nothing happened.
    const caught = describeSwing(swing({ outcome: 'inPlay', distFt: 405.4, points: 87 }));
    expect(caught).toContain('405');
    expect(caught).toContain('+87');

    // Every outcome that CAN score says what it scored; the two that never can
    // say nothing, because `+0` on a whiff is true and useless and `+0` on a
    // foul would be a lie.
    const scoring: SwingResult[] = [
      swing({ outcome: 'homeRun', distFt: 412.2, points: 162 }),
      swing({ outcome: 'inPlay', fence: 'offWall', distFt: 398.9, points: 85 }),
      swing({ outcome: 'inPlay', distFt: 261.0, points: 37 }),
      swing({ outcome: 'foul', distFt: 340.5, points: 16 }),
    ];
    for (const r of scoring) {
      expect(describeSwing(r), r.outcome).toMatch(/\+\d+/);
      expect(describeSwing(r)).toContain(`+${r.points}`);
    }
    for (const r of [
      swing({ outcome: 'whiff', points: 0 }),
      swing({ outcome: 'take', points: 0, strike: true }),
      swing({ outcome: 'take', points: 0, strike: false }),
    ]) {
      expect(describeSwing(r), r.outcome).not.toMatch(/\+/);
    }

    // The three fair-ball wordings stay distinguishable — off the wall is not a
    // catch, and a home run is not either.
    expect(describeSwing(swing({ outcome: 'homeRun', distFt: 412, points: 162 }))).toContain('GONE');
    expect(
      describeSwing(swing({ outcome: 'inPlay', fence: 'offWall', distFt: 399, points: 85 })),
    ).toContain('Off the wall');
    expect(describeSwing(swing({ outcome: 'inPlay', distFt: 399, points: 85 }))).toContain('Caught');
  });
});

describe('derby copy — the coaching line is contextual and self-extinguishing', () => {
  it('fires only on an in-play ball that had home-run carry to the gaps', () => {
    const { deepFt, gapFt, clearFt } = parkCopyNumbers(HARBOURFRONT);
    // The numbers the copy quotes, against the park's own data block.
    expect(deepFt).toBe(400);
    expect(gapFt).toBe(375);
    expect(clearFt).toBe(385);
    // ⚠ AND THE GAPS ARE NOT THE FOUL LINES. Harbourfront's line samples are
    // 328 ft, and a copy that quoted them would be coaching a hook into the
    // seats down the line — which `PULL_INTENT_MAX_IN` makes reachable and
    // rules a FOUL. The filter is what stops that, so it is asserted here.
    expect(Math.min(...HARBOURFRONT.fence.map((s) => s.distFt))).toBe(328);
    expect(gapFt).toBeGreaterThan(328);

    // Fires: a ball with the carry to clear the gaps that stayed in the park.
    expect(coachSwing(swing({ outcome: 'inPlay', distFt: 405 }), gapFt, clearFt)).toContain('375');
    // Silent: not enough carry — the aim was not the problem.
    expect(coachSwing(swing({ outcome: 'inPlay', distFt: 300 }), gapFt, clearFt)).toBeNull();
    expect(coachSwing(swing({ outcome: 'inPlay', distFt: clearFt - 0.1 }), gapFt, clearFt)).toBeNull();
    // SELF-EXTINGUISHING: a player who is already clearing the wall, hooking it
    // foul or missing entirely is not the player this line is for.
    for (const o of ['homeRun', 'foul', 'whiff', 'take'] as const) {
      expect(coachSwing(swing({ outcome: o, distFt: 430 }), gapFt, clearFt), o).toBeNull();
    }
  });

  it('a second park prints its OWN dimensions', () => {
    // The copy is data-driven or it is wrong at Alpine, which is deeper and
    // asymmetric and carries a 16 ft wall in left-centre.
    const h = parkCopyNumbers(HARBOURFRONT);
    const a = parkCopyNumbers(ALPINE_HEIGHTS);
    expect(a.deepFt).not.toBe(h.deepFt);
    // ⚠ THE GAP DISTANCE HAPPENS TO MATCH (both parks sample a 375 ft gap), and
    // that is why the CLEARANCE is the assertion with teeth: Alpine's 16 ft wall
    // in left-centre makes it 383 against Harbourfront's uniform-10 ft 385, so a
    // copy that read the height from the wrong park would be caught here and
    // nowhere else.
    expect(a.gapFt).toBe(h.gapFt);
    expect(a.clearFt).not.toBe(h.clearFt);
    // The clearance datum tracks the WALL HEIGHT, not just the distance — the
    // whole reason it is `dist + height` and not `dist`.
    //
    // ⚠ FROM THE CONSTANT, NOT FROM `45`. This re-derivation exists to check
    // `parkCopyNumbers`, so it has to filter on the same thing the
    // implementation does; a literal here would keep passing if `FOUL_LINE_DEG`
    // ever moved and the implementation followed it, which is the one case a
    // re-derivation is for.
    const fair = ALPINE_HEIGHTS.fence.filter((s) => Math.abs(s.bearingDeg) < FOUL_LINE_DEG);
    expect(a.clearFt).toBe(Math.min(...fair.map((s) => s.distFt + s.heightFt)));
    expect(a.clearFt).toBeGreaterThan(a.gapFt);
    // eslint-disable-next-line no-console
    console.log(
      `\n[COPY] park numbers the coaching line quotes\n` +
        `  ${HARBOURFRONT.name}: deep ${h.deepFt} ft, gaps ${h.gapFt} ft, clears at ${h.clearFt}\n` +
        `  ${ALPINE_HEIGHTS.name}: deep ${a.deepFt} ft, gaps ${a.gapFt} ft, clears at ${a.clearFt}`,
    );
  });
});
