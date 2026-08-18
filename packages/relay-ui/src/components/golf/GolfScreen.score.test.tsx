// @vitest-environment jsdom
//
// A REJECTED `submitGameScore` MUST NOT LOSE THE LEADERBOARD ENTRY.
//
// All three of GolfScreen's board submits — Mini-Golf, the range Target
// Challenge and a full Course round — were
// `api.submitGameScore(...).catch(() => undefined)`. Partly mitigated:
// `recordGolfGame`/`recordRangeGame` write the LOCAL personal best first, so a
// personal best survived. The board entry did not, and the exactly-once ref in
// each effect meant it was never retried on that mount either — so a rejected
// POST discarded the round's ranked result outright. A full 18 is the most
// expensive thing a player can lose.
//
// ⚠ THE REJECTION IS THE PRIMARY CASE. Each test drives a FAILING POST and then
// asserts the entry comes back on the NEXT mount. The resolved arm is asserted
// once, at the end.
//
// Assertions are on what reaches `api` across a real unmount/remount of the real
// screen — not on the queue module's own bookkeeping.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GolfScreen } from './GolfScreen';

const spies = vi.hoisted(() => ({
  getDaily: vi.fn(),
  getDailyLeaderboard: vi.fn(),
  getTournament: vi.fn(),
  submitGameScore: vi.fn(),
  postDailyResult: vi.fn(),
  postTournamentResult: vi.fn(),
  getGameLeaderboard: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: spies }));

// Mini-golf, reduced to "finish a 3-hole partial round".
vi.mock('./GolfGame', () => ({
  GolfGame: (p: { onFinish: (r: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        p.onFinish({
          score: 1200,
          roundsPlayed: 3,
          bestStreak: 2,
          perHole: [
            { hole: 1, par: 3, strokes: 2, sunk: true },
            { hole: 2, par: 3, strokes: 3, sunk: true },
            { hole: 3, par: 3, strokes: 4, sunk: true },
          ],
        })
      }
    >
      finish putt
    </button>
  ),
}));

// A full Course round, reported through onRoundComplete (the real trigger: the
// final hole being CARDED, not a button).
vi.mock('./CourseGame', () => ({
  default: (p: { onRoundComplete?: (r: unknown) => void }) =>
    p.onRoundComplete ? (
      <button
        type="button"
        onClick={() => p.onRoundComplete!({ courseId: 'augusta', holes: 18, toPar: -2 })}
      >
        card last hole
      </button>
    ) : null,
}));

vi.mock('./GolfMenu', () => ({
  GolfMenu: ({ onStart }: { onStart: (m: string, a?: string) => void }) => (
    <div>
      <button type="button" onClick={() => onStart('putt', 'garden')}>
        play mini golf
      </button>
      <button type="button" onClick={() => onStart('course', 'augusta')}>
        play full round
      </button>
    </div>
  ),
}));

vi.mock('./RangeGame', () => ({ RangeGame: () => null }));
vi.mock('./GolfDaily', () => ({ GolfDaily: () => null }));
vi.mock('./GolfTournaments', () => ({ GolfTournaments: () => null }));
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
    useGolfCosmetics: () => ({}),
  };
});

beforeEach(() => {
  localStorage.clear();
  // Fresh id space per test — see ChallengeCard.test.tsx.
  localStorage.setItem('relay.golfPendingSeq', String(Math.floor(Math.random() * 1e6) + 1e6));
  for (const s of Object.values(spies)) s.mockReset();
  spies.getDaily.mockRejectedValue(new Error('no'));
  spies.getTournament.mockRejectedValue(new Error('no'));
  spies.getGameLeaderboard.mockResolvedValue({ entries: [] });
});

afterEach(cleanup);

function mount() {
  return render(
    <MemoryRouter initialEntries={['/games']}>
      <GolfScreen onExitToHub={() => undefined} />
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => undefined);
}

function click(label: string) {
  act(() => (screen.getByText(label) as HTMLElement).click());
}

/** Every `submitGameScore` body seen so far. */
function bodies() {
  return spies.submitGameScore.mock.calls.map((c) => c[0]);
}

describe('GolfScreen — a rejected board submit is retried, not lost', () => {
  it('⚠ MINI-GOLF: a rejected score comes back on the next mount', async () => {
    spies.submitGameScore.mockRejectedValue(new Error('500'));

    const first = mount();
    await flush();
    click('play mini golf');
    click('finish putt');
    await flush();

    expect(bodies()).toEqual([
      { score: 1200, rounds: 3, bestStreak: 2, game: 'golf', toPar: 0 },
    ]);
    first.unmount();

    // The player comes back to golf. Nothing survives but what was persisted.
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 1200 });
    mount();
    await flush();

    expect(bodies()).toHaveLength(2);
    expect(bodies()[1]).toEqual(bodies()[0]);
  });

  it('⚠ COURSE: a rejected FULL ROUND comes back on the next mount', async () => {
    spies.submitGameScore.mockRejectedValue(new Error('offline'));

    const first = mount();
    await flush();
    click('play full round');
    click('card last hole');
    await flush();

    const round = {
      game: 'golfcourse',
      course: 'augusta',
      toPar: -2,
      rounds: 18,
      bestStreak: 0,
      score: 0,
    };
    expect(bodies()).toEqual([round]);
    first.unmount();

    spies.submitGameScore.mockResolvedValue({ ok: true, best: 0 });
    mount();
    await flush();

    expect(bodies()).toEqual([round, round]);
  });

  it('⚠ the retry stops once it lands — a third mount re-sends nothing', async () => {
    spies.submitGameScore.mockRejectedValueOnce(new Error('500'));

    const first = mount();
    await flush();
    click('play mini golf');
    click('finish putt');
    await flush();
    first.unmount();

    spies.submitGameScore.mockResolvedValue({ ok: true, best: 1200 });
    const second = mount();
    await flush();
    expect(bodies()).toHaveLength(2);
    second.unmount();

    mount();
    await flush();
    expect(bodies()).toHaveLength(2);
  });

  it('sanity: a resolved submit is sent once and never repeated', async () => {
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 1200 });

    const first = mount();
    await flush();
    click('play mini golf');
    click('finish putt');
    await flush();
    expect(bodies()).toHaveLength(1);
    first.unmount();

    mount();
    await flush();
    expect(bodies()).toHaveLength(1);
  });
});
