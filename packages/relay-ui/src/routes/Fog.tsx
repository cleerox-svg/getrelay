import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { FogLeaderboard } from '../components/fog/FogLeaderboard';
import { FreePlay } from '../components/fog/FreePlay';
import { GuessGame } from '../components/fog/GuessGame';
import type { GameResult } from '../components/fog/GuessGame';
import { TuneGame } from '../components/tune/TuneGame';
import type { TuneGameResult } from '../components/tune/TuneGame';
import { TuneDolphin } from '../components/tune/TuneDolphin';
import { TuneLeaderboard } from '../components/tune/TuneLeaderboard';
import { TuneVisualizer } from '../components/tune/TuneVisualizer';
import {
  TUNE_SKINS,
  getTuneSkinId,
  resolveSkin,
  setTuneSkinId,
  skinVars,
} from '../lib/tune/skins';
import { api } from '../lib/api';
import { availableSources } from '../lib/fog/sources';
import type { FogCategory, SourceAvailability } from '../lib/fog/sources';
import { getFogStats, recordFogGame } from '../lib/fog/stats';
import { ROUNDS } from '../lib/fog/tuning';
import { TUNE_GENRES, tuneAvailable } from '../lib/tune/sources';
import type { TuneGenreId, TuneMode } from '../lib/tune/sources';
import { getTuneStats, recordTuneGame } from '../lib/tune/stats';
import { ROUNDS as TUNE_ROUNDS } from '../lib/tune/tuning';
import { useStore } from '../lib/store';

// /discover is the Fog tab: a steamed-up window with a mystery image
// on the other side. Wipe a peephole, guess what's out there. Screen
// switching (menu / game / results / sandbox) is component state, NOT
// subroutes — the tab bar's active check is an exact pathname match.
// Entering guess/free DOES push a same-path history entry carrying a
// state marker, so a back gesture pauses the game (guess) or returns
// to the menu (free) instead of leaving the tab; AndroidBackButton's
// nav(-1) pops that same entry, so hardware back flows through the
// identical path. Back in a guess game escalates: first press pauses,
// second press leaves the game (see the popstate effect).

// 'hub' is the Games landing: a grid of game chiclets. Picking one
// routes into that game's sub-flow (menu → guess → results), which is
// pure component state (as before) — the tab bar's active check is an
// exact pathname match, so game switching never touches the URL path.
// The in-game guess/free screens DO push a same-path history marker so a
// back gesture pauses/leaves the game exactly as it always has; hub↔menu
// is plain state with a "‹ Games" affordance.
type Screen = 'hub' | 'menu' | 'guess' | 'results' | 'free';

type FogHistoryState = { fog?: 'guess' | 'free' } | null;

// The chiclet grid, as data so adding a game is one more entry. `id`
// drives which sub-flow renders; `icon` is a flat SVG under /public/games.
const GAMES: { id: 'fog' | 'tune'; title: string; subtitle: string; icon: string }[] = [
  {
    id: 'fog',
    title: 'Fog',
    subtitle: 'Wipe the steamed-up window and guess what’s behind it.',
    icon: '/games/fog.svg',
  },
  {
    id: 'tune',
    title: 'Guess the Tune',
    subtitle: 'Hear a short clip and name the song title.',
    icon: '/games/tune.svg',
  },
];

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

