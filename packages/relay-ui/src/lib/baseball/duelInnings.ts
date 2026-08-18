// The Duel — the HALF-INNING STATE MACHINE, and nothing else.
//
// Extracted from `duelSim.ts` before it was written, along the seam
// `derbyState.ts` was taken along: `duelSim.ts` is the LOOP (serve a pitch, map
// the inputs onto the collision, book the result) and this file is the pure
// bookkeeping the loop hands its results to. Nothing here knows what a pitch is.
// A plate appearance goes in as one of seven words; outs, bases, the score, the
// half and the game-over condition come out.
//
// ⚠ EVERY FUNCTION IS PURE AND TAKES A `Situation` STRUCTURALLY, not the sim, so
// the machine is unit-testable without integrating a single trajectory — which
// is exactly what makes "an inning ends on the wrong out count" a one-line test
// instead of a game replay.
//
// ⚠ THE ADVANCEMENT RULE LIVES IN `duelRules.ts`, not here. This file decides
// WHEN runners move; `advanceRunners`/`forceWalk` decide WHERE they go, and the
// forced-advance-only simplification and its scoring bias are argued there.

import type { Bases, Half, PitchOutcome, Team, Winner } from './duelRules';
import {
  BALLS_FOR_WALK,
  EMPTY_BASES,
  FOUL_PROTECTED_STRIKES,
  MAX_INNINGS,
  OUTS_PER_HALF,
  STRIKES_FOR_K,
  advanceRunners,
  forceWalk,
} from './duelRules';
import type { PlayResult } from './fielding';

/** How a plate appearance ended. Seven words, and there is no eighth. */
export type PaOutcome =
  | 'walk'
  | 'strikeout'
  | 'out'
  | 'single'
  | 'double'
  | 'triple'
  | 'homeRun';

/** Bases gained by the BATTER, per outcome. `null` = he did not reach. */
const BASES_GAINED: Record<PaOutcome, number | null> = {
  walk: null,
  strikeout: null,
  out: null,
  single: 1,
  double: 2,
  triple: 3,
  homeRun: 4,
};

/** Did this outcome retire the batter? RULE — three of the seven do. */
export const isOut = (o: PaOutcome): boolean =>
  o === 'strikeout' || o === 'out';

/** The half-inning bookkeeping, named structurally so `DuelSim` satisfies it. */
export interface Situation {
  inning: number;
  half: Half;
  outs: number;
  bases: Bases;
  awayScore: number;
  homeScore: number;
}

/** Who is batting. `top` is the away team, as in baseball. */
export const battingTeam = (half: Half): Team => (half === 'top' ? 'away' : 'home');

/**
 * Project exactly the six fields of a `Situation` out of whatever was passed.
 *
 * ⚠ IT EXISTS SO NOTHING IN THIS FILE EVER SPREADS ITS CALLER. `DuelSim`
 * satisfies `Situation` STRUCTURALLY, so `{ ...sit }` copies the entire live sim
 * — config, served pitch, last record, the PRNG state — and handing that back
 * for `Object.assign` writes all of it again. That is a no-op today and a
 * stale-write the first time a line is inserted between the read and the write.
 * Six named fields in, six named fields out.
 */
const situationOf = (s: Situation): Situation => ({
  inning: s.inning,
  half: s.half,
  outs: s.outs,
  bases: s.bases,
  awayScore: s.awayScore,
  homeScore: s.homeScore,
});

/** Who is leading, or a tie. Read at the end of a game and by the walk-off test. */
export function winnerOf(sit: Situation): Winner {
  if (sit.homeScore > sit.awayScore) return 'home';
  if (sit.awayScore > sit.homeScore) return 'away';
  return 'tie';
}

/**
 * Apply one plate appearance. Returns the situation AFTER the bases, the outs
 * and the score have moved, plus the runs it drove in.
 *
 * ⚠ IT DOES NOT END THE HALF. That is `advanceHalf`, called separately by the
 * loop, because the walk-off test has to run BETWEEN the two: a run that wins
 * the game in the bottom of the last inning ends it immediately, with runners on
 * and fewer than three out.
 */
export function applyPa(sit: Situation, outcome: PaOutcome): { sit: Situation; runs: number } {
  const gained = BASES_GAINED[outcome];
  let bases = sit.bases;
  let runs = 0;
  if (outcome === 'walk') {
    const w = forceWalk(sit.bases);
    bases = w.bases;
    runs = w.runs;
  } else if (gained !== null) {
    const a = advanceRunners(sit.bases, gained);
    bases = a.bases;
    runs = a.runs;
  }
  // ⚠ AN OUT MOVES NOBODY. No sacrifice fly, no productive out, no runner
  // advancing on a ground ball — see `duelRules`'s advancement note, which
  // records that every one of those omissions biases scoring the same way.
  const outs = sit.outs + (isOut(outcome) ? 1 : 0);
  const scoring = battingTeam(sit.half);
  return {
    sit: {
      ...situationOf(sit),
      bases,
      outs,
      awayScore: sit.awayScore + (scoring === 'away' ? runs : 0),
      homeScore: sit.homeScore + (scoring === 'home' ? runs : 0),
    },
    runs,
  };
}

/**
 * THE WALK-OFF. True when the home team has just taken the lead in the bottom of
 * an inning at or past regulation — at which point the game is over on the spot,
 * mid-half, whatever the out count and whoever is on base.
 *
 * ⚠ IT IS A STRICT LEAD, NOT "SCORED A RUN". A home team that ties the game with
 * one out has not won anything, and the half plays on. Checked after every plate
 * appearance rather than only after a scoring one, because "did the score change"
 * and "is the home team now ahead" are different questions and only the second
 * one ends a game.
 */
