import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { useStore } from '../lib/store';
import type { Chat } from '../lib/types';

function formatRelative(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'now';
  if (diff < 86_400_000) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff < 7 * 86_400_000) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function LegacyChats() {
  const me = useStore((s) => s.me);
  const chats = useStore((s) => s.chats);
  const presence = useStore((s) => s.presence);
  const loadChats = useStore((s) => s.loadChats);
  const deleteChat = useStore((s) => s.deleteChat);
  const nav = useNavigate();
  const [section, setSection] = useState<'chats' | 'groups'>('chats');
  const [confirmDelete, setConfirmDelete] = useState<Chat | null>(null);
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  function onPressStart(c: Chat) {
    longPressFiredRef.current = false;
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setConfirmDelete(c);
    }, 450);
  }
  function onPressEnd() {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  }
  function onPressClick(c: Chat) {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    nav(`/chats/${encodeURIComponent(c.id)}`);
  }

  useEffect(() => {
    loadChats();
  }, [loadChats]);

  const visible = chats.filter((c) =>
    section === 'groups' ? c.type === 'group' : c.type === '1to1',
  );

  return (
    <div className="legacy-page">
      <header className="legacy-navbar">
        <Link
          to="/profile"
          aria-label="Profile"
          style={{ display: 'inline-flex', marginRight: 4 }}
        >
          <Avatar
            src={me?.avatarUrl ?? null}
            name={me?.displayName ?? me?.email ?? 'Me'}
            size={32}
          />
        </Link>
        <div className="l-title">
          <span>Relay</span>
          {me?.statusMessage ? (
            <span className="l-title-sub">{me.statusMessage}</span>
          ) : null}
        </div>
        <div className="l-right">
          <Link to="/add-contact" aria-label="Add contact">
            <svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
              <path
                d="M14 7v14M7 14h14"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </Link>
        </div>
      </header>

      <nav className="legacy-tabstrip" role="tablist">
        <button
          role="tab"
          aria-selected={section === 'chats'}
          className={section === 'chats' ? 'active' : undefined}
          onClick={() => setSection('chats')}
        >
          CHATS
        </button>
        <button
          role="tab"
          aria-selected={section === 'groups'}
          className={section === 'groups' ? 'active' : undefined}
          onClick={() => setSection('groups')}
        >
          GROUPS
        </button>
      </nav>

      {visible.length === 0 ? (
        <div className="legacy-empty">
          {section === 'groups' ? (
            <>
              <div style={{ fontSize: 15, marginBottom: 8 }}>No groups yet</div>
              <Link
                to="/new-group"
                style={{
                  display: 'inline-block',
                  background: 'var(--legacy-blue)',
                  color: '#FFFFFF',
                  padding: '8px 16px',
                  borderRadius: 999,
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                New group
              </Link>
            </>
          ) : (
            <>
              <div style={{ fontSize: 15, marginBottom: 8 }}>No chats yet</div>
              <div style={{ fontSize: 13 }}>Tap + to add a contact by PIN.</div>
            </>
          )}
        </div>
      ) : (
        <div className="legacy-list">
          {visible.map((c) => {
            const isGroup = c.type === 'group';
            const peerOnline = c.peer ? presence[c.peer.id]?.online ?? false : false;
            const last = c.lastMessage;
            const lastPreview = last?.deletedAt
              ? 'Message recalled'
              : last?.messageType === 'ping'
                ? 'sent a PING!!'
                : last?.messageType === 'image'
                  ? '📷 Photo'
                  : (last?.body ?? '');
            // Classic rows show the contact's current status under their
            // name. Fall back to the last-message preview when they haven't
            // set one (or for groups, where status doesn't apply).
            const subtitle = isGroup
              ? `${c.memberCount ?? '–'} members`
              : (c.peer?.statusMessage?.trim() || lastPreview);
            const name = c.peer?.displayName ?? c.subject ?? 'Chat';

            return (
              <button
                key={c.id}
                type="button"
                className="legacy-list-row"
                onClick={() => onPressClick(c)}
                onMouseDown={() => onPressStart(c)}
                onMouseUp={onPressEnd}
                onMouseLeave={onPressEnd}
                onTouchStart={() => onPressStart(c)}
                onTouchEnd={onPressEnd}
                onTouchCancel={onPressEnd}
              >
                {isGroup ? (
                  <GroupAvatar subject={c.subject ?? 'Group'} size={44} />
                ) : (
                  <Avatar
                    src={c.peer?.avatarUrl ?? null}
                    name={name}
                    size={44}
                  />
                )}
                <div className="l-meta">
                  <div className="l-name">
                    {!isGroup && peerOnline ? <span className="l-name-dot" /> : null}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {name}
                    </span>
                  </div>
                  <div className="l-preview">{subtitle || ' '}</div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 4,
                  }}
                >
                  <span className="l-time">{formatRelative(c.lastActivityAt)}</span>
                  {c.unreadCount > 0 ? (
                    <span
                      style={{
                        background: 'var(--legacy-blue)',
                        color: '#FFFFFF',
                        fontSize: 11,
                        fontWeight: 700,
                        borderRadius: 999,
                        padding: '1px 7px',
                        minWidth: 20,
                        textAlign: 'center',
                      }}
                    >
                      {c.unreadCount > 99 ? '99+' : c.unreadCount}
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <Link
        to={section === 'groups' ? '/new-group' : '/add-contact'}
        className="legacy-fab"
        aria-label={section === 'groups' ? 'New group' : 'Add contact'}
      >
        <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden="true">
          <path
            d="M14 7v14M7 14h14"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </svg>
      </Link>

      {confirmDelete ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setConfirmDelete(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 30,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--legacy-card-bg)',
              color: 'var(--legacy-text)',
              borderRadius: 8,
              minWidth: 260,
              maxWidth: 320,
              padding: 16,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
            }}
          >
            <div style={{ fontSize: 15, marginBottom: 14 }}>
              Delete this chat?
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
              }}
            >
              <button
                onClick={() => setConfirmDelete(null)}
                style={{
                  padding: '8px 14px',
                  color: 'var(--legacy-text-dim)',
                  fontWeight: 600,
                  fontSize: 14,
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const id = confirmDelete.id;
                  setConfirmDelete(null);
                  deleteChat(id).catch(() => undefined);
                }}
                style={{
                  padding: '8px 14px',
                  color: 'var(--legacy-ping, #E5443B)',
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
