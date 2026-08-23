import type { DuelState } from '../../../lib/baseball/duelState';
import { basesLabel } from './duelCopy';
import { StatChip } from './StatChip';

// The duel's status line: inning, count, outs, who is on, and the score.
//
// ⚠ IT DERIVES NOTHING. Every field is read straight off `DuelState`, which
// `duelState.ts` builds fresh from the sim's own counters. In particular the
// count is `balls`/`strikes` as the sim holds them — not `last.ballsAfter`,
// which is the count that pitch PRODUCED and is 4-2 on a walk.
//
// ⚠ AND THE SCORE IS LABELLED BY ROLE, NOT BY SIDE. `humanBats` says which half
// the player bats; the chip shows YOU and CPU rather than AWAY and HOME, because
// "am I winning" is the question a status line answers. `duelBoard.ts` owns the
// same two names — see its note on why they are not club marks.

export function DuelChip({ state }: { state: DuelState }) {
  const you = state.humanBats === 'home' ? state.homeScore : state.awayScore;
  const cpu = state.humanBats === 'home' ? state.awayScore : state.homeScore;
  return (
    <StatChip
      cells={[
        { k: 'Inn', v: `${state.half === 'top' ? 'T' : 'B'}${state.inning}` },
        { k: 'Count', v: `${state.balls}-${state.strikes}` },
        { k: 'Outs', v: String(state.outs), tint: state.outs > 0 ? '#ffb4a2' : undefined },
        { k: 'On', v: basesLabel(state.bases) },
        { k: 'You', v: String(you), tint: you > cpu ? '#b6f4c8' : undefined },
        { k: 'CPU', v: String(cpu), tint: cpu > you ? '#ffb4a2' : undefined },
      ]}
    />
  );
}
