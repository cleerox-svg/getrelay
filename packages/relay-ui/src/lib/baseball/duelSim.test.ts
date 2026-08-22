// The duel bench.
//
// `duelSim.ts` writes no physics, so this file re-asserts none. What it asserts
// is what a GAME LOOP can get wrong that a physics bench cannot see: that the
// count obeys the rule book, that a runner advances the number of bases he is
// entitled to and not one more, that a half-inning ends on exactly three outs,
// that the game ends where baseball says it ends, that the pitcher's stop error
// lands on the right axis with the right sign, and that a seed replays a game
// pitch for pitch.
//
// It also PRINTS the outcome distribution AND the ground-ball table, because a
// duel can be inside every tolerance and still be a game in which nothing ever
// happens — and because the ground-ball out rate is where the one number the
// rolling phase calibrates (`groundBall.ROLL_DECEL_DIRT_FPS2`) is measured. ⚠ The
// rate alone is not the claim: `groundBall.test.ts` carries the structure
// assertions that a coin-flip model hitting the same rate would fail. ⚠ The bands on
// that table are REGRESSION FENCES rather than a calibration — roughly ±50 %
// around the measured values — and the assertions that actually guard its SHAPE
// are the monotonicity checks (a better AI strikes out less and walks less) plus
// `HR per ball in play`, which is the one band known to bite on a real defect.
// The bench's own comment says so at the assertions; this line and that one have
// to agree, and an earlier draft of both oversold it.
//
// TWENTY-ONE MUTATIONS WERE WATCHED — each applied to the source, the duel, AI,
// budget and determinism suites run, then reverted, with the pristine text
// byte-compared back and a GREEN BASELINE re-established first. Observed failure
// counts, not predicted ones, in the convention `derbySim.test.ts` sets.
//
//   1. `advanceRunners` advances every runner one base too far        → 1 fail
//   2. `forceWalk` moves runners who are not forced                   → 1 fail
//   3. the foul clause's `Math.min` deleted (2-strike foul = K)       → 2 fail
//   4. `halfIsOver` fires at TWO outs                                 → 2 fail
//   5. `advanceHalf` never ends the game after the bottom of
//      regulation                                                     → 2 fail
//   6. `isWalkOff` reads `>=`, so a TYING run wins the game           → 1 fail
//   7. `pitchLocation`'s lateral term loses `armSideX` (mirrored)     → 1 fail
//   8. `pitchLocation`'s two axes swapped                             → 1 fail
//   9. `DUEL_ASSIST` reverted to the derby's shoulder                 → 2 fail
//  10. `duelSim` stops passing the duel assist into `aimSwing`        → 1 fail
//  11. `rngState` dropped from `duelSnapshot`                         → 1 fail
//  12. `getState` hands out `bases` by reference                      → 1 fail
//  13. `paOutcomeOf` checks the strikeout before the walk             → 1 fail
//  14. `aiSwingDecision` ignores its `difficulty` argument            → 3 fail
//  15. `aiPitchCommand` ignores its `difficulty` argument             → 3 fail
//  16. the AI's timing draw moves inside a branch (variable draw
//      count, so the next pitch depends on the last decision)         → 7 fail
//  17. the count is not reset after a plate appearance                → 5 fail
//  18. a caught foul pop is scored a FOUL rather than an out          → 1 fail
//  19. `advanceHalf` clears the outs and bases on a FINISHED game     → 1 fail
//  20. `duelSnapshot` hands out `served` by reference                 → 1 fail
//  21. `applyPa` spreads the whole live sim back through `Situation`  → 1 fail
//
// ⚠ THREE OF THEM SURVIVED THE FIRST PASS, and those three are the most
// informative rows in the table, because each exposed a real gap rather than a
// missing assertion:
//
//   • (13) SURVIVED, and it is UNREACHABLE rather than untested: one pitch moves
//     one number, so no legal count can reach four balls AND three strikes at
//     once, and the ordering can never be observed. Closed by asserting the
//     PROPERTY the ordering rests on — exclusivity over all 60 legal
//     count × outcome pairs — plus the ordering itself on the impossible input,
//     so the STATEMENT of the rule is pinned. Same category `fielding.ts`
//     records for its infield cap.
//   • (19) SURVIVED because the game-over assertion only covered the
//     BOTTOM-half branch, and the mutation lived in the top-half one (the home
//     team not batting because it already leads). Two returns, one assertion.
//     Closed by asserting the final state on BOTH branches.
//   • (21) SURVIVED because it is behaviourally invisible today — the machine is
//     handed a superset and writes it back unchanged. Closed STRUCTURALLY, by
//     asserting the machine returns exactly the six `Situation` keys, since
//     nothing about the game's behaviour can see it until the day it can.

import { describe, expect, it } from 'vitest';
import { vLen } from './airPhysics';
import type { PitchCommand } from './ai';
import { aiPitchCommand, aiSwingDecision } from './ai';
import { DERBY_ASSIST, aimErrorForUndercutIn, reticleResidual } from './batterAim';
import { LOC_DISTANCE_IN } from './bat';
import { SWING_UNDERCUT_IN } from './batterAim';
import {
  addLineRuns,
  advanceHalf,
  applyPa,
  battingTeam,
  countAfter,
  halfIsOver,
  isWalkOff,
  paOutcomeOf,
  winnerOf,
} from './duelInnings';
import type { PaOutcome, Situation } from './duelInnings';
import {
  BALLS_FOR_WALK,
  COMMAND_MISS_H_FT,
  COMMAND_MISS_X_FT,
  DUEL_ASSIST,
  DUEL_MIX,
  EMPTY_BASES,
  FOUL_PROTECTED_STRIKES,
  MAX_INNINGS,
  OUTS_PER_HALF,
  REGULATION_INNINGS,
  STRIKES_FOR_K,
  advanceRunners,
  forceWalk,
  pitchLocation,
  resolveDuelConfig,
  validateDuelFormat,
  validateDuelMix,
} from './duelRules';
import type { Bases, DuelConfig } from './duelRules';
import { DuelSim } from './duelSim';
import { ALIGNMENT } from './fielders';
import { simDraw } from './rng';
import { CALL_ZONE, ZONE_CENTER, isStrike } from './zone';

const ownDataProps = (o: object) =>
  Object.keys(o)
    .filter((k) => typeof (o as Record<string, unknown>)[k] !== 'function')
    .sort();

const b = (s: string): Bases => [s[0] === '1', s[1] === '2', s[2] === '3'];
const show = (x: Bases) => `${x[0] ? '1' : '-'}${x[1] ? '2' : '-'}${x[2] ? '-3'.slice(1) : '-'}`;

/** The human bats FIRST, so a scripted test controls the bat from pitch one. */
const scripted = (over: Partial<DuelConfig> = {}) =>
  new DuelSim({ seed: 7, humanBats: 'away', ...over });

const MEATBALL: PitchCommand = { id: 'ff', intentX: 0, intentH: ZONE_CENTER.h, stopError: 0 };
const WAY_OUTSIDE: PitchCommand = { id: 'ff', intentX: 1.7, intentH: ZONE_CENTER.h, stopError: 0 };

/**
 * Serve a meatball and swing at it. `underIn` is how far BELOW the pitch the
 * reticle sits, in inches: + means aiming under the ball, which adds undercut
 * and raises the launch angle, and − means aiming over it, which takes undercut
 * away and drives the ball into the ground. 0 is the reference swing.
 */
function swingWith(sim: DuelSim, underIn: number, dtMs = 0) {
  const pr = sim.servePitch(MEATBALL);
  sim.setReticle(pr.plate.x, pr.plate.h - underIn / 12);
  return sim.swing(pr.plate.t + dtMs / 1000);
}

