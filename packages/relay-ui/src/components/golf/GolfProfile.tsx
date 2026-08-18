import { useEffect, useState } from 'react';
import { Avatar } from '../Avatar';
import { api } from '../../lib/api';
import type { GolfRecords } from '../../lib/api';
import { getCourse } from '../../lib/golf/courses';
import { useStore } from '../../lib/store';
import { useEconomy, useEquippedFrame } from '../../lib/golf/economy';
import { withTimeout } from '../../lib/golf/loadState';
import { LoadFailure } from './shared/LoadFailure';
import { CoinBalance } from './CoinBalance';
import { fmtToPar } from './shared/scoreFormat';
import type { GolfStats, TournamentMe } from '../../lib/types';

// Whole-stroke ± to-par is shared (shared/scoreFormat); this is the fractional
// variant, for the averages (handicap / scoring average).
function fmtToParDec(n: number | null | undefined): string {
  if (n == null) return '—';
  if (Math.abs(n) < 0.05) return 'E';
  return n > 0 ? `+${n.toFixed(1)}` : `−${Math.abs(n).toFixed(1)}`;
}

// Friendly course name for a per-course / recent-round bucket. A null bucket is
// the uncategorized / mini-golf pile; getCourse() resolves real course ids.
function courseName(id: string | null): string {
  return id == null ? 'Mini-golf' : getCourse(id).name;
}

