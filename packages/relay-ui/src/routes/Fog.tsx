import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { FogLeaderboard } from '../components/fog/FogLeaderboard';
import { FreePlay } from '../components/fog/FreePlay';
import { GuessGame } from '../components/fog/GuessGame';
import type { GameResult } from '../components/fog/GuessGame';
import { api } from '../lib/api';
import { availableSources } from '../lib/fog/sources';
import type { FogCategory, SourceAvailability } from '../lib/fog/sources';
import { getFogStats, recordFogGame } from '../lib/fog/stats';
import { ROUNDS } from '../lib/fog/tuning';
import { useStore } from '../lib/store';

// /discover is the Fog tab: a steamed-up window with a mystery image
// on the other side. Wipe a peephole, guess what's out there. Screen
// switching (menu / game / results / sandbox) is component state, NOT
// subroutes — the tab bar's active check is an exact pathname match.
// Entering guess/free DOES push a same-path history entry carrying a
// state marker, so a back gesture pauses the game (guess) or returns
// to the menu (free) instead of leaving the tab; AndroidBackButton's
// nav(-1) pops that same entry, so hardware back flows through the
// identical path.

type Screen = 'menu' | 'guess' | 'results' | 'free';

type FogHistoryState = { fog?: 'guess' | 'free' } | null;

const CATEGORIES: { id: FogCategory; label: string }[] = [
  { id: 'mix', label: 'Mix' },
  { id: 'logos', label: 'Team logos' },
  { id: 'pack', label: 'Objects' },
  { id: 'gifs', label: 'GIFs' },
  { id: 'contacts', label: 'Contacts' },
];

const UNAVAILABLE_REASON: Partial<Record<FogCategory, string>> = {
  logos: 'Teams unavailable',
  gifs: 'GIFs unavailable',
  contacts: 'Need 4 contacts with avatars',
};

export function Fog() {
  const me = useStore((s) => s.me);
  const [screen, setScreen] = useState<Screen>('menu');
  const [category, setCategory] = useState<FogCategory>('mix');
  const [avail, setAvail] = useState<SourceAvailability | null>(null);
  const [result, setResult] = useState<GameResult | null>(null);
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const submittedRef = useRef<GameResult | null>(null);
  // Read inside the popstate effect, which must not re-run on a pause
  // toggle (it reacts to history only).
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const location = useLocation();
  const nav = useNavigate();
  const histFog = (location.state as FogHistoryState)?.fog;
  const histFogRef = useRef(histFog);
  histFogRef.current = histFog;

  // Local stats re-read whenever we land back on menu/results — cheap
  // localStorage read, no need for state plumbing from the recorder.
  const stats = useMemo(() => getFogStats(), [screen, result]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    availableSources().then((a) => {
      if (!cancelled) setAvail(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Back-gesture / popstate handling. This effect reacts ONLY to
  // history changes (deps = the marker), never to screen changes:
  // - back while playing → toggle the pause sheet (pause, or Resume if
  //   it's already open) and re-arm the guard entry. Back NEVER ends a
  //   run any more; ending is an explicit choice (sheet "End game" or
  //   the header End pill).
  // - back in free play → menu (unchanged).
  // - a marker with no matching screen (reload, remount after a tab
  //   switch mid-game, forward-nav) is stale — clear it in place.
  // When guess/free are left via UI buttons instead, the pushed entry
  // is consumed with nav(-1); by the time that popstate lands here the
  // screen has already moved on, so every branch below is a no-op.
  //
  // Why the re-push can't loop: back pops the marker (histFog
  // 'guess' → undefined) which runs this effect; the push flips it
  // back ('guess') which runs it exactly once more, and that run hits
  // NO branch — screen 'guess' WITH the 'guess' marker is the steady
  // state. History depth is unchanged too (one pop, one push), so
  // pause/resume cycles can't grow the stack.
  //
  // Toggling (rather than always pausing) is deliberate: back while
  // the sheet is open reads as Resume, so the back button is never
  // dead and never strands the user — every press does something
  // visible, and neither press can silently drop them out of the tab
  // mid-game.
  useEffect(() => {
    if (screen === 'guess' && histFog !== 'guess') {
      setPaused(!pausedRef.current);
      nav(location.pathname, { state: { fog: 'guess' } });
    } else if (screen === 'free' && histFog !== 'free') {
      setScreen('menu');
    } else if (histFog && (screen === 'menu' || screen === 'results')) {
      nav(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histFog]);

  // Consume the history entry pushed when entering guess/free — unless
  // a back gesture already popped it (then histFog is already gone).
  function consumeHistoryEntry(marker: 'guess' | 'free') {
    if (histFogRef.current === marker) nav(-1);
  }

  // Persist + submit a finished game exactly once. Local stats are
  // updated regardless of network; the POST is fire-and-forget — a
  // failed submit keeps the local best and just skips the "Best" pill.
  // Partial games (roundsPlayed 1..7) are valid submissions; a
  // 0-round game never reaches this screen and must never be POSTed.
  useEffect(() => {
    if (
      screen !== 'results' ||
      !result ||
      result.roundsPlayed < 1 ||
      submittedRef.current === result
    )
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

  function startGame() {
    setResult(null);
    setServerBest(null);
    setPaused(false);
    setScreen('guess');
    // Push the back-gesture guard entry (see the popstate effect).
    nav(location.pathname, { state: { fog: 'guess' } });
  }

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

  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Fog</h1>

      {/* Bottom padding clears both the fixed Konsta Tabbar and the
          classic-mode .legacy-tabbar (same treatment as /sports). */}
      <div style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}>
        {screen === 'guess' ? (
          <GuessGame
            category={category}
            paused={paused}
            // Resume only clears the flag: the guard entry was already
            // re-pushed when the back gesture paused us, so back works
            // again immediately without touching history here.
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
        ) : screen === 'free' ? (
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
        ) : screen === 'results' && result ? (
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
                onClick={startGame}
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
        ) : (
          <div className="px-4 flex flex-col gap-4">
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
                      <span className="block text-[10px] font-normal">
                        {UNAVAILABLE_REASON[c.id]}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              className="rounded-2xl py-4 text-[17px] font-bold"
              style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
              onClick={startGame}
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
              onClick={() => {
                setScreen('free');
                // Same back-gesture guard entry as the guess game.
                nav(location.pathname, { state: { fog: 'free' } });
              }}
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
        )}
      </div>
    </Page>
  );
}