// ===========================================================================
describe('duel — the format and its data', () => {
  it('the format validates, and the three count rules are the rule book', () => {
    expect(validateDuelFormat()).toEqual([]);
    expect(validateDuelMix()).toEqual([]);
    expect(OUTS_PER_HALF).toBe(3);
    expect(BALLS_FOR_WALK).toBe(4);
    expect(STRIKES_FOR_K).toBe(3);
    expect(FOUL_PROTECTED_STRIKES).toBe(2);
    expect(REGULATION_INNINGS).toBe(3);
    expect(MAX_INNINGS).toBeGreaterThan(REGULATION_INNINGS);
    // …and the validator BITES rather than being a decorative green tick.
    expect(validateDuelFormat(0).join(' | ')).toContain('innings 0');
    expect(validateDuelFormat(MAX_INNINGS + 1).join(' | ')).toContain('exceeds');
    expect(validateDuelMix([{ id: 'ff', weight: 0.5, chase: 0 }]).length).toBeGreaterThan(0);
    expect(validateDuelMix([{ id: 'ff', weight: 1, chase: 9 }]).join(' | ')).toContain('chase');
  });

  it('the config path VALIDATES and throws — it does not silently repair', () => {
    expect(() => new DuelSim({ seed: 1, innings: -3 })).toThrow(/invalid duel config/);
    expect(() => new DuelSim({ seed: 1, difficulty: 2 })).toThrow(/difficulty/);
    expect(() => new DuelSim({ seed: 1, defense: -1 })).toThrow(/defense/);
    expect(() => new DuelSim({ seed: Number.NaN })).toThrow(/seed/);
    const c = resolveDuelConfig({ seed: 5 });
    expect(c.humanBats).toBe('home');
    expect(c.innings).toBe(REGULATION_INNINGS);
    expect(c.roofClosed).toBe(true);
  });

  it('⚠ the duel arsenal is DATA, and every published pitch stays reachable', () => {
    // "Content is data, not a branch": a ninth pitch is a row in pitches.ts.
    expect(DUEL_MIX.length).toBe(8);
    expect(DUEL_MIX.reduce((s, m) => s + m.weight, 0)).toBeCloseTo(1, 12);
    // …and it is NOT the derby's cooperating mix: the breaking balls roughly
    // double, which is the difference between a server and an opponent.
    const breaking = DUEL_MIX.filter((m) => m.id === 'sl' || m.id === 'st' || m.id === 'cu')
      .reduce((s, m) => s + m.weight, 0);
    expect(breaking).toBeGreaterThan(0.28);
  });
});

// ===========================================================================
describe('duel — the pitcher command map', () => {
  it('⚠ a FULL stop error lands EXACTLY on the called-zone corner', () => {
    // The derivation, asserted rather than described: the displacement at
    // |e| = 1 is the called zone's half-width and half-height, so the worst
    // legal miss on a pitch aimed at dead centre is the first pitch that is not
    // a strike. That one sentence fixes BOTH the scale and the axis.
    const centre = { x: 0, h: ZONE_CENTER.h };
    const early = pitchLocation(centre, 1, 'R');
    expect(early.x).toBeCloseTo(CALL_ZONE.left, 12);
    expect(early.h).toBeCloseTo(CALL_ZONE.top, 12);
    expect(isStrike(early.x, early.h)).toBe(true);
    // …and a hair past it is a ball. The boundary is a boundary.
    const past = pitchLocation(centre, 1, 'R', 1.001);
    expect(isStrike(past.x, past.h)).toBe(false);

    // ⚠ SIGN. `e > 0` is the EARLY release: up and to the pitcher's ARM side,
    // which for a RHP is REPORT −x (the third-base side). Dropping `armSideX`
    // mirrors every command miss in the game.
    expect(early.x).toBeLessThan(0);
    expect(early.h).toBeGreaterThan(centre.h);
    const late = pitchLocation(centre, -1, 'R');
    expect(late.x).toBeGreaterThan(0);
    expect(late.h).toBeLessThan(centre.h);
    // A left-hander mirrors laterally and NOT vertically — the arm slot tilts,
    // it does not invert.
    const lhp = pitchLocation(centre, 1, 'L');
    expect(lhp.x).toBeCloseTo(-early.x, 12);
    expect(lhp.h).toBeCloseTo(early.h, 12);

    // ⚠ AXIS. The lateral term uses the zone's WIDTH and the vertical its
    // HEIGHT; swapping them is a mutation that no `isStrike` test alone catches,
    // because the swapped corner is still a corner of a box.
    expect(Math.abs(early.x - centre.x)).toBeCloseTo(COMMAND_MISS_X_FT, 12);
    expect(Math.abs(early.h - centre.h)).toBeCloseTo(COMMAND_MISS_H_FT, 12);
    expect(COMMAND_MISS_X_FT).not.toBeCloseTo(COMMAND_MISS_H_FT, 2);
  });

  it('zero error is the intent, the error is linear, and it clamps', () => {
    const t = { x: 0.2, h: 2.8 };
    expect(pitchLocation(t, 0, 'R')).toEqual(t);
    const half = pitchLocation(t, 0.5, 'R');
    const full = pitchLocation(t, 1, 'R');
    expect(half.x - t.x).toBeCloseTo((full.x - t.x) / 2, 12);
    expect(half.h - t.h).toBeCloseTo((full.h - t.h) / 2, 12);
    expect(pitchLocation(t, 9, 'R')).toEqual(full);
    // …and `missScale` is the one modulator: a COMMAND card scales the miss.
    expect(pitchLocation(t, 1, 'R', 0).x).toBeCloseTo(t.x, 12);
    expect(pitchLocation(t, 1, 'R', 0.5).x - t.x).toBeCloseTo((full.x - t.x) / 2, 12);
  });

  it('the sim actually THROWS the located pitch, and prints the command ladder', () => {
    const rows: string[] = [];
    for (const e of [-1, -0.5, 0, 0.5, 1]) {
      const sim = scripted();
      const pr = sim.servePitch({ id: 'ff', intentX: 0, intentH: ZONE_CENTER.h, stopError: e });
      rows.push(
        `  stop ${e.toFixed(2).padStart(5)}  target (${sim.served!.targetX.toFixed(3)}, ` +
          `${sim.served!.targetH.toFixed(3)})  crossed (${pr.plate.x.toFixed(3)}, ` +
          `${pr.plate.h.toFixed(3)})  ${pr.plate.strike ? 'STRIKE' : 'ball  '}`,
      );
      // The aim solve puts the ball where the command map asked, to the inch.
      expect(Math.hypot(pr.plate.x - sim.served!.targetX, pr.plate.h - sim.served!.targetH))
        .toBeLessThan(0.01);
    }
    // eslint-disable-next-line no-console
    console.log('\n[DUEL COMMAND — RHP, 4-seamer aimed at dead centre]\n' + rows.join('\n'));
  });
});

