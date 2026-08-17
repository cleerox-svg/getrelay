// Course round SCORECARD — the score formatting plus the card rendering shared
// by the END-OF-ROUND overlay and the MID-ROUND pause sheet (CoursePauseSheet).
//
// All of this lived inside CourseGame, where the card was reachable only on the
// final hole: a player who paused on hole 5 got "Thru 4 · +2" and nothing else.
// The sheet renders the SAME table off the SAME data rather than a second copy
// that would be free to drift from it — and extracting it is also what pays for
// the pause wiring under `budget.test.ts`'s CourseGame ratchet.
//
// Pure DOM/CSS + arithmetic: no `three`, no sim state, no clock and no
// randomness (the screenshot gate is exact-pixel), so it is safe to import from
// the non-lazy HUD.

import type { GolfCourse } from '../../lib/golf/courses';

/** One completed hole on the round scorecard. */
export interface HoleScore {
  hole: number;
  par: number;
  strokes: number;
}

/**
 * The hole being played right now — same shape as a carded hole, deliberately a
 * DIFFERENT type: it is not on the card, so it is not in any total and (see
 * CoursePauseSheet's `endRoundNote`) is not banked when a round is abandoned.
 */
export interface HoleInProgress {
  hole: number;
  par: number;
  strokes: number;
}

// The app bundles JetBrains Mono as var(--font-mono); Tailwind's `font-mono`
// only reaches the generic ui-monospace stack, so numerals use this inline.
export const MONO = { fontFamily: 'var(--font-mono)' } as const;

/**
 * Format a running / total score relative to par: 0 → "E", positive → "+n",
 * negative → "−n" (true minus sign).
 */
