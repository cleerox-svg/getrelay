import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Game-agnostic flow machine shared by every mini game on the Games tab
// (Fog, Tune, Golf). Screen switching (menu / game / results / sandbox)
// is component state, NOT subroutes — the tab bar's active check is an
// exact pathname match. Entering guess/free DOES push a same-path
// history entry carrying a state marker, so a back gesture pauses the
// game (guess) or returns to the menu (free) instead of leaving the tab;
// AndroidBackButton's nav(-1) pops that same entry, so hardware back
// flows through the identical path. Back in a guess game escalates:
// first press pauses, second press leaves (see the popstate effect).
//
// 'hub' (the chiclet grid) is route-level now — when the hub shows, no
// screen hook is mounted — so this machine only knows menu/guess/free/
// results. hub↔menu is plain state with a "‹ Games" affordance handled
// by the route.
export type GameScreen = 'menu' | 'guess' | 'free' | 'results';

type FogHistoryState = { fog?: 'guess' | 'free' } | null;

export function useGameFlow() {
  const [screen, setScreen] = useState<GameScreen>('menu');
  const [paused, setPaused] = useState(false);
  const [statsKey, setStatsKey] = useState(0);

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

  // The one case a menu stats useMemo can't see: backing out of a
  // running game renders the menu BEFORE GuessGame's unmount safety net
  // writes the partial run to localStorage, so that first read misses
  // it. React flushes child unmount cleanups before parent effects, so
  // by the time this runs the write has landed — bump statsKey once so
  // each screen re-reads. Guarded by the ref so ordinary menu visits
  // cost no extra render.
  useEffect(() => {
    if (screen !== 'menu' || !abandonedRef.current) return;
    abandonedRef.current = false;
    setStatsKey((k) => k + 1);
  }, [screen]);

  // Back-gesture / popstate handling. This effect reacts ONLY to
  // history changes (deps = the marker), never to screen changes.
  //
  // Back during a guess game escalates the conventional Android way —
  // the first press pauses, the second press leaves:
  // - back while PLAYING → open the pause sheet and re-arm the guard
  //   entry (one pop + one push, so history depth is unchanged). The
  //   run is frozen, not lost.
  // - back while PAUSED → do NOT re-arm. The pop stands, so we drop
  //   out of the game to the menu; GuessGame unmounts and its
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

  function startGame() {
    setPaused(false);
    setScreen('guess');
    // Push the back-gesture guard entry (see the popstate effect). The
    // marker is game-agnostic — the guess screen renders GuessGame,
    // TuneGame, GolfGame or the range's RangeGame from the owning
    // screen, and the pause/back choreography is identical.
    nav(location.pathname, { state: { fog: 'guess' } });
  }

  function startFree() {
    setScreen('free');
    // Same back-gesture guard entry as the guess game.
    nav(location.pathname, { state: { fog: 'free' } });
  }

  function markAbandoned() {
    abandonedRef.current = true;
  }

  return {
    screen,
    setScreen,
    paused,
    setPaused,
    startGame,
    startFree,
    consumeHistoryEntry,
    markAbandoned,
    statsKey,
  };
}
