import { Suspense, lazy, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import { Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { FogScreen } from '../components/fog/FogScreen';
import { TuneScreen } from '../components/tune/TuneScreen';
import { GolfScreen } from '../components/golf/GolfScreen';
import { useStore } from '../lib/store';
import { getFogStats } from '../lib/fog/stats';
import { getTuneStats } from '../lib/tune/stats';
import { getGolfStats } from '../lib/golf/stats';

// /games is the Games tab: a grid of game chiclets (the "hub").
// Picking one routes into that game's standalone screen (menu → guess →
// results), which is pure component state — the tab bar's active check is
// an exact pathname match, so game switching never touches the URL path.
// The in-game guess/free screens DO push a same-path history marker so a
// back gesture pauses/leaves the game exactly as it always has (see
// lib/games/useGameFlow.ts); hub↔menu is plain state with a "‹ Games"
// affordance handled by each screen's onExitToHub.

// ⚠ BASEBALL IS LAZY AT THE *SCREEN*, NOT JUST AT THE SCENE, AND THAT IS
// MEASURED. `DerbyGame` already `lazy()`-imports `StadiumGL`, so `three` was
// never the question — but the HUD imports `DerbySim`, which pulls `pitchSim`,
// `batSim`, `battedBallSim`, `airPhysics`, `parks`, `pitches`, `pchip` and
// `zone` behind it. Imported eagerly here, like `GolfScreen` is, that put the
// whole baseball physics library in the entry chunk: 843.66 kB → 874.99 kB
// (+31.33 kB raw, +12.22 kB gzip) for every user who opens Relay to read a
// message. Behind this boundary the same build is 843.66 → 844.51 kB, i.e.
// +0.85 kB raw / +0.21 kB gzip — the tile, the `GameId` and the lazy stub,
// which is what the hub should actually cost. The physics goes in the baseball
// chunk (31.06 kB) where it is used, and `three` in its own (533.04 kB).
export type GameId = 'fog' | 'tune' | 'golf' | 'baseball';

const BaseballScreen = lazy(() =>
  import('../components/baseball/BaseballScreen').then((m) => ({ default: m.BaseballScreen })),
);

// The chiclet grid, as data so adding a game is one more entry. `id`
// drives which screen renders; `icon` is a flat SVG under /public/games.
const GAMES: { id: GameId; title: string; subtitle: string; icon: string }[] = [
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
  {
    id: 'baseball',
    title: 'Baseball',
    subtitle: 'Sit on a pitch, pick your spot, and put it over the wall.',
    icon: '/games/baseball.svg',
  },
];

// Flat SVG icon path for a game id, sourced from the GAMES data above so the
// hub landing and any future chiclet consumers share one asset map.
const iconOf = (id: GameId): string => GAMES.find((g) => g.id === id)?.icon ?? '';

// History-state key carrying the deep-linked game from GamesDeepLink to the
// hub. Deliberately NOT `game`: useGameFlow owns `state.game` for its
// back-gesture marker, and the two must not be mistaken for each other.
type HubEntryState = { hubGame?: GameId } | null;

// Deep-link entry for /games/:game — the path the worker's golf-challenge
// pushes carry (relay-worker/src/games.ts sends url: '/games/golf', which
// sw.js hands to App's SwNavigationBridge). Games are NOT subroutes (see the
// header comment), so this does not render the hub at /games/golf; it
// normalizes the URL back to /games and passes the validated id along in
// history state, which <Games> reads once as its initial selection.
//
// Redirecting rather than rendering here keeps two invariants:
//  - the tab bar's active check is an exact `pathname === '/games'`
//    (MainLayout.tsx), so sitting on /games/golf would leave the Games tab
//    unhighlighted — the same reason the /discover redirect lives outside
//    the MainLayout group;
//  - useGameFlow pushes its back-gesture marker at `location.pathname`, so
//    an un-normalized path would leak /games/golf into the in-game history
//    entries and, on exit, into the URL the user is left on.
// `replace` means history depth after the deep link is identical to landing
// on /games directly, which is what useGameFlow's depth invariant assumes.
// An unknown id (/games/bogus) redirects with no state, so the hub renders —
// degrading to the grid instead of falling through to /chats.
export function GamesDeepLink() {
  const { game } = useParams();
  const id = GAMES.find((g) => g.id === game)?.id;
  const state: HubEntryState = id ? { hubGame: id } : null;
  return <Navigate to="/games" replace state={state} />;
}

export function Games() {
  const me = useStore((s) => s.me);
  // Personal bests for the hub cards. Read from localStorage (offline-safe)
  // once per landing mount; omit the "Best" line until a game's been played.
  const fogStats = getFogStats();
  const tuneStats = getTuneStats();
  const golfStats = getGolfStats();
  // Which mini game the Games hub is showing. null = the chiclet grid
  // (hub). Each game's standalone screen owns its own menu/game/results
  // flow and the back-gesture choreography (via useGameFlow).
  //
  // Seeded once, on mount, from the history state GamesDeepLink leaves
  // behind for a /games/:game deep link (a push-notification tap). Read in
  // the lazy initializer on purpose: it is a one-shot entry hint, not a
  // binding. Later navigations rewrite that entry's state (useGameFlow's
  // marker, and its `state: null` reset) without ever yanking the user out
  // of the game they're in, and switching games from the hub still touches
  // no history at all.
  const entry = useLocation().state as HubEntryState;
  const [selected, setSelected] = useState<GameId | null>(() => entry?.hubGame ?? null);

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
          <div className="games-hub px-4">
            <div className="games-head">
              <p className="games-eyebrow">Relay Arcade</p>
              <h2 className="games-hub-title">Games</h2>
              <p className="games-sub">Three games, each its own world. Pick one to play.</p>
            </div>

            {/* Featured Golf — the flagship: a painted CSS "broadcast" hero
                (same technique as .golf-hero) with a Featured badge + play
                affordance. Clicking mounts the decoupled GolfScreen. */}
            <button type="button" className="games-feat" onClick={() => setSelected('golf')}>
              <div className="games-feat-art">
                <span className="g-sun" />
                <span className="g-fairway" />
                <span className="g-green" />
                <span className="g-flag" />
                <img className="games-feat-emblem" src={iconOf('golf')} alt="" />
                <span className="games-feat-grad" />
                <span className="games-feat-badge">Featured</span>
              </div>
              <div className="games-feat-ft">
                <div className="games-feat-txt">
                  <b>Golf</b>
                  <span>3D courses · mini-golf · driving range</span>
                  {golfStats.gamesPlayed > 0 && (
                    <span className="games-feat-best">
                      Best <b>{golfStats.bestScore.toLocaleString()}</b>
                    </span>
                  )}
                </div>
                <span className="games-feat-go" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </div>
            </button>

            {/* Secondary tiles — each tinted to its own world. */}
            <div className="games-grid">
              <button
                type="button"
                className="games-card games-card--fog"
                onClick={() => setSelected('fog')}
              >
                <div className="games-card-cap">
                  <img className="games-card-icon" src={iconOf('fog')} alt="" />
                </div>
                <div className="games-card-b">
                  <b>Fog</b>
                  <span>Guess through the mist</span>
                  {fogStats.gamesPlayed > 0 && (
                    <div className="games-card-best">
                      <span>Best</span>
                      <b>{fogStats.bestScore.toLocaleString()}</b>
                    </div>
                  )}
                </div>
              </button>

              <button
                type="button"
                className="games-card games-card--tune"
                onClick={() => setSelected('tune')}
              >
                <div className="games-card-cap">
                  <img className="games-card-icon" src={iconOf('tune')} alt="" />
                </div>
                <div className="games-card-b">
                  <b>Tune</b>
                  <span>Name the track</span>
                  {tuneStats.gamesPlayed > 0 && (
                    <div className="games-card-best">
                      <span>Best</span>
                      <b>{tuneStats.bestScore.toLocaleString()}</b>
                    </div>
                  )}
                </div>
              </button>

              <button
                type="button"
                className="games-card games-card--baseball"
                onClick={() => setSelected('baseball')}
              >
                <div className="games-card-cap">
                  <img className="games-card-icon" src={iconOf('baseball')} alt="" />
                </div>
                <div className="games-card-b">
                  <b>Baseball</b>
                  <span>Home Run Derby</span>
                </div>
              </button>
            </div>

            <p className="games-note">
              Each game keeps its own modes, stats &amp; leaderboard.
            </p>
          </div>
        ) : selected === 'fog' ? (
          <FogScreen onExitToHub={() => setSelected(null)} />
        ) : selected === 'tune' ? (
          <TuneScreen onExitToHub={() => setSelected(null)} />
        ) : selected === 'baseball' ? (
          <Suspense fallback={<div className="bb-menu bb-sub">Warming up…</div>}>
            <BaseballScreen onExitToHub={() => setSelected(null)} />
          </Suspense>
        ) : (
          <GolfScreen onExitToHub={() => setSelected(null)} />
        )}
      </div>
    </Page>
  );
}
