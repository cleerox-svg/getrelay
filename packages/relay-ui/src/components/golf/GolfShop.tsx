import { useEffect, useState } from 'react';
import { affordability, useEconomy, economyErrorCode } from '../../lib/golf/economy';
import { isFirstLoad } from '../../lib/golf/loadState';
import type { Cosmetic, CosmeticSlot } from '../../lib/types';
import { CoinBalance } from './CoinBalance';
import { LoadFailure, LoadFailureLine } from './shared/LoadFailure';

// Human labels + ordering for the three cosmetic slots.
const SLOTS: { slot: CosmeticSlot; label: string; hint: string }[] = [
  { slot: 'ball', label: 'Golf balls', hint: 'Ball skin in every round' },
  { slot: 'trail', label: 'Ball trails', hint: 'Tracer colour on the flight' },
  { slot: 'frame', label: 'Avatar frames', hint: 'Framing your golf avatar' },
];

const RARITY_LABEL: Record<Cosmetic['rarity'], string> = {
  common: 'Common',
  rare: 'Rare',
  epic: 'Epic',
};

// Map a 400 error code from purchase/equip onto a friendly line.
function messageFor(code: string): string {
  switch (code) {
    case 'insufficient_funds':
      return 'Not enough coins yet.';
    case 'already_owned':
      return 'You already own that.';
    case 'not_owned':
      return 'Buy it first to equip it.';
    case 'wrong_slot':
      return "That doesn't fit this slot.";
    case 'unknown_cosmetic':
      return 'That item is unavailable.';
    default:
      return 'Something went wrong — try again.';
  }
}

// A generic visual preview for a cosmetic — NO per-id logic, driven only by
// `slot` + `visual`. Defaults render as "none" rather than a placeholder colour.
function Swatch({ item }: { item: Cosmetic }) {
  const color = item.visual.color;
  if (item.slot === 'ball') {
    return (
      <span
        className="golf-cos-swatch"
        style={{
          background: `radial-gradient(circle at 34% 30%, color-mix(in srgb, ${color ?? '#ffffff'} 55%, white), ${color ?? '#f2f2f2'} 72%)`,
          boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.12)',
        }}
      />
    );
  }
  if (item.slot === 'trail') {
    if (item.id === 'trail_none' || !color) {
      return <span className="golf-cos-swatch golf-cos-none">none</span>;
    }
    return (
      <span
        className="golf-cos-swatch"
        style={{
          background: `linear-gradient(90deg, transparent, ${color})`,
        }}
      />
    );
  }
  // frame
  if (item.id === 'frame_none' || !color) {
    return <span className="golf-cos-swatch golf-cos-none">none</span>;
  }
  const glow = item.visual.style === 'glow';
  return (
    <span className="golf-cos-swatch" style={{ background: 'var(--bubble-them)' }}>
      <span
        style={{
          position: 'absolute',
          inset: 6,
          borderRadius: 999,
          background: 'var(--card-bg)',
          ...(glow
            ? { boxShadow: `0 0 0 2px ${color}, 0 0 8px 1px ${color}` }
            : { border: `2px solid ${color}` }),
        }}
      />
    </span>
  );
}

