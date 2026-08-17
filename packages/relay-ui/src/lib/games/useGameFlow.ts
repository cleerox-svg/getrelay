import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

// Game-agnostic flow machine shared by every mini game on the Games tab
// (Fog, Tune, Golf). Screen switching (menu / game / results / sandbox)
// is component state, NOT subroutes — the tab bar's active check is an
// exact pathname match. Entering guess/free DOES push a same-path
// history entry carrying a state marker, so a back gesture pauses the
// game or returns to the menu instead of leaving the tab;
// AndroidBackButton's nav(-1) pops that same entry, so hardware back
// flows through the identical path. Back in a guess game escalates:
// first press pauses, second press leaves. Back on the free screen
// escalates the SAME way when the owner entered via startFreeGuarded()
// to declare the session has unsaved progress, and goes straight to the
// menu when it entered via plain startFree() (see the popstate effect).
//
// 'hub' (the chiclet grid) is route-level now — when the hub shows, no
// screen hook is mounted — so this machine only knows menu/guess/free/
// results. hub↔menu is plain state with a "‹ Games" affordance handled
// by the route.
export type GameScreen = 'menu' | 'guess' | 'free' | 'results';

// The same-path history marker written when entering guess/free.
//
// A legacy `fog` key (from when the hub was Fog-anchored) used to be read
// here as a fallback. It was never written, was documented as believed
// unreachable, and has now been retired.
//
// NOTE the hub's deep-link entry state (routes/Games.tsx) deliberately uses
// a DIFFERENT key, `hubGame`. It must never collide with this one: a hub
// entry that looked like a marker would trip the stale-marker branch on
// mount.
type GameHistoryState = { game?: 'guess' | 'free' } | null;

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

  // Whether the CURRENT free-screen session has progress worth a confirm
  // step, declared by which door the owning screen came in by — plain
  // startFree() or startFreeGuarded().
  // Read only by the popstate effect, and only while screen === 'free'.
  //
  // A ref, not state, for two reasons: the popstate effect must react to
  // history alone (same reason pausedRef exists), and a session's guard is
  // fixed at entry, so nothing renders off it.
  //
  // The staleness invariant that makes this safe to read from a ref, and
  // it rests on ONE mechanism rather than several: enterFree() writes this
  // UNCONDITIONALLY, and enterFree is the only assignment of screen =
  // 'free' in the codebase. So every read is preceded by the live
  // session's own declaration, and a guarded course round cannot leave the
  // guard armed for the range-practice session after it.
  //
  // The leave branch deliberately does NOT also clear it. A second clear
  // there is unreachable-as-safety — you cannot get back to a read without
  // passing through enterFree — and its only real effect was to mask the
  // absence of the unconditional write from the tests, which is how the
  // write went unpinned in the first place. One mechanism, one test.
  const freeGuardRef = useRef(false);

  const location = useLocation();
  const nav = useNavigate();
  const state = location.state as GameHistoryState;
  const histGame = state?.game;
  const histGameRef = useRef(histGame);
  histGameRef.current = histGame;

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
  //   round). History is back at the plain /games entry, so the
  //   NEXT back leaves the tab like on any other screen — a running
  //   game can never trap the user in the tab or block app exit.
  // - back on the free screen → whichever door the owner came in by:
  //     * startFreeGuarded() (golf Course mode, baseball Derby/Duel) →
  //       the IDENTICAL two-press escalation as guess above, abandoned
  //       flag included, so the child's unmount safety net gets to bank
  //       the partial run and the menu re-reads it. One back press at
  //       hole 14 of 18 must not be able to destroy the round.
  //     * startFree() (range practice, single-hole play) → straight to
  //       the menu, one press, exactly as this screen has always
  //       behaved. There is nothing to bank, so a confirm step would be
  //       pure friction.
  //   Guarding is OPT-IN: a screen that never heard of it keeps the old
  //   behaviour, and the flag is rewritten on EVERY entry, so a guarded
  //   round can't arm the guard for the session after it.
  // - a marker with no matching screen (reload, remount after a tab
  //   switch mid-game, forward-nav) is stale — clear it in place.
  // When guess/free are left via UI buttons instead, the pushed entry
  // is consumed with nav(-1); by the time that popstate lands here the
  // screen has already moved on, so every branch below is a no-op.
  //
  // History depth across play → back → resume → back → back, starting
  // from the plain /games entry [A]. Read [G] as the marker for either
  // escalating screen — the ledger is identical for a guess game and
  // for a GUARDED free session, because they run the same branch:
  //   startGame/…Guarded pushes it   [A, G]  playing
  //   back (playing) → pop + re-push [A, G]  paused, sheet up
  //   Resume (touches no history)    [A, G]  playing, guard still armed
  //   back (playing) → pop + re-push [A, G]  paused again
  //   back (paused)  → pop, no push  [A]     menu, partial run recorded
  //   back                           [...]   leaves /games
  // Nothing grows the stack, and every press does something visible.
  // An UNGUARDED free session just collapses the middle rows out:
  //   startFree pushes the marker    [A, F]  playing
  //   back → pop, no push            [A]     menu
  //   back                           [...]   leaves /games
  //
  // Why the re-push can't loop — the argument holds for BOTH escalating
  // screens: back pops the marker (histGame 'guess' → undefined) which
  // runs this effect; the push flips it back ('guess') which runs it
  // exactly once more, and that run hits NO branch — screen 'guess'
  // WITH the 'guess' marker is the steady state. Substitute 'free'
  // throughout for the guarded free case and every step still reads
  // true, because the re-push writes the marker that MATCHES the screen
  // we are still on. In particular the second run does NOT reach the
  // paused/leave arm even though pausedRef is now true: it is gated
  // behind `histGame !== marker`, which the re-push just made false. So
  // a guarded free session cannot ping-pong between pausing and
  // leaving, and the guard flag is never even consulted while marker
  // and screen agree.
  useEffect(() => {
    // The two-press escalation, shared verbatim between the guess screen
    // and a guarded free session so the two can never drift apart.
    function escalate(marker: 'guess' | 'free') {
      // pausedRef, not `paused`: this effect must not re-run on a
      // pause toggle, so it reads the live value instead of closing
      // over it.
      if (pausedRef.current) {
        abandonedRef.current = true;
        setPaused(false);
        setScreen('menu');
      } else {
        setPaused(true);
        nav(location.pathname, { state: { game: marker } });
      }
    }

    if (screen === 'guess' && histGame !== 'guess') {
      escalate('guess');
    } else if (screen === 'free' && histGame !== 'free') {
      if (freeGuardRef.current) escalate('free');
      else setScreen('menu');
    } else if (histGame && (screen === 'menu' || screen === 'results')) {
      nav(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [histGame]);

  // Consume the history entry pushed when entering guess/free — unless
  // a back gesture already popped it (then histGame is already gone).
  function consumeHistoryEntry(marker: 'guess' | 'free') {
    if (histGameRef.current === marker) nav(-1);
  }

  function startGame() {
    setPaused(false);
    setScreen('guess');
    // Push the back-gesture guard entry (see the popstate effect). The
    // marker is game-agnostic — the guess screen renders GuessGame,
    // TuneGame, GolfGame or the range's RangeGame from the owning
    // screen, and the pause/back choreography is identical.
    nav(location.pathname, { state: { game: 'guess' } });
  }

  // Enter the free screen. Two named doors rather than one door with an
  // argument, and the naming is the whole safety property:
  //
  //  - startFree()        nothing to lose (range practice, single-hole
  //                       play). Back returns to the menu in one press,
  //                       exactly as this screen has always behaved.
  //  - startFreeGuarded() THIS session has progress a back gesture would
  //                       destroy — a multi-hole course round, a Derby or
  //                       Duel. Back escalates like a guess game: first
  //                       press pauses, second leaves and banks.
  //
  // Why not startFree({ guardProgress: true })? Both of these are used
  // directly as click handlers (`onClick={startFree}` in FogScreen), and a
  // handler is called with the click EVENT. An options-object parameter
  // would read `guardProgress` off a MouseEvent, get undefined, and
  // silently produce an UNGUARDED round — a protection that looks present
  // and isn't, which is the exact bug class this guard exists to kill.
  // TypeScript only catches that where the function is passed bare; a
  // loosely-typed boundary would swallow it. Zero-parameter functions
  // cannot be mis-called that way: any extra argument is ignored, and
  // both doors stay safe to hand straight to onClick.
  //
  // Guarding is a property of the SESSION, not of the history entry: both
  // push the identical { game: 'free' } marker, so consumeHistoryEntry,
  // the stale-marker branch and the hub's `hubGame` collision guard all
  // stay untouched.
  //
  // The flag is written UNCONDITIONALLY on every entry, which is what
  // makes the ref read in the popstate effect impossible to serve stale.
  // A standalone setFreeGuard() could be forgotten on the next entry and
  // would arm a confirm step on an empty range session. If a game ever
  // needs to arm mid-session (only after the first stroke lands, say),
  // add an explicit updater then — but keep these unconditional writes as
  // the session's reset.
  function enterFree(guardProgress: boolean) {
    freeGuardRef.current = guardProgress;
    // Start every session UNPAUSED, exactly as startGame() does. This is
    // not defensive tidying — without it the guard eats itself on the
    // SECOND guarded round of a session:
    //   startFreeGuarded() → back (pause arm, paused true) → the pause
    //   sheet's own exit button moves the screen and consumes the marker
    //   but does NOT reset paused → startFreeGuarded() again → the first
    //   back press reads pausedRef true and takes the LEAVE arm → the
    //   round is destroyed on one press, which is the bug this whole
    //   mechanism exists to prevent.
    // The reset belongs HERE rather than at the exit buttons because the
    // call sites disagree about it (BaseballScreen resets, FogScreen does
    // not) and every one of them is a chance to forget. Entering a screen
    // is the moment its pause state is unambiguously known.
    setPaused(false);
    setScreen('free');
    // Same back-gesture guard entry as the guess game.
    nav(location.pathname, { state: { game: 'free' } });
  }

  function startFree() {
    enterFree(false);
  }

  function startFreeGuarded() {
    enterFree(true);
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
    startFreeGuarded,
    consumeHistoryEntry,
    markAbandoned,
    statsKey,
  };
}
