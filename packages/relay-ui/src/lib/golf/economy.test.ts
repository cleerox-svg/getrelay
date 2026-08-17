// Regression suite for the golf economy store's LOADING states.
//
// THE BUG THIS PINS. `ensure*()` used to mark a slice loaded in the catch arm:
//
//     catch { set({ walletLoaded: true }); }   // balance stays null
//
// so one failed /economy/wallet made a 670-coin wallet indistinguishable from
// an empty one, permanently — the `if (loaded) return` guard never retried for
// the rest of the session — and the shop rendered "Need more coins" on every
// item. `ensureCosmetics` had the same shape, which is why a purchased,
// equipped ball skin stopped applying. Every test below fails if a failed fetch
// is allowed to look like a successful one again.
//
// MUTATIONS WATCHED TO FAIL against this file (failures in THIS file):
//   1. wallet catch arm → `set({ walletState: 'ready' })`             → 5 fail
//   2. cosmetics catch arm → `set({ cosmeticsState: 'ready' })`       → 1 fail
//   3. season catch arm → `set({ seasonState: 'ready' })`             → 1 fail
//   4. the ensure guard made sticky again — `walletState !== 'idle'`  → 1 fail
//   5. `affordability()` → `balance != null && balance >= price`      → 1 fail
//   6. `withTimeout()` reduced to a pass-through (test times out)     → 1 fail
//   7. `share()`'s in-flight dedupe removed                           → 1 fail

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const getWallet = vi.fn();
const getCosmetics = vi.fn();
const getSeason = vi.fn();
const purchaseCosmetic = vi.fn();

vi.mock('../api', () => {
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
      purchaseCosmetic: (...a: unknown[]) => purchaseCosmetic(...a),
    },
  };
});

const { useEconomy, affordability, __resetEconomyInFlight } = await import('./economy');
const { GOLF_FETCH_TIMEOUT_MS } = await import('./loadState');

const WALLET = {
  balance: 670,
  ledger: [{ delta: 25, reason: 'round_reward', ref: null, balanceAfter: 670, createdAt: 1 }],
};
const CATALOG = {
  catalog: [
    {
      id: 'ball_sunset',
      slot: 'ball' as const,
      name: 'Sunset',
      rarity: 'rare' as const,
      price: 200,
      visual: { color: '#f80' },
    },
  ],
  owned: ['frame_bronze'],
  equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_bronze' },
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ensureWallet — a failed fetch is not a loaded wallet', () => {
  it('lands in error, NOT ready, when the fetch rejects', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet();

    const st = useEconomy.getState();
    expect(st.walletState).toBe('error');
    // The whole point: nothing in the store may claim the wallet is known.
    expect(st.walletState).not.toBe('ready');
    expect(st.balance).toBeNull();
  });

  it('RETRIES after a failure — the failure is not sticky for the session', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet();
    expect(useEconomy.getState().walletState).toBe('error');

    // No `force`: a plain ensure() from the next mount must refetch.
    getWallet.mockResolvedValueOnce(WALLET);
    await useEconomy.getState().ensureWallet();

    expect(getWallet).toHaveBeenCalledTimes(2);
    expect(useEconomy.getState().walletState).toBe('ready');
    expect(useEconomy.getState().balance).toBe(670);
  });

  it('does not refetch once ready', async () => {
    getWallet.mockResolvedValue(WALLET);
    await useEconomy.getState().ensureWallet();
    await useEconomy.getState().ensureWallet();
    expect(getWallet).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    getWallet.mockResolvedValue(WALLET);
    const a = useEconomy.getState().ensureWallet();
    const b = useEconomy.getState().ensureWallet();
    await Promise.all([a, b]);
    expect(getWallet).toHaveBeenCalledTimes(1);
    expect(useEconomy.getState().balance).toBe(670);
  });

  it('keeps a known balance when a forced REFRESH fails', async () => {
    getWallet.mockResolvedValueOnce(WALLET);
    await useEconomy.getState().ensureWallet();

    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet(true);

    const st = useEconomy.getState();
    expect(st.walletState).toBe('error'); // surfaced…
    expect(st.balance).toBe(670); // …but the last good balance survives.
  });

  it('times out a hung request into a retryable error', async () => {
    vi.useFakeTimers();
    getWallet.mockReturnValueOnce(new Promise(() => {})); // never settles
    const p = useEconomy.getState().ensureWallet();
    await vi.advanceTimersByTimeAsync(GOLF_FETCH_TIMEOUT_MS + 1);
    await p;
    expect(useEconomy.getState().walletState).toBe('error');
  });

  it('is loading, not ready and not error, while in flight', async () => {
    let release: (v: unknown) => void = () => undefined;
    getWallet.mockReturnValueOnce(new Promise((res) => (release = res)));
    const p = useEconomy.getState().ensureWallet();
    await Promise.resolve();
    expect(useEconomy.getState().walletState).toBe('loading');
    release(WALLET);
    await p;
    expect(useEconomy.getState().walletState).toBe('ready');
  });
});

