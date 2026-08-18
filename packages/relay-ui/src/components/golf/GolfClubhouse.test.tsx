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
//   1. economy.ts wallet catch arm → `set({ walletState: 'ready' })`
//                                                       → 2 fail (+7 economy)
//   2. economy.ts season catch arm → `set({ seasonState: 'ready' })`
//                                                       → 1 fail (+1 economy)
//   3. GolfProfile's error branch removed                              → 4 fail
//   4. GolfProfile's `failures > 0` → `failures === requests.length`
//      (the SHIPPED code, and the live defect: the three getGolfStats calls
//      failing while getGolfRecords / getTournamentMe answer empty rendered
//      "No rounds yet" to a player with a full history)                → 2 fail
//   5. GolfProfile's `anyFailed && !hasAnything` → `anyFailed` (the OTHER
//      direction: a partial failure buries a card that has real numbers on it)
//                                                                      → 1 fail
//   6. GolfWallet's stale-ledger LoadFailureLine (GolfWallet.tsx:56) replaced
//      with `false`                                                    → 1 fail
//   7. `isFirstLoad` → `s === 'idle'` (loadState.ts) — the wallet flashes "No
//      coin activity yet" and the season "No active season" on every mount
//                                                                      → 2 fail
//   8. `withTimeout` reduced to a pass-through — a hung card request stays a
//      spinner forever                                                 → 1 fail

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
const { GOLF_FETCH_TIMEOUT_MS } = await import('../../lib/golf/loadState');

