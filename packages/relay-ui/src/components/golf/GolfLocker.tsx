import { useState } from 'react';
import { GolfShop } from './GolfShop';
import { GolfSeason } from './GolfSeason';
import { GolfWallet } from './GolfWallet';

type LockerView = 'shop' | 'season' | 'wallet';

// The Locker hub tab — one home for the whole golf economy, split by an inner
// segmented control so the hub's top-level tab bar stays legible (Shop / Season
// / Wallet all live here instead of three separate top tabs). Each section is a
// self-loading component (they ensure* their own store slices), so switching is
// instant after the first load.
export function GolfLocker() {
  const [view, setView] = useState<LockerView>('shop');

  return (
    <div className="flex flex-col gap-4">
      <div className="golf-seg" role="group" aria-label="Locker section">
        {(
          [
            ['shop', 'Shop'],
            ['season', 'Season'],
            ['wallet', 'Wallet'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'shop' ? <GolfShop /> : null}
      {view === 'season' ? <GolfSeason /> : null}
      {view === 'wallet' ? <GolfWallet /> : null}
    </div>
  );
}
