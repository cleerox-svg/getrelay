import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Navbar, NavbarBackLink, Page } from 'konsta/react';
import { api } from '../lib/api';
import type {
  SportsBoxPlayer,
  SportsGameDetail,
  SportsLinescorePeriod,
  SportsLinescoreTotal,
  SportsTeamBox,
} from '../lib/types';

function leagueAccent(league: 'NHL' | 'MLB'): string {
  return league === 'NHL' ? '#AF1E2D' : '#134A8E';
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
        const r = await api.getSportsGame(leagueLc as 'nhl' | 'mlb', id!);
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
    load();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isLeague, leagueLc, id]);

  return (
    <Page>
      <Navbar
        title="Game details"
        left={<NavbarBackLink onClick={() => window.history.back()} />}
      />
      <div style={{ padding: '12px 14px' }}>
        {!isLeague ? (
          <div style={{ color: 'var(--text-dim)' }}>Unknown league.</div>
        ) : !loaded ? (
          <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
        ) : error || !detail ? (
          <div style={{ color: 'var(--text-dim)' }}>Couldn't load this game.</div>
        ) : (
          <>
            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  background: leagueAccent(detail.league),
                  color: 'white',
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  padding: '2px 8px',
                  borderRadius: 999,
                }}
              >
                {detail.league}
              </span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-dim)' }}>
                {detail.statusDetail}
              </span>
            </div>

            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 4,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>{detail.awayTeam.abbr}</span>
              <span style={{ fontWeight: 800 }}>{detail.awayTeam.score ?? '–'}</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 13, fontWeight: 500 }}>at</span>
              <span style={{ fontWeight: 800 }}>{detail.homeTeam.score ?? '–'}</span>
              <span>{detail.homeTeam.abbr}</span>
            </div>
            {detail.venue ? (
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 14 }}>
                {detail.venue}
              </div>
            ) : null}

            {/* Linescore */}
            <section style={{ marginBottom: 18 }}>
              <h3
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: 'var(--text-dim)',
                  margin: '0 0 6px',
                }}
              >
                LINESCORE
              </h3>
              <LinescoreTable
                periods={detail.linescore}
                totals={detail.totals}
                homeAbbr={detail.homeTeam.abbr}
                awayAbbr={detail.awayTeam.abbr}
              />
            </section>

            {/* Scoring */}
            <section style={{ marginBottom: 18 }}>
              <h3
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: 'var(--text-dim)',
                  margin: '0 0 6px',
                }}
              >
                SCORING
              </h3>
              <ScoringPlayList plays={detail.scoringPlays} league={detail.league} />
            </section>

            {/* Three stars (NHL) */}
            {detail.threeStars && detail.threeStars.length > 0 ? (
              <section style={{ marginBottom: 18 }}>
                <h3
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: 0.6,
                    color: 'var(--text-dim)',
                    margin: '0 0 6px',
                  }}
                >
                  THREE STARS
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {detail.threeStars.map((s) => (
                    <div
                      key={s.star}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 8,
                        fontSize: 14,
                      }}
                    >
                      <span style={{ fontWeight: 800, width: 16 }}>{s.star}.</span>
                      <span style={{ fontWeight: 600 }}>{s.name}</span>
                      <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{s.teamAbbr}</span>
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

            {/* Box scores */}
            <section style={{ marginBottom: 18 }}>
              <h3
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: 'var(--text-dim)',
                  margin: '0 0 8px',
                }}
              >
                {detail.awayTeam.abbr || 'AWAY'} BOX
              </h3>
              <BoxSection box={detail.awayBox} league={detail.league} />
            </section>

            <section style={{ marginBottom: 24 }}>
              <h3
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  letterSpacing: 0.6,
                  color: 'var(--text-dim)',
                  margin: '0 0 8px',
                }}
              >
                {detail.homeTeam.abbr || 'HOME'} BOX
              </h3>
              <BoxSection box={detail.homeBox} league={detail.league} />
            </section>
          </>
        )}
      </div>
    </Page>
  );
}
