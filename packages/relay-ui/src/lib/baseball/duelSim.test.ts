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
// It also PRINTS the outcome table and asserts its bands, because a duel can be
// inside every tolerance and still be a game in which nothing ever happens.
//
// MUTATIONS WATCHED TO FAIL — each applied to the source, the baseball suite
// run, then reverted. Observed failure counts, not predicted ones; the table is
// in this file's git history and in the M4 report.
//
//   1. `advanceRunners` advances runners one base too far          → see report
//   2. `forceWalk` moves every runner, not just the forced ones    → …
//   3. the foul clause's `Math.min` deleted (2-strike foul = K)    → …
//   4. `halfIsOver` fires at 2 outs                                → …
//   5. `advanceHalf` never ends the game at regulation             → …
//   6. `isWalkOff` reads `>=` instead of `>` (a tying run wins)    → …
//   7. `pitchLocation`'s lateral term loses `armSideX`             → …
//   8. `pitchLocation`'s two axes swapped                          → …
//   9. `DUEL_ASSIST` reverted to the derby's shoulder              → …
//  10. `rngState` dropped from `duelSnapshot`                      → …
//  11. `bases` handed out by reference from `getState()`           → …
//  12. `paOutcomeOf` checks the strikeout before the walk          → …

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
    // (b) NOT after the bottom of the second.
    expect(advanceHalf(sit({ inning: 2, half: 'bottom', outs: 3, awayScore: 2 }), 3).over).toBe(false);
    // (c) the home team does not bat in the bottom of the last if it leads.
    const skipped = advanceHalf(sit({ inning: 3, half: 'top', outs: 3, homeScore: 1 }), 3);
    expect(skipped.over).toBe(true);
    expect(winnerOf(skipped.sit)).toBe('home');
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
    lines.push(
      `${rec.pitchId} ${rec.balls}-${rec.strikes} ${rec.outcome} ${rec.plateX.toFixed(4)} ` +
        `${rec.plateH.toFixed(4)} ${rec.evMph.toFixed(3)} ${rec.distFt.toFixed(3)} ` +
        `${rec.play ?? '-'} ${rec.pa?.outcome ?? '-'} ${sim.awayScore}-${sim.homeScore}`,
    );
  }
  return { sim, transcript: lines.join('\n') };
}

describe('duel — the outcome bench', () => {
  it('⚠ PRINTS the outcome distribution at three difficulties, and asserts the bands', () => {
    const N = 16;
    const rows: string[] = [];
    const summary: { d: number; runs: number; k: number; bb: number; hr: number; hrBip: number }[] = [];
    for (const d of [0.15, 0.5, 0.85]) {
      const counts: Record<string, number> = {};
      let runs = 0;
      let pitches = 0;
      let pas = 0;
      let maxInn = 0;
      const scores: string[] = [];
      for (let i = 0; i < N; i++) {
        const { sim, transcript } = autoGame(2000 + i, d, d);
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
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[DUEL OUTCOMES — ${N} seeded games per difficulty, AI vs AI at the same skill]\n` +
        '  diff   runs/g  pit    PA/g   K/PA%  BB/PA%  HR/PA%  HR/BIP%  maxInn   1B/2B/3B   first five finals\n' +
        rows.join('\n') +
        '\n  MLB reference: K 22 %, BB 8.5 %, HR 3 % of PA, ~5 % of balls in play.\n' +
        '  This is an ARCADE duel and sits deliberately above the home-run line.\n',
    );

    for (const r of summary) {
      // A game where nothing happens is the failure this bench exists to catch.
      expect(r.runs, `diff ${r.d}: runs/game`).toBeGreaterThan(1.5);
      expect(r.runs, `diff ${r.d}: runs/game`).toBeLessThan(16);
      expect(r.k, `diff ${r.d}: K/PA`).toBeGreaterThan(8);
      expect(r.k, `diff ${r.d}: K/PA`).toBeLessThan(60);
      expect(r.hr, `diff ${r.d}: HR/PA`).toBeGreaterThan(1);
      expect(r.hr, `diff ${r.d}: HR/PA`).toBeLessThan(18);
      expect(r.hrBip, `diff ${r.d}: HR per ball in play`).toBeLessThan(28);
    }
    // ⚠ THE CURVE HAS TO POINT THE RIGHT WAY, which no single band can see: a
    // better AI strikes out less and walks less, at every step.
    expect(summary[0]!.k).toBeGreaterThan(summary[1]!.k);
    expect(summary[1]!.k).toBeGreaterThan(summary[2]!.k);
    expect(summary[0]!.bb).toBeGreaterThan(summary[2]!.bb);
  });
});
