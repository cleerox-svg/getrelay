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
    // Free play does NOT escalate — one back is enough.
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(log.map((e) => e.action)).toEqual(['PUSH', 'POP']);
    expect(depth()).toBe(0);

    act(() => back());
    expect(screen.getByTestId('outside')).toBeDefined();
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

  it('clears a stale legacy `fog` marker too', () => {
    // The `fog` fallback is documented as believed-unreachable but kept; pin
    // the read so retiring it is a deliberate act rather than an accident.
    mount({ pathname: '/games', state: { fog: 'guess' } });
    expect(screen.getByTestId('screen').textContent).toBe('menu');
    expect(log.at(-1)).toEqual({ action: 'REPLACE', pathname: '/games', state: null });
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
