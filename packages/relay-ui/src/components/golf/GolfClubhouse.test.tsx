// @vitest-environment jsdom
//
// THE CLUBHOUSE MUST NOT REPORT A FAILED FETCH AS AN EMPTY LIFE.
//
// Same defect class as GolfShop.test.tsx, on the other three Clubhouse panels.
// Each of them had exactly one bit for two facts, and every one of them
// resolved that bit in the direction that lies to the player:
//
//   GolfWallet   — a failed wallet fetch → "No coin activity yet — play rounds
//                  to earn." to a player with a ledger of round payouts.
//   GolfSeason   — a failed season fetch → "No active season", hiding a live
//                  track with claimable tiers and offering no way to retry.
//   GolfProfile  — all five stat requests failing → "No rounds yet. Play your
//                  first round to start your card." to a player with a history.
//
// The assertions are deliberately two-sided: the honest error must appear AND
// the false empty-state copy must not, because "render an error instead" is
// only half of the fix — a screen that shows both still tells the player their
// coins are gone.
//
// MUTATIONS WATCHED TO FAIL against this file (failures in THIS file):
//   1. economy.ts wallet catch arm → `set({ walletState: 'ready' })`   → 1 fail
//   2. economy.ts season catch arm → `set({ seasonState: 'ready' })`   → 1 fail
//   3. GolfProfile's `allFailed` branch removed                        → 1 fail
//   4. GolfProfile's `failures === requests.length` → `failures > 0`   → 1 fail

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getWallet = vi.fn();
const getCosmetics = vi.fn();
const getSeason = vi.fn();
const getGolfStats = vi.fn();
const getGolfRecords = vi.fn();
const getTournamentMe = vi.fn();

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
      getWallet: (...a: unknown[]) => getWallet(...a),
      getCosmetics: (...a: unknown[]) => getCosmetics(...a),
      getSeason: (...a: unknown[]) => getSeason(...a),
      getGolfStats: (...a: unknown[]) => getGolfStats(...a),
      getGolfRecords: (...a: unknown[]) => getGolfRecords(...a),
      getTournamentMe: (...a: unknown[]) => getTournamentMe(...a),
      purchaseCosmetic: vi.fn(),
      equipCosmetic: vi.fn(),
      claimSeasonTier: vi.fn(),
    },
  };
});

vi.mock('../../lib/store', () => {
  const state = { me: { displayName: 'Tester', pin: 'AB12CD34' } };
  return { useStore: (sel: (s: typeof state) => unknown) => sel(state) };
});

const { GolfWallet } = await import('./GolfWallet');
const { GolfSeason } = await import('./GolfSeason');
const { GolfProfile } = await import('./GolfProfile');
const { useEconomy, __resetEconomyInFlight } = await import('../../lib/golf/economy');

const LEDGER = [
  { delta: 25, reason: 'round_reward', ref: null, balanceAfter: 670, createdAt: Date.now() },
];
const EMPTY_STATS = {
  game: 'golfcourse' as const,
  gamesPlayed: 0,
  best: null,
  average: null,
  bestStreak: null,
  lastPlayed: null,
  handicap: null,
  perCourse: [],
  recent: [],
};

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
  getCosmetics.mockResolvedValue({
    catalog: [],
    owned: [],
    equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_none' },
  });
});

afterEach(() => cleanup());

describe('GolfWallet', () => {
  it('reports an unreachable wallet instead of "no coin activity"', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    render(<GolfWallet />);

    await screen.findByText('Couldn’t reach your wallet.');
    expect(screen.queryByText(/No coin activity yet/)).toBeNull();

    getWallet.mockResolvedValueOnce({ balance: 670, ledger: LEDGER });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Round payout');
    expect(screen.getByText('670')).toBeTruthy();
  });

  it('still reports a genuinely empty ledger as no activity', async () => {
    getWallet.mockResolvedValue({ balance: 0, ledger: [] });
    render(<GolfWallet />);
    await screen.findByText(/No coin activity yet/);
  });
});

describe('GolfSeason', () => {
  it('reports an unreachable season instead of "no active season"', async () => {
    getSeason.mockRejectedValueOnce(new Error('offline'));
    getWallet.mockResolvedValue({ balance: 670, ledger: [] });
    render(<GolfSeason />);

    await screen.findByText('The season track needs a connection.');
    expect(screen.queryByText(/No active season/)).toBeNull();

    getSeason.mockResolvedValueOnce({
      xp: 120,
      currentTier: 2,
      tiers: [{ tier: 1, xpRequired: 100, reward: { coins: 50 } }],
      claimed: [],
      claimable: [1],
      endsAt: Date.now() + 86_400_000,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Claim' });
  });
});

describe('GolfProfile', () => {
  it('reports a card that could not load instead of "no rounds yet"', async () => {
    getGolfStats.mockRejectedValue(new Error('offline'));
    getGolfRecords.mockRejectedValue(new Error('offline'));
    getTournamentMe.mockRejectedValue(new Error('offline'));
    getWallet.mockRejectedValue(new Error('offline'));
    render(<GolfProfile />);

    await screen.findByText('Couldn’t load your card.');
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
  });

  it('still reports a real newcomer as having no rounds', async () => {
    getGolfStats.mockResolvedValue(EMPTY_STATS);
    getGolfRecords.mockResolvedValue({ records: {} });
    getTournamentMe.mockResolvedValue({ trophies: null, placements: [] });
    getWallet.mockResolvedValue({ balance: 0, ledger: [] });
    render(<GolfProfile />);

    await screen.findByText('No rounds yet.');
    expect(screen.queryByText(/Couldn’t load your card/)).toBeNull();
  });

  it('renders the card when SOME requests fail but one answers', async () => {
    // A partial failure is not a failed card — the panels that answered still
    // carry real numbers, so it must not be swallowed into the error state.
    getGolfStats.mockResolvedValue({ ...EMPTY_STATS, gamesPlayed: 12, handicap: 4.2 });
    getGolfRecords.mockRejectedValue(new Error('offline'));
    getTournamentMe.mockRejectedValue(new Error('offline'));
    getWallet.mockResolvedValue({ balance: 670, ledger: [] });
    render(<GolfProfile />);

    await waitFor(() => expect(screen.queryByText('Course rounds')).toBeTruthy());
    expect(screen.queryByText(/Couldn’t load your card/)).toBeNull();
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
  });
});
