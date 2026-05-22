import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Tabbar, TabbarLink } from 'konsta/react';
import { InstallPrompt } from '../components/InstallPrompt';
import { PushPrompt } from '../components/PushPrompt';
import { useLegacyUi } from '../lib/legacy';
import { useStore } from '../lib/store';

const TABS = [
  { to: '/chats',    label: 'Chats',    icon: ChatsIcon },
  { to: '/sports',   label: 'Sports',   icon: SportsIcon },
  { to: '/feeds',    label: 'Feeds',    icon: FeedsIcon },
  { to: '/discover', label: 'Discover', icon: DiscoverIcon },
  { to: '/contacts', label: 'Contacts', icon: ContactsIcon },
];

export function MainLayout() {
  const nav = useNavigate();
  const loc = useLocation();
  const legacy = useLegacyUi();
  const unread = useStore((s) => s.chats.reduce((n, c) => n + (c.unreadCount ?? 0), 0));
  // True when any followed team has a live game right now. Drives a
  // small red dot on the Sports tab so the user notices without
  // having to switch tabs to check. Selector is a `.some()` over a
  // typically-2-element array — cheap enough to recompute every
  // render even if Zustand re-fires.
  const anyLive = useStore((s) =>
    s.sportsSubs.some((sub) => sub.current?.status === 'live'),
  );

  // Classic mode gets its own tab bar instead of Konsta's. Same
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
                  {t.to === '/sports' && anyLive ? (
                    <span
                      className="l-tab-badge l-tab-badge-dot"
                      aria-label="live game"
                    />
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
                  {t.to === '/sports' && anyLive ? (
                    <span
                      aria-label="live game"
                      className="absolute -top-0.5 -right-1 inline-block w-[10px] h-[10px] rounded-full live-dot"
                      style={{
                        background: 'var(--ping)',
                        boxShadow:
                          '0 0 0 2px var(--page-bg, #FFFFFF), inset 0 1px 0 rgba(255,255,255,0.3)',
                      }}
                    />
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
function SportsIcon({ active }: { active: boolean }) {
  // Three-bar podium — universal "scoreboard / standings" glyph.
  // Tallest pillar in the middle (1st place), shorter flanks (2nd
  // and 3rd) sit lower. Reads at 28px without needing detail.
  return (
    <svg viewBox="0 0 28 28" width="28" height="28">
      <g
        stroke="currentColor"
        strokeWidth={active ? 2 : 1.6}
        fill={active ? 'currentColor' : 'none'}
        fillOpacity={active ? 0.12 : 0}
        strokeLinejoin="round"
      >
        <rect x="11" y="6" width="6" height="17" rx="1" />
        <rect x="4" y="11" width="6" height="12" rx="1" />
        <rect x="18" y="13" width="6" height="10" rx="1" />
      </g>
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
