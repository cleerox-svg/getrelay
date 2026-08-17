// @vitest-environment jsdom
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom';
import { useGameFlow } from './useGameFlow';

// Behavioural guard for the back-gesture / popstate state machine every mini
// game shares. The hook's header documents an exact history-DEPTH invariant
// ("nothing grows the stack, and every press does something visible") and an
// escalation (back while playing pauses; back while paused leaves), and both
// were previously guarded only by that comment.
//
// Two things make the invariants observable without reaching inside the hook:
//
//  1. A SENTINEL entry underneath /games. Every render mounts the router at
//     ['/outside', '/games'] with initialIndex 1, so "one back too many leaves
//     the Games tab" is literally visible as /outside appearing. If the hook
//     ever over-pushed, the user would be trapped in the tab and these tests
//     would show /games where /outside is expected.
//  2. A NAV LOG of (action, pathname, state) recorded per location change.
//     PUSH counts +1, POP counts -1, REPLACE 0 — so `depth()` is the ledger
//     the header comment draws by hand.
//
// Back is driven with nav(-1), which is exactly what AndroidBackButton does
// and what a browser back gesture produces: the hook only ever observes a
// location change, never the event itself.

type NavEntry = { action: string; pathname: string; state: unknown };

let log: NavEntry[] = [];
let renders = 0;
// Reassigned on every render so tests always poke the live closure.
let flow: ReturnType<typeof useGameFlow>;
let back: () => void;

// Net history depth relative to the /games entry the harness starts on.
const depth = () => log.reduce((d, e) => d + (e.action === 'PUSH' ? 1 : e.action === 'POP' ? -1 : 0), 0);

