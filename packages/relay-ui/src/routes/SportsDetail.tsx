import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Navbar, NavbarBackLink, Page } from 'konsta/react';
import { api } from '../lib/api';
import type {
  SportsBoxPlayer,
  SportsGameDetail,
  SportsLinescorePeriod,
  SportsLinescoreTotal,
  SportsStartingGoalie,
  SportsTeamBox,
  SportsTeamLeaders,
  SportsTeamSeasonStats,
} from '../lib/types';

function leagueAccent(league: 'NHL' | 'MLB'): string {
  return league === 'NHL' ? '#AF1E2D' : '#134A8E';
}

// Tiny stat tile for the StartingGoalies card. Right-aligned numeric
// columns share a fixed width so the W / L / OTL / SO / GAA / SV%
// stack lines up across home / away. Renders an em-dash when the
// upstream omits a value (rookies or short-season backups).
function GoalieStat({ label, value }: { label: string; value: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 36 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.6,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

function formatSavePct(n: number | null): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  // ".932" — NHL convention, no leading zero, three decimals.
  return n.toFixed(3).replace(/^0/, '');
}

function GoalieRow({ g }: { g: SportsStartingGoalie }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        flexWrap: 'wrap',
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>{g.name}</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-dim)' }}>
            {g.teamAbbr}
          </span>
          {g.starter ? (
            <span
              style={{
                background: 'var(--bubble-them, #E5E5EA)',
                color: 'var(--text)',
                padding: '1px 7px',
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              Likely
            </span>
          ) : null}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <GoalieStat label="W" value={g.wins == null ? null : String(g.wins)} />
        <GoalieStat label="L" value={g.losses == null ? null : String(g.losses)} />
        <GoalieStat label="OTL" value={g.otLosses == null ? null : String(g.otLosses)} />
        <GoalieStat label="SO" value={g.shutouts == null ? null : String(g.shutouts)} />
        <GoalieStat label="GAA" value={g.gaa == null ? null : g.gaa.toFixed(2)} />
        <GoalieStat label="SV%" value={formatSavePct(g.savePct)} />
      </div>
    </div>
  );
}

// "05/21" — short month/day for the recent matchups list. Parses
// the worker's YYYY-MM-DD using the UTC slots so the displayed day
// matches the stored date regardless of the viewer's timezone.
function formatMatchupDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`;
}

// One row of the team-stat comparison card. Two values flanking a
// label, with a single bar split proportionally between them so the
// dominant team owns the wider share. `lowerIsBetter` flips the
// color (and which side reads as the "leader") for stats like goals
// against — bigger isn't better there.
function StatComparisonRow({
  label,
  away,
  home,
  format,
  lowerIsBetter = false,
}: {
  label: string;
  away: number | null;
  home: number | null;
  format: (n: number) => string;
  lowerIsBetter?: boolean;
}) {
  const a = away ?? 0;
  const h = home ?? 0;
  const total = a + h;
  // Equal split when both sides are zero / missing — keeps the bar
  // from collapsing into a single color.
  const awayShare = total > 0 ? (a / total) * 100 : 50;
  const homeShare = 100 - awayShare;
  const awayLeads = lowerIsBetter ? a < h : a > h;
  const homeLeads = lowerIsBetter ? h < a : h > a;
  return (
    <div style={{ padding: '8px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 16, fontWeight: 700, opacity: awayLeads ? 1 : 0.55 }}>
          {away == null ? '—' : format(away)}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, opacity: homeLeads ? 1 : 0.55 }}>
          {home == null ? '—' : format(home)}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          height: 6,
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--separator, rgba(0,0,0,0.08))',
        }}
      >
        <div
          style={{
            width: `${awayShare}%`,
            background: awayLeads ? 'var(--accent, #007AFF)' : 'var(--bubble-them, #C7C7CC)',
          }}
        />
        <div
          style={{
            width: `${homeShare}%`,
            background: homeLeads ? 'var(--accent, #007AFF)' : 'var(--bubble-them, #C7C7CC)',
          }}
        />
      </div>
    </div>
  );
}

function TeamStatsComparison({
  away,
  home,
  awayAbbr,
  homeAbbr,
}: {
  away?: SportsTeamSeasonStats;
  home?: SportsTeamSeasonStats;
  awayAbbr: string;
  homeAbbr: string;
}) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const dec = (n: number) => n.toFixed(2);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        <span>{awayAbbr}</span>
        <span>{homeAbbr}</span>
      </div>
      <StatComparisonRow
        label="Goals per game"
        away={away?.gfPerGame ?? null}
        home={home?.gfPerGame ?? null}
        format={dec}
      />
      <StatComparisonRow
        label="Goals against per game"
        away={away?.gaPerGame ?? null}
        home={home?.gaPerGame ?? null}
        format={dec}
        lowerIsBetter
      />
      <StatComparisonRow
        label="Power play %"
        away={away?.ppPct ?? null}
        home={home?.ppPct ?? null}
        format={pct}
      />
      <StatComparisonRow
        label="Penalty kill %"
        away={away?.pkPct ?? null}
        home={home?.pkPct ?? null}
        format={pct}
      />
    </div>
  );
}

// One row of the team-leaders card: two side-by-side leader names
// flanking a centered stat label, with the value next to each name.
// Hides the row when neither side has a leader for that stat.
function TeamLeadersRow({
  label,
  away,
  home,
}: {
  label: string;
  away?: { name: string; value: number };
  home?: { name: string; value: number };
}) {
  if (!away && !home) return null;
  return (
    <div style={{ padding: '8px 0' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 0.6,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <div style={{ flex: '1 1 0', minWidth: 0, textAlign: 'left' }}>
          {away ? (
            <>
              <span style={{ fontSize: 18, fontWeight: 800, marginRight: 8 }}>{away.value}</span>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{away.name}</span>
            </>
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>—</span>
          )}
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0, textAlign: 'right' }}>
          {home ? (
            <>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{home.name}</span>
              <span style={{ fontSize: 18, fontWeight: 800, marginLeft: 8 }}>{home.value}</span>
            </>
          ) : (
            <span style={{ color: 'var(--text-dim)' }}>—</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TeamLeadersComparison({
  away,
  home,
  awayAbbr,
  homeAbbr,
}: {
  away?: SportsTeamLeaders;
  home?: SportsTeamLeaders;
  awayAbbr: string;
  homeAbbr: string;
}) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.5,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          marginBottom: 4,
        }}
      >
        <span>{awayAbbr}</span>
        <span>{homeAbbr}</span>
      </div>
      <TeamLeadersRow label="Points" away={away?.points} home={home?.points} />
      <TeamLeadersRow label="Goals" away={away?.goals} home={home?.goals} />
      <TeamLeadersRow label="Assists" away={away?.assists} home={home?.assists} />
    </div>
  );
}

// "Sat · 7:00 PM ET" for the pregame matchup card.
// Worker hands us startTimeLocal already formatted ("7:00 PM ET") and
// startTime as ms epoch; we just prepend the short weekday in the
// viewer's locale.
function formatPreKickoff(startTime: number, startTimeLocal: string): string {
  if (!startTime) return startTimeLocal;
  try {
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(
      new Date(startTime),
    );
    return `${day} · ${startTimeLocal}`;
  } catch {
    return startTimeLocal;
  }
}

function LinescoreTable({
  periods,
  totals,
  homeAbbr,
  awayAbbr,
}: {
  periods: SportsLinescorePeriod[];
  totals: SportsLinescoreTotal[];
  homeAbbr: string;
  awayAbbr: string;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 13,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <thead>
          <tr style={{ color: 'var(--text-dim)' }}>
            <th style={{ textAlign: 'left', padding: '6px 8px' }} />
            {periods.map((p) => (
              <th key={p.label} style={{ padding: '6px 6px', textAlign: 'center' }}>
                {p.label}
              </th>
            ))}
            {totals.map((t) => (
              <th
                key={t.label}
                style={{
                  padding: '6px 6px',
                  textAlign: 'center',
                  fontWeight: 700,
                  color: 'var(--text)',
                }}
              >
                {t.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ borderTop: '1px solid var(--separator, rgba(0,0,0,0.08))' }}>
            <td style={{ padding: '6px 8px', fontWeight: 600 }}>{awayAbbr || 'AWAY'}</td>
            {periods.map((p, i) => (
              <td key={i} style={{ padding: '6px 6px', textAlign: 'center' }}>
                {p.away ?? '–'}
              </td>
            ))}
            {totals.map((t) => (
              <td
                key={t.label}
                style={{ padding: '6px 6px', textAlign: 'center', fontWeight: 700 }}
              >
                {t.away}
              </td>
            ))}
          </tr>
          <tr style={{ borderTop: '1px solid var(--separator, rgba(0,0,0,0.08))' }}>
            <td style={{ padding: '6px 8px', fontWeight: 600 }}>{homeAbbr || 'HOME'}</td>
            {periods.map((p, i) => (
              <td key={i} style={{ padding: '6px 6px', textAlign: 'center' }}>
                {p.home ?? '–'}
              </td>
            ))}
            {totals.map((t) => (
              <td
                key={t.label}
                style={{ padding: '6px 6px', textAlign: 'center', fontWeight: 700 }}
              >
                {t.home}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function ScoringPlayList({
  plays,
  league,
}: {
  plays: SportsGameDetail['scoringPlays'];
  league: 'NHL' | 'MLB';
}) {
  if (plays.length === 0) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>
        No scoring plays yet.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {plays.map((p, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            gap: 10,
            paddingBottom: 8,
            borderBottom:
              i < plays.length - 1 ? '1px solid var(--separator, rgba(0,0,0,0.08))' : 'none',
          }}
        >
          <div
            style={{
              flex: '0 0 70px',
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: 'var(--text-dim)',
              paddingTop: 2,
            }}
          >
            {p.period}
            {league === 'NHL' && p.clock ? (
              <div style={{ fontWeight: 500 }}>{p.clock}</div>
            ) : null}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {p.teamAbbr ? `${p.teamAbbr} · ` : ''}
              {p.awayScore} – {p.homeScore}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>{p.description}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PlayerLine({ p }: { p: SportsBoxPlayer }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '6px 0',
        borderBottom: '1px solid var(--separator, rgba(0,0,0,0.06))',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          {p.pos ? (
            <span style={{ color: 'var(--text-dim)', fontWeight: 500, marginRight: 6 }}>
              {p.pos}
            </span>
          ) : null}
          {p.name}
          {p.decision ? (
            <span
              style={{
                marginLeft: 6,
                fontSize: 10,
                fontWeight: 700,
                padding: '1px 6px',
                borderRadius: 999,
                background:
                  p.decision === 'W'
                    ? '#34C759'
                    : p.decision === 'L'
                      ? '#FF3B30'
                      : 'var(--text-dim)',
                color: 'white',
              }}
            >
              {p.decision}
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 12,
            color: 'var(--text-dim)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {p.line}
        </div>
      </div>
    </div>
  );
}

function BoxSection({ box, league }: { box: SportsTeamBox; league: 'NHL' | 'MLB' }) {
  if (league === 'MLB') {
    const batters = box.batters ?? [];
    const pitchers = box.pitchers ?? [];
    return (
      <div>
        {batters.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: 'var(--text-dim)',
                marginBottom: 4,
              }}
            >
              BATTING
            </div>
            {batters.map((p, i) => (
              <PlayerLine key={`b-${i}`} p={p} />
            ))}
          </>
        ) : null}
        {pitchers.length > 0 ? (
          <>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 0.6,
                color: 'var(--text-dim)',
                marginTop: 10,
                marginBottom: 4,
              }}
            >
              PITCHING
            </div>
            {pitchers.map((p, i) => (
              <PlayerLine key={`p-${i}`} p={p} />
            ))}
          </>
        ) : null}
      </div>
    );
  }
  // NHL
  const skaters = box.skaters ?? [];
  const goalies = box.goalies ?? [];
  return (
    <div>
      {skaters.length > 0 ? (
        <>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: 'var(--text-dim)',
              marginBottom: 4,
            }}
          >
            SKATERS (top by points)
          </div>
          {skaters.map((p, i) => (
            <PlayerLine key={`s-${i}`} p={p} />
          ))}
        </>
      ) : null}
      {goalies.length > 0 ? (
        <>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: 'var(--text-dim)',
              marginTop: 10,
              marginBottom: 4,
            }}
          >
            GOALIES
          </div>
          {goalies.map((p, i) => (
            <PlayerLine key={`g-${i}`} p={p} />
          ))}
        </>
      ) : null}
    </div>
  );
}

export function SportsDetail() {
  const { league, id } = useParams<{ league: string; id: string }>();
  const [searchParams] = useSearchParams();
  // The card that linked here passes `abbr` (NHL) or `teamId` (MLB) so
  // the detail view knows which side to highlight as "ours". When the
  // user deep-links straight in, both are absent and the worker falls
  // back to MTL / TOR.
  const teamKey = searchParams.get('abbr') ?? searchParams.get('teamId') ?? undefined;
  const leagueLc = (league ?? '').toLowerCase();
  const isLeague = leagueLc === 'nhl' || leagueLc === 'mlb';
  const [detail, setDetail] = useState<SportsGameDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const liveRef = useRef(false);

  useEffect(() => {
    if (!isLeague || !id) return;
    let cancelled = false;
    let timer: number | undefined;
    async function load() {
      try {
        const r = await api.getSportsGame(leagueLc as 'nhl' | 'mlb', id!, teamKey);
        if (cancelled) return;
        setDetail(r);
        liveRef.current = r.status === 'live';
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError((e as Error)?.message ?? 'failed');
      } finally {
        if (!cancelled) {
          setLoaded(true);
          timer = window.setTimeout(load, liveRef.current ? 30_000 : 300_000);
        }
      }
    }
    // Mobile browsers throttle setTimeout while the tab/PWA is
    // hidden, so the next poll can be far overdue when the user
    // returns. Force a refresh on visibility-restore and on network
    // reconnect so the live scoreboard isn't frozen on resume.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (timer !== undefined) window.clearTimeout(timer);
      void load();
    };
    const onOnline = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      void load();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [isLeague, leagueLc, id, teamKey]);

  return (
    <Page>
      <Navbar
        title="Game details"
        left={<NavbarBackLink onClick={() => window.history.back()} />}
      />
      <div style={{ padding: '4px 14px 24px' }}>
        {!isLeague ? (
          <div style={{ color: 'var(--text-dim)' }}>Unknown league.</div>
        ) : !loaded ? (
          <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
        ) : error || !detail ? (
          <div style={{ color: 'var(--text-dim)' }}>Couldn't load this game.</div>
        ) : (
          <>
            {/* Header card — score lock-up. Gets the same lifted-tile
                treatment as everything below so it reads as the headline
                card of a stack rather than as a flat page header. */}
            <div className="detail-card">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                <span
                  style={{
                    background: `linear-gradient(180deg, color-mix(in srgb, ${leagueAccent(detail.league)} 88%, white) 0%, ${leagueAccent(detail.league)} 100%)`,
                    color: 'white',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    padding: '2px 8px',
                    borderRadius: 999,
                    boxShadow:
                      'inset 0 1px 0 rgba(255,255,255,0.20), 0 1px 2px rgba(0,0,0,0.18)',
                    textShadow: '0 1px 0 rgba(0,0,0,0.18)',
                  }}
                >
                  {detail.league}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 12,
                    color: 'var(--text-dim)',
                    fontWeight: 600,
                  }}
                >
                  {detail.statusDetail}
                </span>
              </div>

              {detail.series ? (
                // Playoff context bar above the matchup. Matches the
                // list card's "ROUND 3 · GAME 2" treatment so the
                // detail page reads as a continuation of the same
                // card rather than a different layout.
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 10,
                    paddingBottom: 10,
                    borderBottom: '1px solid var(--separator, rgba(0,0,0,0.08))',
                  }}
                >
                  {detail.series.round ? (
                    <span
                      style={{
                        background: leagueAccent(detail.league),
                        color: 'white',
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: 0.6,
                        padding: '2px 8px',
                        borderRadius: 999,
                        textTransform: 'uppercase',
                      }}
                    >
                      {detail.series.round}
                    </span>
                  ) : null}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 0.6,
                      color: 'var(--text)',
                      textTransform: 'uppercase',
                    }}
                  >
                    {detail.series.gameLabel}
                  </span>
                </div>
              ) : null}

              {detail.status === 'pre' ? (
                // Pregame: no scores yet, so the old "AWAY – at – HOME"
                // lockup printed two stray em-dashes that read as
                // "blank at blank". Render a centered "AWAY  vs  HOME"
                // with the day-of-week + start time underneath.
                <div style={{ textAlign: 'center', padding: '4px 0' }}>
                  <div
                    style={{
                      fontSize: 26,
                      fontWeight: 800,
                      display: 'flex',
                      alignItems: 'baseline',
                      justifyContent: 'center',
                      gap: 14,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    <span>{detail.awayTeam.abbr}</span>
                    <span
                      style={{
                        color: 'var(--text-dim)',
                        fontSize: 14,
                        fontWeight: 500,
                        letterSpacing: 0.3,
                        textTransform: 'uppercase',
                      }}
                    >
                      vs
                    </span>
                    <span>{detail.homeTeam.abbr}</span>
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      fontSize: 13,
                      color: 'var(--text-dim)',
                      fontWeight: 600,
                    }}
                  >
                    {formatPreKickoff(detail.startTime, detail.startTimeLocal)}
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 12,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span>{detail.awayTeam.abbr}</span>
                  <span style={{ fontWeight: 800, fontSize: 28 }}>
                    {detail.awayTeam.score ?? '–'}
                  </span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 14, fontWeight: 500 }}>
                    at
                  </span>
                  <span style={{ fontWeight: 800, fontSize: 28 }}>
                    {detail.homeTeam.score ?? '–'}
                  </span>
                  <span>{detail.homeTeam.abbr}</span>
                </div>
              )}
              {detail.series ? (
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text-dim)',
                    marginTop: 8,
                  }}
                >
                  {detail.series.seriesLabel}
                </div>
              ) : null}

              {detail.venue ? (
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--text-dim)',
                    marginTop: 8,
                  }}
                >
                  {detail.venue}
                </div>
              ) : null}
            </div>

            {/* Team comparison stats (NHL only). Worker pulls
                postseason-only stats when the game has a series
                attached, regular-season otherwise — the period
                drives the section title. */}
            {detail.teamSeasonStats &&
            (detail.teamSeasonStats.home || detail.teamSeasonStats.away) ? (
              <section className="detail-card">
                <h3 className="detail-card-title">
                  Team Stats —{' '}
                  {detail.teamSeasonStats.period === 'postseason'
                    ? 'Postseason'
                    : 'Regular Season'}
                </h3>
                <TeamStatsComparison
                  away={detail.teamSeasonStats.away}
                  home={detail.teamSeasonStats.home}
                  awayAbbr={detail.awayTeam.abbr}
                  homeAbbr={detail.homeTeam.abbr}
                />
              </section>
            ) : null}

            {/* Team leaders (NHL only). Per-team points / goals /
                assists leaders for the same period as the stat
                comparison bars above. Hidden when neither side has
                qualifying skater rows (e.g. asking for postseason
                stats on a team that didn't make the playoffs). */}
            {detail.teamLeaders &&
            (detail.teamLeaders.home || detail.teamLeaders.away) ? (
              <section className="detail-card">
                <h3 className="detail-card-title">
                  Team Leaders —{' '}
                  {detail.teamLeaders.period === 'postseason'
                    ? 'Postseason'
                    : 'Regular Season'}
                </h3>
                <TeamLeadersComparison
                  away={detail.teamLeaders.away}
                  home={detail.teamLeaders.home}
                  awayAbbr={detail.awayTeam.abbr}
                  homeAbbr={detail.homeTeam.abbr}
                />
              </section>
            ) : null}

            {/* Starting goalies (NHL pregame). Worker only fills the
                array when landing.matchup.goalieComparison is
                present, which is the pregame window — once the puck
                drops the boxscore goalies take over. */}
            {detail.startingGoalies && detail.startingGoalies.length > 0 ? (
              <section className="detail-card">
                <h3 className="detail-card-title">Starting Goalies</h3>
                {detail.startingGoalies
                  .slice()
                  .sort((a, b) => (a.side === 'away' ? -1 : 1))
                  .map((g, i) => (
                    <GoalieRow key={`g-${g.side}-${i}`} g={g} />
                  ))}
              </section>
            ) : null}

            {/* Linescore */}
            <section className="detail-card">
              <h3 className="detail-card-title">Linescore</h3>
              <LinescoreTable
                periods={detail.linescore}
                totals={detail.totals}
                homeAbbr={detail.homeTeam.abbr}
                awayAbbr={detail.awayTeam.abbr}
              />
            </section>

            {/* Scoring */}
            <section className="detail-card">
              <h3 className="detail-card-title">Scoring</h3>
              <ScoringPlayList plays={detail.scoringPlays} league={detail.league} />
            </section>

            {/* Three stars (NHL) — ranked medallions */}
            {detail.threeStars && detail.threeStars.length > 0 ? (
              <section className="detail-card">
                <h3 className="detail-card-title">Three Stars</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {detail.threeStars.map((s) => (
                    <div
                      key={s.star}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontSize: 14,
                      }}
                    >
                      <span
                        className="three-star-rank"
                        data-star={String(s.star)}
                      >
                        {s.star}
                      </span>
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                        {s.teamAbbr}
                      </span>
                      {s.note ? (
                        <span
                          style={{
                            color: 'var(--text-dim)',
                            fontSize: 12,
                            marginLeft: 'auto',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {s.note}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {/* Recent head-to-head (NHL: full-season schedule;
                MLB: schedule API filtered by opponentId). Hidden
                when the upstream returned no qualifying finals
                (e.g. first matchup of the season). */}
            {detail.recentMatchups && detail.recentMatchups.length > 0 ? (
              <section className="detail-card">
                <h3 className="detail-card-title">Recent Matchups</h3>
                <div>
                  {detail.recentMatchups.map((m) => {
                    const winnerAbbr =
                      m.homeScore > m.awayScore
                        ? m.homeAbbr
                        : m.awayScore > m.homeScore
                          ? m.awayAbbr
                          : null;
                    return (
                      <div
                        key={`${m.date}-${m.homeAbbr}-${m.awayAbbr}`}
                        style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: 10,
                          padding: '6px 0',
                          borderTop: '1px solid var(--separator, rgba(0,0,0,0.06))',
                        }}
                      >
                        <span
                          style={{
                            fontSize: 11,
                            color: 'var(--text-dim)',
                            minWidth: 56,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {formatMatchupDate(m.date)}
                        </span>
                        <span style={{ flex: 1, fontSize: 13 }}>
                          {/* Bold the winner — mirrors how broadcast box
                              scores call attention to the result. */}
                          <span style={{ fontWeight: winnerAbbr === m.awayAbbr ? 700 : 500 }}>
                            {m.awayAbbr}
                          </span>
                          <span style={{ color: 'var(--text-dim)', margin: '0 6px' }}>@</span>
                          <span style={{ fontWeight: winnerAbbr === m.homeAbbr ? 700 : 500 }}>
                            {m.homeAbbr}
                          </span>
                        </span>
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 700,
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {m.awayScore}–{m.homeScore}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Box scores — one card per team */}
            <section className="detail-card">
              <h3 className="detail-card-title">
                {detail.awayTeam.abbr || 'Away'} Box
              </h3>
              <BoxSection box={detail.awayBox} league={detail.league} />
            </section>

            <section className="detail-card">
              <h3 className="detail-card-title">
                {detail.homeTeam.abbr || 'Home'} Box
              </h3>
              <BoxSection box={detail.homeBox} league={detail.league} />
            </section>
          </>
        )}
      </div>
    </Page>
  );
}
