import { useEffect, useMemo, useRef, useState } from 'react';
import { TuneGame } from './TuneGame';
import type { TuneGameResult } from './TuneGame';
import { TuneDolphin } from './TuneDolphin';
import { TuneLeaderboard } from './TuneLeaderboard';
import { TuneVisualizer } from './TuneVisualizer';
import {
  TUNE_SKINS,
  getTuneSkinId,
  resolveSkin,
  setTuneSkinId,
  skinVars,
} from '../../lib/tune/skins';
import { api } from '../../lib/api';
import { TUNE_GENRES, tuneAvailable } from '../../lib/tune/sources';
import type { TuneGenreId, TuneMode } from '../../lib/tune/sources';
import { getTuneStats, recordTuneGame } from '../../lib/tune/stats';
import { ROUNDS as TUNE_ROUNDS } from '../../lib/tune/tuning';
import { useGameFlow } from '../../lib/games/useGameFlow';

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

export function TuneScreen({ onExitToHub }: { onExitToHub: () => void }) {
  const { screen, setScreen, paused, setPaused, startGame, consumeHistoryEntry, statsKey } =
    useGameFlow();
  const [tuneAvail, setTuneAvail] = useState<boolean | null>(null);
  // Persisted Tune player skin (localStorage). Selecting one updates the
  // live player + preview immediately.
  const [tuneSkinId, setTuneSkinIdState] = useState<string>(() => getTuneSkinId());
  // Tune round options, chosen on the menu and passed into TuneGame. Both
  // default to the shipped behavior (all genres pooled, guess the title).
  const [tuneGenre, setTuneGenre] = useState<TuneGenreId>('any');
  const [tuneMode, setTuneMode] = useState<TuneMode>('title');
  const [tuneResult, setTuneResult] = useState<TuneGameResult | null>(null);
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);
  const submittedTuneRef = useRef<TuneGameResult | null>(null);

  // Local stats re-read whenever we land back on menu/results.
  const stats = useMemo(
    () => getTuneStats(),
    [screen, tuneResult, statsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Probe the music service the first time the Tune flow is shown — one
  // search, cached in state.
  useEffect(() => {
    if (tuneAvail !== null) return;
    let cancelled = false;
    tuneAvailable()
      .then((a) => {
        if (!cancelled) setTuneAvail(a);
      })
      .catch(() => {
        if (!cancelled) setTuneAvail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tuneAvail]);

  // Tune twin of Fog's submit effect. Records to tune stats and submits
  // with game:'tune'. Same exactly-once guard, same partial-run rules
  // (roundsPlayed 1..7 are valid; a 0-round game never lands here).
  useEffect(() => {
    if (
      screen !== 'results' ||
      !tuneResult ||
      tuneResult.roundsPlayed < 1 ||
      submittedTuneRef.current === tuneResult
    )
      return;
    submittedTuneRef.current = tuneResult;
    recordTuneGame(tuneResult.score, tuneResult.bestStreak);
    api
      .submitGameScore({
        score: tuneResult.score,
        rounds: tuneResult.roundsPlayed,
        bestStreak: tuneResult.bestStreak,
        game: 'tune',
      })
      .then((r) => {
        setServerBest(r.best);
        setLbKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [screen, tuneResult]);

  function changeSkin(id: string) {
    setTuneSkinIdState(id);
    setTuneSkinId(id);
  }

  function play() {
    setTuneResult(null);
    setServerBest(null);
    startGame();
  }

  if (screen === 'guess') {
    return (
      <TuneGame
        genre={tuneGenre}
        mode={tuneMode}
        paused={paused}
        skin={resolveSkin(tuneSkinId)}
        skins={TUNE_SKINS}
        onSkinChange={changeSkin}
        // Same guard-entry contract as GuessGame.
        onResume={() => setPaused(false)}
        onFinish={(r) => {
          setPaused(false);
          if (r.roundsPlayed > 0) {
            setTuneResult(r);
            setScreen('results');
          } else {
            setScreen('menu');
          }
          consumeHistoryEntry('guess');
        }}
      />
    );
  }

  if (screen === 'results' && tuneResult) {
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
            {tuneResult.score.toLocaleString()}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Best streak x{tuneResult.bestStreak}
            {serverBest != null ? (
              <span className="ml-2 font-semibold" style={{ color: 'var(--accent)' }}>
                Best: {serverBest.toLocaleString()}
              </span>
            ) : null}
          </div>
          {tuneResult.roundsPlayed < TUNE_ROUNDS ? (
            <div className="text-xs pt-1" style={{ color: 'var(--text-dim)' }}>
              Ended early — {tuneResult.roundsPlayed}/{TUNE_ROUNDS} rounds
            </div>
          ) : null}
          {/* Per-round chips: seconds of the clip heard at guess time + hit/miss. */}
          <div className="flex flex-wrap justify-center gap-1.5 pt-3">
            {tuneResult.perRound.map((r, i) => (
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
                {r.correct ? '✓' : '✗'} {r.secondsHeard.toFixed(1)}s
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

        <TuneLeaderboard refreshKey={lbKey} />
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
        Hear a short clip of a song and name the title — four choices,
        the less you listen, the more you score.
      </div>

      {/* Player skin picker + live preview. Original,
          retro-media-player-inspired looks (no trademarked
          art/branding); choice persists in localStorage. */}
      <div>
        <div className="text-xs font-bold tracking-wider pb-2" style={{ color: 'var(--text-dim)' }}>
          PLAYER SKIN
        </div>
        <div className="tune-skin" style={{ ...skinVars(resolveSkin(tuneSkinId)), marginBottom: 10 }}>
          <div
            className="tune-chrome"
            style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}
          >
            <div className="tune-titlebar">
              <span>Relay Tunes</span>
              <span style={{ fontWeight: 700 }}>{resolveSkin(tuneSkinId).name}</span>
            </div>
            {resolveSkin(tuneSkinId).screen === 'dolphin' ? (
              <div
                className="tune-dolphin-screen"
                style={{ position: 'relative', inset: 'auto', height: 76 }}
              >
                <TuneDolphin />
                <div className="tune-dolphin-caption">♪ Guess the title</div>
              </div>
            ) : (
              <div className="tune-readout" style={{ fontSize: 12 }}>
                ♪ Now playing — guess the title
              </div>
            )}
            <TuneVisualizer active bars={18} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {TUNE_SKINS.map((s) => (
            <button
              key={s.id}
              type="button"
              style={chip(tuneSkinId === s.id, false)}
              onClick={() => changeSkin(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>

      {/* Guess-what toggle: title or artist. Two-chip
          segmented control, same chip styling as the genres. */}
      <div>
        <div className="text-xs font-bold tracking-wider pb-2" style={{ color: 'var(--text-dim)' }}>
          GUESS THE
        </div>
        <div className="flex gap-2">
          {(
            [
              { id: 'title', label: 'Title' },
              { id: 'artist', label: 'Artist' },
            ] as { id: TuneMode; label: string }[]
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              style={chip(tuneMode === m.id, false)}
              onClick={() => setTuneMode(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Genre picker — mirrors Fog's category chips. "Any"
          pools every genre's seeds. */}
      <div>
        <div className="text-xs font-bold tracking-wider pb-2" style={{ color: 'var(--text-dim)' }}>
          GENRE
        </div>
        <div className="flex flex-wrap gap-2">
          {TUNE_GENRES.map((g) => (
            <button
              key={g.id}
              type="button"
              style={chip(tuneGenre === g.id, false)}
              onClick={() => setTuneGenre(g.id)}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <button
        type="button"
        disabled={tuneAvail === false}
        className="rounded-2xl py-4 text-[17px] font-bold"
        style={{
          background: 'var(--accent)',
          color: '#FFFFFF',
          border: 0,
          opacity: tuneAvail === false ? 0.55 : 1,
        }}
        onClick={play}
      >
        Play
      </button>

      {tuneAvail === false ? (
        <div className="text-xs text-center" style={{ color: 'var(--text-dim)' }}>
          Music service unavailable — check your connection.
        </div>
      ) : null}

      {stats.gamesPlayed > 0 ? (
        <div className="text-xs text-center" style={{ color: 'var(--text-dim)' }}>
          Personal best {stats.bestScore.toLocaleString()} · streak x{stats.bestStreak} ·{' '}
          {stats.gamesPlayed} game{stats.gamesPlayed === 1 ? '' : 's'}
        </div>
      ) : null}

      <TuneLeaderboard refreshKey={lbKey} />
    </div>
  );
}
