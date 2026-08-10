import { useEffect, useMemo, useRef, useState } from 'react';
import { FogLeaderboard } from './FogLeaderboard';
import { FreePlay } from './FreePlay';
import { GuessGame } from './GuessGame';
import type { GameResult } from './GuessGame';
import { api } from '../../lib/api';
import { availableSources } from '../../lib/fog/sources';
import type { FogCategory, SourceAvailability } from '../../lib/fog/sources';
import { getFogStats, recordFogGame } from '../../lib/fog/stats';
import { ROUNDS } from '../../lib/fog/tuning';
import { useGameFlow } from '../../lib/games/useGameFlow';

const CATEGORIES: { id: FogCategory; label: string }[] = [
  { id: 'mix', label: 'Mix' },
  { id: 'logos', label: 'Team logos' },
  { id: 'pack', label: 'Objects' },
  { id: 'gifs', label: 'GIFs' },
  { id: 'music', label: 'Album art' },
  { id: 'contacts', label: 'Contacts' },
];

const UNAVAILABLE_REASON: Partial<Record<FogCategory, string>> = {
  logos: 'Teams unavailable',
  gifs: 'GIFs unavailable',
  music: 'Music search unavailable',
  contacts: 'Need 4 contacts with avatars',
};

const chip = (active: boolean, disabled: boolean): React.CSSProperties => ({
  border: '1px solid var(--separator)',
  background: active ? 'var(--accent)' : 'var(--card-bg)',
  color: active ? '#FFFFFF' : disabled ? 'var(--text-dim)' : 'var(--text)',
  opacity: disabled ? 0.55 : 1,
  borderRadius: 999,
  padding: '7px 12px',
  fontSize: 13,
  fontWeight: 600,
  textAlign: 'left',
});

