import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Block, List, ListItem, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { ContactStatus } from '../lib/types';

// /feeds is the contact-status surface only — sports lives on its
// own /sports tab now. Keeps social and scores from competing for
// attention on the same screen.
export function Feeds() {
  const me = useStore((s) => s.me);
  const [statuses, setStatuses] = useState<ContactStatus[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .listFeed()
      .then((r) => setStatuses(r.statuses))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

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

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Updates</h1>

      <Block className="text-sm !mt-3 !mb-2" style={{ color: 'var(--text-dim)' }}>
        Set your own status from{' '}
        <Link to="/profile" style={{ color: 'var(--accent)' }}>
          Profile
        </Link>
        .
      </Block>

      {!loaded ? null : statuses.length === 0 ? (
        <Block className="text-center !mt-4" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">No statuses yet</div>
          <div className="text-sm">
            Set yours in Profile, or add contacts to see theirs here.
          </div>
        </Block>
      ) : (
        <List strong inset>
          {statuses.map((s) => (
            <ListItem
              key={s.userId}
              media={<Avatar src={s.avatarUrl} name={s.displayName} size={44} />}
              title={
                <span className="flex items-baseline gap-2">
                  <strong>{s.displayName}</strong>
                  {s.mine ? (
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      (you)
                    </span>
                  ) : null}
                </span>
              }
              text={s.statusMessage}
              link={s.mine ? undefined : true}
              href={s.mine ? undefined : `/contacts/${encodeURIComponent(s.userId)}`}
            />
          ))}
        </List>
      )}
    </Page>
  );
}
