// Golf economy client state — a small, self-contained zustand store that caches
// the player's coin wallet, cosmetics catalog / ownership / equip, and season
// track. Kept OUT of the messenger AppState (lib/store.ts) so the games layer
// never bloats core chat state, mirroring lib/golf/stats.ts's module-scoped
// pattern. `three`-free: the shop / season / wallet DOM and the render resolver
// all import from here without pulling the lazy `three` chunk.
//
// Loading is lazy + cached: callers invoke ensure*() which fetches once and
// then no-ops while a copy is in the store. Mutations (purchase / equip /
// claim) update the cache in place from the server's read-after-write payloads,
// so the shop, the hub balance chip and the golf renderer all stay in sync
// without a refetch. Every fetch degrades gracefully (unauthed / offline just
// leaves the slice empty → the economy UI hides itself).

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

const DEFAULT_EQUIPPED: EquippedCosmetics = {
  ball: 'ball_classic',
  trail: 'trail_none',
  frame: 'frame_none',
};

interface EconomyState {
  // Wallet
  balance: number | null;
  ledger: WalletLedgerEntry[];
  walletLoaded: boolean;
  // Cosmetics
  catalog: Cosmetic[];
  owned: string[];
  equipped: EquippedCosmetics;
  cosmeticsLoaded: boolean;
  // Season
  season: SeasonResponse | null;
  seasonLoaded: boolean;

  // Fetch-once loaders (no-op while a copy is cached; force refetches).
  ensureWallet: (force?: boolean) => Promise<void>;
  ensureCosmetics: (force?: boolean) => Promise<void>;
  ensureSeason: (force?: boolean) => Promise<void>;

  // Mutations — throw the ApiError code up to the caller for message mapping.
  purchase: (cosmeticId: string) => Promise<void>;
  equip: (slot: CosmeticSlot, cosmeticId: string) => Promise<void>;
  claim: (tier: number) => Promise<void>;
}

export const useEconomy = create<EconomyState>((set, get) => ({
  balance: null,
  ledger: [],
  walletLoaded: false,
  catalog: [],
  owned: [],
  equipped: DEFAULT_EQUIPPED,
  cosmeticsLoaded: false,
  season: null,
  seasonLoaded: false,

  ensureWallet: async (force = false) => {
    if (!force && get().walletLoaded) return;
    try {
      const w = await api.getWallet();
      set({ balance: w.balance, ledger: w.ledger, walletLoaded: true });
    } catch {
      set({ walletLoaded: true });
    }
  },

  ensureCosmetics: async (force = false) => {
    if (!force && get().cosmeticsLoaded) return;
    try {
      const c = await api.getCosmetics();
      set({
        catalog: c.catalog,
        owned: c.owned,
        equipped: c.equipped,
        cosmeticsLoaded: true,
      });
    } catch {
      set({ cosmeticsLoaded: true });
    }
  },

  ensureSeason: async (force = false) => {
    if (!force && get().seasonLoaded) return;
    try {
      const s = await api.getSeason();
      set({ season: s, seasonLoaded: true });
    } catch {
      set({ seasonLoaded: true });
    }
  },

  purchase: async (cosmeticId) => {
    const res = await api.purchaseCosmetic(cosmeticId);
    set((st) => ({
      balance: res.balance,
      owned: st.owned.includes(cosmeticId) ? st.owned : [...st.owned, cosmeticId],
    }));
    // The purchase moved coins → the ledger is stale; refresh it best-effort.
    void get().ensureWallet(true);
  },

  equip: async (slot, cosmeticId) => {
    const res = await api.equipCosmetic(slot, cosmeticId);
    set({ equipped: res.equipped });
  },

  claim: async (tier) => {
    const res = await api.claimSeasonTier(tier);
    set((st) => ({
      balance: res.balance,
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
