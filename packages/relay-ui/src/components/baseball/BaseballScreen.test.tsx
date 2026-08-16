// @vitest-environment jsdom
//
// THE EXIT PROOF. `DerbyGame.test.tsx` stands the HUD up with props alone; this
// file is the other half — the HUD inside the flow machine it actually ships in,
// asserting the ONE property the pair of them share and neither could hold
// alone: **leaving a derby and finishing a derby are different events.**
//
// ⚠ THE BUG THIS EXISTS FOR, MEASURED. `DerbyGame`'s unmount safety net called
// `finish()`, and `finish()` called `onFinish` — so the abandon path and the
// natural-finish path were one function. Pressing "‹ Exit" one pitch into a
// session, with history ['/chats', '/games']:
//
//     LOCATION AFTER EXIT: /chats          (expected /games)
//     BODY: Derby complete 160 · Home runs 1 · Barrels 1 · Longest 410 ft
//
// Two symptoms, one cause. `onExit` sets the screen to 'menu', which unmounts
// `DerbyGame`, whose net reports a finish, which puts `BaseballScreen` on the
// RESULTS screen the player did not ask for — and calls
// `consumeHistoryEntry('guess')` a second time before `histGameRef` has
// re-rendered, so `useGameFlow` fires a second `nav(-1)` and the player leaves
// the Games tab entirely. One press, two pops.
//
// Golf's nets do not do this (`GolfGame`, `RangeGame`: "No setState here — the
// whole route may be unmounting"), so the fix is golf's shape: `bank()` writes
// the score, `finish()` banks AND reports, and only the second is a finish.
//
// The sentinel `/chats` entry underneath `/games` is `useGameFlow.test.tsx`'s
// device: a second pop is not an abstraction to reason about, it is `/chats`
// appearing on screen.
//
// It also holds the OTHER thing this screen does, which arrived unasserted and
// was deletable: raising the store's `immersive` flag for the duration of a
// derby. Two mutations were watched to fail in the follow-up review pass:
//
//   1. the whole `setImmersive` effect deleted   → 2 fail
//   2. only its cleanup deleted
//      (`return () => setImmersive(false)`)      → 1 fail
//
// Both were survivable before — the flag is invisible on screen while the
// canvas covers the chrome anyway, so no pixel and no other assertion moves.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { BaseballScreen } from './BaseballScreen';
import { useStore } from '../../lib/store';
import { DERBY_ROUNDS, PITCHES_PER_ROUND } from '../../lib/baseball/derbyRules';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';

/** Exactly the shape `DerbyGame.bank()` posts. Typed so `mock.calls` is readable. */
interface Submitted {
  score: number;
  rounds: number;
  bestStreak: number;
  game: string;
}

const { submitSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn(
    async (_body: { score: number; rounds: number; bestStreak: number; game: string }) => ({
      ok: true,
    }),
  ),
}));
vi.mock('../../lib/api', () => ({ api: { submitGameScore: submitSpy }, API_BASE: '' }));
vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

/** Mirrors `DerbyGame`'s own lead-in. Not exported by it; kept in step by hand. */
const PITCH_LEAD_MS = 380;
/**
 * The wall clock a ~0.41 s crossing takes at PITCH_TEMPO — see DerbyGame.test.
 *
 * ⚠ DERIVED FROM THE KNOB, NOT A LITERAL. It was `+ 745`, which was 0.41 s at
 * PITCH_TEMPO = 0.55 and 25 ms of true time OUT at 0.45 — so the M2 feel pass's
 * tempo change (an explicitly-labelled feel knob, free to turn) broke this file
 * with an assertion about `bestStreak`. A test that pins a wall time cannot also
 * be tempo-independent unless it derives it.
 */
const CROSSING_TRUE_S = 0.41;
const SWING_AT_MS = PITCH_LEAD_MS + Math.round((CROSSING_TRUE_S / PITCH_TEMPO) * 1000);

