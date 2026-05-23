import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { SportsCard } from '../components/SportsCard';
import { useStore } from '../lib/store';
import type { SportsGame, SportsSub } from '../lib/types';

interface CardItem {
  game: SportsGame;
  teamKey: string;
  isPrevious: boolean;
  hasCurrent: boolean;
}

// Display order across all followed teams:
//   0. live games today
//   1. games not played yet today (next-up first)
//   2. finished games today
//   3. previous-day results (most recent first)
// Without live games, group 1 floats to the top — so the first card
// is always "what's next today" when nothing is in progress.
function bucket(item: CardItem): number {
  if (item.isPrevious) return 3;
  if (item.game.status === 'live') return 0;
  if (item.game.status === 'pre') return 1;
  return 2;
}

function sortItems(subs: SportsSub[]): CardItem[] {
  const items: CardItem[] = [];
  for (const s of subs) {
    if (s.current) {
      items.push({ game: s.current, teamKey: s.teamKey, isPrevious: false, hasCurrent: true });
    }
    if (s.previous) {
      items.push({
        game: s.previous,
        teamKey: s.teamKey,
        isPrevious: true,
        hasCurrent: !!s.current,
      });
    }
  }
  items.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Previous-day cards read most-recent-first; everything else
    // (live / next-up / finished today) reads earliest-first so the
    // card you most care about right now sits at the top of its
    // group.
    return ba === 3 ? b.game.startTime - a.game.startTime : a.game.startTime - b.game.startTime;
  });
  return items;
}

// Dedicated /sports tab. Reads from the store-level poller (started
// in RequireAuth) so the data stays warm even when this tab isn't
// mounted — that's what makes the bottom-nav live-game badge possible.
export function Sports() {
  const me = useStore((s) => s.me);
  const subs = useStore((s) => s.sportsSubs);
  const loaded = useStore((s) => s.sportsLoaded);
  const items = sortItems(subs);

  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar
              src={me?.avatarUrl ?? null}
              name={me?.displayName ?? me?.email ?? 'Me'}
              size={30}
            />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Sports</h1>

      {items.length > 0 ? (
        // Bottom padding leaves the last card breathing room above
        // the fixed Tabbar. Without it the card's bottom edge sits
        // under the tab bar and the page can feel scroll-locked when
        // the user's touch starts in that overlap zone.
        <div
          className="px-4"
          style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
        >
          {items.map((item) => (
            <SportsCard
              key={`${item.game.league}-${item.teamKey}-${item.isPrevious ? 'prev' : 'curr'}-${item.game.id || item.game.startTime}`}
              game={item.game}
              teamKey={item.teamKey}
              label={
                item.isPrevious
                  ? item.hasCurrent
                    ? 'Last game'
                    : 'No game today · Last result'
                  : undefined
              }
            />
          ))}
        </div>
      ) : subs.length === 0 && loaded ? (
        <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">No teams followed yet</div>
          <div className="text-sm">
            Pick teams in{' '}
            <Link to="/settings/sports" style={{ color: 'var(--accent)' }}>
              Profile → Sports
            </Link>{' '}
            to see scores here.
          </div>
        </Block>
      ) : null}
    </Page>
  );
}
