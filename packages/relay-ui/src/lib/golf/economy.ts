// Golf economy client state — a small, self-contained zustand store that caches
// the player's coin wallet, cosmetics catalog / ownership / equip, and season
// track. Kept OUT of the messenger AppState (lib/store.ts) so the games layer
// never bloats core chat state, mirroring lib/golf/stats.ts's module-scoped
// pattern. `three`-free: the shop / season / wallet DOM and the render resolver
// all import from here without pulling the lazy `three` chunk.
//
// Loading is lazy + cached: callers invoke ensure*() which fetches once and
// then no-ops while a GOOD copy is in the store.
//
// ⚠ A FAILED FETCH IS NOT A LOADED SLICE. Each slice carries a `LoadState`
// (see loadState.ts), not a `loaded` boolean. This is a fixed production bug,
// not a style preference: the old code set `loaded: true` in the catch arm, so
// one failed /economy/wallet left `balance: null` behind a guard that never
// retried, and the shop rendered "Need more coins" on every item of a
// 670-coin wallet for the whole session. The same shape sank cosmetics — a
// failed fetch meant "you own nothing", so a purchased, equipped ball skin
// silently stopped applying. Rules:
//
//   1. Only the SUCCESS arm may set 'ready'. The catch arm sets 'error'.
//   2. 'error' is retryable — ensure*() refetches from it with no `force`.
//   3. Data already in the store SURVIVES a failed refresh (a forced refetch
//      that fails must not blank a balance we legitimately know).
//   4. The UI must render 'error' as an error with a retry, never as an empty
//      catalog or an unaffordable price. See `affordability()`.
//   5. A SUPERSEDED answer never lands. Nothing here can be cancelled, so every
//      write carries a generation and a stale one is dropped — see the
//      `generation` block below.
//
// Mutations (purchase / equip / claim) update the cache in place from the
// server's read-after-write payloads, so the shop, the hub balance chip and the
// golf renderer all stay in sync without a refetch.

import { create } from 'zustand';
import { api, ApiError } from '../api';
import type {
  Cosmetic,
  CosmeticSlot,
  EquippedCosmetics,
  SeasonResponse,
  WalletLedgerEntry,
} from '../types';
import { resolveFrame, type GolfFrame } from './cosmetics';
import { withTimeout, type LoadState } from './loadState';

const DEFAULT_EQUIPPED: EquippedCosmetics = {
  ball: 'ball_classic',
  trail: 'trail_none',
  frame: 'frame_none',
};

interface EconomyState {
  // Wallet. `balance` is null until a fetch SUCCEEDS — null means UNKNOWN, not
  // zero, and must never be rendered as "can't afford" (see affordability()).
  balance: number | null;
  ledger: WalletLedgerEntry[];
  walletState: LoadState;
  // Cosmetics
  catalog: Cosmetic[];
  owned: string[];
  equipped: EquippedCosmetics;
  cosmeticsState: LoadState;
  // Season
  season: SeasonResponse | null;
  seasonState: LoadState;

  // Fetch-once loaders. No-op while a READY copy is cached; retry from 'error';
  // join an in-flight request rather than duplicating it. `force` refetches.
  ensureWallet: (force?: boolean) => Promise<void>;
  ensureCosmetics: (force?: boolean) => Promise<void>;
  ensureSeason: (force?: boolean) => Promise<void>;

  // Mutations — throw the ApiError code up to the caller for message mapping.
  purchase: (cosmeticId: string) => Promise<void>;
  equip: (slot: CosmeticSlot, cosmeticId: string) => Promise<void>;
  claim: (tier: number) => Promise<void>;
}

// In-flight request per slice, so two components mounting at once (the hub
// header + the shop) share ONE request and both settle on the same answer.
type Slice = 'wallet' | 'cosmetics' | 'season';
const inFlight: Partial<Record<Slice, Promise<void>>> = {};

// ⚠ A SUPERSEDED ANSWER MUST NOT LAND. `force`ing a refetch does not cancel the
// read it replaces (`fetch` here takes no AbortSignal), and a mutation's
// read-after-write cannot cancel one either — so without this counter the older
// request's `set()` still ran, LAST, and overwrote what we already knew:
// a slow /economy/wallet in flight, a purchase completing (balance 470, fresh
// ledger), then the pre-purchase answer arriving reverted the balance to 670
// and blanked the ledger to []. `GolfSeason` mounts an `ensureWallet()` and
// gates Claim on `claimable`, so that revert was reachable in the shipped app.
//
// Every write to a slice — a read starting, or a mutation writing the server's
// read-after-write — takes the NEXT generation; a request may only `set()` while
// the generation it took is still current. A stale one drops its write (both
// arms: a stale FAILURE must not flip a slice we have since learned to 'error'
// either) and returns.
//
// A dropped write can leave the slice at 'loading' with nothing in flight, and
// that is DELIBERATELY not repaired here: it is not 'ready', so the next
// `ensure*()` refetches it (rule 2), and no screen shows a spinner in that
// situation — every "Loading…" branch is gated on having NO data, which a
// completed mutation contradicts (you cannot buy from a catalog you never
// loaded). Repairing it would mean writing a state nobody measured.
const generation: Record<Slice, number> = { wallet: 0, cosmetics: 0, season: 0 };

/**
 * Retire every write still in flight for `slice` and return the generation the
 * caller now owns. Compare with `isCurrent()` before any `set()`.
 */
function supersede(slice: Slice): number {
  return ++generation[slice];
}

function isCurrent(slice: Slice, gen: number): boolean {
  return generation[slice] === gen;
}

/**
 * Run `job` for `slice`, sharing a request that is already in flight unless the
 * caller explicitly forced a refetch (a forced refresh follows a mutation, so
 * an older in-flight read would answer with pre-mutation data — hence also the
 * generation `job` is handed, which is what actually stops that answer landing).
 */