// ===========================================================================
describe('duel — the bases: FORCED ADVANCE ONLY', () => {
  it('⚠ every runner advances EXACTLY the batter’s bases, and no more', () => {
    const rows: string[] = [];
    for (const start of ['---', '1--', '-2-', '--3', '12-', '1-3', '-23', '123']) {
      const cells = [1, 2, 3, 4].map((g) => {
        const r = advanceRunners(b(start), g);
        return `${show(r.bases)}/${r.runs}`;
      });
      const w = forceWalk(b(start));
      rows.push(`  ${start}   ${cells.join('   ')}   BB ${show(w.bases)}/${w.runs}`);
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n[BASES — forced advance only. cells: 1B / 2B / 3B / HR, then the walk]\n' +
        '  from     single      double      triple     homer\n' +
        rows.join('\n') +
        '\n  ⚠ A SINGLE DOES NOT SCORE FROM SECOND. Deliberate, and it biases scoring DOWN.\n',
    );

    // The rule, one base at a time. An off-by-one in either direction is caught.
    expect(advanceRunners(b('---'), 1)).toEqual({ bases: b('1--'), runs: 0 });
    expect(advanceRunners(b('-2-'), 1)).toEqual({ bases: b('1-3'), runs: 0 });
    expect(advanceRunners(b('--3'), 1)).toEqual({ bases: b('1--'), runs: 1 });
    expect(advanceRunners(b('123'), 1)).toEqual({ bases: b('123'), runs: 1 });
    expect(advanceRunners(b('1--'), 2)).toEqual({ bases: b('-23'), runs: 0 });
    expect(advanceRunners(b('12-'), 2)).toEqual({ bases: b('-23'), runs: 1 });
    expect(advanceRunners(b('1--'), 3)).toEqual({ bases: b('--3'), runs: 1 });
    expect(advanceRunners(b('123'), 4)).toEqual({ bases: b('---'), runs: 4 });
    expect(advanceRunners(b('---'), 4)).toEqual({ bases: b('---'), runs: 1 });

    // ⚠ THE SIMPLIFICATION ITSELF, pinned so it cannot drift into a model. A
    // real single scores a runner from second more often than not; here he
    // stops at third, and a real double scores him from first.
    expect(advanceRunners(b('-2-'), 1).runs).toBe(0);
    expect(advanceRunners(b('1--'), 2).runs).toBe(0);

    expect(() => advanceRunners(b('---'), 0)).toThrow();
    expect(() => advanceRunners(b('---'), 5)).toThrow();
  });

  it('a walk forces ONLY the runners with nowhere to go', () => {
    expect(forceWalk(b('---'))).toEqual({ bases: b('1--'), runs: 0 });
    expect(forceWalk(b('1--'))).toEqual({ bases: b('12-'), runs: 0 });
    // ⚠ THE ONE A "MOVE EVERYBODY" MUTATION GETS WRONG: first is empty, so the
    // runner on second does not move at all.
    expect(forceWalk(b('-2-'))).toEqual({ bases: b('12-'), runs: 0 });
    expect(forceWalk(b('--3'))).toEqual({ bases: b('1-3'), runs: 0 });
    expect(forceWalk(b('1-3'))).toEqual({ bases: b('123'), runs: 0 });
    expect(forceWalk(b('12-'))).toEqual({ bases: b('123'), runs: 0 });
    expect(forceWalk(b('123'))).toEqual({ bases: b('123'), runs: 1 });
  });
});

