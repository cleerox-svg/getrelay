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
// ⚠ AND `onExit` IS NOT THE ONLY EXIT. The multi-hole sessions — a full Course
// round and the 3-hole tournament — now enter through `startFreeGuarded()`, whose
// LEAVE arm (the second back press) also reaches the menu WITHOUT the child's
// `onExit`. So the reset cannot live in an exit callback at all: it lives at the
// top of `startGolf()`, on the ENTRY side, where every launch must pass.
//
// WHICH SESSIONS ARE GUARDED IS ITSELF PINNED HERE (the "back-press count"
// tests), because it is a safety property, not a preference: guarding a session
// with nothing to bank costs a confirm tap for no reason, and NOT guarding one
// that cards means a single back press destroys holes the player played.
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
const inRound = () => screen.queryByTestId('course') != null;

/**
 * Leave the running round by back gesture ONLY — never through `onExit`.
 * An UNGUARDED session goes in one press; a GUARDED one takes two (the first
 * freezes it and raises the pause sheet), and the count is asserted, since which
 * sessions are guarded is the safety property under test.
 */
async function leaveByBack(expect2: boolean) {
  act(() => back());
  await flush();
  expect(inRound()).toBe(expect2);
  if (expect2) {
    act(() => back());
    await flush();
    expect(inRound()).toBe(false);
  }
}

beforeEach(() => {
  localStorage.clear();
  for (const s of Object.values(spies)) s.mockReset();
  spies.getDaily.mockResolvedValue(DAILY);
  spies.getDailyLeaderboard.mockResolvedValue({ entries: [] });
  // No live event → the Arena tab-entry steer stays on Daily. `seed` must match
  // what the GolfTournaments stub launches with (555): it is the event's identity,
  // and a pending round tagged with a DIFFERENT one is evicted as stale.
  spies.getTournament.mockResolvedValue({
    msLeft: 0,
    entry: null,
    entrants: 0,
    holes: [],
    seed: 555,
  });
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

    // Leave WITHOUT onExit. One press: the daily is a single hole, so it is
    // deliberately unguarded (nothing cards, nothing to bank).
    await leaveByBack(false);

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
    await leaveByBack(false);

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

    // GUARDED: three holes and a scorecard, so it takes two presses to leave.
    await leaveByBack(true);

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

    // Back out and return to Events: the captured round is waiting there, tagged
    // with the event it was played on.
    await leaveByBack(true);
    click(screen.getByRole('tab', { name: /Events/ }));
    await flush();
    expect(screen.getByTestId('tourney-pending').textContent).toBe('pending');
    expect(seen.tourneyPending).toMatchObject({
      kind: 'tournament',
      tag: '555',
      strokes: 12,
      toPar: 0,
    });
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

    // Out through the GUARDED leave arm — two presses, and no onExit at either.
    await leaveByBack(true);

    // The next normal round is the player's own pick, played as a single hole.
    await pick('hole 12');
    expect(screen.getByTestId('course').textContent).toBe('augusta');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    expect(screen.getByTestId('seed').textContent).toBe('undefined');
    expect(channels()).toBe('-/round');

    // ...and the captured event round is STILL waiting to be submitted: the reset
    // does not throw the score away.
    await leaveByBack(false);
    click(screen.getByRole('tab', { name: /Arena/ }));
    click(screen.getByRole('tab', { name: /Events/ }));
    await flush();
    expect(seen.tourneyPending).toMatchObject({ kind: 'tournament', strokes: 11, toPar: -1 });
  });

  it('cannot be daily AND tournament at once — the second start replaces the first', async () => {
    mount();
    await playDaily();
    await leaveByBack(false);

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

// WHICH sessions declare unsaved progress. `startFreeGuarded()` buys a two-press
// exit (press 1 freezes the round and raises the pause sheet, press 2 banks the
// carded holes and leaves); `startFree()` leaves in one. Getting this wrong is a
// bug in EITHER direction, so both are pinned, by press count.
describe('GolfScreen — only a session that can lose holes is guarded', () => {
  it('guards a FULL Course round — one back press must not destroy it', async () => {
    mount();
    await pick('full round');
    expect(screen.getByTestId('startHole').textContent).toBe('undefined');
    // Press 1: still in the round (frozen, sheet up — see GolfScreen.pause.test).
    await leaveByBack(true);
  });

  it('does NOT guard single-hole Course play — nothing cards, so one press exits', async () => {
    mount();
    await pick('hole 12');
    expect(screen.getByTestId('startHole').textContent).toBe('11');
    await leaveByBack(false);
  });

  it('does NOT guard the daily — one hole, no card, and the entry is not spent', async () => {
    mount();
    await playDaily();
    await leaveByBack(false);
  });

  it('guards the 3-hole tournament round', async () => {
    mount();
    click(screen.getByRole('tab', { name: /Arena/ }));
    await flush();
    click(screen.getByRole('tab', { name: /Events/ }));
    click(screen.getByText('enter event'));
    await flush();
    await leaveByBack(true);
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
    await leaveByBack(false);
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
    await leaveByBack(false);
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

  // ⚠ THE HAZARD PERSISTENCE INTRODUCED, which losing the result did not have: a
  // record can now outlive the CHALLENGE it was played on. The endpoints take
  // only {strokes,toPar} and file against whatever is current, so a score played
  // yesterday and stranded offline would land on TODAY's board — polluting a day
  // the player never played, which is worse than the score being absent.
  it('never submits a result played on an EARLIER challenge, and evicts it', async () => {
    spies.postDailyResult.mockRejectedValue(new Error('offline'));

    mount();
    await playDaily();
    act(() =>
      seen.course?.onHoleComplete?.({
        courseId: 'augusta',
        hole: 7,
        strokes: 2,
        par: 4,
        toPar: -2,
      }),
    );
    await flush();
    // Stranded: the POST fails, so the record stays pending.
    await leaveByBack(false);
    expect(spies.postDailyResult).toHaveBeenCalledTimes(1);

    // Midnight passes. A NEW challenge is live, with a different seed.
    spies.postDailyResult.mockClear();
    spies.getDaily.mockResolvedValue({ ...DAILY, date: '2026-08-18', hole: 3, seed: 777 });

    cleanup();
    mount();
    // The record is still in the slot at mount, so the hub still opens on its
    // tab; the eviction happens when the fetch reveals the new seed.
    expect(screen.queryByText('pick hole 12')).toBeNull();
    await flush();
    // That −2 is NOT filed against the new day...
    expect(spies.postDailyResult).not.toHaveBeenCalled();

    // ...and it is GONE rather than merely skipped. Observable without reaching
    // into storage: a pending record steers the OPENING tab to Arena, so once it
    // is evicted the hub opens on Play again. (Skipping without evicting leaves a
    // dead record that hijacks the opening tab forever.)
    cleanup();
    mount();
    expect(screen.getByText('pick hole 12')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Play today/ })).toBeNull();
    await flush();
    expect(spies.postDailyResult).not.toHaveBeenCalled();
    // The new day's hole is still playable, and plays as a daily.
    await playDaily();
    expect(screen.getByTestId('startHole').textContent).toBe('2');
    expect(screen.getByTestId('seed').textContent).toBe('777');
    expect(channels()).toBe('hole/-');
  });
});
