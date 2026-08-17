// @vitest-environment jsdom
//
// A SPECIAL ROUND MUST NOT BE ABLE TO CORRUPT THE NEXT ONE.
//
// `GolfScreen` used to track Daily and Tournament play with five independent
// state slots (`dailyActive`, `dailySeed`, `tourneyActive`, `tourneyCourse`,
// `tourneySeed`), and the ONLY place any of them was cleared was inside
// `CourseGame`'s `onExit`. A back GESTURE out of a round calls no callback at
// all — `useGameFlow`'s popstate branch just moves the screen back to the menu —
// so the flag survived and rewired a LATER, unrelated round:
//
//   • stale `dailyActive`  → a casual single hole was POSTed as today's Daily
//                            Challenge attempt, burning the day's entry;
//   • stale `tourneyActive`→ picking "Augusta · Hole 12" played the synthesized
//                            3-hole tournament course from hole 1 instead;
//   • either              → a full 18-hole round posted NOWHERE, because
//                            `onRoundComplete` was undefined while a daily was
//                            "active".
//
// So every test below leaves the special round by the BACK GESTURE (nav(-1),
// which is exactly what the Android hardware button and a browser back produce)
// and then asserts on what the NEXT round is handed. There is deliberately no
// test that exits via `onExit`: that is the path that already worked.
//
// ⚠ AND `onExit` IS ABOUT TO STOP BEING THE ONLY EXIT TWICE OVER. `useGameFlow`
// now offers `startFreeGuarded()`, whose LEAVE arm (the second back press, and
// the pause sheet's "End round" once it is wired) also calls `setScreen('menu')`
// WITHOUT the child's `onExit`. The reset therefore cannot live in an exit
// callback at all — it lives at the top of `startGolf()`, on the ENTRY side,
// where every launch must pass. `flow.guarded` below opts one test into the
// guarded door so that arm is exercised with the REAL hook today, before the
// integration flip (this file does not, and must not, change which door
// GolfScreen opens).
//
// NOTE ON "WITHOUT onExit": `onExit` is a prop of the STUBBED child, and nothing
// in this file ever invokes it. So in every test below it is not merely untested
// but unreachable — the reset being observed can only be the entry-side one.
//
// WHY THE ASSERTIONS ARE ON `CourseGame`'S PROPS. `CourseGame` is stubbed, so
// what is pinned is the wiring `GolfScreen` chooses — the course, the starting
// hole, the seed and WHICH completion channel exists. That set is the whole
// contract; a hole reported through the wrong channel is the bug.
//
// ⚠ NOTHING HERE IMPORTS `CourseIntent` OR `lib/golf/pendingResult`. The point
// is not that the union agrees with itself — this repo has shipped two bugs
// where a guard and its implementation agreed by construction. Every assertion
// is on observable behaviour: props handed to the child, and requests reaching
// `api`.
//
// MUTATION-CHECKED against the pre-fix code (the five flags, cleared only in
// onExit): tests 1, 2, 3, 4 and 6 all fail, and 5 fails because a pending result
// was plain component state that a remount simply forgot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { GolfScreen } from './GolfScreen';

// Captured props of the stubbed children, per render.
const seen = vi.hoisted(() => ({
  course: null as null | {
    course: { id: string };
    startHole?: number;
    seed?: number;
    onHoleComplete?: (r: { courseId: string; hole: number; strokes: number; par: number; toPar: number }) => void;
    onRoundComplete?: (r: { courseId: string; holes: number; strokes: number; par: number; toPar: number }) => void;
  },
  tourneyPending: null as unknown,
}));

// Opts a test into the guarded free-screen door WITHOUT editing GolfScreen: the
// real useGameFlow is used, only the door GolfScreen's `startFree` opens is
// swapped for `startFreeGuarded`. That is exactly the one-line flip the
// integration owner will make, so the escalation (back → pause, back → leave,
// no onExit) can be walked against the real state machine now.
const flow = vi.hoisted(() => ({ guarded: false }));
vi.mock('../../lib/games/useGameFlow', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/games/useGameFlow')>();
  return {
    ...mod,
    useGameFlow: () => {
      const f = mod.useGameFlow();
      return flow.guarded ? { ...f, startFree: f.startFreeGuarded } : f;
    },
  };
});

