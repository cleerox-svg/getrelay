// The post-game results screen for the two SCORED hub flows — Mini-Golf and the
// range's Target Challenge.
//
// It was written twice, inline in `GolfScreen`, 77 lines each and identical
// except for five values: the result numbers, the "ended early" wording, the
// chip row, what "Play again" does, and which leaderboard to show. That is the
// shape a component is for, and the duplication was load-bearing in the wrong
// direction — `GolfScreen` is at its size ratchet, so every line spent on a
// second copy of this markup is a line the hub's actual wiring cannot have.
//
// Pure presentation: no api, no sim, no `three`, no timers, no randomness.

import { GolfLeaderboard } from './GolfLeaderboard';

/**
 * One per-round pill. `label` is the whole text (the range's ✓/✗ prefix included)
 * and `ok` picks the green/red pair.
 */
export interface ResultChip {
  label: string;
  ok: boolean;
}

export function GolfResultScreen({
  score,
  bestStreak,
  serverBest,
  earlyNote,
  chips,
  onPlayAgain,
  onMenu,
  board,
  refreshKey,
}: {
  score: number;
  bestStreak: number;
  // The server's personal best for this board, once the submit has answered.
  serverBest: number | null;
  // "Ended early — 3/8 balls", or null for a completed run.
  earlyNote: string | null;
  chips: ResultChip[];
  onPlayAgain: () => void;
  onMenu: () => void;
  // Which board to list underneath. Omitted → GolfLeaderboard's own default
  // ('golf', mini-golf).
  board?: 'golf' | 'golfcourse' | 'golfrange';
  // Bumped by the caller once the submit has answered, so the board refetches.
  refreshKey: number;
}) {
  return (
    <div className="px-4 flex flex-col gap-4">
      <div
        className="rounded-2xl p-5 text-center"
        style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
      >
        <div className="text-xs font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
          FINAL SCORE
        </div>
        <div className="text-[40px] font-bold tabular-nums fog-pop" style={{ color: 'var(--text)' }}>
          {score.toLocaleString()}
        </div>
        <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
          Best streak x{bestStreak}
          {serverBest != null ? (
            <span className="ml-2 font-semibold" style={{ color: 'var(--accent)' }}>
              Best: {serverBest.toLocaleString()}
            </span>
          ) : null}
        </div>
        {earlyNote ? (
          <div className="text-xs pt-1" style={{ color: 'var(--text-dim)' }}>
            {earlyNote}
          </div>
        ) : null}
        {/* Per-shot / per-hole chips. */}
        <div className="flex flex-wrap justify-center gap-1.5 pt-3">
          {chips.map((c, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums"
              style={{
                background: c.ok
                  ? 'color-mix(in srgb, var(--online) 18%, transparent)'
                  : 'color-mix(in srgb, var(--ping) 15%, transparent)',
                color: c.ok ? 'var(--online)' : 'var(--ping)',
              }}
            >
              {c.label}
            </span>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-xl py-3 text-[15px] font-bold"
          style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
          onClick={onPlayAgain}
        >
          Play again
        </button>
        <button
          type="button"
          className="flex-1 rounded-xl py-3 text-[15px] font-bold"
          style={{
            background: 'var(--card-bg)',
            color: 'var(--text)',
            border: '1px solid var(--separator)',
          }}
          onClick={onMenu}
        >
          Menu
        </button>
      </div>

      <GolfLeaderboard refreshKey={refreshKey} game={board} />
    </div>
  );
}
