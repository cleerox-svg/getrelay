import { useEffect, useMemo, useState } from 'react';
import { Block } from 'konsta/react';
import { api } from '../lib/api';
import type {
  SportsStandingGroup,
  SportsLeaderList,
  SportsStandingRow,
  SportsStatsResponse,
} from '../lib/types';
import { LeagueChip, sportsCardStyle } from '../components/sportsShared';

type League = 'NHL' | 'MLB';

// A sortable standings column. `get` is the numeric value used for sorting;
// `fmt` is what the cell shows. `descFirst` is the natural direction on first
// tap (points/wins read high→low; losses/OT/games-back read low→high).
interface Column {
  key: string;
  label: string;
  get: (r: SportsStandingRow) => number;
  fmt: (r: SportsStandingRow) => string;
  descFirst: boolean;
}

const NHL_COLUMNS: Column[] = [
  { key: 'gp', label: 'GP', get: (r) => r.gp ?? 0, fmt: (r) => String(r.gp ?? 0), descFirst: true },
  { key: 'w', label: 'W', get: (r) => r.wins, fmt: (r) => String(r.wins), descFirst: true },
  { key: 'l', label: 'L', get: (r) => r.losses, fmt: (r) => String(r.losses), descFirst: false },
  { key: 'ot', label: 'OT', get: (r) => r.ot ?? 0, fmt: (r) => String(r.ot ?? 0), descFirst: false },
  { key: 'pts', label: 'PTS', get: (r) => r.points ?? 0, fmt: (r) => String(r.points ?? 0), descFirst: true },
];

const parseGb = (gb: string | null): number =>
  gb && gb !== '-' ? parseFloat(gb) || 0 : 0;

const MLB_COLUMNS: Column[] = [
  { key: 'w', label: 'W', get: (r) => r.wins, fmt: (r) => String(r.wins), descFirst: true },
  { key: 'l', label: 'L', get: (r) => r.losses, fmt: (r) => String(r.losses), descFirst: false },
  {
    key: 'pct',
    label: 'PCT',
    get: (r) => parseFloat(r.pct ?? '0') || 0,
    fmt: (r) => r.pct ?? '—',
    descFirst: true,
  },
  { key: 'gb', label: 'GB', get: (r) => parseGb(r.gb), fmt: (r) => r.gb ?? '—', descFirst: false },
];

const COLUMNS: Record<League, Column[]> = { NHL: NHL_COLUMNS, MLB: MLB_COLUMNS };
const DEFAULT_SORT: Record<League, string> = { NHL: 'pts', MLB: 'pct' };

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

const NUM_COL_WIDTH = 30;

function TeamLogo({ logo, abbr }: { logo: string | null; abbr: string }) {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        width={20}
        height={20}
        style={{ width: 20, height: 20, objectFit: 'contain', flex: '0 0 auto' }}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
    );
  }
  return (
    <span
      style={{
        width: 20,
        height: 20,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        background: 'var(--bubble-them, #E5E5EA)',
        fontSize: 9,
        fontWeight: 700,
      }}
    >
      {abbr || '·'}
    </span>
  );
}

