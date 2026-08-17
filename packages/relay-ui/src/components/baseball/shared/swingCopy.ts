// The derby's plain-English READOUT COPY: one line for what a swing did, and one
// optional coaching line for the lesson it happened to demonstrate.
//
// Split out of `DerbyGame.tsx` at the 700-line component cap — EXTRACTION, NOT A
// RAISED CAP, the same discipline `lib/baseball` uses. The seam is real: these
// are pure `SwingResult → string` functions with no React, no refs and no
// clock, so they are unit-testable directly instead of only through a mounted
// HUD, which is what `DerbyGame.test.tsx` needs in order to assert the copy at
// all without pumping a 24-pitch session per string.
//
// ⚠ THEY DECIDE NOTHING. Every number below was produced by `DerbySim`; this
// file reads `SwingResult` and the park's fence DATA and formats. The layering
// rule is "GL renders and never computes gameplay, HUD polls and never
// re-renders per frame" — copy is the HUD's half of that, and it stays copy.

import { chainMultiplier } from '../../../lib/baseball/derbyChain';
import type { SwingResult } from '../../../lib/baseball/derbyState';
import type { Park } from '../../../lib/baseball/parks';
import { FOUL_LINE_DEG } from '../../../lib/baseball/parks';

/**
 * One line of plain English for a swing.
 *
 * ⚠ EVERY SCORING OUTCOME NOW SHOWS ITS DISTANCE AND ITS PAYOUT, and that is the
 * highest-value string in the HUD. M2 shipped `'In play — out'` for a 405 ft fly
 * ball that scored 0 — measured, 20–48 % of a session at every skill level — so
 * the game's answer to a well-struck ball was indistinguishable from its answer
 * to a whiff. `derbyScoring.ts` made those swings pay; this is what makes the
 * player able to SEE that they paid, and the two halves are the fix.
 *
 * A whiff and a take are the only two without a `+n`, because they are the only
 * two that can never earn one — printing `+0` on them would be true and useless,
 * and printing it on a foul would be a lie.
 */
export function describeSwing(r: SwingResult): string {
  const ft = r.distFt.toFixed(0);
  switch (r.outcome) {
    case 'homeRun': {
      // ⚠ THE MULTIPLIER IS PRINTED WHEN IT IS EARNING, AND ONLY THEN. A
      // mechanic the player cannot see is a mechanic he cannot chase, and
      // `+380` on its own is indistinguishable from a monstrous home run. The
      // factor is read from `chainMultiplier(r.chainIndex)` — the sim's own
      // function on the sim's own reported index — rather than divided out of
      // `points`, which rounds and would print `×1.99`.
      const m = chainMultiplier(r.chainIndex);
      const chain = m > 1 ? ` ×${m.toFixed(2)}` : '';
      return `GONE! ${ft} ft · +${r.points}${chain}`;
    }
    case 'foul':
      return `Foul ball · +${r.points}`;
    case 'take':
      return r.strike ? 'Took a strike' : 'Ball';
    case 'whiff':
      return 'Swing and a miss';
    default:
      return r.fence === 'offWall'
        ? `Off the wall — ${ft} ft · +${r.points}`
        : `Caught — ${ft} ft · +${r.points}`;
  }
}

/**
 * The two fence numbers the coaching copy quotes, read straight off PARK DATA so
 * that a second park says its own dimensions rather than Harbourfront's.
 *
 * ⚠ THE "GAPS" ARE THE SHALLOWEST SAMPLE STRICTLY INSIDE THE FOUL LINES. Quoting
 * the lines themselves (328 ft at Harbourfront) would be coaching the player to
 * hook one foul, which is the outcome `PULL_INTENT_MAX_IN` exists to make
 * possible and the copy has no business recommending.
 *
 * `clearFt` is a first-order clearance estimate — the gap's distance plus its
 * wall height — on the same arithmetic BASEBALL.md § "The park" quotes: a 400 ft
 * carry lands at the BASE of a 400 ft wall, and clearing a 10 ft wall there
 * takes ~409 ft against this rule's 410. It gates a HINT, never an outcome, so
 * the conservative foot is free and the alternative (re-deriving
 * `distanceAtHeight` in a HUD) would be gameplay in the wrong layer.
 */
export function parkCopyNumbers(park: Park): { deepFt: number; gapFt: number; clearFt: number } {
  const fair = park.fence.filter((s) => Math.abs(s.bearingDeg) < FOUL_LINE_DEG);
  return {
    deepFt: Math.max(...fair.map((s) => s.distFt)),
    gapFt: Math.min(...fair.map((s) => s.distFt)),
    clearFt: Math.min(...fair.map((s) => s.distFt + s.heightFt)),
  };
}

/**
 * The one CONTEXTUAL coaching line — deliberately self-extinguishing rather than
 * a permanent tip.
 *
 * ⚠ THE LESSON IT TEACHES IS MEASURED, AND IT IS NOT THE ONE THAT SOUNDS RIGHT.
 * A reticle-X sweep at perfect timing (40 sessions per row, aiming at the
 * pitch's own height) says dead centre is the WORST viable placement:
 *
 *     reticleX  0.0 ft   HR 54 %   ← "aim at the middle", the natural instinct
 *     reticleX −0.3 ft   HR 70 %
 *     reticleX +0.2 ft   HR 96 %
 *
 * Not because centring is bad contact — it is the BEST contact on the board,
 * 406.7 ft of mean carry at a 100 % barrel rate — but because dead centre is the
 * deepest wall in the park. The player's ball was good and the park was bigger
 * there, and nothing on screen ever said so.
 *
 * So this fires on exactly the swings where that happened: an in-play ball whose
 * carry would have cleared the gaps. A player who has learned it stops producing
 * those swings and never reads it again, which is the property a permanent tip
 * cannot have.
 *
 * ⚠ IT SAYS "OFF THE MIDDLE", NOT "PULL", AND THE DIFFERENCE IS A KNOWN MODEL
 * DEFECT. The sweep above is ASYMMETRIC — +0.2 ft (a RHB going the other way)
 * beats −0.3 ft (pulling) at a park whose ±22° samples are both 375 ft — and the
 * asymmetry tracks CARRY (401.8 ft against 387.4), i.e. it is `eA` rising toward
 * the handle in a rigid-body bat with no `e(z)` and therefore no jamming
 * (BASEBALL.md § "The collision"). Teaching "shade to the opposite field" would
 * be teaching a modelling limitation. The symmetric, real half of the finding is
 * that the deepest wall is straight ahead, and that is all this line claims.
 */
export function coachSwing(r: SwingResult, gapFt: number, clearFt: number): string | null {
  if (r.outcome !== 'inPlay' || r.distFt < clearFt) return null;
  return `That carries the ${gapFt.toFixed(0)} ft gaps — dead centre is the deep part.`;
}