describe('ensureCosmetics / ensureSeason — same rule', () => {
  it('a failed cosmetics fetch does not claim an empty catalog is the truth', async () => {
    getCosmetics.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureCosmetics();

    const st = useEconomy.getState();
    expect(st.cosmeticsState).toBe('error');
    expect(st.cosmeticsState).not.toBe('ready');
    // "owned: []" here means UNKNOWN. If this were 'ready' the shop would show a
    // purchased, equipped skin as un-owned — the reported "skins don't work".
    expect(st.owned).toEqual([]);

    getCosmetics.mockResolvedValueOnce(CATALOG);
    await useEconomy.getState().ensureCosmetics();
    expect(useEconomy.getState().cosmeticsState).toBe('ready');
    expect(useEconomy.getState().owned).toEqual(['frame_bronze']);
    expect(useEconomy.getState().equipped.frame).toBe('frame_bronze');
  });

  it('a failed season fetch is retryable', async () => {
    getSeason.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureSeason();
    expect(useEconomy.getState().seasonState).toBe('error');

    getSeason.mockResolvedValueOnce({
      xp: 10,
      currentTier: 1,
      tiers: [],
      claimed: [],
      claimable: [],
      endsAt: 0,
    });
    await useEconomy.getState().ensureSeason();
    expect(useEconomy.getState().seasonState).toBe('ready');
    expect(useEconomy.getState().season?.xp).toBe(10);
  });
});

describe('purchase', () => {
  it('takes the server balance as authoritative even after a failed wallet load', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet();
    expect(useEconomy.getState().walletState).toBe('error');

    purchaseCosmetic.mockResolvedValueOnce({ balance: 470 });
    getWallet.mockResolvedValue({ ...WALLET, balance: 470 });
    await useEconomy.getState().purchase('ball_sunset');

    // The read-after-write balance lands immediately…
    expect(useEconomy.getState().balance).toBe(470);
    expect(useEconomy.getState().owned).toContain('ball_sunset');
    // …and the best-effort ledger refresh purchase() kicks off settles ready.
    await vi.waitFor(() => expect(useEconomy.getState().walletState).toBe('ready'));
    expect(useEconomy.getState().balance).toBe(470);
  });
});

describe('affordability — three answers, never two', () => {
  it('an UNKNOWN balance is not "cannot afford"', () => {
    expect(affordability(null, 200)).toBe('unknown');
    expect(affordability(null, 200)).not.toBe('no');
  });

  it('reports yes/no against a known balance', () => {
    expect(affordability(670, 200)).toBe('yes');
    expect(affordability(200, 200)).toBe('yes'); // exact price is affordable
    expect(affordability(199, 200)).toBe('no');
    expect(affordability(0, 200)).toBe('no');
  });
});