/**
 * The session seed.
 *
 * ⚠ IT IS PINNED THROUGH `Date.now`, AND THAT IS NOT A CONVENIENCE.
 * `BaseballScreen` deliberately does NOT thread a seed prop — the shipped game
 * takes a fresh session every time (`DerbyGame`'s `seed ?? (Date.now() >>> 0)`),
 * and threading one just so a test could reach it would be a test changing the
 * product. So the test pins the CLOCK instead, which is the same thing the
 * screenshot harness does. With this value the first pitch of the session is a
 * home run, which is what gives the "the partial run was banked" assertion below
 * a non-zero number to check rather than a hopeful `>= 0`.
 */
const SEED_CLOCK_MS = 20260819;

let now = 0;
let frames: FrameRequestCallback[] = [];
let path = '';
let back: () => void = () => undefined;

beforeEach(() => {
  now = 0;
  frames = [];
  path = '';
  submitSpy.mockClear();
  // The store is a module singleton, so the immersive flag survives between
  // tests. Reset it so "it was raised" is this test's doing and not the last's.
  useStore.getState().setImmersive(false);
  vi.spyOn(Date, 'now').mockReturnValue(SEED_CLOCK_MS);
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function advance(ms: number, stepMs = 8) {
  for (let done = 0; done < ms; done += stepMs) {
    now += stepMs;
    const due = frames;
    frames = [];
    act(() => {
      for (const cb of due) cb(now);
    });
  }
}

// The location readout and the back driver, both inside the router. `nav(-1)` is
// exactly what `AndroidBackButton` calls and what a browser back gesture
// produces — `window.history.back()` would talk to jsdom's history, which a
// `MemoryRouter` does not use.
function Probe() {
  path = useLocation().pathname;
  const nav = useNavigate();
  back = () => nav(-1);
  return null;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/chats', '/games']} initialIndex={1}>
      <Probe />
      <Routes>
        <Route path="/chats" element={<div data-testid="chats">chats</div>} />
        <Route path="/games" element={<BaseballScreen onExitToHub={() => undefined} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const body = () => document.body.textContent ?? '';
const surface = () => document.querySelectorAll('div[style*="touch-action"]')[0] as HTMLElement;

function tap(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  });
}

/** Serve, swing on time, and let the play resolve. */
function playOnePitch() {
  act(() => screen.getByText('Pitch it in').click());
  advance(SWING_AT_MS, 4);
  tap(surface());
  advance(14000, 48);
}

describe('BaseballScreen — leaving is not finishing', () => {
  it('⚠ "‹ Exit" mid-session lands on the MENU, in /games, with the run banked', () => {
    mount();
    act(() => screen.getByText('Play Derby').click());
    playOnePitch();
    expect(screen.getByText('‹ Exit')).toBeTruthy();

    act(() => screen.getByText('‹ Exit').click());

    // (1) ONE pop, not two. The startGame push is consumed and the sentinel
    // beneath /games is untouched — a second nav(-1) would show it.
    expect(path).toBe('/games');
    expect(screen.queryByTestId('chats')).toBeNull();

    // (2) The screen the player asked for. "Derby complete" here is the exact
    // symptom the reviewer photographed.
    expect(body()).not.toContain('Derby complete');
    expect(screen.getByText('Home Run Derby')).toBeTruthy();
    expect(screen.getByText('Play Derby')).toBeTruthy();

    // (3) …and the partial run is still banked. Abandoning must not cost the
    // score; that is what the unmount net is FOR, and dropping the net to fix
    // (1) and (2) would trade one bug for another.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const sent: Submitted = submitSpy.mock.calls[0]![0];
    expect(sent.game).toBe('bbderby');
    expect(sent.rounds).toBe(1);
    expect(sent.score).toBeGreaterThan(0);
    expect(sent.bestStreak).toBeGreaterThanOrEqual(1);
  });

  it('the back GESTURE escalates the same way: pause, then the menu — never results', () => {
    // The other route into the same net, and the one that broke identically:
    // back #1 raises the pause sheet, back #2 leaves. Before the split, back #2
    // landed on "Derby complete".
    const { container } = mount();
    act(() => screen.getByText('Play Derby').click());
    playOnePitch();

    act(() => back());
    advance(32, 8);
    expect(container.querySelector('.bb-pause')).toBeTruthy();

    act(() => back());
    advance(32, 8);
    expect(path).toBe('/games');
    expect(body()).not.toContain('Derby complete');
    expect(screen.getByText('Play Derby')).toBeTruthy();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('a COMPLETED session still reaches the results screen, and banks exactly once', () => {
    mount();
    act(() => screen.getByText('Play Derby').click());
    for (let i = 0; i < DERBY_ROUNDS * PITCHES_PER_ROUND; i++) playOnePitch();

    // The natural finish is the one path that reports, so this is the assertion
    // that stops "the net must not call onFinish" being satisfied by nothing
    // ever calling it.
    expect(screen.getByText('Derby complete')).toBeTruthy();
    expect(screen.getByText('Best streak')).toBeTruthy();
    expect(path).toBe('/games');
    expect(screen.queryByTestId('chats')).toBeNull();

    // `reportedRef` still gates BOTH paths: the results screen unmounts
    // `DerbyGame`, whose net runs, and it must not submit a second score.
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const sent: Submitted = submitSpy.mock.calls[0]![0];
    expect(sent.rounds).toBe(DERBY_ROUNDS);

    // The streak on screen is the SIM's, which is the whole point of moving it
    // there: it is booked by `commit()`, snapshotted, and submitted — one value,
    // not a HUD ref that happens to agree.
    const shown = /Best streak\s*(\d+)/.exec(body());
    expect(shown, `no best-streak stat on screen; body was:\n${body()}`).toBeTruthy();
    expect(Number(shown![1])).toBe(sent.bestStreak);
    expect(sent.bestStreak).toBeGreaterThan(0);
  });
});

describe('BaseballScreen — the app chrome yields to the canvas, and gets it back', () => {
  // ⚠ THIS EXISTS BECAUSE THE EFFECT WAS DELETABLE. `BaseballScreen`'s
  // `setImmersive` effect landed as a one-line footnote in a commit about four
  // other things, and the reviewer deleted the whole effect with all 12 baseball
  // tests still green. It is a real behaviour change — `MainLayout` renders the
  // bottom tab bar and the top navbar only when `immersive` is false — so
  // without it both stay MOUNTED and painting a second layout, with their
  // blur/backdrop surfaces composited every frame, underneath a full-screen
  // WebGL canvas that already covers them at `zIndex: 60`. Invisible on screen,
  // which is exactly why the visual gate cannot hold it and this must.
  //
  // The RESTORE half is the half that would actually be seen: leave a derby by
  // any path with the flag still raised and the player is in a chromeless app
  // with no way back to the tab bar.

  const immersive = () => useStore.getState().immersive;

  it('⚠ the derby raises `immersive`, and every exit lowers it again', () => {
    mount();
    // The menu is ordinary chrome — the tab bar belongs to the player here.
    expect(immersive()).toBe(false);

    act(() => screen.getByText('Play Derby').click());
    expect(immersive()).toBe(true);

    // Leaving to the menu is the common path, and it goes through the SCREEN
    // changing rather than through an unmount — so a cleanup-only implementation
    // would not be enough.
    playOnePitch();
    act(() => screen.getByText('‹ Exit').click());
    expect(screen.getByText('Play Derby')).toBeTruthy();
    expect(immersive()).toBe(false);
  });

  it('the results screen is chrome again, and unmounting restores it too', () => {
    const { unmount } = mount();
    act(() => screen.getByText('Play Derby').click());
    expect(immersive()).toBe(true);

    // A COMPLETED session: the results card is ordinary chrome, so the flag has
    // to fall on the screen change and not only on the way out of the tab.
    for (let i = 0; i < DERBY_ROUNDS * PITCHES_PER_ROUND; i++) playOnePitch();
    expect(screen.getByText('Derby complete')).toBeTruthy();
    expect(immersive()).toBe(false);

    // …and the unmount net: play again, then tear the whole route down mid-derby
    // the way a route change or an Android back out of the tab does.
    act(() => screen.getByText('Play again').click());
    expect(immersive()).toBe(true);
    unmount();
    expect(immersive()).toBe(false);
  });
});
