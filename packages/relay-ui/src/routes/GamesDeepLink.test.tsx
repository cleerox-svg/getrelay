// @vitest-environment jsdom
import type { ReactElement } from 'react';
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
import { GamesDeepLink } from './Games';
import { useGameFlow } from '../lib/games/useGameFlow';

// /games/:game is the path a push-notification tap lands on (the worker's
// golf-challenge sends url: '/games/golf'). Games are NOT subroutes, so
// GamesDeepLink normalizes the URL back to /games and hands the validated id
// along in history state.
//
// GamesDeepLink is exported separately from <Games>, so these tests mount it
// alone rather than dragging in Konsta, the store and all three game screens
// via the hub — the redirect is the whole behaviour under test.
//
// The router is seeded with a SENTINEL entry underneath the deep link so
// `replace` is observable as behaviour: after the redirect, one back must
// reach /sentinel. If the redirect ever pushed, history would be one deeper
// than landing on /games directly, which is exactly what useGameFlow's depth
// invariant assumes it is not.

let landedState: unknown;
let landedAction: string | undefined;
let back: () => void;

function Probe() {
  const location = useLocation();
  landedState = location.state;
  landedAction = useNavigationType();
  return <div data-testid="hub">hub</div>;
}

// The same landing, but with useGameFlow mounted the way the real game
// screens mount it — used for the key-collision test below.
function ProbeWithFlow() {
  const location = useLocation();
  landedState = location.state;
  landedAction = useNavigationType();
  const flow = useGameFlow();
  return <div data-testid="hub">{flow.screen}</div>;
}

function Back() {
  const nav = useNavigate();
  back = () => nav(-1);
  return null;
}

// React 19 dropped the global JSX namespace, so annotate with ReactElement.
function mount(path: string, hub: () => ReactElement = Probe) {
  landedState = undefined;
  landedAction = undefined;
  const Hub = hub;
  return render(
    <MemoryRouter initialEntries={['/sentinel', path]} initialIndex={1}>
      <Back />
      <Routes>
        <Route path="/sentinel" element={<div data-testid="sentinel">sentinel</div>} />
        <Route path="/games" element={<Hub />} />
        <Route path="/games/:game" element={<GamesDeepLink />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('GamesDeepLink', () => {
  it.each([
    ['/games/golf', 'golf'],
    ['/games/fog', 'fog'],
    ['/games/tune', 'tune'],
  ])('%s redirects to /games carrying hubGame %s', (path, id) => {
    mount(path);
    // Normalized to the exact /games pathname — MainLayout's tab bar active
    // check is `pathname === '/games'`, so sitting on /games/golf would leave
    // the Games tab unhighlighted.
    expect(screen.getByTestId('hub')).toBeDefined();
    expect(landedState).toEqual({ hubGame: id });
  });

  it('an unknown game degrades to the hub grid with no state', () => {
    mount('/games/bogus');
    // Not a fall-through to /chats, and not a blank screen: the hub renders,
    // just with nothing preselected.
    expect(screen.getByTestId('hub')).toBeDefined();
    expect(landedState).toBeNull();
  });

  it('redirects with replace, so history depth matches landing on /games directly', () => {
    mount('/games/golf');
    expect(landedAction).toBe('REPLACE');

    // Behavioural proof: one back reaches the sentinel. Had the redirect
    // pushed, this back would land on /games/golf and bounce straight back
    // to the hub — trapping the user.
    act(() => back());
    expect(screen.getByTestId('sentinel')).toBeDefined();
    expect(screen.queryByTestId('hub')).toBeNull();
  });

  it('uses the hubGame key and NOT `game`, which useGameFlow owns', () => {
    mount('/games/golf');
    const state = landedState as Record<string, unknown>;
    // The key-collision guard, asserted literally: useGameFlow reads
    // state.game as its back-gesture marker. A hub entry keyed `game` would
    // look like a marker. `fog` was the legacy marker key, now retired from
    // the hook — pinned as absent here so it cannot creep back in either.
    expect(Object.keys(state)).toEqual(['hubGame']);
    expect(state.game).toBeUndefined();
    expect(state.fog).toBeUndefined();
  });

  it('does not trip useGameFlow’s stale-marker branch on arrival', () => {
    // The consequence the naming avoids, tested end to end: land the deep
    // link on a hub that mounts useGameFlow, and the hook must sit still.
    mount('/games/golf', ProbeWithFlow);

    expect(screen.getByTestId('hub').textContent).toBe('menu');
    // If `hubGame` were `game`, the hook would have fired its stale-marker
    // clear — a REPLACE wiping state to null, destroying the selection the
    // deep link just delivered.
    expect(landedAction).toBe('REPLACE'); // GamesDeepLink's own redirect...
    expect(landedState).toEqual({ hubGame: 'golf' }); // ...and nothing wiped it.

    // And the entry is still the plain one back-wise: one press leaves.
    act(() => back());
    expect(screen.getByTestId('sentinel')).toBeDefined();
  });
});