// --- the api surface both GolfScreen and the REAL GolfDaily reach for --------
const spies = vi.hoisted(() => ({
  getDaily: vi.fn(),
  getDailyLeaderboard: vi.fn(),
  getTournament: vi.fn(),
  submitGameScore: vi.fn(),
  postDailyResult: vi.fn(),
  postTournamentResult: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: spies }));

// --- children that are not under test ---------------------------------------
vi.mock('./CourseGame', () => ({
  default: (p: NonNullable<typeof seen.course>) => {
    seen.course = p;
    return (
      <div>
        <span data-testid="course">{p.course.id}</span>
        <span data-testid="startHole">{String(p.startHole)}</span>
        <span data-testid="seed">{String(p.seed)}</span>
        {/* Which completion channel exists — the wiring that decides where a
            finished hole/round is reported. */}
        <span data-testid="channels">
          {`${p.onHoleComplete ? 'hole' : '-'}/${p.onRoundComplete ? 'round' : '-'}`}
        </span>
      </div>
    );
  },
}));

vi.mock('./GolfMenu', () => ({
  // The Play tab's picker, reduced to the two choices these tests make: one
  // single hole (Augusta · Hole 12, 0-based index 11) and one full round.
  GolfMenu: ({ onStart }: { onStart: (m: string, a?: string) => void }) => (
    <div>
      <button type="button" onClick={() => onStart('course', 'augusta#11')}>
        pick hole 12
      </button>
      <button type="button" onClick={() => onStart('course', 'augusta')}>
        pick full round
      </button>
    </div>
  ),
}));

vi.mock('./GolfTournaments', () => ({
  GolfTournaments: (p: { pendingResult: unknown; onPlay: (c: unknown, seed: number) => void }) => {
    seen.tourneyPending = p.pendingResult;
    return (
      <div>
        <span data-testid="tourney-pending">{p.pendingResult ? 'pending' : 'none'}</span>
        <button
          type="button"
          onClick={() =>
            p.onPlay({ id: 'tourney-3', name: 'Rapid', holes: [], par: 12, yards: 1200 }, 555)
          }
        >
          enter event
        </button>
      </div>
    );
  },
}));

vi.mock('./GolfGame', () => ({ GolfGame: () => null }));
vi.mock('./RangeGame', () => ({ RangeGame: () => null }));
vi.mock('./GolfLeaderboard', () => ({ GolfLeaderboard: () => null }));
vi.mock('./GolfProfile', () => ({ GolfProfile: () => null }));
vi.mock('./GolfShop', () => ({ GolfShop: () => null }));
vi.mock('./GolfSeason', () => ({ GolfSeason: () => null }));
vi.mock('./GolfWallet', () => ({ GolfWallet: () => null }));
vi.mock('./CoinBalance', () => ({ CoinBalance: () => null }));
vi.mock('../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../lib/audio', () => ({
  startMusic: () => undefined,
  stopMusic: () => undefined,
  duckMusic: () => undefined,
  play: () => undefined,
}));
vi.mock('../../lib/store', () => {
  // A STABLE state object: GolfScreen selects setImmersive out of it into an
  // effect dep, so a fresh identity per render would loop.
  const state = { me: { displayName: 'Tester' }, setImmersive: () => undefined };
  return { useStore: (sel: (s: typeof state) => unknown) => sel(state) };
});
vi.mock('../../lib/golf/economy', () => {
  const state = {
    catalog: [],
    equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_none' },
    balance: 0,
    ensureCosmetics: async () => undefined,
    ensureWallet: async () => undefined,
  };
  return {
    useEconomy: (sel: (s: typeof state) => unknown) => sel(state),
    useEquippedFrame: () => undefined,
  };
});