// The Shop / Locker: browse the cosmetics catalog grouped by slot, buy with
// coins and equip owned items per slot. Balance is shown prominently at the top.
// Every mutation refetches through the store, so ownership / equip / balance
// stay in sync with the golf renderer (which reads the same equipped state).
export function GolfShop() {
  const balance = useEconomy((s) => s.balance);
  const catalog = useEconomy((s) => s.catalog);
  const owned = useEconomy((s) => s.owned);
  const equipped = useEconomy((s) => s.equipped);
  const cosmeticsState = useEconomy((s) => s.cosmeticsState);
  const walletState = useEconomy((s) => s.walletState);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  const ensureWallet = useEconomy((s) => s.ensureWallet);
  const purchase = useEconomy((s) => s.purchase);
  const equip = useEconomy((s) => s.equip);

  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ id: string; text: string; ok: boolean } | null>(null);

  useEffect(() => {
    void ensureCosmetics();
    void ensureWallet();
  }, [ensureCosmetics, ensureWallet]);

  async function onBuy(item: Cosmetic) {
    setBusy(item.id);
    setMsg(null);
    try {
      await purchase(item.id);
      setMsg({ id: item.id, text: `Unlocked ${item.name}!`, ok: true });
    } catch (e) {
      setMsg({ id: item.id, text: messageFor(economyErrorCode(e)), ok: false });
    } finally {
      setBusy(null);
    }
  }

  async function onEquip(item: Cosmetic) {
    setBusy(item.id);
    setMsg(null);
    try {
      await equip(item.slot, item.id);
      setMsg({ id: item.id, text: `Equipped ${item.name}.`, ok: true });
    } catch (e) {
      setMsg({ id: item.id, text: messageFor(economyErrorCode(e)), ok: false });
    } finally {
      setBusy(null);
    }
  }

  // Three outcomes, never two: still loading / couldn't load / genuinely empty.
  // The middle one used to be rendered as the last one.
  if (catalog.length === 0) {
    if (isFirstLoad(cosmeticsState)) {
      return <div className="golf-empty">Loading the pro shop…</div>;
    }
    if (cosmeticsState === 'error') {
      return (
        <LoadFailure
          title="The pro shop needs a connection."
          detail="Couldn’t load your items — your coins and skins are safe."
          onRetry={() => void ensureCosmetics(true)}
        />
      );
    }
    return <div className="golf-empty">The pro shop is closed — reconnect to browse.</div>;
  }

  return (
    <div className="golf-shop">
      <div className="golf-shop-bar">
        <div>
          <b>Pro shop</b>
          <div className="golf-shop-sub">Spend coins on balls, trails &amp; frames</div>
        </div>
        <CoinBalance balance={balance} />
      </div>

      {/* ⚠ A wallet we could not reach is NOT a wallet with no coins. Say so and
          offer the retry; the buy buttons below fall back to an UNKNOWN
          affordance rather than a false "Need more coins". */}
      {walletState === 'error' ? (
        <LoadFailureLine
          text="Couldn’t reach your wallet."
          onRetry={() => void ensureWallet(true)}
        />
      ) : null}

      {/* Same rule for a stale catalog: what you own may be out of date, so say
          it rather than let an item read as un-owned. */}
      {cosmeticsState === 'error' ? (
        <LoadFailureLine
          text="Couldn’t refresh your items."
          onRetry={() => void ensureCosmetics(true)}
        />
      ) : null}

      {SLOTS.map(({ slot, label, hint }) => {
        const items = catalog.filter((c) => c.slot === slot);
        if (items.length === 0) return null;
        return (
          <div key={slot} className="golf-shop-group">
            <div className="golf-shop-grouph">
              <b>{label}</b>
              <span>{hint}</span>
            </div>
            <div className="golf-cos-grid">
              {items.map((item) => {
                const isOwned = owned.includes(item.id);
                const isEquipped = equipped[slot] === item.id;
                const afford = affordability(balance, item.price);
                const showMsg = msg && msg.id === item.id;
                return (
                  <div
                    key={item.id}
                    className={`golf-cos-card rar-${item.rarity}${isEquipped ? ' is-equipped' : ''}`}
                  >
                    <Swatch item={item} />
                    <div className="golf-cos-name">{item.name}</div>
                    <div className="golf-cos-rar">{RARITY_LABEL[item.rarity]}</div>

                    {isOwned ? (
                      <button
                        type="button"
                        className="golf-cos-equip"
                        disabled={isEquipped || busy === item.id}
                        aria-pressed={isEquipped}
                        onClick={() => onEquip(item)}
                      >
                        {isEquipped ? 'Equipped' : 'Equip'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="golf-cos-buy"
                        disabled={afford !== 'yes' || busy === item.id}
                        aria-disabled={afford !== 'yes'}
                        title={
                          afford === 'unknown'
                            ? 'Your coin balance is unavailable right now'
                            : undefined
                        }
                        onClick={() => onBuy(item)}
                      >
                        <span aria-hidden="true">◉</span>{' '}
                        {item.price.toLocaleString()}
                      </button>
                    )}

                    {showMsg ? (
                      <div className={`golf-cos-msg${msg!.ok ? ' ok' : ' err'}`}>{msg!.text}</div>
                    ) : !isOwned && afford === 'no' ? (
                      <div className="golf-cos-msg dim">Need more coins</div>
                    ) : !isOwned && afford === 'unknown' ? (
                      // NOT "Need more coins" — we do not know what they have.
                      <div className="golf-cos-msg dim">Balance unavailable</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