function StandingsCard({
  group,
  columns,
  sort,
  onSort,
}: {
  group: SportsStandingGroup;
  columns: Column[];
  sort: SortState;
  onSort: (key: string) => void;
}) {
  // columns is always one of the non-empty NHL/MLB constants.
  const col = (columns.find((c) => c.key === sort.key) ?? columns[0])!;
  const rows = useMemo(() => {
    const sorted = [...group.rows];
    sorted.sort((a, b) => {
      const diff = col.get(a) - col.get(b);
      return sort.dir === 'desc' ? -diff : diff;
    });
    return sorted;
  }, [group.rows, col, sort.dir]);

  return (
    <div className="sports-card" style={sportsCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <LeagueChip league={group.league} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{group.division}</span>
      </div>

      {/* Column header row — tap to sort by that column. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '2px 0 4px',
          borderBottom: '1px solid var(--separator, rgba(0,0,0,0.06))',
        }}
      >
        <span style={{ width: 16, flex: '0 0 auto' }} />
        <span style={{ width: 20, flex: '0 0 auto' }} />
        <span style={{ flex: 1, minWidth: 0 }} />
        {columns.map((c) => {
          const active = c.key === sort.key;
          return (
            <button
              key={c.key}
              onClick={() => onSort(c.key)}
              style={{
                width: NUM_COL_WIDTH,
                flex: '0 0 auto',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'right',
                padding: 0,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.2,
                color: active ? 'var(--accent, #007AFF)' : 'var(--text-dim)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.label}
              {active ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
            </button>
          );
        })}
      </div>

      {rows.map((row, i) => (
        <div
          key={row.teamId || row.name}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 0',
            borderTop: i === 0 ? 'none' : '1px solid var(--separator, rgba(0,0,0,0.06))',
          }}
        >
          <span
            style={{
              width: 16,
              flex: '0 0 auto',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {i + 1}
          </span>
          <TeamLogo logo={row.logo} abbr={row.abbr} />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {row.name}
          </span>
          {columns.map((c) => (
            <span
              key={c.key}
              style={{
                width: NUM_COL_WIDTH,
                flex: '0 0 auto',
                textAlign: 'right',
                fontSize: 13,
                fontWeight: c.key === sort.key ? 700 : 500,
                color: c.key === sort.key ? 'var(--text)' : 'var(--text-dim)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {c.fmt(row)}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

function LeadersCard({ list }: { list: SportsLeaderList }) {
  return (
    <div className="sports-card" style={sportsCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <LeagueChip league={list.league} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{list.category}</span>
      </div>
      {list.rows.map((row, i) => (
        <div
          key={`${row.rank}-${row.name}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '5px 0',
            borderTop: i === 0 ? 'none' : '1px solid var(--separator, rgba(0,0,0,0.06))',
          }}
        >
          <span
            style={{
              width: 16,
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {row.rank}
          </span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 14,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
            }}
          >
            {row.name}
            {row.team ? (
              <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-dim)' }}>{row.team}</span>
            ) : null}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 16,
        marginBottom: -4,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 0.6,
        textTransform: 'uppercase',
        color: 'var(--text-dim)',
      }}
    >
      {children}
    </div>
  );
}

// NHL / MLB sub-toggle inside the Stats page. Mirrors the Scores/News/Stats
// segmented control so the nesting reads consistently. Defaults to NHL.
function LeagueToggle({ league, onChange }: { league: League; onChange: (l: League) => void }) {
  const leagues: League[] = ['NHL', 'MLB'];
  return (
    <div style={{ padding: '0 16px 4px' }}>
      <div
        style={{
          display: 'flex',
          background: 'var(--bubble-them, #E5E5EA)',
          borderRadius: 10,
          padding: 3,
          gap: 3,
        }}
      >
        {leagues.map((l) => {
          const active = l === league;
          return (
            <button
              key={l}
              onClick={() => onChange(l)}
              style={{
                flex: 1,
                border: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                background: active ? 'var(--accent, #007AFF)' : 'transparent',
                color: active ? 'white' : 'var(--text)',
                borderRadius: 8,
                padding: '5px 0',
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {l}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function SportsStats() {
  const [data, setData] = useState<SportsStatsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [league, setLeague] = useState<League>('NHL');
  // Sort is tracked per league so switching leagues restores that league's
  // last (or default) sort.
  const [sortByLeague, setSortByLeague] = useState<Record<League, SortState>>({
    NHL: { key: DEFAULT_SORT.NHL, dir: 'desc' },
    MLB: { key: DEFAULT_SORT.MLB, dir: 'desc' },
  });

  useEffect(() => {
    let alive = true;
    api
      .sportsStats()
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const columns = COLUMNS[league];
  const sort = sortByLeague[league];

  function handleSort(key: string) {
    setSortByLeague((prev) => {
      const cur = prev[league];
      let dir: 'asc' | 'desc';
      if (cur.key === key) {
        dir = cur.dir === 'desc' ? 'asc' : 'desc';
      } else {
        const col = columns.find((c) => c.key === key);
        dir = col?.descFirst ? 'desc' : 'asc';
      }
      return { ...prev, [league]: { key, dir } };
    });
  }

  if (failed) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">Couldn’t load stats right now.</div>
      </Block>
    );
  }
  if (data === null) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">Loading…</div>
      </Block>
    );
  }

  const standings = data.standings.filter((g) => g.league === league);
  const leaders = data.leaders.filter((l) => l.league === league);

  return (
    <>
      <LeagueToggle league={league} onChange={setLeague} />
      <div
        className="px-4"
        style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
      >
        {standings.length === 0 && leaders.length === 0 ? (
          <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
            <div className="text-sm">No {league} stats available right now.</div>
          </Block>
        ) : (
          <>
            {standings.length > 0 ? <SectionLabel>Standings</SectionLabel> : null}
            {standings.map((g) => (
              <StandingsCard
                key={`${g.league}-${g.division}`}
                group={g}
                columns={columns}
                sort={sort}
                onSort={handleSort}
              />
            ))}
            {leaders.length > 0 ? <SectionLabel>League leaders</SectionLabel> : null}
            {leaders.map((l) => (
              <LeadersCard key={`${l.league}-${l.category}`} list={l} />
            ))}
          </>
        )}
      </div>
    </>
  );
}