// Today's challenge: Augusta hole 7 (1-based `hole`, so 0-based index 6), seeded.
const DAILY = {
  date: '2026-08-17',
  game: 'golfcourse' as const,
  course: 'augusta',
  hole: 7,
  seed: 4242,
  today: null,
  streak: { current: 3, best: 5 },
};

/** A promise whose settling the test controls — stands in for a slow POST. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Back gesture. nav(-1) is exactly what AndroidBackButton does and what a
// browser back produces: useGameFlow only ever observes the location change.
let back: () => void = () => undefined;
function Nav() {
  const nav = useNavigate();
  back = () => nav(-1);
  return null;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/games']}>
      <Nav />
      <GolfScreen onExitToHub={() => undefined} />
    </MemoryRouter>,
  );
}

/** Let every pending microtask (the api promises) land. */
async function flush() {
  await act(async () => undefined);
}

function click(el: Element | null | undefined) {
  act(() => (el as HTMLElement).click());
}

/** Open Arena › Daily and wait for the real GolfDaily to have today's card. */
async function openDaily() {
  click(screen.getByRole('tab', { name: /Arena/ }));
  await flush();
}

/** Start today's daily round from the real GolfDaily card. */
async function playDaily() {
  await openDaily();
  click(screen.getByRole('button', { name: /Play today/ }));
  await flush();
}

/** Pick a plain Course round from the Play tab. */
async function pick(what: 'hole 12' | 'full round') {
  click(screen.getByRole('tab', { name: /Play/ }));
  click(screen.getByText(what === 'hole 12' ? 'pick hole 12' : 'pick full round'));
  await flush();
}

const channels = () => screen.getByTestId('channels').textContent;

beforeEach(() => {
  localStorage.clear();
  flow.guarded = false;
  for (const s of Object.values(spies)) s.mockReset();
  spies.getDaily.mockResolvedValue(DAILY);
  spies.getDailyLeaderboard.mockResolvedValue({ entries: [] });
  // No live event → the Arena tab-entry steer stays on Daily.
  spies.getTournament.mockResolvedValue({ msLeft: 0, entry: null, entrants: 0, holes: [] });
  spies.submitGameScore.mockResolvedValue({ best: 0 });
  spies.postDailyResult.mockResolvedValue({
    today: { strokes: 4, toPar: 0, score: 100 },
    streak: { current: 4, best: 5 },
    improved: true,
  });
  spies.postTournamentResult.mockResolvedValue({
    entry: { rank: 1, toPar: 0, strokes: 12 },
    entrants: 1,
    improved: true,
  });
  seen.course = null;
  seen.tourneyPending = null;
});

afterEach(() => {
  cleanup();
});

