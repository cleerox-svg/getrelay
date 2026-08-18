// @vitest-environment jsdom
//
// THE PRO SHOP MUST NOT TELL A PLAYER THEY ARE BROKE WHEN IT DOES NOT KNOW.
//
// Reported from production against a wallet holding 670 coins whose ledger is
// credits-only (no purchase has ever debited it): the shop rendered "Need more
// coins" on a 200-coin item, and an owned + equipped skin read as un-owned.
// Nothing was wrong with the data. `ensureWallet` had marked the wallet LOADED
// in its catch arm, leaving `balance: null`, and `canAfford = balance != null &&
// balance >= price` collapsed UNKNOWN onto NO.
//
// So this file pins the DISPLAY half of the fix (economy.test.ts pins the store
// half): a null balance is an unknown affordance with a visible, retryable
// error — never a false negative — and a failed catalog fetch is not an empty
// shop.
//
// MUTATIONS WATCHED TO FAIL against this file (counts are failures in THIS
// file; the economy.ts ones additionally fail in lib/golf/economy.test.ts):
//   1. `affordability()` → `balance != null && balance >= price ? 'yes' : 'no'`
//      (the original expression)                        → 1 fail (+1 economy)
//   2. `afford === 'no'` → `afford !== 'yes'` on the "Need more coins" line
//                                                                     → 1 fail
//   3. economy.ts wallet catch arm → `set({ walletState: 'ready' })`
//                                                       → 1 fail (+5 economy)
//   4. economy.ts cosmetics catch arm → `set({ cosmeticsState: 'ready' })`
//                                                       → 1 fail (+1 economy)
//   5. the `cosmeticsState === 'error'` branch removed (falls through to
//      "The pro shop is closed")                                      → 1 fail
//   6. the ensure guard made sticky again — `walletState !== 'idle'`
//                                                       → 2 fail (+1 economy)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const getWallet = vi.fn();
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
      getWallet: (...a: unknown[]) => getWallet(...a),
      getCosmetics: (...a: unknown[]) => getCosmetics(...a),
      purchaseCosmetic: vi.fn(),
      equipCosmetic: vi.fn(),
      getSeason: vi.fn(),
      claimSeasonTier: vi.fn(),
    },
  };
});

const { GolfShop } = await import('./GolfShop');
const { useEconomy, __resetEconomyInFlight } = await import('../../lib/golf/economy');

const CATALOG = {
  catalog: [
    {
      id: 'ball_sunset',
      slot: 'ball' as const,
      name: 'Sunset',
      rarity: 'rare' as const,
      price: 200,
      visual: { color: '#ff8800' },
    },
  ],
  owned: ['frame_bronze'],
  equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_bronze' },
};
const WALLET = { balance: 670, ledger: [] };

function buyButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /200/ }) as HTMLButtonElement;
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
});

afterEach(() => cleanup());

describe('GolfShop — an unreachable wallet', () => {
  it('never renders "Need more coins" for an UNKNOWN balance', async () => {
    getCosmetics.mockResolvedValue(CATALOG);
    getWallet.mockRejectedValue(new Error('offline'));

    render(<GolfShop />);
    await screen.findByText('Sunset');

    // The reported symptom, asserted as absent.
    expect(screen.queryByText('Need more coins')).toBeNull();
    // …and the honest replacement is present.
    await screen.findByText('Balance unavailable');
    // The buy is still blocked (we cannot spend coins we cannot count) but the
    // reason shown is the true one.
    expect(buyButton().disabled).toBe(true);
  });

  it('surfaces the failure with a retry that recovers the real balance', async () => {
    getCosmetics.mockResolvedValue(CATALOG);
    getWallet.mockRejectedValueOnce(new Error('offline'));

    render(<GolfShop />);
    await screen.findByText('Couldn’t reach your wallet.');
    expect(buyButton().disabled).toBe(true);

    getWallet.mockResolvedValueOnce(WALLET);
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0]!);

    await waitFor(() => expect(screen.queryByText('Couldn’t reach your wallet.')).toBeNull());
    expect(screen.getByText('670')).toBeTruthy();
    expect(buyButton().disabled).toBe(false);
    expect(screen.queryByText('Balance unavailable')).toBeNull();
  });

  it('refetches on a REMOUNT after a failure — not sticky for the session', async () => {
    // The original guard (`if (loaded) return`) made one failed fetch permanent
    // until a full page reload: leaving the Locker and coming back showed the
    // same phantom-broke shop.
    getCosmetics.mockResolvedValue(CATALOG);
    getWallet.mockRejectedValueOnce(new Error('offline'));

    render(<GolfShop />);
    await screen.findByText('Balance unavailable');
    cleanup();

    getWallet.mockResolvedValueOnce(WALLET);
    render(<GolfShop />);
    await screen.findByText('670');
    await waitFor(() => expect(buyButton().disabled).toBe(false));
  });

  it('still says "Need more coins" when the balance is KNOWN and short', async () => {
    // Guards against "fixing" the false negative by deleting the true one.
    getCosmetics.mockResolvedValue(CATALOG);
    getWallet.mockResolvedValue({ balance: 12, ledger: [] });

    render(<GolfShop />);
    await screen.findByText('Need more coins');
    expect(screen.queryByText('Balance unavailable')).toBeNull();
    expect(buyButton().disabled).toBe(true);
  });

  it('enables the buy at exactly the price', async () => {
    getCosmetics.mockResolvedValue(CATALOG);
    getWallet.mockResolvedValue({ balance: 200, ledger: [] });

    render(<GolfShop />);
    await screen.findByText('Sunset');
    await waitFor(() => expect(buyButton().disabled).toBe(false));
    expect(screen.queryByText('Need more coins')).toBeNull();
  });
});

describe('GolfShop — an unreachable catalog', () => {
  it('does not report a failed fetch as a closed shop', async () => {
    getCosmetics.mockRejectedValueOnce(new Error('offline'));
    getWallet.mockResolvedValue(WALLET);

    render(<GolfShop />);
    await screen.findByText('The pro shop needs a connection.');
    // "closed" is the EMPTY-catalog copy: a different fact, and the one that
    // made an owned, equipped skin look like it had never been bought.
    expect(screen.queryByText(/pro shop is closed/)).toBeNull();

    getCosmetics.mockResolvedValueOnce(CATALOG);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Sunset');
  });

  it('shows a genuinely empty catalog as a closed shop', async () => {
    getCosmetics.mockResolvedValue({ catalog: [], owned: [], equipped: CATALOG.equipped });
    getWallet.mockResolvedValue(WALLET);

    render(<GolfShop />);
    await screen.findByText(/pro shop is closed/);
  });

  it('equips from a catalog that loaded, and marks owned items owned', async () => {
    getCosmetics.mockResolvedValue({ ...CATALOG, owned: ['frame_bronze', 'ball_sunset'] });
    getWallet.mockResolvedValue(WALLET);

    render(<GolfShop />);
    // An owned item offers Equip, never a price — the "skins don't work" path.
    await screen.findByRole('button', { name: 'Equip' });
    expect(screen.queryByRole('button', { name: /200/ })).toBeNull();
  });
});