function Harness() {
  renders += 1;
  flow = useGameFlow();
  const location = useLocation();
  const action = useNavigationType();
  const nav = useNavigate();
  back = () => nav(-1);
  useEffect(() => {
    log.push({ action, pathname: location.pathname, state: location.state });
    // The location object identity changes on every history transition, which
    // is the granularity we want to record at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);
  return (
    <div>
      <span data-testid="screen">{flow.screen}</span>
      <span data-testid="paused">{String(flow.paused)}</span>
      <span data-testid="statsKey">{flow.statsKey}</span>
    </div>
  );
}

// `entry` lets a test land on /games with history state already present (the
// stale-marker case: a reload or a remount after a tab switch mid-game).
function mount(entry: { pathname: string; state?: unknown } = { pathname: '/games' }) {
  log = [];
  renders = 0;
  const r = render(
    <MemoryRouter initialEntries={['/outside', entry]} initialIndex={1}>
      <Routes>
        <Route path="/outside" element={<div data-testid="outside">outside</div>} />
        <Route path="/games" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
  // React Router reports the LANDING location as a POP (there is no
  // transition into it). Drop it so `depth()` measures movement relative to
  // the /games entry rather than starting the ledger at -1. Anything the hook
  // does during mount — the stale-marker clear — has already flushed inside
  // render()'s act() and stays in the log.
  log.shift();
  return r;
}

afterEach(() => {
  cleanup();
});

describe('useGameFlow', () => {
  it('starts on the menu, unpaused, with a zero statsKey', () => {
    mount();
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(screen.getByTestId('paused').textContent).toBe('false');
    expect(screen.getByTestId('statsKey').textContent).toBe('0');
    expect(depth()).toBe(0);
  });

  it('startGame() moves to guess and pushes the same-path marker', () => {
    mount();
    act(() => flow.startGame());

    expect(screen.getByTestId('screen').textContent).toBe('guess');
    expect(screen.getByTestId('paused').textContent).toBe('false');
    // Exactly one push, and it is SAME-PATH: the tab bar's active check is an
    // exact pathname match, so the marker must not move the URL.
    expect(log).toEqual([{ action: 'PUSH', pathname: '/games', state: { game: 'guess' } }]);
    expect(depth()).toBe(1);
  });

  it('back while playing pauses and re-arms, leaving history depth unchanged', () => {
    mount();
    act(() => flow.startGame());
    expect(depth()).toBe(1);
    log = [];

    act(() => back());

    // The documented ledger: [A] → startGame → [A,G] → back → [A,G] paused.
    expect(screen.getByTestId('screen').textContent).toBe('guess');
    expect(screen.getByTestId('paused').textContent).toBe('true');
    expect(log.map((e) => e.action)).toEqual(['POP', 'PUSH']);
    expect(depth()).toBe(0); // net zero => overall depth still [A, G]
    expect(log.at(-1)).toEqual({ action: 'PUSH', pathname: '/games', state: { game: 'guess' } });
  });

  it('does not loop after re-arming: guess + guess-marker is the steady state', () => {
    mount();
    act(() => flow.startGame());
    log = [];
    act(() => back());
    const settled = log.length;

    // Any further flush must move nothing — the re-push flips the marker back
    // and that run hits no branch.
    act(() => {});
    expect(log.length).toBe(settled);
    expect(screen.getByTestId('paused').textContent).toBe('true');
  });

  it('back while paused leaves to the menu without re-arming, so the next back leaves the tab', () => {
    mount();
    act(() => flow.startGame());
    act(() => back()); // pause
    expect(screen.getByTestId('paused').textContent).toBe('true');
    log = [];

    act(() => back()); // escalate: leave the game

    // The pop STANDS this time — no compensating push.
    expect(log.map((e) => e.action)).toEqual(['POP']);
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(screen.getByTestId('paused').textContent).toBe('false');

    // ...which is the whole point: history is back at the plain /games entry,
    // so one more back leaves the tab. A running game can never trap the user.
    act(() => back());
    expect(screen.getByTestId('outside')).toBeDefined();
  });

  it('survives play → back → resume → back → back without growing the stack', () => {
    mount();

    act(() => flow.startGame()); //            [A, G] playing
    act(() => back()); //                      [A, G] paused (pop + re-push)
    const beforeResume = log.length;
    act(() => flow.setPaused(false)); //        [A, G] resume touches no history
    expect(log.length).toBe(beforeResume); //   ...and the guard is still armed
    act(() => back()); //                      [A, G] paused again
    expect(screen.getByTestId('paused').textContent).toBe('true');
    act(() => back()); //                      [A]    menu

    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(depth()).toBe(0); // back to the plain /games entry
    act(() => back()); //                      leaves /games
    expect(screen.getByTestId('outside')).toBeDefined();
  });

  it('startFree() pushes a free marker and back returns to the menu', () => {
    mount();
    act(() => flow.startFree());

    expect(screen.getByTestId('screen').textContent).toBe('free');
    expect(log).toEqual([{ action: 'PUSH', pathname: '/games', state: { game: 'free' } }]);

    act(() => back());
    // UNGUARDED free play does NOT escalate — one back is enough. This is the
    // range-practice / single-hole case: nothing to bank, so a confirm step
    // would be pure friction.
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(screen.getByTestId('paused').textContent).toBe('false');
    expect(log.map((e) => e.action)).toEqual(['PUSH', 'POP']);
    expect(depth()).toBe(0);
    // No abandoned flag either: an unguarded session has no partial run to
    // re-read, so the menu must not pay for an extra stats pass.
    expect(screen.getByTestId('statsKey').textContent).toBe('0');

    act(() => back());
    expect(screen.getByTestId('outside')).toBeDefined();
  });

  // Both entry points are used DIRECTLY as click handlers (FogScreen does
  // `onClick={startFree}`), so React calls them with the click event. This is
  // why guarding is chosen by FUNCTION NAME and not by an argument: an
  // options-object parameter would read `guardProgress` off a MouseEvent, get
  // undefined, and silently produce an unguarded round — a protection that
  // looks present and isn't, which is the very bug class the guard exists to
  // kill. Zero-parameter functions cannot be mis-called that way.
  it.each([
    ['startFree', false],
    ['startFreeGuarded', true],
  ] as const)('%s ignores an argument, so it is safe as a bare onClick handler', (name, guarded) => {
    mount();
    const fakeClickEvent = { type: 'click', preventDefault() {}, nativeEvent: {} };
    // Exactly what `onClick={flow[name]}` does at runtime.
    act(() => (flow[name] as (e: unknown) => void)(fakeClickEvent));
    act(() => back());

    // Guardedness came from the name, so passing an event changed nothing.
    expect(screen.getByTestId('paused').textContent).toBe(String(guarded));
    expect(screen.getByTestId('screen').textContent).toBe(guarded ? 'free' : 'menu');
  });

  // A GUARDED free session — golf Course mode, baseball Derby/Duel: the screen
  // is the same `free`, but there is a multi-hole round in flight, so a single
  // back press must not be able to destroy it. The contract is that guarded
  // free is byte-for-byte the guess escalation, so these mirror the guess tests
  // above deliberately.
  describe('guarded free (startFreeGuarded())', () => {
    it('pushes the SAME `free` marker, so nothing else in the flow changes', () => {
      mount();
      act(() => flow.startFreeGuarded());

      expect(screen.getByTestId('screen').textContent).toBe('free');
      // Same key, same value: guarding is a property of the SESSION, not of
      // the history entry. A new marker key would have to be taught to
      // consumeHistoryEntry, the stale-marker branch and the hub's
      // `hubGame` collision guard.
      expect(log).toEqual([{ action: 'PUSH', pathname: '/games', state: { game: 'free' } }]);
      expect(depth()).toBe(1);
    });

    it('back while playing pauses and re-arms, leaving history depth unchanged', () => {
      mount();
      act(() => flow.startFreeGuarded());
      log = [];

      act(() => back());

      // The bug this exists for: pre-guard, this press went straight to the
      // menu and the round was gone.
      expect(screen.getByTestId('screen').textContent).toBe('free');
      expect(screen.getByTestId('paused').textContent).toBe('true');
      expect(log.map((e) => e.action)).toEqual(['POP', 'PUSH']);
      expect(depth()).toBe(0); // net zero => still [A, F]
      expect(log.at(-1)).toEqual({ action: 'PUSH', pathname: '/games', state: { game: 'free' } });
    });

    it('does not loop after re-arming: free + free-marker is the steady state', () => {
      mount();
      act(() => flow.startFreeGuarded());
      log = [];
      act(() => back());
      const settled = log.length;
      const settledRenders = renders;

      // The re-push flips the marker back to the one matching the screen, so
      // the follow-up run hits no branch. If it did, the paused arm would fire
      // and the player would be thrown to the menu by their own pause press.
      act(() => {});
      act(() => {});
      expect(log.length).toBe(settled);
      expect(renders - settledRenders).toBeLessThan(3);
      expect(screen.getByTestId('screen').textContent).toBe('free');
      expect(screen.getByTestId('paused').textContent).toBe('true');
    });

    it('back while paused leaves to the menu, banks the partial run, and frees the tab', () => {
      mount();
      act(() => flow.startFreeGuarded());
      act(() => back()); // pause
      expect(screen.getByTestId('paused').textContent).toBe('true');
      log = [];

      act(() => back()); // escalate: leave

      // The pop STANDS — no compensating push.
      expect(log.map((e) => e.action)).toEqual(['POP']);
      expect(screen.getByTestId('screen').textContent).toBe('menu');
      expect(screen.getByTestId('paused').textContent).toBe('false');
      // The abandoned marker is set the same way the guess branch sets it, so
      // the menu re-reads local stats after the child's unmount safety net has
      // written the partial round.
      expect(screen.getByTestId('statsKey').textContent).toBe('1');

      // History is back at the plain /games entry: a guarded round can no more
      // trap the user in the tab than a guess game can.
      act(() => back());
      expect(screen.getByTestId('outside')).toBeDefined();
    });

    it('survives play → back → resume → back → back without growing the stack', () => {
      // The header comment's ledger, replayed for the free screen:
      mount();

      act(() => flow.startFreeGuarded()); // [A, F] playing
      act(() => back()); //                                  [A, F] paused
      const beforeResume = log.length;
      act(() => flow.setPaused(false)); //                    [A, F] resume: no history
      expect(log.length).toBe(beforeResume); //               ...guard still armed
      expect(depth()).toBe(1);
      act(() => back()); //                                  [A, F] paused again
      expect(screen.getByTestId('screen').textContent).toBe('free');
      expect(screen.getByTestId('paused').textContent).toBe('true');
      act(() => back()); //                                  [A]    menu

      expect(screen.getByTestId('screen').textContent).toBe('menu');
      expect(depth()).toBe(0); // back at the plain /games entry, five presses on
      act(() => back()); //                                  leaves /games
      expect(screen.getByTestId('outside')).toBeDefined();
    });

    it('does not arm the guard for the NEXT free session', () => {
      // The staleness hazard of a ref-held flag, pinned: finish a guarded
      // round, then start an unguarded one (course round → range practice) and
      // the confirm step must be gone.
      mount();
      act(() => flow.startFreeGuarded());
      act(() => back()); // pause
      act(() => back()); // leave
      expect(screen.getByTestId('screen').textContent).toBe('menu');
      log = [];

      act(() => flow.startFree()); // in by the plain door this time
      act(() => back());

      expect(screen.getByTestId('screen').textContent).toBe('menu');
      expect(screen.getByTestId('paused').textContent).toBe('false');
      expect(log.map((e) => e.action)).toEqual(['PUSH', 'POP']);
      expect(depth()).toBe(0);
    });

    it('is still left cleanly by the UI exit path', () => {
      // Guarding changes the back gesture only; the buttons still consume the
      // marker without pausing on the way out.
      mount();
      act(() => flow.startFreeGuarded());
      log = [];

      act(() => {
        flow.setScreen('results');
        flow.consumeHistoryEntry('free');
      });

      expect(screen.getByTestId('screen').textContent).toBe('results');
      expect(screen.getByTestId('paused').textContent).toBe('false');
      expect(log.map((e) => e.action)).toEqual(['POP']);
      expect(depth()).toBe(-1);
    });
  });

  it('clears a stale marker in place and settles instead of looping', () => {
    mount({ pathname: '/games', state: { game: 'guess' } });

    // A marker with no matching screen (reload / remount after a tab switch
    // mid-game) is cleared with a REPLACE, not a pop — the entry itself is
    // wrong, so history depth must not move.
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(log.map((e) => e.action)).toEqual(['REPLACE']);
    expect(log.at(-1)!.state).toBeNull();
    expect(depth()).toBe(0);

    const settled = log.length;
    const settledRenders = renders;
    act(() => {});
    act(() => {});
    expect(log.length).toBe(settled);
    // The clear must not re-trigger itself; a runaway would blow past this.
    expect(renders - settledRenders).toBeLessThan(3);

    // Depth is untouched, so back still leaves the tab in one press.
    act(() => back());
    expect(screen.getByTestId('outside')).toBeDefined();
  });

  it('ignores the retired legacy `fog` key entirely', () => {
    // `fog` was the pre-hub marker key, read as a fallback long after it
    // stopped being written and documented as believed-unreachable. It is now
    // retired, so a `fog` entry is just unrecognised state: NOT a marker, and
    // therefore nothing to clear. Pinned so the key cannot creep back in.
    mount({ pathname: '/games', state: { fog: 'guess' } });
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(log).toEqual([]); // no REPLACE — the hook does not recognise it
    expect(depth()).toBe(0);

    // And it is left alone rather than wiped, which is what the hub's own
    // `hubGame` entry relies on (see routes/GamesDeepLink.test.tsx).
    act(() => back());
    expect(screen.getByTestId('outside')).toBeDefined();
  });

  it('consumeHistoryEntry() pops the marker when it is present', () => {
    mount();
    act(() => flow.startGame());
    log = [];

    // How the UI buttons leave a game: the screen moves on first, so the
    // popstate that lands is a no-op for every branch of the effect.
    act(() => {
      flow.setScreen('results');
      flow.consumeHistoryEntry('guess');
    });

    expect(screen.getByTestId('screen').textContent).toBe('results');
    expect(log.map((e) => e.action)).toEqual(['POP']);
    expect(depth()).toBe(-1); // the startGame push is consumed
    // Crucially it did NOT pause/re-arm on the way out.
    expect(screen.getByTestId('paused').textContent).toBe('false');
  });

  it('consumeHistoryEntry() does nothing when the marker is absent', () => {
    mount();
    // No marker (a back gesture already popped it). A spurious nav(-1) here
    // would yank the user clean out of the Games tab.
    act(() => flow.consumeHistoryEntry('guess'));

    expect(log).toEqual([]);
    expect(screen.queryByTestId('outside')).toBeNull();
    expect(screen.getByTestId('screen').textContent).toBe('menu');
  });

  it('consumeHistoryEntry() ignores a marker of the other kind', () => {
    mount();
    act(() => flow.startFree());
    log = [];
    act(() => flow.consumeHistoryEntry('guess'));
    expect(log).toEqual([]);
  });

  it('markAbandoned() bumps statsKey exactly once on return to the menu', () => {
    mount();
    act(() => flow.startGame());
    expect(screen.getByTestId('statsKey').textContent).toBe('0');

    act(() => {
      flow.markAbandoned();
      flow.setScreen('menu');
    });
    expect(screen.getByTestId('statsKey').textContent).toBe('1');

    // The flag is one-shot: ordinary menu visits cost nothing.
    act(() => flow.setScreen('results'));
    act(() => flow.setScreen('menu'));
    expect(screen.getByTestId('statsKey').textContent).toBe('1');
  });

  it('does not bump statsKey for a plain (non-abandoned) return to the menu', () => {
    mount();
    act(() => flow.startGame());
    act(() => flow.setScreen('menu'));
    expect(screen.getByTestId('statsKey').textContent).toBe('0');
  });

  it('bumps statsKey when a paused game is backed out of', () => {
    // The abandon path the hook sets internally (back while paused), not via
    // markAbandoned() — the partial run has to be re-read either way.
    mount();
    act(() => flow.startGame());
    act(() => back()); // pause
    act(() => back()); // leave
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(screen.getByTestId('statsKey').textContent).toBe('1');
  });
});
