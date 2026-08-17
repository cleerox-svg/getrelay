import type { CSSProperties } from 'react';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';
import { CHAIN_START, chainMultiplier } from '../../../lib/baseball/derbyChain';
import type { DerbyState } from '../../../lib/baseball/derbyState';

// The derby's status line: round, pitch, outs, score.
//
// ⚠ IT DERIVES NOTHING. Every field is read straight off `DerbyState`, which
// `derbyState.ts` builds fresh from the sim's own counters — no "pitches left"
// computed here from two other numbers, because that is how a HUD and a sim
// start disagreeing about whose round it is. `totalPitches`, `outs` and
// `maxScore` are the sim's arithmetic; this file is a layout.
//
// ⚠ AND IT IS THE ONE PLACE THE FROSTED TOKENS ARE IMPORTED ACROSS GAMES.
// `components/golf/shared/frosted.ts` is a 46-line pure-CSS token module with no
// `three` and no golf logic in it; copying it here to get a baseball-coloured
// pill would be exactly the "fork sideways" the charter names as the failure
// mode (rule 5). HANDOFF: it belongs at `components/games/shared/frosted.ts`,
// and moving it is one import line in each consumer. It is not moved here
// because golf is mid-audit and that file is theirs.

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

function Cell({ k, v, tint }: { k: string; v: string; tint?: string }) {
  return (
    <div style={cell}>
      <span style={label}>{k}</span>
      <span style={tint ? { ...value, color: tint } : value}>{v}</span>
    </div>
  );
}

/**
 * What the NEXT home run would be multiplied by, given the run already going.
 *
 * ⚠ IT IS THE NEXT SWING'S FACTOR, NOT THE LAST ONE'S, and the distinction is
 * the whole point of the cell: a chip that reported what the previous ball
 * earned would be a receipt, and this is meant to be a reason to keep swinging.
 * `curStreak` is the run BEFORE the next swing, so the next home run is at
 * position `curStreak + 1` — the same arithmetic `DerbySim.resolveSwing` does,
 * and it is spelled the same way here so the two cannot disagree about which
 * swing they mean.
 *
 * ⚠ IT DERIVES NO PAYOUT. `chainMultiplier` is the sim's own function; this file
 * calls it and formats, exactly as the header's rule requires.
 */
function nextChain(curStreak: number): { label: string; live: boolean } {
  const m = chainMultiplier(curStreak + 1);
  if (m > 1) return { label: `×${m.toFixed(2)}`, live: true };
  // Not earning yet — show how far off it is, because "0 of 2 more" is the
  // information a player needs and "×1.00" is not.
  return { label: `${curStreak}/${CHAIN_START - 1}`, live: false };
}

export function CountChip({ state }: { state: DerbyState }) {
  const chain = nextChain(state.curStreak);
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
      <Cell k="Round" v={`${state.round}/${state.rounds}`} />
      <Cell k="Pitch" v={`${state.pitch}/${state.pitchesPerRound}`} />
      <Cell k="Outs" v={String(state.outs)} tint={state.outs > 0 ? '#ffb4a2' : undefined} />
      <Cell k="HR" v={String(state.homeRuns)} tint={state.homeRuns > 0 ? '#b6f4c8' : undefined} />
      <Cell k="Chain" v={chain.label} tint={chain.live ? '#ffd166' : undefined} />
      <Cell k="Score" v={state.score.toLocaleString()} />
    </div>
  );
}