export function FogScreen({ onExitToHub }: { onExitToHub: () => void }) {
  const { screen, setScreen, paused, setPaused, startGame, startFree, consumeHistoryEntry, statsKey } =
    useGameFlow();
  const [category, setCategory] = useState<FogCategory>('mix');
  const [avail, setAvail] = useState<SourceAvailability | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);
  const submittedRef = useRef<GameResult | null>(null);

  // Local stats re-read whenever we land back on menu/results — cheap
  // localStorage read, no need for state plumbing from the recorder.
  const stats = useMemo(
    () => getFogStats(),
    [screen, result, statsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  useEffect(() => {
    let cancelled = false;
    availableSources().then((a) => {
      if (!cancelled) setAvail(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist + submit a finished game exactly once. Local stats are
  // updated regardless of network; the POST is fire-and-forget — a
  // failed submit keeps the local best and just skips the "Best" pill.
  // Partial games (roundsPlayed 1..7) are valid submissions; a
  // 0-round game never reaches this screen and must never be POSTed.
  useEffect(() => {
    if (screen !== 'results' || !result || result.roundsPlayed < 1 || submittedRef.current === result)
      return;
    submittedRef.current = result;
    recordFogGame(result.score, result.bestStreak);
    api
      .submitGameScore({
        score: result.score,
        rounds: result.roundsPlayed,
        bestStreak: result.bestStreak,
      })
      .then((r) => {
        setServerBest(r.best);
        setLbKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [screen, result]);

  function play() {
    setResult(null);
    setServerBest(null);
    startGame();
  }

  if (screen === 'guess') {
    return (
      <GuessGame
        category={category}
        paused={paused}
        // Resume only clears the flag: the guard entry was already
        // re-pushed when the back gesture paused us and nothing
        // consumed it since, so it is still armed — the next back
        // pauses again rather than leaving. Touching history here
        // would double-push and strand an extra entry.
        onResume={() => setPaused(false)}
        onFinish={(r) => {
          setPaused(false);
          // 0 completed rounds → nothing to show or record.
          if (r.roundsPlayed > 0) {
            setResult(r);
            setScreen('results');
          } else {
            setScreen('menu');
          }
          consumeHistoryEntry('guess');
        }}
      />
    );
  }

  if (screen === 'free') {
    return (
      <>
        <div className="px-4 pb-2">
          <button
            type="button"
            className="text-sm font-semibold"
            style={{ color: 'var(--accent)', background: 'transparent', border: 0, padding: 0 }}
            onClick={() => {
              setScreen('menu');
              consumeHistoryEntry('free');
            }}
          >
            ‹ Back
          </button>
        </div>
        <FreePlay />
      </>
    );
  }

  if (screen === 'results' && result) {
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
            {result.score.toLocaleString()}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Best streak x{result.bestStreak}
            {serverBest != null ? (
              <span className="ml-2 font-semibold" style={{ color: 'var(--accent)' }}>
                Best: {serverBest.toLocaleString()}
              </span>
            ) : null}
          </div>
          {result.roundsPlayed < ROUNDS ? (
            <div className="text-xs pt-1" style={{ color: 'var(--text-dim)' }}>
              Ended early — {result.roundsPlayed}/{ROUNDS} rounds
            </div>
          ) : null}
          {/* Per-round chips: remaining fog % at guess time + hit/miss. */}
          <div className="flex flex-wrap justify-center gap-1.5 pt-3">
            {result.perRound.map((r, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums"
                style={{
                  background: r.correct
                    ? 'color-mix(in srgb, var(--online) 18%, transparent)'
                    : 'color-mix(in srgb, var(--ping) 15%, transparent)',
                  color: r.correct ? 'var(--online)' : 'var(--ping)',
                }}
              >
                {r.correct ? '✓' : '✗'} {Math.round(r.fogPct * 100)}%
              </span>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl py-3 text-[15px] font-bold"
            style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
            onClick={play}
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
            onClick={() => setScreen('menu')}
          >
            Menu
          </button>
        </div>

        <FogLeaderboard refreshKey={lbKey} />
      </div>
    );
  }

  // menu
  return (
    <div className="px-4 flex flex-col gap-4">
      {/* Back to the chiclet grid. Pure state — hub↔menu doesn't
          touch history; the in-game back gesture is handled by the
          marker choreography in useGameFlow. */}
      <button
        type="button"
        className="self-start text-sm font-semibold"
        style={{ color: 'var(--accent)', background: 'transparent', border: 0, padding: 0 }}
        onClick={onExitToHub}
      >
        ‹ Games
      </button>

      <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
        Something’s outside the steamed-up window. Wipe just enough to
        guess it — the less you wipe, the more you score.
      </div>

      {/* Category picker */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((c) => {
          const enabled = c.id === 'mix' || c.id === 'pack' || (avail?.[c.id] ?? true);
          return (
            <button
              key={c.id}
              type="button"
              disabled={!enabled}
              style={chip(category === c.id, !enabled)}
              onClick={() => enabled && setCategory(c.id)}
            >
              {c.label}
              {!enabled && UNAVAILABLE_REASON[c.id] ? (
                <span className="block text-[10px] font-normal">{UNAVAILABLE_REASON[c.id]}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="rounded-2xl py-4 text-[17px] font-bold"
        style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
        onClick={play}
      >
        Play
      </button>

      <button
        type="button"
        className="rounded-xl py-3 text-[15px] font-semibold"
        style={{
          background: 'var(--card-bg)',
          color: 'var(--text)',
          border: '1px solid var(--separator)',
        }}
        onClick={startFree}
      >
        Free play
      </button>

      {stats.gamesPlayed > 0 ? (
        <div className="text-xs text-center" style={{ color: 'var(--text-dim)' }}>
          Personal best {stats.bestScore.toLocaleString()} · streak x{stats.bestStreak} ·{' '}
          {stats.gamesPlayed} game{stats.gamesPlayed === 1 ? '' : 's'}
        </div>
      ) : null}

      <FogLeaderboard refreshKey={lbKey} />
    </div>
  );
}
