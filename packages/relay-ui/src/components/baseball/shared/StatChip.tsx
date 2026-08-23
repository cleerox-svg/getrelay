import type { CSSProperties } from 'react';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';

// THE STATUS PILL, as a layout with nothing in it.
//
// Extracted from `CountChip.tsx` when the duel needed the same pill with
// different cells. The alternative was a second `Cell` and a second frosted
// container in `DuelChip.tsx` — the charter's rule 5 ("share upward, never fork
// sideways") failing in the softest possible place, where nothing breaks and the
// two modes' chrome slowly stops matching.
//
// ⚠ IT DERIVES NOTHING, AND THAT RULE IS INHERITED BY EVERY CALLER. A cell is a
// label and an already-formatted string. No "pitches left" computed from two
// other numbers here or in a caller — that is how a HUD and a sim start
// disagreeing about whose inning it is.
//
// ⚠ AND IT IS THE ONE PLACE THE FROSTED TOKENS ARE IMPORTED ACROSS GAMES.
// `components/golf/shared/frosted.ts` is a 46-line pure-CSS token module with no
// `three` and no golf logic in it. HANDOFF: it belongs at
// `components/games/shared/frosted.ts`, and moving it is one import line in each
// consumer. Not moved here because golf is mid-audit and that file is theirs.

const cell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  lineHeight: 1.05,
  minWidth: 42,
};
const label: CSSProperties = {
  fontSize: 9,
  letterSpacing: 0.8,
  textTransform: 'uppercase',
  opacity: 0.7,
};
const value: CSSProperties = { ...MONO_NUM, fontSize: 16, fontWeight: 800 };

/** One label-over-value column. `tint` colours the value alone. */
export interface StatCell {
  k: string;
  v: string;
  tint?: string | undefined;
}

export function Cell({ k, v, tint }: StatCell) {
  return (
    <div style={cell}>
      <span style={label}>{k}</span>
      <span style={tint ? { ...value, color: tint } : value}>{v}</span>
    </div>
  );
}

export function StatChip({ cells }: { cells: StatCell[] }) {
  return (
    <div
      style={{
        ...frostedSurface(999),
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '7px 16px',
        pointerEvents: 'none',
      }}
    >
      {cells.map((c) => (
        <Cell key={c.k} k={c.k} v={c.v} tint={c.tint} />
      ))}
    </div>
  );
}
