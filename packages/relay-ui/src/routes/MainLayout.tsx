import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Tabbar, TabbarLink } from 'konsta/react';
import { InstallPrompt } from '../components/InstallPrompt';
import { PushPrompt } from '../components/PushPrompt';
import { useLegacyUi } from '../lib/legacy';
import { useStore } from '../lib/store';

const TABS = [
  { to: '/chats',    label: 'Chats',    icon: ChatsIcon },
  { to: '/calls',    label: 'Calls',    icon: CallsIcon },
  { to: '/feeds',    label: 'Feeds',    icon: FeedsIcon },
  { to: '/discover', label: 'Discover', icon: DiscoverIcon },
  { to: '/contacts', label: 'Contacts', icon: ContactsIcon },
];

export function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const legacy = useLegacyUi();
  const unread = useStore((s) => s.chats.reduce((n, c) => n + (c.unreadCount ?? 0), 0));

  // Legacy mode gets its own BBM-style tab bar instead of Konsta's. Same
  // five destinations so the user isn't locked into Chats.
  if (legacy) {
    return (
      <>
        <Outlet />
        <InstallPrompt />
        <PushPrompt />
        <nav
          className="legacy-tabbar"
          role="tablist"
          aria-label="Sections"
        >
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = loc.pathname === t.to;
            return (
              <button
                type="button"
                key={t.to}
                role="tab"
                aria-selected={active}
                className={active ? 'active' : undefined}
                onClick={() => nav(t.to)}
              >
                <span className="l-tab-icon">
                  <Icon active={active} />
                  {t.to === '/chats' && unread > 0 ? (
                    <span className="l-tab-badge">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </span>
                <span className="l-tab-label">{t.label}</span>
              </button>
            );
          })}
        </nav>
      </>
    );
  }

  return (
    <>
      <Outlet />
      <InstallPrompt />
      <PushPrompt />
      <Tabbar labels icons className="left-0 bottom-0 fixed">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = loc.pathname === t.to;
          return (
            <TabbarLink
              key={t.to}
              active={active}
              onClick={() => nav(t.to)}
              icon={
                <span className="relative inline-block">
                  <Icon active={active} />
                  {t.to === '/chats' && unread > 0 ? (
                    <span
                      className="absolute -top-1 -right-2 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-bold text-white"
                      style={{ background: 'var(--ping)' }}
                    >
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </span>
              }
              label={t.label}
            />
          );
        })}
      </Tabbar>
    </>
  );
}

function strokeColor(active: boolean): string {
  return active ? 'currentColor' : 'currentColor';
}

function ChatsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <path
        d="M5 8a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7l-4 3v-3H8a3 3 0 0 1-3-3z"
        stroke={strokeColor(active)}
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
        strokeLinejoin="round"
      />
    </svg>
  );
}
function CallsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <path
        d="M7 5h3l2 5-2.5 1.5a11 11 0 0 0 6 6L17 15l5 2v3a2 2 0 0 1-2 2A15 15 0 0 1 5 7a2 2 0 0 1 2-2z"
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
        strokeLinejoin="round"
      />
    </svg>
  );
}
function FeedsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <g
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="5" y="6" width="18" height="16" rx="3" />
        <path d="M9 11h10M9 15h10M9 19h7" stroke="currentColor" fill="none" />
      </g>
    </svg>
  );
}
function DiscoverIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <g
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
      >
        <circle cx="14" cy="14" r="9" />
        <path d="m17 11-2 6-6 2 2-6 6-2Z" fill={active ? 'currentColor' : 'none'} />
      </g>
    </svg>
  );
}
function ContactsIcon({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <g
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
        strokeLinejoin="round"
      >
        <circle cx="14" cy="10" r="4" />
        <path d="M5 23c1-4 5-6 9-6s8 2 9 6" />
      </g>
    </svg>
  );
}
