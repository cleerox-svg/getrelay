// @vitest-environment jsdom
//
// A HUNG ARENA REQUEST MUST BECOME A RETRYABLE ERROR, NOT A PERMANENT SPINNER.
//
// #266 added four `withTimeout()` call sites outside the economy store and only
// the store's was covered: deleting the timeout from `GolfTournaments`'s event
// or leaderboard fetch, or from `GolfDaily`'s, failed 0 tests, while the screen
// it governs sits on "Loading the live event…" / "Loading today's challenge…"
// forever — no error, no Retry, exactly the state `loadState.ts` exists to
// forbid. A request that never settles is indistinguishable from one still on
// its way, so only the clock can tell them apart.
//
// Both directions on every case: a millisecond BEFORE the budget the screen is
// still loading (the timeout bounds a hung request, it must not shorten a slow
// one), and a millisecond after it is the failure state with its Retry.
//
// MUTATIONS WATCHED TO FAIL against this file (failures in THIS file):
//   1. `withTimeout(api.getTournament())` → `api.getTournament()`      → 1 fail
//   2. `withTimeout(api.getTournamentLeaderboard(s))` → unwrapped      → 1 fail
//   3. `withTimeout(api.getDaily())` → `api.getDaily()`                → 1 fail
//   4. `withTimeout(api.getDailyLeaderboard())` → unwrapped            → 1 fail
//   5. `withTimeout` reduced to a pass-through (loadState.ts)          → 4 fail
//      (all four measured on 2026-08-18 against this file)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const getDaily = vi.fn();
const getDailyLeaderboard = vi.fn();
const getTournament = vi.fn();
const getTournamentLeaderboard = vi.fn();
const getCosmetics = vi.fn();

vi.mock('../../lib/api', () => {
  class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
    ) {
      super(code);
    }
  }
  return {
    ApiError,
    api: {
      getDaily: (...a: unknown[]) => getDaily(...a),
      getDailyLeaderboard: (...a: unknown[]) => getDailyLeaderboard(...a),
      getTournament: (...a: unknown[]) => getTournament(...a),
      getTournamentLeaderboard: (...a: unknown[]) => getTournamentLeaderboard(...a),
      getCosmetics: (...a: unknown[]) => getCosmetics(...a),
      getWallet: vi.fn(),
      getSeason: vi.fn(),
      postDailyResult: vi.fn(),
      postTournamentResult: vi.fn(),
    },
  };
});

const { GolfDaily } = await import('./GolfDaily');
const { GolfTournaments } = await import('./GolfTournaments');
const { useEconomy, __resetEconomyInFlight } = await import('../../lib/golf/economy');
const { GOLF_FETCH_TIMEOUT_MS } = await import('../../lib/golf/loadState');

const NEVER = () => new Promise(() => {});

// Today's challenge, already played — `today` is what makes GolfDaily fetch the
// leaderboard at all.
const DAILY = {
  date: '2026-08-18',
  game: 'golfcourse' as const,
  course: 'augusta',
  hole: 1,
  seed: 4242,
  today: { strokes: 4, toPar: 0, score: 1200 },
  streak: { current: 3, best: 7 },
};

// The live event, already entered — `entry` is what makes GolfTournaments fetch
// the leaderboard.
const TOURNEY = {
  id: 12,
  seed: 99,
  holes: [
    { course: 'augusta', hole: 1 },
    { course: 'augusta', hole: 2 },
    { course: 'augusta', hole: 3 },
  ],
  openedAt: Date.now() - 3_600_000,
  closesAt: Date.now() + 3_600_000,
  msLeft: 3_600_000,
  entrants: 8,
  entry: { score: 1400, toPar: -1, strokes: 11, rank: 2 },
};

