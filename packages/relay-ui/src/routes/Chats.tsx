import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { SegmentedControl } from '../components/SegmentedControl';
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
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px 4px',
        }}
      >
        <Link to="/profile" aria-label="Profile">
          <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={32} />
        </Link>
        <div style={{ flex: 1 }} />
        <Link to="/add-contact" className="btn-ghost" aria-label="Add contact">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
              <path d="M12 6v12M6 12h12" />
            </g>
          </svg>
        </Link>
      </div>

      <h1 className="large-title">Chats</h1>

      <SegmentedControl
        value={section}
        options={[
          { value: 'messages', label: 'Messages' },
          { value: 'groups', label: 'Groups', disabled: true },
        ]}
        onChange={(v) => setSection(v as 'messages' | 'groups')}
      />

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {chats.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--text-dim)',
              padding: '60px 24px',
            }}
          >
            <div style={{ fontSize: 16, marginBottom: 8 }}>No chats yet</div>
            <div style={{ fontSize: 14 }}>Tap + above to add a contact by PIN.</div>
          </div>
        ) : null}

        {chats.map((c) => {
          const peerOnline = c.peer ? presence[c.peer.id]?.online ?? false : false;
          const last = c.lastMessage;
          const preview = last?.deletedAt
            ? 'Message recalled'
            : last?.messageType === 'ping'
              ? 'sent a PING!!'
              : (last?.body ?? '');
          return (
            <button
              key={c.id}
              onClick={() => nav(`/chats/${encodeURIComponent(c.id)}`)}
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '10px 16px',
                background: 'var(--bg)',
                borderBottom: '1px solid var(--separator)',
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                minHeight: 'auto',
                minWidth: 'auto',
              }}
            >
              <Avatar
                src={c.peer?.avatarUrl ?? null}
                name={c.peer?.displayName ?? c.subject ?? 'Chat'}
                size={44}
                online={peerOnline}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <strong
                    style={{
                      fontWeight: 600,
                      fontSize: 16,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.peer?.displayName ?? c.subject ?? 'Chat'}
                  </strong>
                  <span style={{ color: 'var(--text-dim)', fontSize: 13, flex: '0 0 auto' }}>
                    {formatRelative(c.lastActivityAt)}
                  </span>
                </div>
                <div
                  style={{
                    color: 'var(--text-dim)',
                    fontSize: 14,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginTop: 2,
                  }}
                >
                  {preview || ' '}
                </div>
              </div>
              {c.unreadCount > 0 ? (
                <span
                  style={{
                    background: 'var(--accent)',
                    color: '#FFFFFF',
                    borderRadius: 999,
                    minWidth: 22,
                    height: 22,
                    padding: '0 7px',
                    fontWeight: 700,
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {c.unreadCount > 99 ? '99+' : c.unreadCount}
                </span>
              ) : (
                <span style={{ color: 'var(--text-dim)', fontSize: 18 }} aria-hidden="true">
                  ›
                </span>
              )}
            </button>
          );
        })}
      </div>
    </>
  );
}
