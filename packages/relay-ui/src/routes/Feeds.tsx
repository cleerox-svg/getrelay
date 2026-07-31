import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Block, List, ListItem, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { api } from '../lib/api';
import { useBetaUi } from '../lib/legacy';
import { useStore } from '../lib/store';
import type { ContactStatus, FeedEvent, GameFeedEvent } from '../lib/types';

// /feeds is the social surface: contact statuses merged with notable Fog
// runs, newest first. Sports lives on its own /sports tab — keeping match
// scores out of here is what leaves room for this to read as "what my
// contacts have been up to".
export function Feeds() {
  const me = useStore((s) => s.me);
  const beta = useBetaUi();
  const nav = useNavigate();
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .listFeed()
      .then((r) => setEvents(r.events ?? statusesToEvents(r.statuses)))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  // Re-render the "2h ago" labels on a slow tick so a feed left open
  // doesn't freeze its timestamps.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  const hasGames = useMemo(() => events.some((e) => e.kind === 'game'), [events]);

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
        Statuses and Fog results from your contacts. Set your own status from{' '}
        <Link to="/profile" style={{ color: 'var(--accent)' }}>
          Profile
        </Link>
        .
      </Block>

      {!loaded ? null : events.length === 0 ? (
        <Block className="text-center !mt-4" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">Nothing here yet</div>
          <div className="text-sm">
            Set a status in Profile, play a round of{' '}
            <Link to="/discover" style={{ color: 'var(--accent)' }}>
              Fog
            </Link>
            , or add contacts to see theirs here.
          </div>
        </Block>
      ) : beta ? (
        // Beta mode renders each event as a lifted card, reusing the exact
        // .chat-card recipe from the Chats tab so the two surfaces stay
        // visually aligned. Modern mode stays on Konsta's grouped list.
        <div className="chat-card-list">
          {events.map((e) => (
            <button
              key={e.id}
              type="button"
              className="chat-card"
              onClick={() => nav(eventHref(e))}
            >
              <Avatar src={e.avatarUrl} name={e.displayName} size={44} />
              <div className="chat-card-meta">
                <span className="chat-card-title">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.displayName}
                  </span>
                  {e.mine ? (
                    <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--text-dim)' }}>
                      (you)
                    </span>
                  ) : null}
                </span>
                {e.kind === 'status' ? (
                  <span className="chat-card-preview">{e.statusMessage}</span>
                ) : (
                  <span
                    className="chat-card-preview"
                    style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                  >
                    <FogGlyph />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {gameEventText(e)}
                    </span>
                  </span>
                )}
              </div>
              <div className="chat-card-right">
                <span className="chat-card-time">{relativeTime(e.at)}</span>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <List strong inset>
          {events.map((e) => (
            <ListItem
              key={e.id}
              media={<Avatar src={e.avatarUrl} name={e.displayName} size={44} />}
              title={
                <span className="flex items-baseline gap-2">
                  <strong>{e.displayName}</strong>
                  {e.mine ? (
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      (you)
                    </span>
                  ) : null}
                </span>
              }
              text={
                e.kind === 'status' ? (
                  e.statusMessage
                ) : (
                  <span className="flex items-center gap-1.5">
                    <FogGlyph />
                    <span>{gameEventText(e)}</span>
                  </span>
                )
              }
              after={
                <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
                  {relativeTime(e.at)}
                </span>
              }
              link
              href={eventHref(e)}
            />
          ))}
        </List>
      )}

      {loaded && hasGames ? (
        <Block className="text-xs !mt-1" style={{ color: 'var(--text-dim)' }}>
          Only standout runs show up here — a first game, a personal best, a
          perfect round, or a long streak. You can stop sharing yours from{' '}
          <Link to="/profile" style={{ color: 'var(--accent)' }}>
            Profile
          </Link>
          .
        </Block>
      ) : null}
    </Page>
  );
}

// Fallback for an older worker that only returns `statuses`. Produces the
// same shape the new endpoint would, minus any game events.
function statusesToEvents(statuses: ContactStatus[]): FeedEvent[] {
  return statuses
    .map(
      (s): FeedEvent => ({
        id: `status:${s.userId}`,
        kind: 'status',
        userId: s.userId,
        displayName: s.displayName,
        pin: s.pin,
        avatarUrl: s.avatarUrl,
        mine: s.mine,
        at: s.updatedAt,
        statusMessage: s.statusMessage,
      }),
    )
    .sort((a, b) => b.at - a.at);
}

// A game event opens Fog (where the leaderboard lives); a status opens
// the contact who set it. Tapping your own status goes to Profile, which
// is the only place you can change it.
function eventHref(e: FeedEvent): string {
  if (e.kind === 'game') return '/discover';
  return e.mine ? '/profile' : `/contacts/${encodeURIComponent(e.userId)}`;
}

function gameEventText(e: GameFeedEvent): string {
  const score = e.score.toLocaleString();
  switch (e.badge) {
    case 'first':
      return `Started playing Fog — ${score}`;
    case 'best':
      return `New personal best — ${score}`;
    case 'perfect':
      return `Perfect game, ${e.rounds}/${e.rounds} rounds — ${score}`;
    case 'streak':
      return `${e.bestStreak} in a row — ${score}`;
  }
}

function relativeTime(at: number): string {
  if (!at) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Small condensation-drip mark, matching the Fog tab icon in MainLayout,
// so a score row is distinguishable from a status at a glance.
function FogGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M4 8h16M4 12h16M4 16h10"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
