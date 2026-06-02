import { useEffect, useState } from 'react';
import { Block } from 'konsta/react';
import { api } from '../lib/api';
import type { SportsStandingGroup, SportsLeaderList, SportsStatsResponse } from '../lib/types';
import { LeagueChip, sportsCardStyle } from '../components/sportsShared';

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

function StandingsCard({ group }: { group: SportsStandingGroup }) {
  const isNhl = group.league === 'NHL';
  return (
    <div className="sports-card" style={sportsCardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <LeagueChip league={group.league} />
        <span style={{ fontSize: 14, fontWeight: 700 }}>{group.division}</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            color: 'var(--text-dim)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {isNhl ? 'PTS' : 'PCT · GB'}
        </span>
      </div>
      {group.rows.map((row, i) => (
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
          <span
            style={{
              fontSize: 12,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {isNhl ? `${row.wins}-${row.losses}-${row.ot ?? 0}` : `${row.wins}-${row.losses}`}
          </span>
          <span
            style={{
              minWidth: 52,
              textAlign: 'right',
              fontSize: 13,
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {isNhl ? (row.points ?? 0) : `${row.pct ?? '—'}${row.gb && row.gb !== '-' ? ` · ${row.gb}` : ''}`}
          </span>
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

export function SportsStats() {
  const [data, setData] = useState<SportsStatsResponse | null>(null);
  const [failed, setFailed] = useState(false);

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
  if (data.standings.length === 0 && data.leaders.length === 0) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">No stats available right now.</div>
      </Block>
    );
  }

  return (
    <div
      className="px-4"
      style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
    >
      {data.standings.length > 0 ? <SectionLabel>Standings</SectionLabel> : null}
      {data.standings.map((g) => (
        <StandingsCard key={`${g.league}-${g.division}`} group={g} />
      ))}
      {data.leaders.length > 0 ? <SectionLabel>League leaders</SectionLabel> : null}
      {data.leaders.map((l) => (
        <LeadersCard key={`${l.league}-${l.category}`} list={l} />
      ))}
    </div>
  );
}
