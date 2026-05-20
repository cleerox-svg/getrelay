import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Block,
  Icon,
  List,
  ListItem,
  Navbar,
  Page,
  Segmented,
  SegmentedButton,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { useStore } from '../lib/store';

function formatRelative(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 86_400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff < 7 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Chats() {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const presence = useStore((s) => s.presence);
  const loadChats = useStore((s) => s.loadChats);
  const nav = useNavigate();
  const [section, setSection] = useState<'messages' | 'groups'>('messages');

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
        right={
          <Link to="/add-contact" className="px-3" aria-label="Add contact">
            <Icon
              ios={
                <svg viewBox="0 0 28 28" width="28" height="28">
                  <path
                    d="M14 7v14M7 14h14"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Chats</h1>

      <Block strong inset className="!mt-2">
        <Segmented strong>
          <SegmentedButton active={section === 'messages'} onClick={() => setSection('messages')}>
            Messages
          </SegmentedButton>
          <SegmentedButton
            active={false}
            onClick={() => undefined}
            className="opacity-40 pointer-events-none"
          >
            Groups
          </SegmentedButton>
        </Segmented>
      </Block>

      {chats.length === 0 ? (
        <Block className="text-center" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">No chats yet</div>
          <div className="text-sm">Tap + to add a contact by PIN.</div>
        </Block>
      ) : (
        <List strongIos insetIos>
          {chats.map((c) => {
            const peerOnline = c.peer ? presence[c.peer.id]?.online ?? false : false;
            const last = c.lastMessage;
            const preview = last?.deletedAt
              ? 'Message recalled'
              : last?.messageType === 'ping'
                ? 'sent a PING!!'
                : (last?.body ?? '');
            return (
              <ListItem
                key={c.id}
                link
                chevronIos={false}
                onClick={() => nav(`/chats/${encodeURIComponent(c.id)}`)}
                media={
                  <Avatar
                    src={c.peer?.avatarUrl ?? null}
                    name={c.peer?.displayName ?? c.subject ?? 'Chat'}
                    size={44}
                    online={peerOnline}
                  />
                }
                title={c.peer?.displayName ?? c.subject ?? 'Chat'}
                text={preview || ' '}
                after={
                  <div className="flex items-center gap-2">
                    <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                      {formatRelative(c.lastActivityAt)}
                    </span>
                    {c.unreadCount > 0 ? (
                      <span
                        className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[12px] font-bold text-white"
                        style={{ background: 'var(--accent)' }}
                      >
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    ) : null}
                  </div>
                }
              />
            );
          })}
        </List>
      )}
    </Page>
  );
}