export function Fog() {
  const me = useStore((s) => s.me);
  // Which mini game the Games hub is showing. Only switchable from the
  // menu; a running game freezes the choice. The Screen state machine
  // below and the whole back-gesture/pause choreography are game-
  // agnostic and shared between the two flows.
  const [game, setGame] = useState<'fog' | 'tune'>('fog');
  const [screen, setScreen] = useState<Screen>('hub');
  const [category, setCategory] = useState<FogCategory>('mix');
  const [avail, setAvail] = useState<SourceAvailability | null>(null);
  const [tuneAvail, setTuneAvail] = useState<boolean | null>(null);
  // Persisted Tune player skin (localStorage). Selecting one updates the
  // live player + preview immediately.
  const [tuneSkinId, setTuneSkinIdState] = useState<string>(() => getTuneSkinId());
  // Tune round options, chosen on the menu and passed into TuneGame. Both
  // default to the shipped behavior (all genres pooled, guess the title).
  const [tuneGenre, setTuneGenre] = useState<TuneGenreId>('any');
  const [tuneMode, setTuneMode] = useState<TuneMode>('title');
  const [result, setResult] = useState<GameResult | null>(null);
  const [tuneResult, setTuneResult] = useState<TuneGameResult | null>(null);
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [statsKey, setStatsKey] = useState(0);
  const submittedRef = useRef<GameResult | null>(null);
  const submittedTuneRef = useRef<TuneGameResult | null>(null);
  // Set when a back-out abandons a running game, so the menu re-reads
  // local stats once GuessGame's unmount safety net has banked the
  // partial run (see the refresh effect below).
  const abandonedRef = useRef(false);
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
  // Keyed by `game` so each flow shows its own personal best.
  const stats = useMemo(
    () => (game === 'tune' ? getTuneStats() : getFogStats()),
    [game, screen, result, tuneResult, statsKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The one case the deps above can't see: backing out of a running
  // game renders the menu BEFORE GuessGame's unmount safety net writes
  // the partial run to localStorage, so that first read misses it.
  // React flushes child unmount cleanups before parent effects, so by
  // the time this runs the write has landed — re-read once. Guarded by
  // the ref so ordinary menu visits cost no extra render.
  useEffect(() => {
    if (screen !== 'menu' || !abandonedRef.current) return;
    abandonedRef.current = false;
    setStatsKey((k) => k + 1);
  }, [screen]);

  useEffect(() => {
    let cancelled = false;
    availableSources().then((a) => {
      if (!cancelled) setAvail(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe the music service the first time the Tune flow is shown — one
  // search, cached in state. Fog-only users never pay for it.
  useEffect(() => {
    if (game !== 'tune' || tuneAvail !== null) return;
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
  }, [game, tuneAvail]);

  // Back-gesture / popstate handling. This effect reacts ONLY to
  // history changes (deps = the marker), never to screen changes.
  //
  // Back during a guess game escalates the conventional Android way —
  // the first press pauses, the second press leaves:
  // - back while PLAYING → open the pause sheet and re-arm the guard
  //   entry (one pop + one push, so history depth is unchanged). The
  //   run is frozen, not lost.
  // - back while PAUSED → do NOT re-arm. The pop stands, so we drop
  //   out of the game to the Fog menu; GuessGame unmounts and its
  //   safety net records + submits the partial run (>=1 completed
  //   round). History is back at the plain /discover entry, so the
  //   NEXT back leaves the tab like on any other screen — a running
  //   game can never trap the user in the tab or block app exit.
  // - back in free play → menu (unchanged).
  // - a marker with no matching screen (reload, remount after a tab
  //   switch mid-game, forward-nav) is stale — clear it in place.
  // When guess/free are left via UI buttons instead, the pushed entry
  // is consumed with nav(-1); by the time that popstate lands here the
  // screen has already moved on, so every branch below is a no-op.
  //
  // History depth across play → back → resume → back → back, starting
  // from the plain /discover entry [A]:
  //   startGame pushes the guard     [A, G]  playing
  //   back (playing) → pop + re-push [A, G]  paused, sheet up
  //   Resume (touches no history)    [A, G]  playing, guard still armed
  //   back (playing) → pop + re-push [A, G]  paused again
  //   back (paused)  → pop, no push  [A]     menu, partial run recorded
  //   back                           [...]   leaves /discover
  // Nothing grows the stack, and every press does something visible.
  //
  // Why the re-push can't loop: back pops the marker (histFog
  // 'guess' → undefined) which runs this effect; the push flips it
  // back ('guess') which runs it exactly once more, and that run hits
  // NO branch — screen 'guess' WITH the 'guess' marker is the steady
  // state.
  useEffect(() => {
    if (screen === 'guess' && histFog !== 'guess') {
      // pausedRef, not `paused`: this effect must not re-run on a
      // pause toggle, so it reads the live value instead of closing
      // over it.
      if (pausedRef.current) {
        abandonedRef.current = true;
        setPaused(false);
        setScreen('menu');
      } else {
        setPaused(true);
        nav(location.pathname, { state: { fog: 'guess' } });
      }
    } else if (screen === 'free' && histFog !== 'free') {
      setScreen('menu');
    } else if (histFog && (screen === 'hub' || screen === 'menu' || screen === 'results')) {
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
      game !== 'fog' ||
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
  }, [game, screen, result]);

  // Tune twin of the submit effect above. Records to tune stats and
  // submits with game:'tune'. Same exactly-once guard, same partial-run
  // rules (roundsPlayed 1..7 are valid; a 0-round game never lands here).
  useEffect(() => {
    if (
      game !== 'tune' ||
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
  }, [game, screen, tuneResult]);

  function startGame() {
    setResult(null);
    setTuneResult(null);
    setServerBest(null);
    setPaused(false);
    setScreen('guess');
    // Push the back-gesture guard entry (see the popstate effect). The
    // marker is game-agnostic — the guess screen renders GuessGame or
    // TuneGame from `game`, and the pause/back choreography is identical.
    nav(location.pathname, { state: { fog: 'guess' } });
  }

  function changeSkin(id: string) {
    setTuneSkinIdState(id);
    setTuneSkinId(id);
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

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Games</h1>

      {/* Bottom padding clears both the fixed Konsta Tabbar and the
          classic-mode .legacy-tabbar (same treatment as /sports). */}
      <div style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}>
        {screen === 'hub' ? (
          <div className="px-4">
            <div className="text-sm pb-3" style={{ color: 'var(--text-dim)' }}>
              Pick a game.
            </div>
            <div className="grid grid-cols-2 gap-3">
              {GAMES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => {
                    setGame(g.id);
                    setScreen('menu');
                  }}
                  className="flex flex-col overflow-hidden text-left"
                  style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--separator)',
                    borderRadius: 18,
                    padding: 0,
                  }}
                >
                  <div
                    className="flex items-center justify-center"
                    style={{ aspectRatio: '1 / 1', background: 'var(--bubble-them)' }}
                  >
                    <img
                      src={g.icon}
                      alt=""
                      style={{ width: '68%', height: '68%', objectFit: 'contain' }}
                    />
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>
                      {g.title}
                    </div>
                    <div className="text-[12px] leading-snug pt-0.5" style={{ color: 'var(--text-dim)' }}>
                      {g.subtitle}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : screen === 'guess' && game === 'fog' ? (
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
        ) : screen === 'guess' && game === 'tune' ? (
          <TuneGame
            genre={tuneGenre}
            mode={tuneMode}
            paused={paused}
            skin={resolveSkin(tuneSkinId)}
            skins={TUNE_SKINS}
            onSkinChange={changeSkin}
            // Same guard-entry contract as GuessGame above.
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
        ) : screen === 'results' && game === 'fog' && result ? (
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
        ) : screen === 'results' && game === 'tune' && tuneResult ? (
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

            <TuneLeaderboard refreshKey={lbKey} />
          </div>
        ) : (
          <div className="px-4 flex flex-col gap-4">
            {/* Back to the chiclet grid. Pure state — hub↔menu doesn't
                touch history; the in-game back gesture is handled by the
                marker choreography above. */}
            <button
              type="button"
              className="self-start text-sm font-semibold"
              style={{ color: 'var(--accent)', background: 'transparent', border: 0, padding: 0 }}
              onClick={() => setScreen('hub')}
            >
              ‹ Games
            </button>

            {game === 'tune' ? (
              <>
                <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                  Hear a short clip of a song and name the title — four choices,
                  the less you listen, the more you score.
                </div>

                {/* Player skin picker + live preview. Original,
                    retro-media-player-inspired looks (no trademarked
                    art/branding); choice persists in localStorage. */}
                <div>
                  <div
                    className="text-xs font-bold tracking-wider pb-2"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    PLAYER SKIN
                  </div>
                  <div
                    className="tune-skin"
                    style={{ ...skinVars(resolveSkin(tuneSkinId)), marginBottom: 10 }}
                  >
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
                  <div
                    className="text-xs font-bold tracking-wider pb-2"
                    style={{ color: 'var(--text-dim)' }}
                  >
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
                  <div
                    className="text-xs font-bold tracking-wider pb-2"
                    style={{ color: 'var(--text-dim)' }}
                  >
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
                  onClick={startGame}
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
              </>
            ) : (
            <>
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
            </>
            )}
          </div>
        )}
      </div>
    </Page>
  );
}