export function isWalkOff(sit: Situation, innings: number): boolean {
  return sit.half === 'bottom' && sit.inning >= innings && sit.homeScore > sit.awayScore;
}

/**
 * The half is over — three outs are in. Roll to the next half, or end the game.
 *
 * The three end conditions, all of them the ordinary rules of baseball:
 *
 *  • After the TOP of an inning at or past regulation, the home team does not
 *    bat if it is already ahead. (A walk-off during the bottom is `isWalkOff`'s
 *    job; this is the case where the bottom never happens at all.)
 *  • After the BOTTOM of an inning at or past regulation, the game is over if
 *    the score is not level.
 *  • Level ⇒ EXTRA INNINGS, because baseball has no tie. Bounded by
 *    `MAX_INNINGS`, which `duelRules.ts` labels a BOUND rather than a rule and
 *    which the outcome bench measures the headroom against.
 */
export function advanceHalf(
  sit: Situation,
  innings: number,
): { sit: Situation; over: boolean } {
  const now = situationOf(sit);
  // ⚠ A GAME THAT ENDS DOES NOT GET A FRESH HALF, and that is a real fix rather
  // than tidiness. Clearing the outs and the bases on the game-over branches
  // made a game that ended on the third out report `outs === 0` with empty bases
  // while a WALK-OFF — which never comes through here — reported the truth. Two
  // conventions for one final state, and a HUD drawing "3 outs, bases loaded" on
  // the last play of one game and "0 outs, nobody on" on the last play of
  // another would have been reading the sim correctly both times.
  const fresh = { outs: 0, bases: EMPTY_BASES };
  const regulation = sit.inning >= innings;
  if (sit.half === 'top') {
    // The home team leads and has no need to bat: the game is over.
    if (regulation && sit.homeScore > sit.awayScore) return { sit: now, over: true };
    return { sit: { ...now, ...fresh, half: 'bottom' }, over: false };
  }
  if (regulation && sit.homeScore !== sit.awayScore) return { sit: now, over: true };
  if (sit.inning >= MAX_INNINGS) return { sit: now, over: true };
  return { sit: { ...now, ...fresh, half: 'top', inning: sit.inning + 1 }, over: false };
}

/** Is the half over? RULE: three outs, and `OUTS_PER_HALF` is never scaled. */
export const halfIsOver = (sit: Situation): boolean => sit.outs >= OUTS_PER_HALF;

/**
 * A line score row that grows to fit. Innings are 1-based; extras append. Pure —
 * it returns a new array rather than pushing into the caller's, so the readout
 * cannot alias sim state through it.
 */
export function addLineRuns(line: readonly number[], inning: number, runs: number): number[] {
  const out = [...line];
  while (out.length < inning) out.push(0);
  out[inning - 1] = (out[inning - 1] ?? 0) + runs;
  return out;
}

// ---------------------------------------------------------------------------
// The count, and what ends a plate appearance
// ---------------------------------------------------------------------------

/**
 * The count after one pitch. THREE RULES OF BASEBALL and no knob:
 *
 *  • a ball adds a ball;
 *  • a called or swinging strike adds a strike;
 *  • ⚠ A FOUL ADDS A STRIKE ONLY BELOW TWO. At two it leaves the count at two,
 *    forever. That `Math.min` is the whole rule, and deleting it turns every
 *    two-strike foul into a strikeout — which is the mutation the bench watches
 *    fail.
 *
 * A ball put in play does not move the count, because the plate appearance is
 * over and the next batter starts at 0-0.
 */
export function countAfter(
  count: { balls: number; strikes: number },
  outcome: PitchOutcome,
): { balls: number; strikes: number } {
  if (outcome === 'ball') return { balls: count.balls + 1, strikes: count.strikes };
  if (outcome === 'foul') {
    return { balls: count.balls, strikes: Math.min(count.strikes + 1, FOUL_PROTECTED_STRIKES) };
  }
  if (outcome === 'calledStrike' || outcome === 'swingingStrike') {
    return { balls: count.balls, strikes: count.strikes + 1 };
  }
  return { balls: count.balls, strikes: count.strikes };
}

/** `PlayResult` → the plate appearance it ended. `FOUL` never reaches here. */
const PA_OF_PLAY: Partial<Record<PlayResult, PaOutcome>> = {
  OUT: 'out',
  SINGLE: 'single',
  DOUBLE: 'double',
  TRIPLE: 'triple',
  HR: 'homeRun',
};

/**
 * Did this pitch end the plate appearance, and how? RULES, in rule order — the
 * walk and the strikeout are decided on the COUNT AFTER, so they beat anything
 * the ball did, and a ball in play is read off `fielding.ts`'s answer.
 */
export function paOutcomeOf(
  outcome: PitchOutcome,
  count: { balls: number; strikes: number },
  play: PlayResult | null,
): PaOutcome | null {
  if (count.balls >= BALLS_FOR_WALK) return 'walk';
  if (count.strikes >= STRIKES_FOR_K) return 'strikeout';
  if (outcome !== 'inPlay') return null;
  const pa = play ? PA_OF_PLAY[play] : undefined;
  if (!pa) throw new Error(`in-play pitch with no fielding result: ${String(play)}`);
  return pa;
}