export function toPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${-n}`;
}

/** Signed to-par bug label: even reads "E", otherwise the true ± sign. */
export function toParBug(d: number): string {
  return d === 0 ? 'E' : toPar(d);
}

/**
 * Strokes / par / to-par summed across the holes carded so far. ONE place
 * computes a round total, so the HUD readout, the scorecard, the finished-round
 * report and the abandoned-round report can never disagree.
 */
export function cardTotals(card: HoleScore[]): { strokes: number; par: number; toPar: number } {
  const strokes = card.reduce((a, h) => a + h.strokes, 0);
  const par = card.reduce((a, h) => a + h.par, 0);
  return { strokes, par, toPar: strokes - par };
}

// Broadcast "score state" palette, driven by strokes-relative-to-par (d):
// under → emerald, level → slate, over → rose. `grad` is the state stripe/bug
// gradient, `dark` the ink that reads on it, `chip`/`chipFg` the ± chip colours.
export function scoreState(d: number): { grad: string; dark: string; chip: string; chipFg: string } {
  if (d < 0)
    return {
      grad: 'linear-gradient(155deg,#43c96d,#1c6f3d)',
      dark: '#062012',
      chip: 'rgba(67,201,109,.16)',
      chipFg: '#8ff0ab',
    };
  if (d > 0)
    return {
      grad: 'linear-gradient(155deg,#f0492e,#8f1f12)',
      dark: '#2a0a05',
      chip: 'rgba(240,73,46,.16)',
      chipFg: '#ffb3a6',
    };
  return {
    grad: 'linear-gradient(155deg,#64717d,#333e47)',
    dark: '#0b0f12',
    chip: 'rgba(255,255,255,.08)',
    chipFg: 'rgba(255,255,255,.6)',
  };
}

// One hole row (broadcast): mono tabular cells, an alternating faint row tint,
// and the ± rendered as a state-coloured chip. The hole cell carries an
// aria-label so a carded hole is addressable as a row.
function ScoreRow({ hole, alt }: { hole: HoleScore; alt: boolean }) {
  const d = hole.strokes - hole.par;
  const state = scoreState(d);
  const cell = alt ? 'bg-white/[.03]' : '';
  return (
    <>
      <div
        className={`py-1.5 pl-2 tabular-nums text-white ${cell}`}
        style={MONO}
        aria-label={`Hole ${hole.hole}`}
      >
        {hole.hole}
      </div>
      <div className={`py-1.5 px-3 text-right tabular-nums text-white/55 ${cell}`} style={MONO}>
        {hole.par}
      </div>
      <div
        className={`py-1.5 px-3 text-right font-semibold tabular-nums text-white ${cell}`}
        style={MONO}
      >
        {hole.strokes}
      </div>
      <div className={`py-1.5 pr-2 text-right ${cell}`}>
        <span
          className="inline-block rounded px-1.5 py-0.5 text-[11px] font-bold tabular-nums"
          style={{ ...MONO, background: state.chip, color: state.chipFg }}
        >
          {toPar(d)}
        </span>
      </div>
    </>
  );
}

// The hole being PLAYED right now — dimmed, with its live strokes and no ±
// chip, because it is not carded: if the round ends here it does not count.
// Deliberately labelled differently from a carded row ("in progress"), so a
// test or a screen reader cannot mistake it for one.
function InProgressRow({
  hole,
  par,
  strokes,
  alt,
}: {
  hole: number;
  par: number;
  strokes: number;
  alt: boolean;
}) {
  const cell = alt ? 'bg-white/[.03]' : '';
  return (
    <>
      <div
        className={`py-1.5 pl-2 tabular-nums text-white/45 ${cell}`}
        style={MONO}
        aria-label={`Hole ${hole} in progress`}
      >
        {hole}
      </div>
      <div className={`py-1.5 px-3 text-right tabular-nums text-white/35 ${cell}`} style={MONO}>
        {par}
      </div>
      <div className={`py-1.5 px-3 text-right tabular-nums text-white/45 ${cell}`} style={MONO}>
        {strokes}
      </div>
      <div className={`py-1.5 pr-2 text-right text-[10px] font-bold uppercase tracking-wide text-white/35 ${cell}`}>
        in play
      </div>
    </>
  );
}

// A subtotal / total line under the scorecard rows (broadcast): mono strokes +
// a state-coloured (±) suffix; the Total row is emphasised.
function SubtotalRow({
  label,
  par,
  strokes,
  bold,
}: {
  label: string;
  par: number;
  strokes: number;
  bold?: boolean;
}) {
  const d = strokes - par;
  const state = scoreState(d);
  return (
    <div className="flex items-center justify-between">
      <span
        className={`text-[11px] uppercase tracking-wide ${
          bold ? 'font-extrabold text-white' : 'font-bold text-white/70'
        }`}
      >
        {label}
      </span>
      <span className="tabular-nums" style={MONO}>
        <span className={bold ? 'text-base font-extrabold text-white' : 'font-semibold text-white'}>
          {strokes}
        </span>
        <span className="ml-1.5 text-xs font-bold" style={{ color: state.chipFg }}>
          ({toPar(d)})
        </span>
      </span>
    </div>
  );
}

/**
 * The card itself: a header row, one row per carded hole, an optional dim row
 * for the hole in progress, then the subtotals. Front/back nine are split only
 * for an 18-hole card ("Out" would otherwise duplicate "Total"), and the
 * subtotals are omitted entirely while nothing is carded yet.
 *
 * Callers own the scroll container (the end-of-round overlay and the pause
 * sheet allow different heights).
 */
export function ScorecardTable({
  card,
  inProgress,
}: {
  card: HoleScore[];
  inProgress?: HoleInProgress;
}) {
  const front = card.slice(0, 9);
  const back = card.slice(9);
  const f = cardTotals(front);
  const b = cardTotals(back);
  const total = cardTotals(card);
  return (
    <>
      <div className="grid grid-cols-[1fr_auto_auto_auto] items-center">
        <div className="py-1 pl-2 text-[10px] font-bold uppercase tracking-wide text-white/40">
          Hole
        </div>
        <div className="py-1 px-3 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
          Par
        </div>
        <div className="py-1 px-3 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
          Score
        </div>
        <div className="py-1 pr-2 text-right text-[10px] font-bold uppercase tracking-wide text-white/40">
          ±
        </div>
        {card.map((h, i) => (
          <ScoreRow key={h.hole} hole={h} alt={i % 2 === 1} />
        ))}
        {inProgress && (
          <InProgressRow
            hole={inProgress.hole}
            par={inProgress.par}
            strokes={inProgress.strokes}
            alt={card.length % 2 === 1}
          />
        )}
      </div>

      {card.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-white/15 px-2 pt-2.5">
          {back.length > 0 && (
            <>
              <SubtotalRow label="Out" par={f.par} strokes={f.strokes} />
              <SubtotalRow label="In" par={b.par} strokes={b.strokes} />
            </>
          )}
          <SubtotalRow label="Total" par={total.par} strokes={total.strokes} bold />
        </div>
      )}
    </>
  );
}

/**
 * End-of-round scorecard overlay (full-round mode): the dark broadcast card with
 * the total score bug, the scrollable table and the two round-level buttons.
 * PURELY PRESENTATIONAL — the round is reported by CourseGame the moment the
 * final hole is carded, never by a button here.
 */
export function CourseScorecardOverlay({
  course,
  card,
  onPlayAgain,
  onExit,
}: {
  course: GolfCourse;
  card: HoleScore[];
  onPlayAgain: () => void;
  onExit?: () => void;
}) {
  const total = cardTotals(card);
  const totalState = scoreState(total.toPar);
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,.72)',
        padding: 16,
      }}
    >
      <div
        className="w-[min(92vw,420px)] overflow-hidden rounded-2xl border"
        style={{
          background: 'linear-gradient(160deg,#0f1a14,#0a120d)',
          borderColor: 'rgba(255,255,255,.08)',
          boxShadow: '0 20px 60px rgba(0,0,0,.55)',
        }}
      >
        {/* Header: title + course on the left, total score bug right. */}
        <div className="flex items-end justify-between gap-3 px-4 pb-3 pt-4">
          <div className="min-w-0">
            <div className="text-2xl font-extrabold uppercase tracking-wide text-white">
              Scorecard
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-wide text-white/55" style={MONO}>
              {course.name}
              {course.location ? ` · ${course.location}` : ''}
            </div>
          </div>
          <div
            className="flex flex-col items-center justify-center rounded-xl px-3 py-1.5"
            style={{ background: totalState.grad, color: totalState.dark }}
          >
            <span className="text-2xl font-extrabold leading-none tabular-nums" style={MONO}>
              {total.strokes}
            </span>
            <span className="mt-0.5 text-[8px] font-bold uppercase tracking-wider opacity-80">
              {toParBug(total.toPar)} · to par
            </span>
          </div>
        </div>

        <div className="max-h-[52vh] overflow-auto px-4 pb-1">
          <ScorecardTable card={card} />
        </div>

        <div className="flex gap-2.5 px-4 pb-4 pt-3">
          <button
            onClick={onPlayAgain}
            className="flex-1 rounded-full bg-emerald-500 px-5 py-2.5 text-sm font-bold text-white"
          >
            Play round again
          </button>
          <button
            onClick={onExit}
            className="rounded-full bg-white/20 px-5 py-2.5 text-sm font-bold text-white"
          >
            Menu
          </button>
        </div>
      </div>
    </div>
  );
}