/** Advance the fake clock inside act(), so React flushes what the timers cause. */
async function tick(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetEconomyInFlight();
  useEconomy.setState({
    balance: null,
    ledger: [],
    walletState: 'idle',
    catalog: [],
    owned: [],
    equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_none' },
    cosmeticsState: 'idle',
    season: null,
    seasonState: 'idle',
  });
  getCosmetics.mockReturnValue(NEVER());
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GolfDaily', () => {
  it('times a hung challenge fetch out into the needs-connection state', async () => {
    getDaily.mockReturnValue(NEVER());
    render(<GolfDaily onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    expect(screen.getByText('Loading today’s challenge…')).toBeTruthy();
    await tick(GOLF_FETCH_TIMEOUT_MS - 1);
    expect(screen.getByText('Loading today’s challenge…')).toBeTruthy();

    await tick(2);
    expect(screen.getByText('Daily needs a connection.')).toBeTruthy();
    expect(screen.queryByText('Loading today’s challenge…')).toBeNull();
    // The failure is only useful with a way out of it.
    expect(screen.getByRole('button', { name: 'Retry loading today’s challenge' })).toBeTruthy();
  });

  it('times a hung leaderboard fetch out into a retryable line', async () => {
    getDaily.mockResolvedValue(DAILY);
    getDailyLeaderboard.mockReturnValue(NEVER());
    render(<GolfDaily onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    await tick(1);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await tick(GOLF_FETCH_TIMEOUT_MS - 2);
    expect(screen.getByText('Loading…')).toBeTruthy();

    await tick(2);
    expect(screen.getByText(/Couldn’t load the leaderboard\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry loading the leaderboard' })).toBeTruthy();
  });

  it('positive control: a challenge that answers renders, no failure copy', async () => {
    getDaily.mockResolvedValue(DAILY);
    getDailyLeaderboard.mockResolvedValue({ entries: [] });
    render(<GolfDaily onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    await tick(1);
    expect(screen.getByText(/Daily Challenge · 2026-08-18/)).toBeTruthy();
    expect(screen.queryByText('Daily needs a connection.')).toBeNull();
    expect(screen.queryByText(/Couldn’t load the leaderboard\./)).toBeNull();
  });
});

describe('GolfTournaments', () => {
  it('times a hung event fetch out into the needs-connection state', async () => {
    getTournament.mockReturnValue(NEVER());
    render(<GolfTournaments onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    expect(screen.getByText('Loading the live event…')).toBeTruthy();
    await tick(GOLF_FETCH_TIMEOUT_MS - 1);
    expect(screen.getByText('Loading the live event…')).toBeTruthy();

    await tick(2);
    expect(screen.getByText('Tournaments need a connection.')).toBeTruthy();
    expect(screen.queryByText('Loading the live event…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry loading the live event' })).toBeTruthy();
  });

  it('times a hung leaderboard fetch out into a retryable line', async () => {
    getTournament.mockResolvedValue(TOURNEY);
    getTournamentLeaderboard.mockReturnValue(NEVER());
    render(<GolfTournaments onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    await tick(1);
    expect(screen.getByText('Loading…')).toBeTruthy();
    await tick(GOLF_FETCH_TIMEOUT_MS - 2);
    expect(screen.getByText('Loading…')).toBeTruthy();

    await tick(2);
    expect(screen.getByText(/Couldn’t load the leaderboard\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry loading the leaderboard' })).toBeTruthy();
  });

  it('positive control: an event that answers renders, no failure copy', async () => {
    getTournament.mockResolvedValue(TOURNEY);
    getTournamentLeaderboard.mockResolvedValue({ entries: [] });
    render(<GolfTournaments onPlay={vi.fn()} pendingResult={null} onResultConsumed={vi.fn()} />);

    await tick(1);
    expect(screen.queryByText('Tournaments need a connection.')).toBeNull();
    expect(screen.queryByText('Loading the live event…')).toBeNull();
    expect(screen.queryByText(/Couldn’t load the leaderboard\./)).toBeNull();
  });
});