// ===========================================================================
describe('duel — the count', () => {
  it('⚠ a FOUL with two strikes leaves the count at two, forever', () => {
    expect(countAfter({ balls: 0, strikes: 0 }, 'foul')).toEqual({ balls: 0, strikes: 1 });
    expect(countAfter({ balls: 0, strikes: 1 }, 'foul')).toEqual({ balls: 0, strikes: 2 });
    // The rule. Deleting the `Math.min` makes every two-strike foul a strikeout.
    expect(countAfter({ balls: 0, strikes: 2 }, 'foul')).toEqual({ balls: 0, strikes: 2 });
    expect(paOutcomeOf('foul', countAfter({ balls: 0, strikes: 2 }, 'foul'), 'FOUL')).toBeNull();
    for (let i = 0; i < 20; i++) {
      expect(countAfter({ balls: 3, strikes: 2 }, 'foul').strikes).toBe(2);
    }
    // …and the other three clauses.
    expect(countAfter({ balls: 1, strikes: 1 }, 'ball')).toEqual({ balls: 2, strikes: 1 });
    expect(countAfter({ balls: 1, strikes: 1 }, 'calledStrike')).toEqual({ balls: 1, strikes: 2 });
    expect(countAfter({ balls: 1, strikes: 1 }, 'swingingStrike')).toEqual({ balls: 1, strikes: 2 });
    expect(countAfter({ balls: 1, strikes: 1 }, 'inPlay')).toEqual({ balls: 1, strikes: 1 });
  });

  it('four balls walk, three strikes retire, and the WALK is checked first', () => {
    expect(paOutcomeOf('ball', { balls: 4, strikes: 2 }, null)).toBe('walk');
    expect(paOutcomeOf('ball', { balls: 3, strikes: 2 }, null)).toBeNull();
    expect(paOutcomeOf('calledStrike', { balls: 3, strikes: 3 }, null)).toBe('strikeout');
    expect(paOutcomeOf('swingingStrike', { balls: 0, strikes: 2 }, null)).toBeNull();
    expect(paOutcomeOf('inPlay', { balls: 1, strikes: 1 }, 'DOUBLE')).toBe('double');
    expect(paOutcomeOf('inPlay', { balls: 1, strikes: 1 }, 'HR')).toBe('homeRun');
    expect(paOutcomeOf('inPlay', { balls: 1, strikes: 1 }, 'OUT')).toBe('out');
    // A ball in play with no fielding answer is a bug, and it is LOUD.
    expect(() => paOutcomeOf('inPlay', { balls: 0, strikes: 0 }, null)).toThrow();
  });

  it('⚠ the walk and the strikeout are MUTUALLY EXCLUSIVE from any legal count', () => {
    // ⚠ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Swapping the walk and
    // strikeout checks in `paOutcomeOf` failed NOTHING, and the reason is worth
    // more than the fix: one pitch moves one number, so no legal count can
    // reach four balls and three strikes at the same time. The reordering is
    // UNREACHABLE, not merely unobserved — the same category `fielding.ts`
    // records for its infield cap.
    //
    // So the honest guard is the PROPERTY the ordering rests on, asserted over
    // every legal count and every pitch outcome, plus the ordering itself
    // asserted directly on the impossible input so that the STATEMENT of the
    // rule is pinned. The day a rule arrives that can produce both at once — a
    // foul-bunt strikeout, an intentional walk shortcut — the first of these
    // fails instead of the game quietly calling the wrong one.
    const outcomes = ['ball', 'calledStrike', 'swingingStrike', 'foul', 'inPlay'] as const;
    let checked = 0;
    for (let balls = 0; balls < BALLS_FOR_WALK; balls++) {
      for (let strikes = 0; strikes < STRIKES_FOR_K; strikes++) {
        for (const o of outcomes) {
          const c = countAfter({ balls, strikes }, o);
          expect(
            c.balls >= BALLS_FOR_WALK && c.strikes >= STRIKES_FOR_K,
            `count ${balls}-${strikes} + ${o} reached BOTH a walk and a strikeout`,
          ).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBe(BALLS_FOR_WALK * STRIKES_FOR_K * outcomes.length);
    // …and the order, on the input the rules cannot produce.
    expect(paOutcomeOf('ball', { balls: BALLS_FOR_WALK, strikes: STRIKES_FOR_K }, null)).toBe('walk');
  });

  it('the live sim walks, strikes out, and survives a two-strike foul', () => {
    const sim = scripted();
    for (let i = 0; i < 3; i++) {
      sim.servePitch(WAY_OUTSIDE);
      const r = sim.take();
      expect(r.outcome).toBe('ball');
      expect(r.pa).toBeNull();
    }
    sim.servePitch(WAY_OUTSIDE);
    const w = sim.take();
    expect(w.pa?.outcome).toBe('walk');
    expect(sim.bases).toEqual([true, false, false]);
    expect(sim.balls).toBe(0);

    const k = scripted({ seed: 11 });
    for (let i = 0; i < 2; i++) {
      k.servePitch(MEATBALL);
      expect(k.take().outcome).toBe('calledStrike');
    }
    k.servePitch(MEATBALL);
    const out = k.take();
    expect(out.pa?.outcome).toBe('strikeout');
    expect(k.outs).toBe(1);

    // …and a two-strike foul is survivable an unbounded number of times.
    const f = scripted({ seed: 13 });
    f.servePitch(MEATBALL);
    f.take();
    f.servePitch(MEATBALL);
    f.take();
    expect(f.strikes).toBe(2);
    for (let i = 0; i < 5; i++) {
      const r = swingWith(f, 0, 22);
      expect(r.outcome).toBe('foul');
      expect(r.strikesAfter).toBe(2);
      expect(r.pa).toBeNull();
    }
    expect(f.outs).toBe(0);
  });
});

// ===========================================================================
describe('duel — the half-inning state machine', () => {
  const sit = (o: Partial<Situation> = {}): Situation => ({
    inning: 1,
    half: 'top',
    outs: 0,
    bases: EMPTY_BASES,
    awayScore: 0,
    homeScore: 0,
    ...o,
  });

  it('⚠ a half ends on EXACTLY three outs, and not on two', () => {
    expect(halfIsOver(sit({ outs: 0 }))).toBe(false);
    expect(halfIsOver(sit({ outs: 1 }))).toBe(false);
    expect(halfIsOver(sit({ outs: 2 }))).toBe(false);
    expect(halfIsOver(sit({ outs: 3 }))).toBe(true);
    // …and the out only comes from the three outcomes that are outs.
    for (const o of ['out', 'strikeout'] as PaOutcome[]) {
      expect(applyPa(sit(), o).sit.outs).toBe(1);
    }
    for (const o of ['walk', 'single', 'double', 'triple', 'homeRun'] as PaOutcome[]) {
      expect(applyPa(sit(), o).sit.outs).toBe(0);
    }
    // ⚠ AN OUT MOVES NOBODY — no sacrifice fly, and that is the stated cap.
    expect(applyPa(sit({ bases: b('--3') }), 'out')).toEqual({
      sit: sit({ bases: b('--3'), outs: 1 }),
      runs: 0,
    });
  });

  it('the halves roll: top, bottom, next inning — and the bases clear', () => {
    const a = advanceHalf(sit({ outs: 3, bases: b('123') }), 3);
    expect(a.over).toBe(false);
    expect(a.sit.half).toBe('bottom');
    expect(a.sit.inning).toBe(1);
    expect(a.sit.outs).toBe(0);
    expect(a.sit.bases).toEqual(EMPTY_BASES);
    const c = advanceHalf(sit({ half: 'bottom', outs: 3 }), 3);
    expect(c.over).toBe(false);
    expect(c.sit).toMatchObject({ half: 'top', inning: 2 });
    expect(battingTeam('top')).toBe('away');
    expect(battingTeam('bottom')).toBe('home');
  });

  it('⚠ the game ends where BASEBALL says it ends, not one half early or late', () => {
    // (a) after the bottom of regulation with a decision.
    const done = advanceHalf(sit({ inning: 3, half: 'bottom', outs: 3, awayScore: 2 }), 3);
    expect(done.over).toBe(true);
    expect(winnerOf(done.sit)).toBe('away');
    // ⚠ A GAME THAT ENDS KEEPS ITS FINAL STATE. Clearing the outs and the bases
    // on the game-over branches gave a HUD two conventions for one final frame:
    // a game ending on the third out reported `outs === 0` with nobody on, while
    // a walk-off — which never comes through `advanceHalf` — reported the truth.
    expect(done.sit.outs).toBe(3);
    expect(advanceHalf(sit({ inning: 3, half: 'bottom', outs: 3, bases: b('12-'), awayScore: 2 }), 3).sit.bases)
      .toEqual(b('12-'));
    // …while a half that merely turns over is cleared, which is the case above.
    // (b) NOT after the bottom of the second.
    expect(advanceHalf(sit({ inning: 2, half: 'bottom', outs: 3, awayScore: 2 }), 3).over).toBe(false);
    // (c) the home team does not bat in the bottom of the last if it leads.
    const skipped = advanceHalf(sit({ inning: 3, half: 'top', outs: 3, bases: b('-2-'), homeScore: 1 }), 3);
    expect(skipped.over).toBe(true);
    expect(winnerOf(skipped.sit)).toBe('home');
    // ⚠ THIS BRANCH KEEPS ITS FINAL STATE TOO, and it is asserted separately
    // because it is a DIFFERENT return: a mutation that cleared the outs and the
    // bases here alone survived the bottom-half assertion below completely.
    expect(skipped.sit.outs).toBe(3);
    expect(skipped.sit.bases).toEqual(b('-2-'));
    // …but it DOES bat if it trails or is level.
    expect(advanceHalf(sit({ inning: 3, half: 'top', outs: 3, awayScore: 1 }), 3).over).toBe(false);
    expect(advanceHalf(sit({ inning: 3, half: 'top', outs: 3 }), 3).over).toBe(false);
    // (d) level after regulation ⇒ EXTRA INNINGS. Baseball has no tie.
    const extra = advanceHalf(sit({ inning: 3, half: 'bottom', outs: 3, awayScore: 4, homeScore: 4 }), 3);
    expect(extra.over).toBe(false);
    expect(extra.sit).toMatchObject({ inning: 4, half: 'top' });
    // (e) …bounded. MAX_INNINGS is a BOUND, not a rule, and it ends a tie.
    const capped = advanceHalf(
      sit({ inning: MAX_INNINGS, half: 'bottom', outs: 3, awayScore: 1, homeScore: 1 }),
      3,
    );
    expect(capped.over).toBe(true);
    expect(winnerOf(capped.sit)).toBe('tie');
  });

  it('⚠ the WALK-OFF is a STRICT lead, in the bottom, at or past regulation', () => {
    expect(isWalkOff(sit({ inning: 3, half: 'bottom', homeScore: 1 }), 3)).toBe(true);
    expect(isWalkOff(sit({ inning: 4, half: 'bottom', homeScore: 1 }), 3)).toBe(true);
    // A TIE is not a walk-off. `>=` here would end a level game on the spot.
    expect(isWalkOff(sit({ inning: 3, half: 'bottom', homeScore: 1, awayScore: 1 }), 3)).toBe(false);
    // Nor is a lead in the wrong half, or before regulation.
    expect(isWalkOff(sit({ inning: 3, half: 'top', homeScore: 1 }), 3)).toBe(false);
    expect(isWalkOff(sit({ inning: 2, half: 'bottom', homeScore: 1 }), 3)).toBe(false);
  });

  it('⚠ the machine returns a SITUATION — six fields, never the caller’s object', () => {
    // ⚠ THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. `DuelSim` satisfies
    // `Situation` structurally, so `{ ...sit }` inside `applyPa` copies the
    // whole live sim — config, served pitch, PRNG state — and `commit` used to
    // assign all of it straight back. That is a no-op while the machine happens
    // to be handed a superset and writes it back unchanged, and a stale-write
    // the first time a line is inserted between the read and the write. Nothing
    // BEHAVIOURAL can see it, so the assertion is structural: the shape of what
    // comes back.
    const KEYS = ['awayScore', 'bases', 'half', 'homeScore', 'inning', 'outs'];
    const fat = { ...sit(), cfg: { seed: 1 }, rngState: 999, served: {}, pitchCount: 7 };
    expect(Object.keys(applyPa(fat, 'single').sit).sort()).toEqual(KEYS);
    expect(Object.keys(applyPa(fat, 'strikeout').sit).sort()).toEqual(KEYS);
    expect(Object.keys(advanceHalf({ ...fat, outs: 3 }, 3).sit).sort()).toEqual(KEYS);
    expect(Object.keys(advanceHalf({ ...fat, outs: 3, half: 'bottom' }, 3).sit).sort()).toEqual(KEYS);
    expect(
      Object.keys(advanceHalf({ ...fat, inning: 3, outs: 3, half: 'bottom', awayScore: 2 }, 3).sit).sort(),
    ).toEqual(KEYS);
  });

  it('the line score grows to fit, extras included, and is not aliased', () => {
    let line: number[] = [];
    line = addLineRuns(line, 1, 2);
    line = addLineRuns(line, 3, 1);
    expect(line).toEqual([2, 0, 1]);
    const before = line;
    const after = addLineRuns(line, 5, 4);
    expect(after).toEqual([2, 0, 1, 0, 4]);
    expect(before).toEqual([2, 0, 1]);
  });

  it('a LIVE game ends on a WALK-OFF, mid-half, with the winning run on the board', () => {
    // A one-inning duel with the HUMAN batting last — the only arrangement in
    // which a walk-off exists at all. The AI takes its half; then the human hits
    // meatball home runs until he leads, and the game must end on the spot
    // rather than playing the half out.
    const sim = new DuelSim({ seed: 3, innings: 1, humanBats: 'home' });
    let guard = 0;
    while (sim.half === 'top' && sim.phase !== 'done') {
      if (guard++ > 400) throw new Error('the top half did not end');
      sim.servePitch(MEATBALL);
      sim.aiBat();
    }
    expect(sim.phase).toBe('ready');
    expect(sim.half).toBe('bottom');
    expect(sim.outs).toBe(0);
    const chasing = sim.awayScore;

    while (sim.phase !== 'done') {
      if (guard++ > 400) throw new Error('the bottom half did not end');
      const r = swingWith(sim, 0);
      expect(r.pa?.outcome).toBe('homeRun');
    }
    expect(sim.homeScore).toBe(chasing + 1);
    expect(sim.winner).toBe('home');
    expect(sim.lastPa?.gameOver).toBe(true);
    expect(sim.lastPa?.outcome).toBe('homeRun');
    // ⚠ MID-HALF: the half never reached three outs. That is the whole point of
    // testing the walk-off BEFORE the three-out test in `commit`.
    expect(sim.outs).toBeLessThan(OUTS_PER_HALF);
    // …and the sim is CLOSED.
    expect(() => sim.servePitch(MEATBALL)).toThrow(/over/);
  });

  it('a scripted half retires on the third out and hands over', () => {
    const sim = scripted({ seed: 21 });
    for (let outs = 0; outs < OUTS_PER_HALF; outs++) {
      expect(sim.half).toBe('top');
      expect(sim.outs).toBe(outs);
      // A 4 in reticle miss below the ball is a pop-up: LA past 50°, caught.
      const r = swingWith(sim, 4);
      expect(r.pa?.outcome).toBe('out');
    }
    // Three outs, and the half turned over — bases and count cleared.
    expect(sim.half).toBe('bottom');
    expect(sim.inning).toBe(1);
    expect(sim.outs).toBe(0);
    expect(sim.balls).toBe(0);
    expect(sim.strikes).toBe(0);
    expect(sim.bases).toEqual(EMPTY_BASES);
    expect(sim.isHumanBatting()).toBe(false);
  });
});

// ===========================================================================
describe('duel — the reticle assist is a MODULATOR, not a fork', () => {
  it('⚠ the DUEL shoulder shrinks the reference PLATEAU and keeps the contact edge', () => {
    // The two properties `DUEL_ASSIST` is calibrated on, measured off the ONE
    // implementation rather than restated.
    const edgeIn = LOC_DISTANCE_IN - SWING_UNDERCUT_IN; // 2.14 in — no bat past it
    const plateauIn = 0.1; // ~0.35° of launch angle: invisible
    const derbyEdge = aimErrorForUndercutIn(edgeIn, DERBY_ASSIST);
    const derbyFlat = aimErrorForUndercutIn(plateauIn, DERBY_ASSIST);
    const duelEdge = aimErrorForUndercutIn(edgeIn, DUEL_ASSIST);
    const duelFlat = aimErrorForUndercutIn(plateauIn, DUEL_ASSIST);
    // eslint-disable-next-line no-console
    console.log(
      '\n[RETICLE ASSIST — the plateau is what a duel could not afford]\n' +
        `  derby (${DERBY_ASSIST.fullMissIn} in, p ${DERBY_ASSIST.fadePower})  contact edge ` +
        `${derbyEdge.toFixed(2)} in   reference plateau ${derbyFlat.toFixed(2)} in ` +
        `= ${((100 * derbyFlat) / derbyEdge).toFixed(0)} %\n` +
        `  duel  (${DUEL_ASSIST.fullMissIn} in, p ${DUEL_ASSIST.fadePower})  contact edge ` +
        `${duelEdge.toFixed(2)} in   reference plateau ${duelFlat.toFixed(2)} in ` +
        `= ${((100 * duelFlat) / duelEdge).toFixed(0)} %\n` +
        '  Inside the plateau every swing is the calibrated 411 ft reference swing.\n',
    );
    expect(derbyFlat / derbyEdge).toBeGreaterThan(0.5);
    expect(duelFlat / duelEdge).toBeLessThan(0.33);
    // …and the CONTACT edge barely moves, so the duel is not harder to touch.
    expect(duelEdge).toBeGreaterThan(derbyEdge * 0.9);
    expect(duelEdge).toBeLessThan(derbyEdge * 1.1);
    // ⚠ `fullMissIn` IS THE CALIBRATED ONE, and this is what it was solved
    // against: at the duel's fade power, the width that reproduces the derby's
    // contact edge EXACTLY is 12.42 in. 12 is that rounded, and the 2.0 % it
    // gives up is the rounding, not a second decision. `fadePower` is a FEEL
    // KNOB and is labelled one — the plateau fraction is a pure function of it,
    // so no width can be "calibrated" to a plateau target.
    const exact = 12.42;
    expect(
      aimErrorForUndercutIn(edgeIn, { fullMissIn: exact, fadePower: DUEL_ASSIST.fadePower }),
    ).toBeCloseTo(derbyEdge, 2);
    expect(DUEL_ASSIST.fullMissIn).toBe(Math.round(exact));
    expect(100 * (1 - duelEdge / derbyEdge)).toBeCloseTo(2.0, 1);
  });

  it('the DERBY shoulder is untouched — golden, and the law still holds for both', () => {
    // A default argument is exactly the sort of change that silently re-shapes
    // the mode it was not for. These are the derby's own numbers.
    expect(reticleResidual(0)).toBe(0);
    expect(reticleResidual(4 / 12)).toBeCloseTo((4 / 8) ** 4, 12);
    expect(reticleResidual(8 / 12)).toBe(1);
    expect(reticleResidual(40 / 12)).toBe(1);
    // The two properties the law rests on, for BOTH pairs: no flat middle, and
    // strictly monotone.
    for (const assist of [DERBY_ASSIST, DUEL_ASSIST]) {
      expect(reticleResidual(0.01 / 12, assist)).toBeGreaterThan(0);
      let prev = 0;
      for (let rIn = 0.25; rIn < 8; rIn += 0.25) {
        const k = reticleResidual(rIn / 12, assist);
        expect(k).toBeGreaterThan(prev);
        prev = k;
      }
    }
  });
});

// ===========================================================================
describe('duel — determinism', () => {
  it('⚠ the same seed replays a BYTE-IDENTICAL game transcript', () => {
    const a = autoGame(4242, 0.5, 0.5);
    const c = autoGame(4242, 0.5, 0.5);
    expect(a.transcript).toBe(c.transcript);
    expect(JSON.stringify(a.sim.getState())).toBe(JSON.stringify(c.sim.getState()));
    // …and a different seed does not. Without this the test above passes on a
    // sim that ignores its seed entirely.
    expect(autoGame(4243, 0.5, 0.5).transcript).not.toBe(a.transcript);
    // The transcript is a real game, not two empty strings.
    expect(a.transcript.length).toBeGreaterThan(500);
    expect(a.sim.pitchCount).toBeGreaterThan(30);
  });

  it('⚠ TRIPWIRE: the snapshottable stream is golf `mulberry32`, exactly', async () => {
    const { mulberry32 } = await import('../golf/wind');
    const gen = mulberry32(9001);
    let state = 9001;
    for (let i = 0; i < 6; i++) {
      const step = simDraw(state);
      expect(step.value).toBe(gen());
      state = step.next;
    }
    expect(new Set([0, 1, 2, 3, 4].map((s) => simDraw(s).value)).size).toBe(5);
  });

  it('snapshot/restore is TOTAL — every own data prop, and nothing aliases', () => {
    const sim = scripted({ seed: 77 });
    swingWith(sim, 0);
    sim.servePitch(WAY_OUTSIDE);
    sim.take();

    // ⚠ RULE: the pair must cover every own data property.
    expect(Object.keys(sim.snapshot()).sort()).toEqual(ownDataProps(sim));

    // getState() hands out copies of every mutable thing it exposes.
    (sim.getState().bases as unknown as boolean[])[2] = true;
    expect(sim.getState().bases[2]).toBe(false);
    sim.getState().lineAway.push(99);
    expect(sim.getState().lineAway.length).toBeLessThan(4);
    const st = sim.getState();
    if (st.last?.flight) {
      st.last.flight.track.t.push(1e9);
      expect(sim.getState().last?.flight?.track.t.at(-1)).not.toBe(1e9);
    }

    // ⚠ …AND `served` IS COPIED ALL THE WAY DOWN TOO. It used to go in by
    // reference on the argument that the sim never mutates it in place — true,
    // and not the property the ⚠ RULE claims. A caller writing to the snapshot's
    // sampled track was editing the live pitch and every future restore of it.
    const snapA = sim.snapshot();
    const liveH = sim.served!.result.track.h[3]!;
    snapA.served!.result.track.h[3] = 1e9;
    snapA.served!.result.plate.v.x = 1e9;
    expect(sim.served!.result.track.h[3]).toBe(liveH);
    expect(sim.served!.result.plate.v.x).not.toBe(1e9);

    // A dry run restores byte-identically — including the PRNG state, which is
    // the field a preview leaks through if it is left out.
    const snap = sim.snapshot();
    const before = JSON.stringify(sim.getState());
    for (let i = 0; i < 6; i++) {
      if (sim.phase === 'done') break;
      sim.servePitch(MEATBALL);
      sim.take();
    }
    expect(JSON.stringify(sim.getState())).not.toBe(before);
    sim.restore(snap);
    expect(JSON.stringify(sim.getState())).toBe(before);
    expect(JSON.stringify(sim.snapshot())).toBe(JSON.stringify(snap));
  });

  it('predict() mutates nothing and never invents a plate appearance', () => {
    const sim = scripted({ seed: 31 });
    const pr = sim.servePitch(MEATBALL);
    sim.setReticle(pr.plate.x, pr.plate.h);
    const before = JSON.stringify(sim.snapshot());
    const p = sim.predict(pr.plate.t);
    expect(JSON.stringify(sim.snapshot())).toBe(before);
    expect(p.pa).toBeNull();
    // …and it agrees with what committing actually does.
    const real = sim.swing(pr.plate.t);
    expect(real.outcome).toBe(p.outcome);
    expect(real.evMph).toBe(p.evMph);
    expect(real.distFt).toBe(p.distFt);
  });

  it('the roles are enforced — neither side plays the other’s half', () => {
    const sim = scripted();
    expect(sim.isHumanBatting()).toBe(true);
    expect(() => sim.aiBat()).toThrow(/human is batting/);
    sim.servePitch(MEATBALL);
    expect(() => sim.servePitch(MEATBALL)).toThrow(/already in flight/);
    // Retire the away side, then the human is on the mound and must command.
    sim.take();
    for (let outs = 0; outs < 3; outs++) {
      for (let s = sim.strikes; s < 3; s++) {
        sim.servePitch(MEATBALL);
        sim.take();
      }
    }
    expect(sim.isHumanBatting()).toBe(false);
    expect(() => sim.servePitch()).toThrow(/needs a PitchCommand/);
  });
});

// ===========================================================================
// The headless AI-vs-AI harness, and the outcome bench
// ===========================================================================

/**
 * Play one whole duel with both sides driven by `ai.ts`.
 *
 * The AI on the sim's own side draws from the SIM's stream; the "human" side is
 * driven by the same functions at `skill` off a SECOND seeded stream, which is
 * what a scripted human is. Nothing here is a mode inside `duelSim` — the sim
 * still refuses to play the human's half for him.
 */
function autoGame(seed: number, difficulty: number, skill: number) {
  const sim = new DuelSim({ seed, difficulty });
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const draw = () => {
    const d = simDraw(s);
    s = d.next;
    return d.value;
  };
  const lines: string[] = [];
  /** Every batted ball that reached the ground still travelling, for the GB table. */
  const grounders: Array<{ la: number; out: boolean; single: boolean; fielder: string }> = [];
  let guard = 0;
  while (sim.phase !== 'done') {
    // A PA cannot loop forever inside the sim — the loop is the CALLER's — so
    // the bound lives here, and a run that hits it is a failed test, not a hang.
    if (guard++ > 3000) throw new Error('duel did not terminate');
    let rec;
    if (sim.isHumanBatting()) {
      const pl = sim.servePitch().plate;
      const d = aiSwingDecision(draw, skill, {
        balls: sim.balls,
        strikes: sim.strikes,
        plateX: pl.x,
        plateH: pl.h,
        plateT: pl.t,
        plateSpeedFps: vLen(pl.v),
      });
      sim.setReticle(d.reticleX, d.reticleH);
      rec = d.swing && d.tapTimeS !== null ? sim.swing(d.tapTimeS) : sim.take();
    } else {
      sim.servePitch(aiPitchCommand(draw, skill, { balls: sim.balls, strikes: sim.strikes }));
      rec = sim.aiBat();
    }
    if (rec.play && rec.play !== 'FOUL') {
      grounders.push({
        la: rec.laDeg,
        out: rec.play === 'OUT',
        single: rec.play === 'SINGLE',
        fielder: rec.fielder,
      });
    }
    lines.push(
      `${rec.pitchId} ${rec.balls}-${rec.strikes} ${rec.outcome} ${rec.plateX.toFixed(4)} ` +
        `${rec.plateH.toFixed(4)} ${rec.evMph.toFixed(3)} ${rec.distFt.toFixed(3)} ` +
        `${rec.play ?? '-'} ${rec.pa?.outcome ?? '-'} ${sim.awayScore}-${sim.homeScore}`,
    );
  }
  return { sim, transcript: lines.join('\n'), grounders };
}

describe('duel — the outcome bench', () => {
  it('⚠ PRINTS the outcome distribution at three difficulties, and asserts the bands', () => {
    const N = 16;
    const rows: string[] = [];
    const gbRows: string[] = [];
    const summary: { d: number; runs: number; k: number; bb: number; hr: number; hrBip: number }[] = [];
    /** The ground-ball tally, pooled across difficulties. See the second table. */
    const gbAll = { bip: 0, gb: 0, outs: 0, singles: 0, gbSingles: 0, steep: 0 };
    const gloves: Record<string, number> = {};
    for (const d of [0.15, 0.5, 0.85]) {
      const counts: Record<string, number> = {};
      let runs = 0;
      let pitches = 0;
      let pas = 0;
      let maxInn = 0;
      const scores: string[] = [];
      const gb = { bip: 0, gb: 0, outs: 0, singles: 0, gbSingles: 0, steep: 0 };
      for (let i = 0; i < N; i++) {
        const { sim, transcript, grounders } = autoGame(2000 + i, d, d);
        // ⚠ THE GROUND-BALL CENSUS USES THE SAME LAUNCH-ANGLE CUT THE ARTIFACT
        // WAS MEASURED WITH — `laDeg < 10` — so the before and after numbers are
        // the same measurement and not two different ones.
        for (const b of grounders) {
          gb.bip++;
          if (b.la < -20) gb.steep++;
          if (b.single) gb.singles++;
          if (b.la >= 10) continue;
          gb.gb++;
          if (b.out) {
            gb.outs++;
            gloves[b.fielder] = (gloves[b.fielder] ?? 0) + 1;
          }
          if (b.single) gb.gbSingles++;
        }
        runs += sim.awayScore + sim.homeScore;
        pitches += sim.pitchCount;
        pas += sim.paCount;
        maxInn = Math.max(maxInn, sim.inning);
        if (i < 5) scores.push(`${sim.awayScore}-${sim.homeScore}`);
        // Every game must actually finish inside the bound, with a verdict, and
        // the line score has to close against the totals.
        expect(sim.phase).toBe('done');
        expect(sim.winner).not.toBeNull();
        expect(sim.inning).toBeLessThanOrEqual(MAX_INNINGS);
        expect(sim.lineAway.reduce((x, y) => x + y, 0)).toBe(sim.awayScore);
        expect(sim.lineHome.reduce((x, y) => x + y, 0)).toBe(sim.homeScore);
        expect(sim.lastPa?.gameOver).toBe(true);
        for (const line of transcript.split('\n')) {
          const pa = line.split(' ')[8];
          if (pa && pa !== '-') counts[pa] = (counts[pa] ?? 0) + 1;
        }
      }
      const g = (k: string) => counts[k] ?? 0;
      const bip = g('out') + g('single') + g('double') + g('triple') + g('homeRun');
      // Guard the tally: a parse that stopped matching would report 0 % of
      // everything and sail through a band that only has lower bounds.
      expect(g('strikeout') + g('walk') + bip).toBe(pas);
      const row = {
        d,
        runs: runs / N,
        k: (100 * g('strikeout')) / pas,
        bb: (100 * g('walk')) / pas,
        hr: (100 * g('homeRun')) / pas,
        hrBip: (100 * g('homeRun')) / bip,
      };
      summary.push(row);
      rows.push(
        `  ${d.toFixed(2)}  ${(runs / N).toFixed(2).padStart(6)}  ${(pitches / N).toFixed(0).padStart(4)}` +
          `  ${(pas / N).toFixed(1).padStart(5)}  ${row.k.toFixed(1).padStart(5)}` +
          `  ${row.bb.toFixed(1).padStart(5)}  ${row.hr.toFixed(1).padStart(5)}` +
          `  ${row.hrBip.toFixed(0).padStart(4)}  ${String(maxInn).padStart(3)}` +
          `   ${g('single')}/${g('double')}/${g('triple')}   ${scores.join(' ')}`,
      );
      gbAll.bip += gb.bip;
      gbAll.gb += gb.gb;
      gbAll.outs += gb.outs;
      gbAll.singles += gb.singles;
      gbAll.gbSingles += gb.gbSingles;
      gbAll.steep += gb.steep;
      gbRows.push(
        `  ${d.toFixed(2)}   ${String(gb.bip).padStart(4)}   ${String(gb.gb).padStart(3)}` +
          `   ${String(gb.outs).padStart(6)}   ${((100 * gb.outs) / Math.max(1, gb.gb))
            .toFixed(1)
            .padStart(6)} %   ${String(gb.singles).padStart(3)}   ${String(gb.gbSingles).padStart(4)}` +
          `   ${((100 * gb.gbSingles) / Math.max(1, gb.singles)).toFixed(0).padStart(4)} %`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[DUEL OUTCOMES — ${N} seeded games per difficulty, AI vs AI at the same skill]\n` +
        '  diff   runs/g  pit    PA/g   K/PA%  BB/PA%  HR/PA%  HR/BIP%  maxInn   1B/2B/3B   first five finals\n' +
        rows.join('\n') +
        '\n  MLB reference: K 22 %, BB 8.5 %, HR 3 % of PA, ~5 % of balls in play.\n' +
        '  This is an ARCADE duel and sits deliberately above the home-run line.\n' +
        '  ⚠ THE ROLLING PHASE MOVED EVERY COLUMN OF THIS TABLE. Before it, the numbers\n' +
        '    at 0.15/0.50/0.85 were runs 5.06/6.19/8.25 and 1B 79/94/153, because every\n' +
        '    ground ball was a base hit. They are now what is printed above. runs/game is\n' +
        '    no longer dominated by that artifact, so it may be READ — though it is still\n' +
        '    not calibrated to anything, and duelRules.ts\'s forced-advance rule still\n' +
        '    biases it DOWN. K/PA and BB/PA remain the two clean comparisons.\n' +
        '  Bands below are regression fences (~±50 %); the shape guards are the\n' +
        '  monotonicity checks and HR/BIP.\n',
    );
    // eslint-disable-next-line no-console
    console.log(
      `\n[GROUND BALLS — the rolling phase, ${N} seeded games per difficulty]\n` +
        '  diff    BIP    GB   GB→out     rate    1B  of GB   share\n' +
        gbRows.join('\n') +
        `\n\n  POOLED: ${gbAll.outs} of ${gbAll.gb} ground balls retired — ` +
        `${((100 * gbAll.outs) / gbAll.gb).toFixed(1)} %, against MLB's ~72 %.\n` +
        `  Putouts by position: ${Object.entries(gloves)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}\n` +
        `  ⚠ EVERY ONE OF THOSE PUTOUTS IS AN INFIELDER'S — zero outfielders — and that is\n` +
        '    the measurement that says `ROLL_GRASS_RATIO` does not co-vary with the roll\n' +
        '    constant fitted against this rate: a fielder who has chased a ball onto the\n' +
        '    grass cannot beat a 4.3 s runner from there, so the grass deceleration has\n' +
        '    near-zero leverage on the number above. `groundBall.ts` argues it; this\n' +
        '    counts it.\n' +
        `  ⚠ THE PITCHER LEADING THAT COLUMN HAS TWO CAUSES AND THE FITTED ROLL CONSTANT\n` +
        `    IS ONE OF THEM. The batting model supplies the balls — ${(
          (100 * gbAll.steep) /
          gbAll.bip
        ).toFixed(0)} % of this bench's\n` +
        '    balls in play leave the bat below −20°, and a real spray chart is not that\n' +
        '    steep. But what decides they die in front of the MOUND rather than reaching\n' +
        '    the middle infield is `ROLL_DECEL_DIRT_FPS2`: at 70 ft/s² a topped ball\n' +
        '    landing 5 ft out at 100 ft/s comes to rest at 76 ft, inside the pitcher\u2019s\n' +
        '    cover. At a deceleration nearer a real skinned infield the same ball stops\n' +
        '    around 148 ft, the pitcher is infeasible anywhere on the path, and the play\n' +
        '    is the shortstop\u2019s or a base hit. A real pitcher takes ~2 % of putouts. So\n' +
        '    this IS fixable here — by the decel-plus-fielding-radius refit `groundBall.ts`\n' +
        '    already names as the follow-up — and not by the batting model alone.\n' +
        "  ⚠ BEFORE THE ROLLING PHASE: 3.4 % at difficulty 0.50 (84 singles, 3 outs from\n" +
        '    87 ground balls) and 6.5 % at 0.85 — there was no 6-3 groundout in the game.\n' +
        '  ⚠ AND THE RATE IS NOT THE CLAIM ON ITS OWN. `ROLL_DECEL_DIRT_FPS2` is fitted\n' +
        '    to it, so a model that made every grounder a coin flip would land here too.\n' +
        '    The claim is this table AND groundBall.test.ts\'s structure assertions —\n' +
        '    at a fielder is an out, through a hole is a hit, and the same slow roller is\n' +
        '    a hit down the third-base line and an out down the first-base line.\n',
    );

    // ⚠ THE GROUND-BALL FENCE. Wide, like the others — but its FLOOR is the one
    // number in this file that is a real regression test rather than a fence:
    // the model this replaced scored 3.4 %, so anything that quietly restores a
    // landing-point lookup lands two-thirds of the way below this line.
    const pooled = (100 * gbAll.outs) / gbAll.gb;
    expect(gbAll.gb, 'ground balls in the sample').toBeGreaterThan(100);
    expect(pooled, 'pooled ground-ball out rate').toBeGreaterThan(60);
    expect(pooled, 'pooled ground-ball out rate').toBeLessThan(84);
    // …and it has to hold at EVERY difficulty, not just pooled: a rate that was
    // 90 % at one skill and 45 % at another would pool to the target and be
    // wrong twice.
    for (const row of gbRows) {
      const rate = Number(row.split('%')[0]!.trim().split(/\s+/).pop());
      expect(rate, `per-difficulty ground-ball out rate (${row.trim()})`).toBeGreaterThan(55);
      expect(rate, `per-difficulty ground-ball out rate (${row.trim()})`).toBeLessThan(90);
    }
    // ⚠ AND THE PUTOUTS HAVE TO BE SPREAD. One fielder making every play would
    // be a geometry bug that the aggregate rate cannot see — and it is exactly
    // what a broken throw-distance or a deleted alignment row would look like.
    const infieldGloves = ALIGNMENT.filter((f) => f.infield && (gloves[f.pos] ?? 0) > 0);
    expect(infieldGloves.map((f) => f.pos), `putouts: ${JSON.stringify(gloves)}`).toEqual([
      'P',
      '3B',
      'SS',
      '2B',
      '1B',
    ]);
    // ⚠ AND NONE OF THEM MAY BE AN OUTFIELDER'S, WHICH IS A CLAIM ABOUT A
    // DIFFERENT CONSTANT. `groundBall.ROLL_GRASS_RATIO` is the one number in the
    // rolling phase with no source, and the reason it does not contaminate the
    // roll constant fitted against the rate above is that it can only touch a
    // play decided beyond the grass line — and no such play beats a 4.3 s
    // runner. A non-zero count here is not a bug; it is the signal that the
    // knob has acquired leverage over the fit and the fit needs re-examining.
    const outfieldPutouts = ALIGNMENT.filter((f) => !f.infield).reduce(
      (t, f) => t + (gloves[f.pos] ?? 0),
      0,
    );
    const totalPutouts = Object.values(gloves).reduce((t, v) => t + v, 0);
    expect(totalPutouts).toBe(gbAll.outs);
    expect(
      outfieldPutouts / totalPutouts,
      `outfielder putouts: ${outfieldPutouts} of ${totalPutouts}`,
    ).toBeLessThan(0.02);

    // ⚠ WHAT THESE BANDS ARE AND ARE NOT. They are REGRESSION FENCES, not a
    // calibration: each is set roughly ±50 % around the measured value, wide
    // enough that a deliberate feel-knob turn does not fail the suite and narrow
    // enough that a structural break does. Only the last one is known to bite on
    // a real defect today — reverting `DUEL_ASSIST` to the derby's shoulder is
    // caught by `hrBip` and by nothing else here. The MONOTONICITY checks below
    // are the assertions that actually guard the shape.
    //
    // ⚠ AND `runs/game` AND THE 1B COLUMN USED TO CARRY A DISCLAIMER HERE, which
    // the rolling phase retired along with the artifact behind it. Both were
    // dominated by `fielding.ts`'s landing-point limitation — every ground ball
    // was a base hit — and both moved hard when `groundBall.ts` landed: runs at
    // the three difficulties went 5.06/6.19/8.25 → 4.69/3.50/3.13 and the 1B
    // column 79/94/153 → 36/31/28. They are readable now. They are still not
    // CALIBRATED to anything — nothing here is fitted to a run environment — and
    // `duelRules.ts`'s forced-advance rule still biases them DOWN, which is now
    // the only stated bias rather than the smaller of two. K/PA and BB/PA remain
    // the two columns with a published number to be read against.
    //
    // ⚠ AND HOW TO READ THE SMALL-n COLUMNS ACROSS TWO RUNS, BECAUSE HR/BIP
    // MOVED 15 → 17 AT DIFFICULTY 0.50 AND THAT IS NOT A RESULT. Two things,
    // and the first rules out the obvious explanation:
    //
    //   • FIELDING CANNOT MOVE HR/BIP, ALGEBRAICALLY. Outs per game are FIXED at
    //     18. With a fixed batted-ball distribution, batted-ball outs are
    //     `18 − K = q·BIP` where `q` is the rate at which balls in play become
    //     outs, so `BIP = (18 − K)/q`; home runs are `HR = h·BIP`, so
    //     `HR/BIP = h` — INVARIANT to `q`. Improving the fielding conversion
    //     rate shortens innings and shrinks BIP and HR together. "Plate
    //     appearances fell 16 %" is therefore not an explanation of anything.
    //   • WHAT MOVED IS THE SAMPLE. `autoGame` runs TWO seeded streams whose
    //     roles swap by half-inning, so when half-innings change length the
    //     streams RE-PHASE and the whole batted-ball population re-draws. The
    //     noise floor calibrates itself from quantities fielding provably cannot
    //     touch: at difficulty 0.85, BB/PA moved 1.5 → 2.6 % and K/PA
    //     21.0 → 22.7 %, both pitch-sequence-only statistics, at n ≈ 390 PA.
    //     Against that scale, HR/BIP moving 2 pp at n = 233 (binomial SE
    //     ≈ 2.5 pp) is inside the floor — and it did not move at all at 0.15.
    //
    // So: CROSS-RUN COMPARISON OF THE SMALL-n COLUMNS IS UNRELIABLE, and a 2 pp
    // wobble in any of them is not evidence of anything. The bands below are set
    // wide for exactly this reason, and the monotonicity checks are what guard
    // the shape.
    for (const r of summary) {
      // A game where nothing happens is the failure this bench exists to catch.
      expect(r.runs, `diff ${r.d}: runs/game`).toBeGreaterThan(3);
      expect(r.runs, `diff ${r.d}: runs/game`).toBeLessThan(13);
      expect(r.k, `diff ${r.d}: K/PA`).toBeGreaterThan(12);
      expect(r.k, `diff ${r.d}: K/PA`).toBeLessThan(52);
      // ⚠ BB/PA HAD NO BAND AT ALL, which meant "asserts the bands" was false of
      // the one column with a known weakness in it (the difficulty-0.85 pitcher
      // walks almost nobody). A floor above zero is the point: a duel in which
      // the four-ball rule never fires is a duel that has lost a rule.
      expect(r.bb, `diff ${r.d}: BB/PA`).toBeGreaterThan(0.4);
      expect(r.bb, `diff ${r.d}: BB/PA`).toBeLessThan(20);
      expect(r.hr, `diff ${r.d}: HR/PA`).toBeGreaterThan(3);
      expect(r.hr, `diff ${r.d}: HR/PA`).toBeLessThan(14);
      expect(r.hrBip, `diff ${r.d}: HR per ball in play`).toBeLessThan(24);
      expect(r.hrBip, `diff ${r.d}: HR per ball in play`).toBeGreaterThan(4);
    }
    // ⚠ THE CURVE HAS TO POINT THE RIGHT WAY, which no single band can see: a
    // better AI strikes out less and walks less, at every step.
    expect(summary[0]!.k).toBeGreaterThan(summary[1]!.k);
    expect(summary[1]!.k).toBeGreaterThan(summary[2]!.k);
    expect(summary[0]!.bb).toBeGreaterThan(summary[1]!.bb);
    expect(summary[1]!.bb).toBeGreaterThan(summary[2]!.bb);
        expect(summary[0]!.bb).toBeGreaterThan(summary[2]!.bb);
  });
});
