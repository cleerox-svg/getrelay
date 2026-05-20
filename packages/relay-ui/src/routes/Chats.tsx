import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PinDisplay } from '../components/PinDisplay';
import { useStore } from '../lib/store';

function formatRelative(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  const d = new Date(ts);
  if (diff < 86_400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff < 7 * 86_400_000) return 'Yesterday';
  return d.toLocaleDateString();
}

export function Chats() {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const loadChats = useStore((s) => s.loadChats);
  const nav = useNavigate();

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>RELAY</h1>
        <Link to="/add-contact" aria-label="Add contact" className="btn-ghost">
          ⊕
        </Link>
        <Link to="/profile" aria-label="Profile" className="btn-ghost">
          ⚙
        </Link>
      </header>
      {me ? (
        <div
          style={{
            padding: '12px 16px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            borderBottom: '1px solid var(--surface)',
          }}
        >
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Your PIN</div>
            <PinDisplay pin={me.pin} />
          </div>
          <button
            className="btn-ghost"
            onClick={() => navigator.clipboard.writeText(me.pin).catch(() => undefined)}
          >
            📋
          </button>
        </div>
      ) : null}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {chats.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 40 }}>
            No chats yet. Tap ⊕ to add a contact.
          </div>
        ) : null}
        {chats.map((c) => {
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
                padding: '14px 16px',
                borderBottom: '1px solid var(--surface)',
                display: 'flex',
                gap: 12,
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: 'transparent',
                  border: `2px solid var(--text-dim)`,
                  flex: '0 0 auto',
                }}
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
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {c.peer?.displayName ?? c.subject ?? 'Chat'}
                  </strong>
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
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
                  }}
                >
                  {preview || ' '}
                </div>
              </div>
              {c.unreadCount > 0 ? (
                <span
                  style={{
                    background: 'var(--accent)',
                    color: '#0A0A0E',
                    borderRadius: 999,
                    padding: '2px 8px',
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  {c.unreadCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
