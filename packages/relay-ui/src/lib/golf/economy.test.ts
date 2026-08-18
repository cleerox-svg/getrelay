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
// MUTATIONS WATCHED TO FAIL against this file (counts are failures in THIS
// file; knock-on counts in the component suites are noted where they exist):
//   1. wallet catch arm → `set({ walletState: 'ready' })`
//                                          → 7 fail (+3 Shop, +2 Clubhouse)
//   2. cosmetics catch arm → `set({ cosmeticsState: 'ready' })`
//                                          → 1 fail (+2 Shop)
//   3. season catch arm → `set({ seasonState: 'ready' })`
//                                          → 1 fail (+1 Clubhouse)
//   4. the ensure guard made sticky again — `walletState !== 'idle'`
//                                          → 2 fail (+2 Shop)
//   5. `affordability()` → `balance != null && balance >= price`
//                                          → 1 fail (+2 Shop)
//   6. `withTimeout()` reduced to a pass-through                      → 1 fail
//   7. `share()`'s in-flight dedupe removed                           → 2 fail
//
// AND the residuals from #266's review, every one of which passed 26/26 before:
//   8. `purchase()`'s `walletState: 'ready'` deleted                  → 1 fail
//   9. `claim()`'s `walletState: 'ready'` deleted                     → 1 fail
//  10. generation guard removed from ensureWallet's SUCCESS arm (a
//      pre-purchase answer reverts the balance and blanks the ledger) → 2 fail
//  11. generation guard removed from ensureWallet's CATCH arm         → 1 fail
//  12. generation guard removed from ensureCosmetics                  → 2 fail
//  13. generation guard removed from ensureSeason                     → 1 fail
//  14. `share()` over-applied — the `force` path also joins an in-flight
//      request (`const running = inFlight[slice]` unconditionally)    → 4 fail
//  15. `purchase()`'s `supersede('cosmetics')` deleted                → 1 fail
//  16. `equip()`'s `supersede('cosmetics')` deleted                   → 2 fail
//  17. `claim()`'s `supersede('season')` deleted                      → 1 fail
//
// ⚠ MEASURED AND REPORTED AS UNKILLABLE: deleting `purchase()`'s or `claim()`'s
// `supersede('wallet')` fails 0 tests, because each issues `ensureWallet(true)`
// in the same tick and `share()` supersedes there anyway. The lines are kept as
// the explicit statement of ownership — a later change that drops the
// best-effort refresh would otherwise silently restore the revert — but nobody
// should believe a test is guarding them.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const getWallet = vi.fn();
const getCosmetics = vi.fn();
const getSeason = vi.fn();
const purchaseCosmetic = vi.fn();
const equipCosmetic = vi.fn();
const claimSeasonTier = vi.fn();

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
      equipCosmetic: (...a: unknown[]) => equipCosmetic(...a),
      claimSeasonTier: (...a: unknown[]) => claimSeasonTier(...a),
    },
  };
});

const { useEconomy, affordability, __resetEconomyInFlight } = await import('./economy');
const { GOLF_FETCH_TIMEOUT_MS } = await import('./loadState');
type LoadStateName = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Record every DISTINCT walletState the store passes through.
 *
 * Needed because `purchase()`/`claim()`'s own `walletState: 'ready'` is
 * TRANSIENT — the best-effort refresh they kick off sets 'loading' in the very
 * next statement — so a `waitFor(state === 'ready')` cannot tell the mutation's
 * write from the refresh's. That is exactly why deleting it failed 0 tests.
 */
function recordWalletStates(): { states: LoadStateName[]; stop: () => void } {
  const states: LoadStateName[] = [useEconomy.getState().walletState];
  const stop = useEconomy.subscribe((st) => {
    if (states[states.length - 1] !== st.walletState) states.push(st.walletState);
  });
  return { states, stop };
}

