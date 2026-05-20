import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';

const ICON_PATHS: Record<string, ReactNode> = {
  chats: (
    <path
      d="M4 6.5a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H10l-4 3v-3H7a3 3 0 0 1-3-3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  calls: (
    <path
      d="M5.6 4.5h2.7l1.6 4.2-2 1.4a10 10 0 0 0 5 5l1.4-2 4.2 1.6v2.7a2 2 0 0 1-2 2 14 14 0 0 1-13-13 2 2 0 0 1 2-2z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      fill="none"
    />
  ),
  feeds: (
    <g
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    >
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M7 9h10M7 13h10M7 17h6" />
    </g>
  ),
  discover: (
    <g
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="m14.6 9.4-1.7 4.9-4.9 1.7 1.7-4.9 4.9-1.7Z" />
    </g>
  ),
  contacts: (
    <g
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
      strokeLinecap="round"
      fill="none"
    >
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 19c1-3.4 4-5 7-5s6 1.6 7 5" />
    </g>
  ),
};

const TABS: { to: string; label: string; key: keyof typeof ICON_PATHS }[] = [
  { to: '/chats',    label: 'Chats',    key: 'chats' },
  { to: '/calls',    label: 'Calls',    key: 'calls' },
  { to: '/feeds',    label: 'Feeds',    key: 'feeds' },
  { to: '/discover', label: 'Discover', key: 'discover' },
  { to: '/contacts', label: 'Contacts', key: 'contacts' },
];

interface TabBarProps {
  unreadChats?: number;
}

export function TabBar({ unreadChats = 0 }: TabBarProps) {
  return (
    <nav
      aria-label="Primary"
      style={{
        position: 'sticky',
        bottom: 0,
        background: 'var(--tabbar-bg)',
        backdropFilter: 'saturate(180%) blur(14px)',
        WebkitBackdropFilter: 'saturate(180%) blur(14px)',
        borderTop: '1px solid var(--separator)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        display: 'flex',
      }}
    >
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end
          style={({ isActive }) => ({
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            padding: '8px 0 6px',
            color: isActive ? 'var(--accent)' : 'var(--text-dim)',
            fontSize: 11,
            fontWeight: 500,
            position: 'relative',
            minHeight: 'var(--tabbar-height)',
          })}
        >
          <span
            aria-hidden="true"
            style={{ width: 26, height: 26, position: 'relative', display: 'inline-block' }}
          >
            <svg viewBox="0 0 24 24" width="26" height="26">
              {ICON_PATHS[t.key]}
            </svg>
            {t.key === 'chats' && unreadChats > 0 ? (
              <span
                style={{
                  position: 'absolute',
                  top: -4,
                  right: -8,
                  minWidth: 18,
                  height: 18,
                  padding: '0 5px',
                  borderRadius: 999,
                  background: 'var(--ping)',
                  color: '#FFFFFF',
                  fontSize: 11,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {unreadChats > 99 ? '99+' : unreadChats}
              </span>
            ) : null}
          </span>
          <span>{t.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
