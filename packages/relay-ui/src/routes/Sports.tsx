import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { SportsCard } from '../components/SportsCard';
import { useStore } from '../lib/store';

// Dedicated /sports tab. Reads from the store-level poller (started
// in RequireAuth) so the data stays warm even when this tab isn't
// mounted — that's what makes the bottom-nav live-game badge possible.
export function Sports() {
  const me = useStore((s) => s.me);
  const subs = useStore((s) => s.sportsSubs);
  const loaded = useStore((s) => s.sportsLoaded);

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

      {subs.length > 0 ? (
        // Bottom padding leaves the last card breathing room above
        // the fixed Tabbar. Without it the card's bottom edge sits
        // under the tab bar and the page can feel scroll-locked when
        // the user's touch starts in that overlap zone.
        <div
          className="px-4"
          style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
        >
          {subs.map((s) => (
            <div key={`${s.league}-${s.teamKey}`}>
              {s.current ? (
                <SportsCard game={s.current} teamKey={s.teamKey} />
              ) : null}
              {s.previous ? (
                <SportsCard
                  game={s.previous}
                  teamKey={s.teamKey}
                  label={s.current ? 'Last game' : 'No game today · Last result'}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : loaded ? (
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