describe('GolfScreen — a back gesture out of a special round cannot corrupt the next one', () => {
  it('does not report a later SINGLE HOLE as the daily', async () => {
    mount();
    await playDaily();
    // The daily really is running: its own course/hole/seed, reported per hole.
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('6');
    expect(screen.getByTestId('seed').textContent).toBe('4242');
    expect(channels()).toBe('hole/-');

    // Leave WITHOUT onExit. Nothing gets to clear anything.
    act(() => back());
    await flush();
    expect(screen.queryByTestId('course')).toBeNull();

    // A casual practice hole. It must be the hole that was picked, unseeded, and
    // must NOT own the daily's reporting channel.
    await pick('hole 12');
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    expect(screen.getByTestId('seed').textContent).toBe('undefined');
    expect(channels()).toBe('-/round');

    // And holing it out reaches the daily endpoint nowhere — not now, and not on
    // a later mount either (nothing was persisted as a pending daily).
    act(() =>
      seen.course?.onHoleComplete?.({
        courseId: 'augusta',
        hole: 12,
        strokes: 3,
        par: 4,
        toPar: -1,
      }),
    );
    await flush();
    expect(spies.postDailyResult).not.toHaveBeenCalled();

    cleanup();
    mount();
    await flush();
    expect(spies.postDailyResult).not.toHaveBeenCalled();
  });

  it('still posts a later FULL ROUND to the golfcourse board', async () => {
    mount();
    await playDaily();
    act(() => back());
    await flush();

    await pick('full round');
    expect(screen.getByTestId('startHole').textContent).toBe('undefined');
    expect(channels()).toBe('-/round');

    act(() =>
      seen.course?.onRoundComplete?.({
        courseId: 'augusta',
        holes: 18,
        strokes: 76,
        par: 72,
        toPar: 4,
      }),
    );
    await flush();
    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(spies.submitGameScore).toHaveBeenCalledWith({
      game: 'golfcourse',
      course: 'augusta',
      toPar: 4,
      rounds: 18,
      bestStreak: 0,
      score: 0,
    });
    // The daily was never involved.
    expect(spies.postDailyResult).not.toHaveBeenCalled();
  });

  it('does not let a tournament override a later normal course selection', async () => {
    mount();
    click(screen.getByRole('tab', { name: /Arena/ }));
    await flush();
    click(screen.getByRole('tab', { name: /Events/ }));
    click(screen.getByText('enter event'));
    await flush();
    // The synthesized 3-hole course, full-round mode, seeded.
    expect(screen.getByTestId('course').textContent).toBe('tourney-3');
    expect(screen.getByTestId('startHole').textContent).toBe('undefined');
    expect(screen.getByTestId('seed').textContent).toBe('555');

    act(() => back());
    await flush();

    await pick('hole 12');
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    expect(screen.getByTestId('seed').textContent).toBe('undefined');
  });

  it('reports a tournament round to the event, not the golfcourse board', async () => {
    mount();
    click(screen.getByRole('tab', { name: /Arena/ }));
    await flush();
    click(screen.getByRole('tab', { name: /Events/ }));
    click(screen.getByText('enter event'));
    await flush();

    act(() =>
      seen.course?.onRoundComplete?.({
        courseId: 'tourney-3',
        holes: 3,
        strokes: 12,
        par: 12,
        toPar: 0,
      }),
    );
    await flush();
    expect(spies.submitGameScore).not.toHaveBeenCalled();

    // Back out and return to Events: the captured round is waiting there.
    act(() => back());
    await flush();
    click(screen.getByRole('tab', { name: /Events/ }));
    await flush();
    expect(screen.getByTestId('tourney-pending').textContent).toBe('pending');
    expect(seen.tourneyPending).toMatchObject({ kind: 'tournament', strokes: 12, toPar: 0 });
  });

  // The scenario code review called out: the round FINISHES, the result is
  // captured correctly (that part is already fixed), and the player backs out of
  // the celebration instead of tapping Menu. Capturing the result and resetting
  // the intent are independent — the old code did the first and not the second,
  // so the next Course selection relaunched the synthesized 3-hole course.
  it('does not relaunch the synthesized course after a COMPLETED tournament round', async () => {
    mount();
    click(screen.getByRole('tab', { name: /Arena/ }));
    await flush();
    click(screen.getByRole('tab', { name: /Events/ }));
    click(screen.getByText('enter event'));
    await flush();

    act(() =>
      seen.course?.onRoundComplete?.({
        courseId: 'tourney-3',
        holes: 3,
        strokes: 11,
        par: 12,
        toPar: -1,
      }),
    );
    await flush();

    act(() => back());
    await flush();

    // The next normal round is the player's own pick, played as a single hole.
    await pick('hole 12');
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    expect(screen.getByTestId('seed').textContent).toBe('undefined');
    expect(channels()).toBe('-/round');

    // ...and the captured event round is STILL waiting to be submitted: the reset
    // does not throw the score away.
    act(() => back());
    await flush();
    click(screen.getByRole('tab', { name: /Arena/ }));
    click(screen.getByRole('tab', { name: /Events/ }));
    await flush();
    expect(seen.tourneyPending).toMatchObject({ kind: 'tournament', strokes: 11, toPar: -1 });
  });

  // The second exit that does not call onExit: the guarded free screen's LEAVE
  // arm (second back press). Once the pause sheet is wired, "End round" reaches
  // the menu the same way. The reset must not depend on onExit AT ALL.
  it('resets the intent when the GUARDED leave arm exits without onExit', async () => {
    flow.guarded = true;
    mount();
    await playDaily();
    expect(screen.getByTestId('seed').textContent).toBe('4242');

    // First back press: the guard escalates — the round is FROZEN, not left, so
    // the intent is still live at this point.
    act(() => back());
    await flush();
    expect(screen.getByTestId('course')).toBeTruthy();

    // Second back press: the leave arm. Menu, and no onExit anywhere.
    act(() => back());
    await flush();
    expect(screen.queryByTestId('course')).toBeNull();

    await pick('hole 12');
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    expect(screen.getByTestId('seed').textContent).toBe('undefined');
    expect(channels()).toBe('-/round');
  });

  it('cannot be daily AND tournament at once — the second start replaces the first', async () => {
    mount();
    await playDaily();
    act(() => back());
    await flush();

    // Straight into an event, with the daily never "closed".
    click(screen.getByRole('tab', { name: /Arena/ }));
    click(screen.getByRole('tab', { name: /Events/ }));
    click(screen.getByText('enter event'));
    await flush();

    expect(screen.getByTestId('course').textContent).toBe('tourney-3');
    expect(screen.getByTestId('seed').textContent).toBe('555');
    // The daily's per-hole channel is GONE: a tournament hole cannot be filed as
    // today's daily attempt.
    expect(channels()).toBe('-/round');
  });
});

