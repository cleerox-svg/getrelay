// Course mode's PAUSE SHEET — raised when the round is frozen (`paused`), with
// the same contract mini-golf's sheet has had all along (see GolfGame.tsx): the
// round stays mounted and frozen underneath, Resume is a true continue, and
// "End round" funnels through the SAME exit path as the HUD's header back
// button. The back gesture that raises it is a history event owned by
// GolfScreen / useGameFlow, not by this sheet.
//
// Three things the Course HUD had nowhere else to put:
//   • THE SCORECARD. Mid-round the player had "Thru 4 · +2" and nothing else —
//     the card was reachable only after the final hole. This renders the SAME
//     `ScorecardTable` the end-of-round overlay does (CourseScorecard.tsx), plus
//     a dim row for the hole in progress showing its live strokes.
//   • MUTE, as a sheet row. It was a bare icon in the top bar; Putt and Range
//     both have it as a row here.
//   • END ROUND, which has to say what it costs — see `endRoundNote` below.
//
// Pure DOM/CSS: no `three`, no sim, no clock and no randomness.

import { MuteButton } from './shared/MuteButton';
import {
  ScorecardTable,
  cardTotals,
  toPar,
  type HoleInProgress,
  type HoleScore,
} from './CourseScorecard';

// One declaration of "the hole in progress", shared with the table that dims it.
export type { HoleInProgress };

/**
 * The truthful subtitle under "End round".
 *
 * Ending mid-round BANKS the holes already carded (CourseGame reports a partial
 * round exactly as GolfGame/RangeGame bank a partial run) and DISCARDS the hole
 * in progress, which was never carded. Both halves of that have to be on the
 * button, because neither is guessable: the old behaviour threw the whole round
 * away, so "your six holes are safe" is news, and a player three strokes into
 * hole 7 will otherwise assume those three count.
 *
 * `inProgress` is OMITTED when the current hole has already been holed out and
 * carded (pausing on the hole-out card). Nothing is in the balance then, and a
 * "hole 9 won't count" line would be a plain lie about a hole that just did.
 *
 * Exported and pure so it can be asserted directly, without rendering a sheet.
 */
export function endRoundNote(a: { banked: number; inProgress?: HoleInProgress }): string {
  const banked =
    a.banked === 0 ? 'Nothing to bank yet' : `Banks ${a.banked} hole${a.banked === 1 ? '' : 's'}`;
  if (!a.inProgress) return banked;
  const n = a.inProgress.strokes;
  return `${banked} · hole ${a.inProgress.hole} (${n} stroke${n === 1 ? '' : 's'}) won't count`;
}

export function CoursePauseSheet({
  courseName,
  holeNo,
  holeCount,
  card,
  inProgress,
  onResume,
  onEndRound,
}: {
  courseName: string;
  // The hole being played, by its DISPLAY id, and the round's length.
  holeNo: number;
  holeCount: number;
  // Holes carded so far this round — empty in single-hole play, which never
  // cards. What "End round" would bank.
  card: HoleScore[];
  // The hole in progress, or undefined once it is holed out and carded.
  inProgress?: HoleInProgress;
  onResume: () => void;
  onEndRound: () => void;
}) {
  const total = cardTotals(card);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Round paused"
      // Tapping the scrim resumes, matching the Putt + Range sheets. Above the
      // AccuracyBar's full-bleed tap overlay (z 45) so a paused strike beat can
      // never swallow a sheet tap.
      onClick={onResume}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        className="fade-in w-[min(92vw,360px)] overflow-hidden rounded-2xl border"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'linear-gradient(160deg,#0f1a14,#0a120d)',
          borderColor: 'rgba(255,255,255,.08)',
          boxShadow: '0 20px 60px rgba(0,0,0,.55)',
        }}
      >
        <div className="px-5 pt-4 text-center">
          <div className="text-lg font-extrabold uppercase tracking-wide text-white">
            Round paused
          </div>
          <div className="mt-0.5 text-[11px] uppercase tracking-wide text-white/55">
            {courseName} · Hole {holeNo} of {holeCount}
            {card.length > 0 ? ` · Thru ${card.length} · ${toPar(total.toPar)}` : ''}
          </div>
        </div>

        {/* The card, exactly as the end-of-round overlay draws it, plus the dim
            in-progress row. Scrolls on its own so an 18-hole card can't push the
            buttons off screen. */}
        <div className="mt-3 max-h-[38vh] overflow-auto px-4">
          <ScorecardTable card={card} inProgress={inProgress} />
        </div>

        <div className="px-4 pb-4 pt-3">
          <button
            type="button"
            onClick={onResume}
            className="w-full rounded-xl px-5 py-3 text-sm font-bold text-white"
            style={{ background: 'var(--accent)', border: 0 }}
          >
            Resume
          </button>
          <MuteButton variant="sheet-dark" />
          {/* Destructive, and it states what happens. Single tap, like Putt and
              Range's "End game" — the back gesture that opens this sheet is
              already the confirm step (first press pauses, second leaves). */}
          <button
            type="button"
            onClick={onEndRound}
            className="mt-2 w-full rounded-xl px-5 py-2.5"
            style={{
              border: '1px solid rgba(240,73,46,.45)',
              background: 'rgba(240,73,46,.12)',
              color: '#ffb3a6',
            }}
          >
            <span className="block text-sm font-bold">End round</span>
            <span className="mt-0.5 block text-[11px] font-semibold leading-tight text-white/55">
              {endRoundNote({ banked: card.length, inProgress })}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
