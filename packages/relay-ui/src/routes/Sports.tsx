import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { SportsCard } from '../components/SportsCard';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { SportsSub } from '../lib/types';

// Dedicated /sports tab. Hosts the per-team card stack that used to
// live at the top of /feeds — pulling it out of Updates keeps the
// social and scores surfaces independent (one for what your contacts
// are saying, one for how your teams are doing). The drill-down at
// /sports/:league/:id is unchanged.
export function Sports() {
  const me = useStore((s) => s.me);
  const [subs, setSubs] = useState<SportsSub[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Track the most recent live state outside React so the polling
  // interval can re-arm itself without re-mounting.
  const liveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function loadSports() {
      try {
        const r = await api.getSports();
        if (cancelled) return;
        setSubs(r.subs ?? []);
        liveRef.current = (r.subs ?? []).some((s) => s.current?.status === 'live');
      } catch {
        /* swallow — failure renders the "no teams" CTA below */
      } finally {
        if (cancelled) return;
        setLoaded(true);
        // 30s while a game is live, 5min otherwise.
        timer = window.setTimeout(loadSports, liveRef.current ? 30_000 : 300_000);
      }
    }
    loadSports();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

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
        <div className="px-4">
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
