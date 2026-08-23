// THE SIDE COLUMNS BOTH MODES SHARE.
//
// Extracted from `derbyBoard.ts` when the duel wanted the identical PITCH panel:
// a pitch's type and its plate speed are the same two facts in both games, and
// two copies of the same `BoardSide` shape is the charter's "one implementation
// per concept" failing where nothing would ever fail loudly — the two boards
// would just slowly stop agreeing about how a pitch id is capitalised.
//
// Pure data mapping. No React, no clock, no `three`.

import type { PitchId } from '../../../lib/baseball/pitches';
import type { BoardSide } from '../stadium/boardState';

/**
 * ⚠ TWO ROWS PER COLUMN, AND THE NUMBER IS `boardPanels.sideRowBudget`, NOT A
 * PREFERENCE. A side column is `label + value` stacks between `SIDE_TOP` and the
 * bottom edge, which at this geometry is **two**, and `sideOps` takes
 * `.slice(0, sideRowBudget(pt))` — so a third row is not a smaller row, it is a
 * row that silently does not exist.
 *
 * ⚠ AND `derbyBoard.ts` SHIPPED FOUR OF THEM. The first version sent SCORE / HR /
 * LONG / RUN and TYPE / MPH / OF / OUTS; the board drew SCORE / HR and TYPE /
 * MPH and dropped the other four on the floor. Every test passed and the PIXEL
 * HARNESS showed it in the first frame it ever painted. That is why the budget is
 * imported and asserted rather than remembered — and why it lives here now, so
 * the duel inherits the lesson instead of re-learning it.
 */
export const SIDE_ROWS = 2;

/**
 * The right column: the pitch just thrown, or about to be.
 *
 * ⚠ NUMBERS, NOT WORDS, AND THE GEOMETRY IS WHY. An 18 ft column at 430 ft
 * carries ten characters at the legibility floor (`boardAtlas.panelCharBudget`
 * prints the measurement), so a longer value truncates with a visible mark
 * rather than shrinking out of the rule. `FF` and `94` are well inside it;
 * `4-Seam Fastball` is not, which is why the id is what goes up.
 */
export function pitchSide(pitchId: PitchId | null, speedMph: number | null): BoardSide {
  return {
    heading: 'PITCH',
    rows: [
      { label: 'TYPE', value: (pitchId ?? '—').toUpperCase() },
      // Rounded HERE, on the way in: the repaint key is taken over the board's
      // INPUTS and a 1024 × 512 RGBA atlas is 2.0 MB per upload, so two polls
      // handing in 93.7001 and 93.7002 would be a full re-upload of a
      // byte-identical picture. `boardState.normaliseArray` cannot help — it
      // normalises numbers, and this is already a STRING by then.
      { label: 'MPH', value: speedMph === null ? '—' : `${Math.round(speedMph)}` },
    ],
  };
}