// Ordinal rank label ("1st", "2nd", "3rd", "12th").
function fmtRank(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// Compact relative time for recent rounds.
function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const day = 86_400_000;
  if (diff < 3_600_000) return 'just now';
  if (diff < day) {
    const h = Math.max(1, Math.round(diff / 3_600_000));
    return `${h}h ago`;
  }
  const days = Math.round(diff / day);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? '' : 's'} ago`;
}

// The Profile sub-tab of the golf hub: the player's card. Pulls the three
// server stat buckets (course / mini-golf / range) plus best-shot records on
// mount; every request degrades gracefully (unauthed / offline just renders
// the empty state). Identity (avatar / name / PIN) comes from the store.
export function GolfProfile() {
  const me = useStore((s) => s.me);
  // The viewer's own equipped frame + coin balance for the card header. The hub
  // already loads the economy on mount; ensure here too so the Profile tab is
  // self-sufficient if reached first.
  const frame = useEquippedFrame();
  const balance = useEconomy((s) => s.balance);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  const ensureWallet = useEconomy((s) => s.ensureWallet);
  useEffect(() => {
    void ensureCosmetics();
    void ensureWallet();
  }, [ensureCosmetics, ensureWallet]);

  const [courseStats, setCourseStats] = useState<GolfStats | null>(null);
  const [puttStats, setPuttStats] = useState<GolfStats | null>(null);
  const [rangeStats, setRangeStats] = useState<GolfStats | null>(null);
  const [records, setRecords] = useState<GolfRecords | null>(null);
  const [tourney, setTourney] = useState<TournamentMe | null>(null);
  const [loaded, setLoaded] = useState(false);
  // ⚠ Every one of these requests failing is NOT the same fact as a player with
  // no rounds, and the card used to render both as "No rounds yet. Play your
  // first round." — telling a player with a full history that their card was
  // empty. Count the failures so the all-failed case can say so and retry.
  const [allFailed, setAllFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setAllFailed(false);
    let failures = 0;
    function soft<T>(p: Promise<T>): Promise<T | null> {
      return withTimeout(p).catch(() => {
        failures += 1;
        return null;
      });
    }
    const requests = [
      soft(api.getGolfStats('golfcourse')),
      soft(api.getGolfStats('golf')),
      soft(api.getGolfStats('golfrange')),
      soft(api.getGolfRecords().then((r) => r.records)),
      soft(api.getTournamentMe()),
    ] as const;
    Promise.all(requests).then(([course, putt, range, rec, tm]) => {
      if (cancelled) return;
      setCourseStats(course);
      setPuttStats(putt);
      setRangeStats(range);
      setRecords(rec);
      setTourney(tm);
      setAllFailed(failures === requests.length);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Best to-par: lowest recorded to-par across per-course bests and recent
  // rounds (server has no single top-level field for it). Falls back to null.
  const bestToPar = (() => {
    const vals: number[] = [];
    courseStats?.perCourse.forEach((p) => {
      if (p.bestToPar != null) vals.push(p.bestToPar);
    });
    courseStats?.recent.forEach((r) => {
      if (r.toPar != null) vals.push(r.toPar);
    });
    return vals.length ? Math.min(...vals) : null;
  })();

  // Scoring average = games-weighted mean of per-course avg to-par.
  const scoringAvg = (() => {
    let games = 0;
    let sum = 0;
    courseStats?.perCourse.forEach((p) => {
      if (p.avgToPar != null) {
        games += p.games;
        sum += p.avgToPar * p.games;
      }
    });
    return games ? sum / games : null;
  })();

  const courseRounds = courseStats?.gamesPlayed ?? 0;
  const bestStreak = puttStats?.bestStreak ?? null;
  const perCourse = (courseStats?.perCourse ?? []).filter((p) => p.games > 0);
  const recent = courseStats?.recent ?? [];

  const anyRecord =
    !!records &&
    (records.longestDrive != null ||
      records.closestToPin != null ||
      records.longestPutt != null);
  const trophies = tourney?.trophies ?? null;
  const placements = tourney?.placements ?? [];
  const playedTourneys = (trophies?.eventsPlayed ?? 0) > 0;
  const hasAnything =
    courseRounds > 0 ||
    anyRecord ||
    playedTourneys ||
    (puttStats?.gamesPlayed ?? 0) > 0 ||
    (rangeStats?.gamesPlayed ?? 0) > 0;

  const recordRows: { icon: string; title: string; sub: string; metric: GolfRecords['longestDrive']; unit: string }[] =
    [
      {
        icon: '🏌️',
        title: 'Longest drive',
        sub: 'Off the tee',
        metric: records?.longestDrive ?? null,
        unit: 'YARDS',
      },
      {
        icon: '🎯',
        title: 'Closest to pin',
        sub: 'Approach',
        metric: records?.closestToPin ?? null,
        unit: 'YARDS',
      },
      {
        icon: '⛳',
        title: 'Longest putt',
        sub: 'On the green',
        metric: records?.longestPutt ?? null,
        unit: 'YARDS',
      },
    ];

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Header: identity + handicap ---- */}
      <div className="golf-phead">
        <Avatar src={me?.avatarUrl} name={me?.displayName} size={60} frame={frame} />
        <div className="g-who">
          <b>{me?.displayName ?? 'Relay golfer'}</b>
          {me?.pin ? <div className="g-pin">PIN · {me.pin}</div> : null}
          <div className="g-coins">
            <CoinBalance balance={balance} size="sm" />
          </div>
        </div>
        <div className="g-hcap">
          <span>Handicap</span>
          <b>{fmtToParDec(courseStats?.handicap ?? null)}</b>
        </div>
      </div>

      {!loaded ? (
        <div className="golf-empty">Loading your card…</div>
      ) : allFailed ? (
        <LoadFailure
          title="Couldn’t load your card."
          detail="Your rounds and records are safe — this is a connection problem."
          onRetry={() => setAttempt((a) => a + 1)}
        />
      ) : !hasAnything ? (
        <div className="golf-empty">
          <b>No rounds yet.</b>
          <br />
          Play your first round to start your card.
        </div>
      ) : (
        <>
          {/* ---- Stat tiles ---- */}
          <div className="golf-tiles">
            <div className="golf-tile">
              <span>Course rounds</span>
              <b>{courseRounds}</b>
              <small>full rounds played</small>
            </div>
            <div className="golf-tile">
              <span>Best round</span>
              <b className={bestToPar != null && bestToPar < 0 ? 'under' : undefined}>
                {fmtToPar(bestToPar)}
              </b>
              <small>to par</small>
            </div>
            <div className="golf-tile">
              <span>Scoring avg</span>
              <b className={scoringAvg != null && scoringAvg < -0.05 ? 'under' : undefined}>
                {fmtToParDec(scoringAvg)}
              </b>
              <small>to par per round</small>
            </div>
            <div className="golf-tile">
              <span>Best streak</span>
              <b>{bestStreak != null ? `×${bestStreak}` : '—'}</b>
              <small>under-par holes</small>
            </div>
            {/* Tournament trophies — spans the full row so the 5th tile reads
                intentionally rather than orphaned. */}
            <div className="golf-tile" style={{ gridColumn: '1 / -1' }}>
              <span>Tournament trophies</span>
              <b>
                <span aria-hidden="true">🏆</span> {trophies?.trophies ?? 0}
              </b>
              <small>
                {trophies && trophies.eventsPlayed > 0
                  ? `${trophies.golds} gold · ${trophies.podiums} podium${
                      trophies.podiums === 1 ? '' : 's'
                    }${trophies.bestRank != null ? ` · best ${fmtRank(trophies.bestRank)}` : ''}`
                  : 'play a Rapid Tournament'}
              </small>
            </div>
          </div>

          {/* ---- Trophy shelf ---- */}
          <h3 className="golf-shelf-h">Trophy shelf · your records</h3>
          <div className="golf-records">
            {recordRows.map((r) => (
              <div key={r.title} className="golf-rec">
                <div className="g-medal" aria-hidden="true">
                  {r.icon}
                </div>
                <div className="g-rt">
                  <b>{r.title}</b>
                  <span>
                    {r.metric != null && r.metric.hole != null
                      ? `Hole ${r.metric.hole}`
                      : r.sub}
                  </span>
                </div>
                <div className="g-val">
                  <b>{r.metric != null ? r.metric.yards.toLocaleString() : '—'}</b>
                  <span>{r.unit}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ---- Recent tournament finishes ---- */}
          {placements.length > 0 ? (
            <>
              <h3 className="golf-shelf-h">Tournament finishes</h3>
              <div className="golf-rows">
                {placements.map((p) => {
                  const podium = p.rank <= 3;
                  return (
                    <div key={p.tournamentId} className="golf-row">
                      <span
                        className={'g-cd' + (podium ? '' : ' over')}
                        aria-hidden="true"
                      />
                      <div className="g-rn">
                        <b>{fmtRank(p.rank)} place</b>
                        <span>
                          {p.trophies} trophy{p.trophies === 1 ? '' : 's'} ·{' '}
                          {relTime(p.closesAt)}
                        </span>
                      </div>
                      <span className={'g-sc' + (podium ? ' under' : '')}>
                        <span aria-hidden="true">🏆</span>
                        {p.trophies}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}

          {/* ---- Per-course breakdown ---- */}
          {perCourse.length > 0 ? (
            <>
              <h3 className="golf-shelf-h">Your courses</h3>
              <div className="golf-rows">
                {perCourse.map((p) => (
                  <div key={p.course ?? 'mini'} className="golf-row">
                    <div className="g-rn">
                      <b>{courseName(p.course)}</b>
                      <span>
                        {p.games} round{p.games === 1 ? '' : 's'} · best {fmtToPar(p.bestToPar)}
                      </span>
                    </div>
                    <span
                      className={
                        'g-sc' +
                        (p.avgToPar != null && p.avgToPar < 0
                          ? ' under'
                          : p.avgToPar != null && p.avgToPar > 0
                            ? ' over'
                            : '')
                      }
                    >
                      {fmtToParDec(p.avgToPar)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : null}

          {/* ---- Recent rounds ---- */}
          {recent.length > 0 ? (
            <>
              <h3 className="golf-shelf-h">Recent rounds</h3>
              <div className="golf-rows">
                {recent.map((r, i) => {
                  const over = r.toPar != null && r.toPar > 0;
                  const under = r.toPar != null && r.toPar < 0;
                  return (
                    <div key={`${r.createdAt}-${i}`} className="golf-row">
                      <span className={'g-cd' + (over ? ' over' : '')} aria-hidden="true" />
                      <div className="g-rn">
                        <b>{courseName(r.course)}</b>
                        <span>
                          {r.rounds} hole{r.rounds === 1 ? '' : 's'} · {relTime(r.createdAt)}
                        </span>
                      </div>
                      <span className={'g-sc' + (under ? ' under' : over ? ' over' : '')}>
                        {fmtToPar(r.toPar)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
