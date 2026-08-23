// THE DUEL'S PLAIN-ENGLISH READOUT COPY — one line for what a pitch did.
//
// The same seam `swingCopy.ts` was split along, and for the same reason: pure
// `PitchRecord → string` functions with no React, no refs and no clock, so the
// vocabulary is unit-testable without pumping a half-inning through a mounted
// HUD. `DuelGame` prints these under the batter and `duelBoard.ts` puts the
// IDENTICAL string on the videoboard — one vocabulary, exactly as the derby's
// board takes `describeSwing(r)` verbatim.
//
// ⚠ IT DECIDES NOTHING. Every field below was produced by `DuelSim`: the umpire's
// call is `record.strike`, the play is `fielding.ts`'s `PlayResult`, the runs are
// `duelInnings.applyPa`'s. This file reads and formats.
//
// ⚠ AND THE PLATE APPEARANCE OUTRANKS THE PITCH. A called strike is "Called
// strike" on 0-0 and "Strikeout looking" on 0-2, because `record.pa` is set iff
// the pitch ENDED the plate appearance — the sim's own answer, not a count
// comparison done here. Re-deriving "was that the third strike?" from
// `strikesAfter` would be a second implementation of `duelInnings.countAfter`
// living in a HUD, and it would be wrong on the foul at two strikes.

import type { Bases } from '../../../lib/baseball/duelRules';
import type { PitchRecord } from '../../../lib/baseball/duelState';
import type { BoardTone } from '../stadium/boardState';

/** The runs a plate appearance drove in, as a suffix. '' when it drove none. */
function runsTail(r: PitchRecord): string {
  const runs = r.pa?.runs ?? 0;
  if (runs < 1) return '';
  return runs === 1 ? ' · 1 run' : ` · ${runs} runs`;
}

/** What a ball in play became. `play` is null only if nothing was put in play. */
function describeInPlay(r: PitchRecord): string {
  const ft = r.distFt.toFixed(0);
  switch (r.play) {
    case 'HR':
      return `GONE! ${ft} ft`;
    case 'TRIPLE':
      return `Triple — ${ft} ft`;
    case 'DOUBLE':
      return `Double — ${ft} ft`;
    case 'SINGLE':
      return `Base hit — ${ft} ft`;
    case 'FOUL':
      return 'Foul ball';
    default:
      // ⚠ THE FIELDER IS NAMED BECAUSE THE SIM NAMED HIM. `record.fielder` is
      // `fielding.ts`'s nearest defender label; inventing "flied out to left"
      // from the spray angle here would be a second fielding model in a HUD.
      return r.fielder ? `Out — ${r.fielder}` : `Out — ${ft} ft`;
  }
}

/** One line of plain English for one pitch. */
export function describePitch(r: PitchRecord): string {
  const ended = r.pa?.outcome ?? null;
  switch (r.outcome) {
    case 'ball':
      return ended === 'walk' ? 'Ball four — walk' : 'Ball';
    case 'calledStrike':
      return ended === 'strikeout' ? 'Strikeout looking' : 'Called strike';
    case 'swingingStrike':
      return ended === 'strikeout' ? 'Strikeout swinging' : 'Swing and a miss';
    case 'foul':
      return 'Foul ball';
    default:
      return describeInPlay(r) + runsTail(r);
  }
}

/**
 * The accent of a result line — the OUTCOME, never the copy.
 *
 * ⚠ IT IS THE BATTING SIDE'S TONE, AND THE HUD SUPPLIES WHOSE HALF IT IS. A home
 * run is 'gone' when the player hit it and a strikeout is 'good' when the player
 * threw it, so the same record reads opposite ways in the two halves — which is
 * the whole of what alternating roles means for copy. `mine` is "the human was
 * the one at bat for this pitch".
 */
export function toneOfPitch(r: PitchRecord, mine: boolean): BoardTone {
  const good = r.play === 'HR' || r.play === 'TRIPLE' || r.play === 'DOUBLE' || r.play === 'SINGLE';
  if (r.play === 'HR') return mine ? 'gone' : 'miss';
  if (good) return mine ? 'good' : 'miss';
  if (r.outcome === 'ball') return mine ? 'good' : 'miss';
  if (r.outcome === 'foul') return 'neutral';
  // A strike or an out: good for the pitching side.
  return mine ? 'miss' : 'good';
}

/**
 * Which bases are occupied, in five characters or fewer.
 *
 * ⚠ FIVE, BECAUSE `boardState.BoardSide` SAYS SO — an 18 ft column at 430 ft
 * carries 5.4 characters at the legibility floor and `fitRun` truncates anything
 * longer with a visible mark. '1-2-3' is exactly five; the em dash for empty is
 * one.
 */
export function basesLabel(bases: Bases): string {
  const on = [bases[0] ? '1' : '', bases[1] ? '2' : '', bases[2] ? '3' : ''].filter(Boolean);
  return on.length ? on.join('-') : '—';
}