// Each Retry is addressed by what it retries — "Retry" alone named every retry
// in the hub, and a screen can show two.
function retry(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('GolfWallet', () => {
  it('reports an unreachable wallet instead of "no coin activity"', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    render(<GolfWallet />);

    await screen.findByText('Couldn’t reach your wallet.');
    expect(screen.queryByText(/No coin activity yet/)).toBeNull();

    getWallet.mockResolvedValueOnce({ balance: 670, ledger: LEDGER });
    fireEvent.click(retry('Retry loading your wallet'));

    await screen.findByText('Round payout');
    expect(screen.getByText('670')).toBeTruthy();
  });

  it('reports a STALE ledger as a line, keeping the rows it already has', async () => {
    // The wallet loaded, then a refresh failed. The panel would hide a ledger
    // the player can still read, so this is the LINE variant — and nothing
    // asserted it: replacing the condition with `false` passed 26/26.
    useEconomy.setState({ balance: 670, ledger: LEDGER, walletState: 'error' });
    getWallet.mockRejectedValueOnce(new Error('offline'));

    render(<GolfWallet />);
    await screen.findByText('Couldn’t refresh your wallet.');
    expect(screen.getByText('Round payout')).toBeTruthy();
    // Not the whole-panel copy (which would blank the ledger), and above all
    // not the false empty state.
    expect(screen.queryByText('Couldn’t reach your wallet.')).toBeNull();
    expect(screen.queryByText(/No coin activity yet/)).toBeNull();

    getWallet.mockResolvedValueOnce({ balance: 670, ledger: LEDGER });
    fireEvent.click(retry('Retry loading your wallet'));
    await waitFor(() => expect(screen.queryByText('Couldn’t refresh your wallet.')).toBeNull());
    expect(screen.getByText('Round payout')).toBeTruthy();
  });

  it('says nothing about a wallet that is fine', async () => {
    getWallet.mockResolvedValue({ balance: 670, ledger: LEDGER });
    render(<GolfWallet />);
    await screen.findByText('Round payout');
    expect(screen.queryByText('Couldn’t refresh your wallet.')).toBeNull();
    expect(screen.queryByText('Couldn’t reach your wallet.')).toBeNull();
  });

  it('shows the loading copy — never "no coin activity" — while the first fetch is in flight', async () => {
    // Asserted SYNCHRONOUSLY, because the frame is transient: every polling
    // assertion in this file races past it, which is why mutating isFirstLoad
    // to `s === 'idle'` failed 0 tests while flashing this copy on every mount.
    getWallet.mockReturnValue(new Promise(() => {}));
    render(<GolfWallet />);
    expect(screen.getByText('Loading your wallet…')).toBeTruthy();
    expect(screen.queryByText(/No coin activity yet/)).toBeNull();
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
    fireEvent.click(retry('Retry loading the season track'));
    await screen.findByRole('button', { name: 'Claim' });
  });

  it('shows the loading copy — never "no active season" — while the first fetch is in flight', async () => {
    getSeason.mockReturnValue(new Promise(() => {}));
    getWallet.mockReturnValue(new Promise(() => {}));
    render(<GolfSeason />);
    expect(screen.getByText('Loading the season…')).toBeTruthy();
    expect(screen.queryByText(/No active season/)).toBeNull();
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

  it('⚠ reports UNKNOWN when only SOME requests fail and the rest answer EMPTY', async () => {
    // THE LIVE DEFECT, and the reviewer's probe verbatim. The first fix only
    // caught 5-of-5 failures, so the three getGolfStats calls failing while
    // getGolfRecords / getTournamentMe answered empty still rendered "No rounds
    // yet. Play your first round." to a player with a full history — no error,
    // no retry. An empty answer from two endpoints does not prove a life.
    getGolfStats.mockRejectedValue(new Error('offline'));
    getGolfRecords.mockResolvedValue({ records: {} });
    getTournamentMe.mockResolvedValue({ trophies: null, placements: [] });
    getWallet.mockResolvedValue({ balance: 670, ledger: [] });
    render(<GolfProfile />);

    await screen.findByText('Couldn’t load your card.');
    expect(screen.queryByText(/No rounds yet/)).toBeNull();

    // …and the Retry that #266 landed actually recovers the history.
    getGolfStats.mockResolvedValue({ ...EMPTY_STATS, gamesPlayed: 12, handicap: 4.2 });
    fireEvent.click(retry('Retry loading your card'));
    await screen.findByText('Course rounds');
    expect(screen.queryByText(/Couldn’t load your card/)).toBeNull();
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
  });

  it('reports UNKNOWN when a SINGLE request fails and the others answer empty', async () => {
    // The smallest version of the same fact: the records endpoint alone failing
    // is enough that "no rounds yet" is not something we know.
    getGolfStats.mockResolvedValue(EMPTY_STATS);
    getGolfRecords.mockRejectedValue(new Error('offline'));
    getTournamentMe.mockResolvedValue({ trophies: null, placements: [] });
    getWallet.mockResolvedValue({ balance: 0, ledger: [] });
    render(<GolfProfile />);

    await screen.findByText('Couldn’t load your card.');
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
  });

  it('turns a HUNG card request into a retryable error, not a permanent spinner', async () => {
    // Three of the four withTimeout call sites added by #266 were unpinned;
    // this is GolfProfile's. Without the timeout the card sits on "Loading your
    // card…" forever, which is the state the convention exists to forbid.
    vi.useFakeTimers();
    getGolfStats.mockReturnValue(new Promise(() => {}));
    getGolfRecords.mockReturnValue(new Promise(() => {}));
    getTournamentMe.mockReturnValue(new Promise(() => {}));
    getWallet.mockReturnValue(new Promise(() => {}));
    render(<GolfProfile />);

    expect(screen.getByText('Loading your card…')).toBeTruthy();
    // Still loading a millisecond short of the budget — the timeout bounds a
    // hung request, it does not shorten a slow one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GOLF_FETCH_TIMEOUT_MS - 1);
    });
    expect(screen.getByText('Loading your card…')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(screen.getByText('Couldn’t load your card.')).toBeTruthy();
    expect(screen.queryByText(/No rounds yet/)).toBeNull();
    expect(screen.queryByText('Loading your card…')).toBeNull();
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