describe('GolfScreen — a finished daily result survives leaving the tab', () => {
  it('POSTs exactly once across a remount, and only clears when the POST resolves', async () => {
    const d = deferred<{
      today: { strokes: number; toPar: number; score: number };
      streak: { current: number; best: number };
      improved: boolean;
    }>();
    spies.postDailyResult.mockReturnValue(d.promise);

    mount();
    await playDaily();
    act(() =>
      seen.course?.onHoleComplete?.({
        courseId: 'augusta',
        hole: 7,
        strokes: 4,
        par: 4,
        toPar: 0,
      }),
    );
    await flush();

    // Back out; the Daily tab is showing again, so the POST goes out — and hangs.
    act(() => back());
    await flush();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(1);
    expect(spies.postDailyResult).toHaveBeenCalledWith({ strokes: 4, toPar: 0 });

    // The player switches tabs mid-request. THE BUG: this used to drop the score
    // on the floor. Now the record outlives the unmount, the next mount opens on
    // the tab that owns it — and must NOT fire a second request for it.
    cleanup();
    mount();
    await flush();
    expect(screen.getByRole('button', { name: /Play today/ })).toBeTruthy();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(1);

    // The request lands. NOW the record may go.
    await act(async () => {
      d.resolve({
        today: { strokes: 4, toPar: 0, score: 100 },
        streak: { current: 4, best: 5 },
        improved: true,
      });
    });
    await flush();

    cleanup();
    mount();
    await flush();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(1);
  });

  it('retries on the next mount when the POST fails, then stops once it lands', async () => {
    spies.postDailyResult.mockRejectedValueOnce(new Error('offline'));

    mount();
    await playDaily();
    act(() =>
      seen.course?.onHoleComplete?.({
        courseId: 'augusta',
        hole: 7,
        strokes: 5,
        par: 4,
        toPar: 1,
      }),
    );
    await flush();
    act(() => back());
    await flush();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(1);
    // The failure is SHOWN, not swallowed, and the record is still pending.
    expect(screen.getByText(/Couldn’t submit/)).toBeTruthy();

    // A later visit picks it up again (the failed attempt released its claim).
    cleanup();
    mount();
    await flush();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(2);
    expect(spies.postDailyResult).toHaveBeenLastCalledWith({ strokes: 5, toPar: 1 });

    // Landed → cleared → no third attempt.
    cleanup();
    mount();
    await flush();
    expect(spies.postDailyResult).toHaveBeenCalledTimes(2);
  });
});