function share(
  slice: Slice,
  force: boolean,
  job: (current: () => boolean) => Promise<void>,
): Promise<void> {
  if (!force) {
    const running = inFlight[slice];
    if (running) return running;
  }
  const gen = supersede(slice);
  const started = job(() => isCurrent(slice, gen)).finally(() => {
    if (inFlight[slice] === started) delete inFlight[slice];
  });
  inFlight[slice] = started;
  return started;
}

// Test seam: drop any shared in-flight promises between cases.
export function __resetEconomyInFlight(): void {
  for (const k of Object.keys(inFlight) as Slice[]) delete inFlight[k];
}

export const useEconomy = create<EconomyState>((set, get) => ({
  balance: null,
  ledger: [],
  walletState: 'idle',
  catalog: [],
  owned: [],
  equipped: DEFAULT_EQUIPPED,
  cosmeticsState: 'idle',
  season: null,
  seasonState: 'idle',

  ensureWallet: (force = false) => {
    if (!force && get().walletState === 'ready') return Promise.resolve();
    return share('wallet', force, async (current) => {
      set({ walletState: 'loading' });
      try {
        const w = await withTimeout(api.getWallet());
        // Superseded by a newer read or by a mutation's read-after-write: this
        // answer is older than what the store already holds. Drop it.
        if (!current()) return;
        set({ balance: w.balance, ledger: w.ledger, walletState: 'ready' });
      } catch {
        if (!current()) return;
        // Keep whatever balance/ledger we already knew — a failed REFRESH must
        // not blank a good balance — but mark the slice failed so the UI can
        // say so and a Retry can refetch.
        set({ walletState: 'error' });
      }
    });
  },

  ensureCosmetics: (force = false) => {
    if (!force && get().cosmeticsState === 'ready') return Promise.resolve();
    return share('cosmetics', force, async (current) => {
      set({ cosmeticsState: 'loading' });
      try {
        const c = await withTimeout(api.getCosmetics());
        if (!current()) return;
        set({
          catalog: c.catalog,
          owned: c.owned,
          equipped: c.equipped,
          cosmeticsState: 'ready',
        });
      } catch {
        if (!current()) return;
        set({ cosmeticsState: 'error' });
      }
    });
  },

  ensureSeason: (force = false) => {
    if (!force && get().seasonState === 'ready') return Promise.resolve();
    return share('season', force, async (current) => {
      set({ seasonState: 'loading' });
      try {
        const s = await withTimeout(api.getSeason());
        if (!current()) return;
        set({ season: s, seasonState: 'ready' });
      } catch {
        if (!current()) return;
        set({ seasonState: 'error' });
      }
    });
  },

  purchase: async (cosmeticId) => {
    const res = await api.purchaseCosmetic(cosmeticId);
    // The server's read-after-write is newer than any read still in flight —
    // retire them before writing, or a pre-purchase answer reverts the balance
    // (and a pre-purchase CATALOG answer un-owns the item just bought).
    supersede('wallet');
    supersede('cosmetics');
    set((st) => ({
      balance: res.balance,
      // The server just told us the balance, so the wallet slice is authoritative
      // again even if its own fetch had failed.
      walletState: 'ready',
      owned: st.owned.includes(cosmeticId) ? st.owned : [...st.owned, cosmeticId],
    }));
    // The purchase moved coins → the ledger is stale; refresh it best-effort.
    void get().ensureWallet(true);
  },

  equip: async (slot, cosmeticId) => {
    const res = await api.equipCosmetic(slot, cosmeticId);
    // Same rule as purchase(): `equipped` belongs to the cosmetics slice, so an
    // older in-flight catalog read would otherwise re-equip the previous item.
    supersede('cosmetics');
    set({ equipped: res.equipped });
  },

  claim: async (tier) => {
    const res = await api.claimSeasonTier(tier);
    // Same rule: this response is newer than any wallet/season read in flight.
    supersede('wallet');
    supersede('season');
    set((st) => ({
      balance: res.balance,
      walletState: 'ready',
      season: st.season
        ? { ...st.season, claimed: res.claimed, claimable: res.claimable }
        : st.season,
    }));
    // A cosmetic reward changes ownership; a coin reward changes the ledger.
    void get().ensureCosmetics(true);
    void get().ensureWallet(true);
  },
}));

// Narrow an unknown thrown value to its ApiError code for message mapping.
export function economyErrorCode(e: unknown): string {
  return e instanceof ApiError ? e.code : 'http_error';
}

/**
 * Can the player afford `price`? THREE answers, not two.
 *
 * ⚠ `balance === null` is UNKNOWN, not broke. Collapsing it to `balance != null
 * && balance >= price` is the bug that made a 670-coin wallet render "Need more
 * coins" on a 200-coin item: an unreachable wallet was reported to the player
 * as a fact about their money. An unknown balance disables the buy button with
 * an UNKNOWN affordance and an error the player can retry.
 */
export type Affordability = 'yes' | 'no' | 'unknown';

export function affordability(balance: number | null, price: number): Affordability {
  if (balance == null) return 'unknown';
  return balance >= price ? 'yes' : 'no';
}

// ---- Selector hooks -----------------------------------------------------
// These return the RESOLVED render/frame shapes. GolfScreen memoises the
// GolfCosmetics object for stable renderer identity; here we keep the inputs
// (catalog + equipped) as the memo deps.

// The equipped avatar frame overlay (or null for frame_none / unloaded).
export function useEquippedFrame(): GolfFrame | null {
  const catalog = useEconomy((s) => s.catalog);
  const equipped = useEconomy((s) => s.equipped);
  return resolveFrame(catalog, equipped);
}