/** A promise we settle by hand, standing in for a slow request. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

describe('purchase / claim — the read-after-write is what makes the wallet ready', () => {
  // ⚠ Both of these make the trailing best-effort refresh REJECT, so the only
  // thing on the path that can produce 'ready' is the mutation's own set. With
  // a resolving refresh (the positive control at the end of each) a deleted
  // `walletState: 'ready'` is invisible — which is how it shipped unasserted.
  it('purchase() marks the wallet ready itself, before the refresh it kicks off', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet();
    expect(useEconomy.getState().walletState).toBe('error');

    const rec = recordWalletStates();
    purchaseCosmetic.mockResolvedValueOnce({ balance: 470 });
    getWallet.mockRejectedValue(new Error('offline')); // the refresh fails too
    await useEconomy.getState().purchase('ball_sunset');

    // The mutation's own write, observed before the refresh's 'loading'.
    expect(rec.states).toContain('ready');
    expect(rec.states.indexOf('ready')).toBeLessThan(rec.states.indexOf('loading'));

    await vi.waitFor(() => expect(useEconomy.getState().walletState).toBe('error'));
    rec.stop();
    // The failed refresh surfaces, but the balance the server just told us
    // survives it (rule 3) — 470, never back to unknown.
    expect(useEconomy.getState().balance).toBe(470);
    expect(useEconomy.getState().owned).toContain('ball_sunset');
  });

  it('claim() marks the wallet ready itself, before the refresh it kicks off', async () => {
    getWallet.mockRejectedValueOnce(new Error('offline'));
    await useEconomy.getState().ensureWallet();

    const rec = recordWalletStates();
    claimSeasonTier.mockResolvedValueOnce({
      ok: true,
      tier: 1,
      reward: { coins: 50 },
      claimed: [1],
      claimable: [],
      balance: 720,
    });
    getWallet.mockRejectedValue(new Error('offline'));
    getCosmetics.mockRejectedValue(new Error('offline'));
    await useEconomy.getState().claim(1);

    expect(rec.states).toContain('ready');
    expect(rec.states.indexOf('ready')).toBeLessThan(rec.states.indexOf('loading'));

    await vi.waitFor(() => expect(useEconomy.getState().walletState).toBe('error'));
    rec.stop();
    expect(useEconomy.getState().balance).toBe(720);
  });

  it('positive control: with a refresh that WORKS the wallet ends ready', async () => {
    purchaseCosmetic.mockResolvedValueOnce({ balance: 470 });
    getWallet.mockResolvedValue({ ...WALLET, balance: 470 });
    await useEconomy.getState().purchase('ball_sunset');
    await vi.waitFor(() => expect(useEconomy.getState().walletState).toBe('ready'));
    expect(useEconomy.getState().balance).toBe(470);
  });
});

describe('a SUPERSEDED answer never lands', () => {
  // The reviewer's probe, verbatim: a slow read in flight, a purchase completing
  // (balance 470 + a fresh ledger), then the pre-purchase answer arriving and
  // reverting the balance to 670 with an empty ledger. `force` was documented as
  // preventing exactly this and did not: nothing cancelled the older request.
  const FRESH_LEDGER = [
    { delta: -200, reason: 'purchase', ref: 'ball_sunset', balanceAfter: 470, createdAt: 2 },
  ];

  it('does not let a pre-purchase read revert the balance or blank the ledger', async () => {
    const slow = deferred<typeof WALLET>();
    getWallet.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureWallet();
    await Promise.resolve();
    expect(useEconomy.getState().walletState).toBe('loading');

    purchaseCosmetic.mockResolvedValueOnce({ balance: 470 });
    getWallet.mockResolvedValue({ balance: 470, ledger: FRESH_LEDGER });
    await useEconomy.getState().purchase('ball_sunset');
    await vi.waitFor(() => expect(useEconomy.getState().ledger).toEqual(FRESH_LEDGER));

    // …and only NOW the old request answers, with pre-purchase data.
    slow.resolve(WALLET);
    await inflight;

    expect(useEconomy.getState().balance).toBe(470); // not 670
    expect(useEconomy.getState().ledger).toEqual(FRESH_LEDGER); // not []
    expect(useEconomy.getState().walletState).toBe('ready');
  });

  it('does not let a superseded FAILURE mark a wallet we have since loaded', async () => {
    const slow = deferred<typeof WALLET>();
    getWallet.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureWallet();
    await Promise.resolve();

    getWallet.mockResolvedValueOnce(WALLET);
    await useEconomy.getState().ensureWallet(true);
    expect(useEconomy.getState().walletState).toBe('ready');

    slow.reject(new Error('offline'));
    await inflight;

    // The failure belongs to a request nobody is waiting on any more.
    expect(useEconomy.getState().walletState).toBe('ready');
    expect(useEconomy.getState().balance).toBe(670);
  });

  it('does not let a pre-equip catalog read put the old ball back on', async () => {
    const slow = deferred<typeof CATALOG>();
    getCosmetics.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureCosmetics();
    await Promise.resolve();

    equipCosmetic.mockResolvedValueOnce({
      ok: true,
      equipped: { ball: 'ball_sunset', trail: 'trail_none', frame: 'frame_bronze' },
    });
    await useEconomy.getState().equip('ball', 'ball_sunset');
    expect(useEconomy.getState().equipped.ball).toBe('ball_sunset');

    slow.resolve(CATALOG); // equipped.ball: 'ball_classic'
    await inflight;

    expect(useEconomy.getState().equipped.ball).toBe('ball_sunset');
  });

  it('does not let a pre-purchase catalog read un-own the item just bought', async () => {
    // `owned` belongs to the cosmetics slice, so the wallet's generation cannot
    // protect it — purchase() has to retire the catalog read too, and unlike the
    // wallet it issues no replacement fetch to do that for it.
    const slow = deferred<typeof CATALOG>();
    getCosmetics.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureCosmetics();
    await Promise.resolve();

    purchaseCosmetic.mockResolvedValueOnce({ balance: 470 });
    getWallet.mockResolvedValue({ ...WALLET, balance: 470 });
    await useEconomy.getState().purchase('ball_sunset');
    expect(useEconomy.getState().owned).toContain('ball_sunset');

    slow.resolve(CATALOG); // owned: ['frame_bronze'] — pre-purchase
    await inflight;

    expect(useEconomy.getState().owned).toContain('ball_sunset');
  });

  it('does not let a pre-claim season read un-claim the tier just claimed', async () => {
    // Same shape on the season slice, which claim() also writes without
    // refetching.
    const SEASON = {
      seasonId: 's1',
      xp: 120,
      currentTier: 2,
      tiers: [{ tier: 1, xpRequired: 100, reward: { coins: 50 } }],
      claimed: [] as number[],
      claimable: [1],
      endsAt: 0,
    };
    useEconomy.setState({ season: SEASON, seasonState: 'ready' });
    const slow = deferred<typeof SEASON>();
    getSeason.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureSeason(true);
    await Promise.resolve();

    claimSeasonTier.mockResolvedValueOnce({
      ok: true,
      tier: 1,
      reward: { coins: 50 },
      claimed: [1],
      claimable: [],
      balance: 720,
    });
    getWallet.mockResolvedValue({ ...WALLET, balance: 720 });
    getCosmetics.mockResolvedValue(CATALOG);
    await useEconomy.getState().claim(1);
    expect(useEconomy.getState().season?.claimed).toEqual([1]);

    slow.resolve(SEASON); // claimed: [] — pre-claim
    await inflight;

    expect(useEconomy.getState().season?.claimed).toEqual([1]);
    expect(useEconomy.getState().season?.claimable).toEqual([]);
  });

  it('leaves a superseded slice REFETCHABLE, never stuck', async () => {
    // A dropped write can leave the slice at 'loading' with nothing in flight.
    // That must not be a dead end: it is not 'ready', so the next ensure*()
    // fetches again (rule 2).
    const slow = deferred<typeof CATALOG>();
    getCosmetics.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureCosmetics();
    await Promise.resolve();
    equipCosmetic.mockResolvedValueOnce({
      ok: true,
      equipped: { ball: 'ball_sunset', trail: 'trail_none', frame: 'frame_none' },
    });
    await useEconomy.getState().equip('ball', 'ball_sunset');
    slow.resolve(CATALOG);
    await inflight;

    getCosmetics.mockResolvedValueOnce(CATALOG);
    await useEconomy.getState().ensureCosmetics();
    expect(getCosmetics).toHaveBeenCalledTimes(2);
    expect(useEconomy.getState().cosmeticsState).toBe('ready');
  });

  it('positive control: an UN-superseded slow read still lands in full', async () => {
    // The guard must drop stale answers ONLY. If it dropped a request nothing
    // superseded, every first load would silently do nothing.
    const slow = deferred<typeof WALLET>();
    getWallet.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureWallet();
    await Promise.resolve();
    slow.resolve(WALLET);
    await inflight;

    expect(useEconomy.getState().balance).toBe(670);
    expect(useEconomy.getState().ledger).toEqual(WALLET.ledger);
    expect(useEconomy.getState().walletState).toBe('ready');
  });
});

describe('share() — force is exactly the opt-out of joining', () => {
  it('a FORCED refetch issues its own request instead of joining an in-flight read', async () => {
    // Over-applying the dedupe (letting `force` join too) is the same defect as
    // not superseding: the caller gets an answer fetched BEFORE their mutation.
    const slow = deferred<typeof WALLET>();
    getWallet.mockReturnValueOnce(slow.promise);
    const inflight = useEconomy.getState().ensureWallet();
    await Promise.resolve();

    getWallet.mockResolvedValueOnce({ ...WALLET, balance: 470 });
    await useEconomy.getState().ensureWallet(true);

    expect(getWallet).toHaveBeenCalledTimes(2);
    expect(useEconomy.getState().balance).toBe(470);

    slow.resolve(WALLET);
    await inflight;
    expect(useEconomy.getState().balance).toBe(470);
  });

  it('positive control: an UNforced second caller still joins the first request', async () => {
    const slow = deferred<typeof WALLET>();
    getWallet.mockReturnValueOnce(slow.promise);
    const a = useEconomy.getState().ensureWallet();
    const b = useEconomy.getState().ensureWallet();
    expect(a).toBe(b);
    slow.resolve(WALLET);
    await Promise.all([a, b]);
    expect(getWallet).toHaveBeenCalledTimes(1);
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
