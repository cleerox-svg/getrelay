// Home Run Derby — the CHAIN MULTIPLIER, and nothing else.
//
// Split out of `derbyScoring.ts` at the 500-line cap — EXTRACTION, NOT A RAISED
// CAP, the same discipline `derbyScoring.ts` itself was split out of
// `derbyRules.ts` under, and along a real seam rather than a convenient one:
// everything here is a pure `chain index → factor` law with no knowledge of
// carry, of the outcome enum, or of the per-pitch cap. `derbyScoring` imports
// it, never the other way round, so this is now the LEAF of the derby's module
// graph and `swingPoints` is still the one place a payout is clamped.
//
// It is imported by the HUD as well (`shared/CountChip.tsx`,
// `shared/swingCopy.ts`), which is the second reason the seam is worth having:
// a chip that wants to print "×1.50" should pull in a nine-line law, not the
// whole payout table.

// ---------------------------------------------------------------------------
// The CHAIN — the top of the skill curve, and the only multiplier in the game
// ---------------------------------------------------------------------------
//
// ⚠ THE DEFECT THIS EXISTS FOR, MEASURED. The M2 feel pass fixed a derby that
// paid nothing for solid contact, and overcorrected at the top: across a
// gaussian timing/aim model, median of 40 sessions,
//
//     skill      σt (wall ms)   before M2   after M2   with the chain
//     novice          45             387        690             690
//     casual          30            1003       1551            1571
//     decent          18            2139       3016            3424
//     good            10            2678       3771            4630
//     expert           5            2873       3895            4907
//     perfect          0            2818       3892            5254
//
// good → perfect was 1.032×. An expert and a perfect player were the same
// player. The reason is arithmetic and not a payout bug: at those skills BOTH
// hit ~18 home runs out of 24 (74 % against 78 %), and a payout that is LINEAR
// in outcomes can only ever report that 4 %. The one quantity in a derby whose
// gradient is not saturated at the top is the RUN: a chain of length L
// contributes L(L−1)/2 chained pitches, which is 40.8 per session at `good`
// against 52.5 at `perfect` — a 1.29× gradient on a 1.04× outcome difference.
// That superlinearity is the whole mechanic.
//
// ⚠ IT IS EARNED BY SKILL, NOT BY VOLUME, and that is a structural property
// rather than a claim: the chain counts CONSECUTIVE HOME RUNS and every other
// outcome — an out, a foul, a whiff, a take — resets it (`DerbySim.commit`). A
// player who swings at all 24 pitches and hits singles earns exactly nothing
// from it, and `validateDerbyPayout` asserts that no non-home-run payout depends
// on the chain index at all. Measured over 40 sessions per skill, the novice
// row reaches a third consecutive home run 0.05 times a session and the casual
// row 0.53, which is why both rows above are unmoved.
//
// ⚠ AND IT COST A CAP RAISE, WHICH WAS NOT THE FIRST CHOICE. A multiplier has
// only `cap − base` of room. At the old 2000-point round the per-pitch cap was
// 250 against a ~190-point barrelled home run, i.e. 1.32×, and the clamp ate the
// mechanic: sweeping the WHOLE payout space under that cap (base points,
// distance slope, ramp start, ramp step, ramp length, linear/quadratic) the best
// reachable good→perfect was 1.115 — and only by cutting the base home-run
// payout ~35 %, which drops the novice row 19 % and the casual row 21 %, i.e. by
// partly undoing the fix that made contact pay. At ≥95 % bottom retention the
// ceiling was 1.095. So the round ceiling moved instead, and it moved as a
// PER-GAME number (`DERBY_POINTS_PER_ROUND`, the `MAX_COURSE_ROUNDS` shape) so
// that no other game's clamp changed. `derbySim.test.ts` prints the frontier.

/**
 * The first position in a run of consecutive home runs that pays a multiplier.
 * FEEL KNOB.
 *
 * 3 rather than 2, so that the multiplier is a RUN and not a pair, and rather
 * than 4 or 5 so that it is REACHABLE: the owner's live session ended with
 * `bestStreak 3`, which lands exactly on the first rung. A player who never sees
 * a mechanic cannot chase it.
 */
export const CHAIN_START = 3;

/** How much each further consecutive home run adds to the multiplier. FEEL KNOB. */
export const CHAIN_STEP = 0.25;

/** How many rungs the ramp has before it flattens. FEEL KNOB. */
export const CHAIN_MAX_STEPS = 4;

/**
 * The multiplier's ceiling. DERIVED — never hand-set, or the sweep below stops
 * describing the constant it is swept against.
 *
 * ⚠ 2.0 IS THE NUMBER THE CAP HEADROOM BUYS, not a taste. The richest home run
 * this game produces at the shipping bat speed is a barrelled ~415 ft ball at
 * ~190 points; ×2 is 380 against a 500-point per-pitch cap, so the clamp does
 * NOT bind in real play (measured worst single pitch: 76 % of cap) and a maximal
 * session lands at ~70 % of `rounds × DERBY_POINTS_PER_ROUND` — which is the
 * headroom the shipping build has today (67.7 %) and which the card modulators
 * `baseball-progression` will add later need to be worth anything. Raising the
 * ceiling to 2.6 buys 1.192 instead of 1.135 and costs ALL of that headroom
 * (worst pitch 98 % of cap); raising the round ceiling to 6000 instead would buy
 * 1.22. Both are printed by the sweep and neither was taken.
 */
export const CHAIN_MULT_MAX = 1 + CHAIN_STEP * CHAIN_MAX_STEPS;

/**
 * The multiplier for the `chainIndex`-th consecutive home run.
 *
 * `chainIndex` is 1-based and counts the swing being scored: the first home run
 * of a run is 1. Anything that is not a home run passes 0, and gets 1.0 — which
 * is also what a non-finite or negative index gets, because this is reachable
 * from a restored snapshot and a NaN multiplier would propagate into a score the
 * worker silently rejects.
 *
 * ⚠ IT IS 1.0 AT EVERY POSITION BELOW `CHAIN_START`, which is what makes the
 * novice and casual rows byte-identical to the shipping payout rather than
 * merely close. That is asserted, not commented.
 */
export function chainMultiplier(chainIndex: number): number {
  if (!Number.isFinite(chainIndex)) return 1;
  const rungs = Math.min(Math.max(0, Math.floor(chainIndex) - (CHAIN_START - 1)), CHAIN_MAX_STEPS);
  return 1 + CHAIN_STEP * rungs;
}