import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { FogScreen } from '../components/fog/FogScreen';
import { TuneScreen } from '../components/tune/TuneScreen';
import { GolfScreen } from '../components/golf/GolfScreen';
import { useStore } from '../lib/store';

// /discover is the Games tab: a grid of game chiclets (the "hub").
// Picking one routes into that game's standalone screen (menu → guess →
// results), which is pure component state — the tab bar's active check is
// an exact pathname match, so game switching never touches the URL path.
// The in-game guess/free screens DO push a same-path history marker so a
// back gesture pauses/leaves the game exactly as it always has (see
// lib/games/useGameFlow.ts); hub↔menu is plain state with a "‹ Games"
// affordance handled by each screen's onExitToHub.

// The chiclet grid, as data so adding a game is one more entry. `id`
// drives which screen renders; `icon` is a flat SVG under /public/games.
const GAMES: { id: 'fog' | 'tune' | 'golf'; title: string; subtitle: string; icon: string }[] = [
  {
    id: 'fog',
    title: 'Fog',
    subtitle: 'Wipe the steamed-up window and guess what’s behind it.',
    icon: '/games/fog.svg',
  },
  {
    id: 'tune',
    title: 'Guess the Tune',
    subtitle: 'Hear a short clip and name the song title.',
    icon: '/games/tune.svg',
  },
  {
    id: 'golf',
    title: 'Golf',
    subtitle: 'Putt the mini-golf course or bomb it down the driving range.',
    icon: '/games/golf.svg',
  },
];

export function Fog() {
  const me = useStore((s) => s.me);
  // Which mini game the Games hub is showing. null = the chiclet grid
  // (hub). Each game's standalone screen owns its own menu/game/results
  // flow and the back-gesture choreography (via useGameFlow).
  const [selected, setSelected] = useState<'fog' | 'tune' | 'golf' | null>(null);

  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Games</h1>

      {/* Bottom padding clears both the fixed Konsta Tabbar and the
          classic-mode .legacy-tabbar (same treatment as /sports). */}
      <div style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}>
        {selected === null ? (
          <div className="px-4">
            <div className="text-sm pb-3" style={{ color: 'var(--text-dim)' }}>
              Pick a game.
            </div>
            <div className="grid grid-cols-2 gap-3">
              {GAMES.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelected(g.id)}
                  className="flex flex-col overflow-hidden text-left"
                  style={{
                    background: 'var(--card-bg)',
                    border: '1px solid var(--separator)',
                    borderRadius: 18,
                    padding: 0,
                  }}
                >
                  <div
                    className="flex items-center justify-center"
                    style={{ aspectRatio: '1 / 1', background: 'var(--bubble-them)' }}
                  >
                    <img
                      src={g.icon}
                      alt=""
                      style={{ width: '68%', height: '68%', objectFit: 'contain' }}
                    />
                  </div>
                  <div className="px-3 py-2.5">
                    <div className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>
                      {g.title}
                    </div>
                    <div className="text-[12px] leading-snug pt-0.5" style={{ color: 'var(--text-dim)' }}>
                      {g.subtitle}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : selected === 'fog' ? (
          <FogScreen onExitToHub={() => setSelected(null)} />
        ) : selected === 'tune' ? (
          <TuneScreen onExitToHub={() => setSelected(null)} />
        ) : (
          <GolfScreen onExitToHub={() => setSelected(null)} />
        )}
      </div>
    </Page>
  );
}
