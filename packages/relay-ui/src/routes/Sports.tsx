import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { SportsCard } from '../components/SportsCard';
import { SportsNews } from './SportsNews';
import { SportsStats } from './SportsStats';
import { todayYmdToronto, useStore } from '../lib/store';
import type { SportsGame, SportsSub } from '../lib/types';

type SportsTab = 'scores' | 'news' | 'stats';

// Scores / News / Stats segmented control. Scores is the default sub-page;
// News and Stats are sibling views inside the same /sports tab so the
// bottom nav and theming stay identical across them.
function SportsTabs({
  tab,
  onChange,
}: {
  tab: SportsTab;
  onChange: (t: SportsTab) => void;
}) {
  const tabs: [SportsTab, string][] = [
    ['scores', 'Scores'],
    ['news', 'News'],
    ['stats', 'Stats'],
  ];
  return (
    <div style={{ padding: '4px 16px 8px' }}>
      <div
        style={{
          display: 'flex',
          background: 'var(--bubble-them, #E5E5EA)',
          borderRadius: 10,
          padding: 3,
          gap: 3,
        }}
      >
        {tabs.map(([key, label]) => {
          const active = tab === key;
          return (
            <button
              key={key}
              onClick={() => onChange(key)}
              style={{
                flex: 1,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: active ? 'var(--accent, #007AFF)' : 'transparent',
                color: active ? 'white' : 'var(--text)',
                borderRadius: 8,
                padding: '6px 0',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface CardItem {
  game: SportsGame;
  teamKey: string;
  isPrevious: boolean;
  hasCurrent: boolean;
}

// Display order across all followed teams:
//   0. live games today
//   1. games not played yet today (next-up first)
//   2. finished games today
//   3. previous-day results (most recent first)
// Without live games, group 1 floats to the top — so the first card
// is always "what's next today" when nothing is in progress.
function bucket(item: CardItem): number {
  if (item.isPrevious) return 3;
  if (item.game.status === 'live') return 0;
  if (item.game.status === 'pre') return 1;
  return 2;
}

function sortItems(subs: SportsSub[]): CardItem[] {
  const items: CardItem[] = [];
  for (const s of subs) {
    if (s.current) {
      items.push({ game: s.current, teamKey: s.teamKey, isPrevious: false, hasCurrent: true });
    }
    if (s.previous) {
      items.push({
        game: s.previous,
        teamKey: s.teamKey,
        isPrevious: true,
        hasCurrent: !!s.current,
      });
    }
  }
  items.sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Previous-day cards read most-recent-first; everything else
    // (live / next-up / finished today) reads earliest-first so the
    // card you most care about right now sits at the top of its
    // group.
    return ba === 3 ? b.game.startTime - a.game.startTime : a.game.startTime - b.game.startTime;
  });
  return items;
}

// Shift a YYYY-MM-DD by N days in UTC. Day arithmetic is calendar-
// based, not wall-clock, so it doesn't drift across DST.
function shiftYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function shortWeekday(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

function shortMonthDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

// Horizontal day-picker strip. Renders 3 days back + today + 3 days
// forward; the selected day is highlighted and the today column is
// underlined. Horizontally scrollable so we don't have to make the
// chips smaller on narrow screens.
function DayTabs({
  selected,
  onChange,
}: {
  selected: string;
  onChange: (ymd: string) => void;
}) {
  const today = todayYmdToronto();
  const days: string[] = [];
  for (let off = -3; off <= 3; off++) days.push(shiftYmd(today, off));
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        overflowX: 'auto',
        padding: '4px 16px 8px',
        scrollSnapType: 'x mandatory',
      }}
    >
      {days.map((d) => {
        const isSelected = d === selected;
        const isToday = d === today;
        return (
          <button
            key={d}
            onClick={() => onChange(d)}
            style={{
              flex: '0 0 auto',
              minWidth: 56,
              scrollSnapAlign: 'center',
              border: 'none',
              background: isSelected ? 'var(--accent, #007AFF)' : 'transparent',
              color: isSelected ? 'white' : 'var(--text)',
              padding: '6px 10px',
              borderRadius: 10,
              cursor: 'pointer',
              fontFamily: 'inherit',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              lineHeight: 1.15,
            }}
          >
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                opacity: isSelected ? 0.85 : 0.65,
              }}
            >
              {shortWeekday(d)}
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                textDecoration: isToday && !isSelected ? 'underline' : 'none',
              }}
            >
              {shortMonthDay(d)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Dedicated /sports tab. Reads from the store-level poller (started
// in RequireAuth) so the data stays warm even when this tab isn't
// mounted — that's what makes the bottom-nav live-game badge possible.
export function Sports() {
  const me = useStore((s) => s.me);
  const sportsSubs = useStore((s) => s.sportsSubs);
  const sportsByDate = useStore((s) => s.sportsByDate);
  const loaded = useStore((s) => s.sportsLoaded);
  const selectedDate = useStore((s) => s.selectedSportsDate);
  const setSelectedSportsDate = useStore((s) => s.setSelectedSportsDate);
  const loadSportsForDate = useStore((s) => s.loadSportsForDate);

  const [tab, setTab] = useState<SportsTab>('scores');

  const today = todayYmdToronto();
  // For today we read sportsSubs directly (the poller writes there).
  // For other days we read the per-day cache, falling back to an
  // empty list while the fetch is in flight.
  const subs = selectedDate === today ? sportsSubs : sportsByDate[selectedDate] ?? [];
  const items = sortItems(subs);

  // When the selected day is anything other than today, fetch it
  // on first reveal. The poller continues to keep today fresh.
  useEffect(() => {
    if (selectedDate === today) return;
    if (sportsByDate[selectedDate] === undefined) {
      void loadSportsForDate(selectedDate);
    }
  }, [selectedDate, today, sportsByDate, loadSportsForDate]);

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

      <SportsTabs tab={tab} onChange={setTab} />

      {tab === 'news' ? (
        <SportsNews />
      ) : tab === 'stats' ? (
        <SportsStats />
      ) : (
        <ScoresTab
          selectedDate={selectedDate}
          setSelectedSportsDate={setSelectedSportsDate}
          items={items}
          sportsSubs={sportsSubs}
          loaded={loaded}
          sportsByDate={sportsByDate}
          today={today}
        />
      )}
    </Page>
  );
}

// The original /sports body: day picker + the sorted score cards. Pulled
// into its own component so the Sports tab can swap Scores / News / Stats
// without disturbing the score-feed logic.
function ScoresTab({
  selectedDate,
  setSelectedSportsDate,
  items,
  sportsSubs,
  loaded,
  sportsByDate,
  today,
}: {
  selectedDate: string;
  setSelectedSportsDate: (ymd: string) => void;
  items: CardItem[];
  sportsSubs: SportsSub[];
  loaded: boolean;
  sportsByDate: Record<string, SportsSub[]>;
  today: string;
}) {
  return (
    <>
      <DayTabs selected={selectedDate} onChange={setSelectedSportsDate} />

      {items.length > 0 ? (
        // Bottom padding leaves the last card breathing room above
        // the fixed Tabbar. Without it the card's bottom edge sits
        // under the tab bar and the page can feel scroll-locked when
        // the user's touch starts in that overlap zone.
        <div
          className="px-4"
          style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
        >
          {items.map((item) => (
            <SportsCard
              key={`${item.game.league}-${item.teamKey}-${item.isPrevious ? 'prev' : 'curr'}-${item.game.id || item.game.startTime}`}
              game={item.game}
              teamKey={item.teamKey}
              label={
                item.isPrevious
                  ? item.hasCurrent
                    ? 'Last game'
                    : 'No game today · Last result'
                  : undefined
              }
            />
          ))}
        </div>
      ) : sportsSubs.length === 0 && loaded ? (
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
      ) : selectedDate !== today && sportsByDate[selectedDate] !== undefined ? (
        // The picked day's response came back empty (no followed
        // teams played) — say so explicitly rather than rendering
        // a blank page.
        <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
          <div className="text-sm">No games for your teams on this day.</div>
        </Block>
      ) : null}
    </>
  );
}
