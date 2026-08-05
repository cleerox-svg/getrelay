import { useEffect, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '../../lib/api';
import type { GameLeaderboardEntry } from '../../lib/types';

interface Props {
  // Bump to force a refetch (e.g. after a score submit succeeds).
  refreshKey?: number;
  // Which board to show: putting ('golf') or the driving range
  // ('golfrange'). Defaults to putting so Phase-1 call sites are unchanged.
  game?: 'golf' | 'golfrange';
}

// Weekly / all-time Golf leaderboard. Rows come pre-ranked from the
// worker; the caller's own row arrives flagged `mine`. Clone of
// FogLeaderboard, parameterized over the putting vs driving-range board.
export function GolfLeaderboard({ refreshKey = 0, game = 'golf' }: Props) {
  const [period, setPeriod] = useState<'weekly' | 'all'>('weekly');
  const [entries, setEntries] = useState<GameLeaderboardEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(false);
    api
      .getGameLeaderboard(period, game)
      .then((r) => {
        if (!cancelled) setEntries(r.entries);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [period, refreshKey, attempt, game]);

  return (
    <div>
      {/* Weekly / all-time segmented control — same idiom as SportsTabs. */}
      <div
        className="flex rounded-[10px] p-[3px] gap-[3px] mb-2"
        style={{ background: 'var(--bubble-them)' }}
      >
        {(
          [
            ['weekly', 'This week'],
            ['all', 'All time'],
          ] as const
        ).map(([key, label]) => {
          const active = period === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPeriod(key)}
              className="flex-1 rounded-lg py-[6px] text-[13px] font-bold"
              style={{
                border: 'none',
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? '#FFFFFF' : 'var(--text)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {error ? (
        <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
          Couldn’t load the leaderboard.
          <button
            type="button"
            className="block mx-auto mt-2 font-semibold"
            style={{ color: 'var(--accent)', background: 'transparent', border: 0 }}
            onClick={() => setAttempt((a) => a + 1)}
          >
            Retry
          </button>
        </div>
      ) : entries === null ? (
        <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="text-center py-6 text-sm" style={{ color: 'var(--text-dim)' }}>
          Play a round to get on the board.
        </div>
      ) : (
        <div
          className="rounded-2xl overflow-hidden"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
        >
          {entries.map((e, i) => (
            <div
              key={e.userId}
              className="flex items-center gap-3 px-3 py-2"
              style={{
                borderTop: i > 0 ? '1px solid var(--separator)' : undefined,
                background: e.mine
                  ? 'color-mix(in srgb, var(--accent) 12%, transparent)'
                  : undefined,
              }}
            >
              <span
                className="w-6 text-center text-sm font-bold tabular-nums shrink-0"
                style={{ color: i < 3 ? 'var(--accent)' : 'var(--text-dim)' }}
              >
                {i + 1}
              </span>
              <Avatar src={e.avatarUrl} name={e.displayName} size={32} />
              <span
                className="flex-1 min-w-0 truncate text-sm font-semibold"
                style={{ color: 'var(--text)' }}
              >
                {e.displayName}
                {e.mine ? (
                  <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-dim)' }}>
                    (you)
                  </span>
                ) : null}
              </span>
              <span className="text-sm font-bold tabular-nums" style={{ color: 'var(--text)' }}>
                {e.best.toLocaleString()}
              </span>
              <span
                className="text-xs tabular-nums w-14 text-right shrink-0"
                style={{ color: 'var(--text-dim)' }}
              >
                {e.games} game{e.games === 1 ? '' : 's'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
