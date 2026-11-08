// Sports cron / feed live-state tests. The important invariant: a
// "game starting" push must fire at FIRST PITCH, not during pregame.
// MLB's /linescore endpoint pre-populates currentInning=1 ("Top 1st")
// while a game is still in Preview/Warmup, so the feed must NOT treat
// currentInning > 0 as "the game is live" — it has to trust the
// schedule's abstractGameState. These tests pin that behavior.
import { beforeAll, describe, expect, it } from 'vitest';
import { env, fetchMock } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  fetchMlbForTeam,
  LIVE_POLL_DEADLINE_MS,
  LIVE_POLL_HARD_STOP_MS,
  LIVE_POLL_INTERVAL_MS,
  nhlStatusFromGameState,
  pregameStartPassed,
  processGameUpdate,
  runSportsCron,
  type SportsPushFn,
  todayCacheMaxAge,
} from '../src/sports';

const TOR = 141;

// Single-use interceptors (no .persist()) so one test's mock can't
// satisfy the next test's fetch. fetchMlbForTeam makes exactly one
// schedule call, plus one linescore call ONLY when the game is live.
function mockSchedule(game: object) {
  fetchMock
    .get('https://statsapi.mlb.com')
    .intercept({ path: (p) => p.startsWith('/api/v1/schedule') })
    .reply(200, { dates: [{ games: [game] }] }, {
      headers: { 'content-type': 'application/json' },
    });
}

function mockLinescore(body: object) {
  fetchMock
    .get('https://statsapi.mlb.com')
    .intercept({ path: (p) => p.includes('/linescore') })
    .reply(200, body, { headers: { 'content-type': 'application/json' } });
}

// A pregame linescore as MLB actually returns it: currentInning is
// already 1 (Top of the 1st) even though first pitch hasn't happened.
const PREGAME_LINESCORE = {
  currentInning: 1,
  inningHalf: 'Top',
  outs: 0,
  teams: { home: { runs: 0 }, away: { runs: 0 } },
};

beforeAll(() => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe('fetchMlbForTeam pregame/live gating', () => {
  it('stays "pre" for a Preview game even when the linescore says Top 1st', async () => {
    mockSchedule({
      gamePk: 700001,
      gameDate: '2026-08-07T22:10:00Z',
      gameType: 'R',
      status: { abstractGameState: 'Preview', detailedState: 'Pre-Game' },
      teams: {
        home: { team: { id: 141, name: 'Toronto Blue Jays', abbreviation: 'TOR' } },
        away: { team: { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI' } },
      },
      linescore: PREGAME_LINESCORE,
      venue: { name: 'Rogers Centre' },
    });

    const game = await fetchMlbForTeam(String(TOR), '2026-08-07');
    expect(game).not.toBeNull();
    // The bug fired a "game starting" push here because status was 'live'.
    expect(game!.status).toBe('pre');
  });

  it('goes "live" and overlays the linescore once the schedule says Live', async () => {
    mockSchedule({
      gamePk: 700002,
      gameDate: '2026-08-07T22:10:00Z',
      gameType: 'R',
      status: { abstractGameState: 'Live', detailedState: 'In Progress' },
      teams: {
        home: { team: { id: 141, name: 'Toronto Blue Jays', abbreviation: 'TOR' } },
        away: { team: { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI' } },
      },
      linescore: { currentInning: 3, inningHalf: 'Bottom', outs: 2 },
      venue: { name: 'Rogers Centre' },
    });
    mockLinescore({
      currentInning: 3,
      inningHalf: 'Bottom',
      outs: 2,
      teams: { home: { runs: 4 }, away: { runs: 2 } },
    });

    const game = await fetchMlbForTeam(String(TOR), '2026-08-07');
    expect(game).not.toBeNull();
    expect(game!.status).toBe('live');
    // Linescore overlay refines the numbers while genuinely live.
    expect(game!.homeTeam.score).toBe(4);
    expect(game!.awayTeam.score).toBe(2);
    expect(game!.statusDetail).toContain('Bot 3rd');
  });

  it('stays "final" for a completed game', async () => {
    mockSchedule({
      gamePk: 700003,
      gameDate: '2026-08-07T22:10:00Z',
      gameType: 'R',
      status: { abstractGameState: 'Final', detailedState: 'Final' },
      teams: {
        home: { team: { id: 141, name: 'Toronto Blue Jays', abbreviation: 'TOR' }, score: 5 },
        away: { team: { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI' }, score: 3 },
      },
      linescore: { currentInning: 9, inningHalf: 'Bottom', outs: 3 },
      venue: { name: 'Rogers Centre' },
    });

    const game = await fetchMlbForTeam(String(TOR), '2026-08-07');
    expect(game).not.toBeNull();
    expect(game!.status).toBe('final');
  });
});

// The Sports response cache (caches.default + the browser HTTP cache)
// serves a pre/final snapshot. The trap: a snapshot cached while a game
// was still 'pre' kept being served after first pitch, freezing the card
// on "7:07 PM ET" while the push cron (which reads upstream directly)
// still sent live score alerts. pregameStartPassed is the guard that
// invalidates such a snapshot the moment the scheduled start passes.
describe('pregameStartPassed cache-staleness guard', () => {
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;

  it('flags a pre-game whose start time has passed as stale', () => {
    expect(pregameStartPassed('pre', now - HOUR)).toBe(true);
  });

  it('keeps a pre-game that has not started yet cached', () => {
    expect(pregameStartPassed('pre', now + HOUR)).toBe(false);
  });

  it('never flags live or final snapshots (they are cached/no-stored on their own rules)', () => {
    expect(pregameStartPassed('live', now - HOUR)).toBe(false);
    expect(pregameStartPassed('final', now - HOUR)).toBe(false);
  });

  it('ignores a missing or zero start time', () => {
    expect(pregameStartPassed('pre', undefined)).toBe(false);
    expect(pregameStartPassed('pre', 0)).toBe(false);
  });
});

// The browser's HTTP cache can't be intercepted by the edge start-time
// bypass, so today's non-live TTL is clamped to never span first pitch.
describe('todayCacheMaxAge browser-TTL clamp', () => {
  const now = Date.now();

  it('returns the cap when no pre-game is pending', () => {
    expect(todayCacheMaxAge([], 30)).toBe(30);
  });

  it('caps a far-off pre-game at the ceiling, not its full countdown', () => {
    expect(todayCacheMaxAge([now + 3 * 60 * 60 * 1000], 30)).toBe(30);
  });

  it('clamps to the seconds remaining until an imminent first pitch', () => {
    const ttl = todayCacheMaxAge([now + 12_000], 30);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(12);
  });

  it('returns 0 once the start time has passed (no caching over a live game)', () => {
    expect(todayCacheMaxAge([now - 60_000], 30)).toBe(0);
  });

  it('takes the nearest pre-game across several pending starts', () => {
    const ttl = todayCacheMaxAge([now + 3 * 60 * 60 * 1000, now + 10_000], 30);
    expect(ttl).toBeLessThanOrEqual(10);
  });
});

// NHL's boxscore sits on gameState "OVER" between the final horn and
// FINAL/OFF. Mapping it to 'pre' wrote a pre-game card for a finished game
// and held the final push until FINAL.
describe('nhlStatusFromGameState', () => {
  it('treats OVER as final alongside FINAL and OFF', () => {
    expect(nhlStatusFromGameState('OVER')).toBe('final');
    expect(nhlStatusFromGameState('FINAL')).toBe('final');
    expect(nhlStatusFromGameState('OFF')).toBe('final');
  });

  it('maps LIVE/CRIT to live and everything else to pre', () => {
    expect(nhlStatusFromGameState('LIVE')).toBe('live');
    expect(nhlStatusFromGameState('CRIT')).toBe('live');
    expect(nhlStatusFromGameState('FUT')).toBe('pre');
    expect(nhlStatusFromGameState('PRE')).toBe('pre');
    expect(nhlStatusFromGameState(undefined)).toBe('pre');
  });
});

// runSportsCron sub-minute live polling. The clock + sleep are injected so
// the loop runs instantly; the boxscore mock is scripted per call so each
// test controls what every pass sees and counts how many passes ran.
describe('runSportsCron live sub-passes', () => {
  const testEnv = env as unknown as Env;

  function todayYmd(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Toronto',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  async function resetDb(subs: { league: 'NHL' | 'MLB'; team: string }[]) {
    // Test-local tables (no users FK) — the cron only reads league/team_key.
    await testEnv.DB.prepare(
      `CREATE TABLE IF NOT EXISTS user_sports_subs (
         user_id TEXT NOT NULL, league TEXT NOT NULL, team_key TEXT NOT NULL,
         created_at INTEGER NOT NULL, PRIMARY KEY (user_id, league, team_key))`,
    ).run();
    await testEnv.DB.prepare(
      `CREATE TABLE IF NOT EXISTS kv_state (
         key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    ).run();
    await testEnv.DB.prepare(`DELETE FROM user_sports_subs`).run();
    await testEnv.DB.prepare(`DELETE FROM kv_state`).run();
    for (const s of subs) {
      await testEnv.DB.prepare(
        `INSERT INTO user_sports_subs (user_id, league, team_key, created_at) VALUES ('u1', ?, ?, 0)`,
      )
        .bind(s.league, s.team)
        .run();
    }
  }

  async function readState(league: string, team: string) {
    const row = await testEnv.DB.prepare(`SELECT value FROM kv_state WHERE key = ?`)
      .bind(`sports:${league}:${team}:${todayYmd()}`)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as { status: string; homeScore: number; awayScore: number }) : null;
  }

  function fakeClock() {
    const c = {
      t: 1_000_000,
      sleeps: [] as number[],
      now: () => c.t,
      sleep: async (ms: number) => {
        c.sleeps.push(ms);
        c.t += ms;
      },
    };
    return c;
  }

  type Box = { gameState: string; home?: number; away?: number };

  // Mocks one NHL team's schedule + landing (single-use, pass 1 only) and a
  // persistent boxscore that walks `script` one entry per call (sticking on
  // the last). Game ids are unique per test so the persistent interceptor
  // can't leak into another test.
  function mockNhl(abbr: string, gameId: number, script: Box[], onBox?: (n: number) => void) {
    const origin = fetchMock.get('https://api-web.nhle.com');
    origin
      .intercept({ path: `/v1/club-schedule/${abbr}/week/now` })
      .reply(200, {
        games: [
          {
            id: gameId,
            gameDate: todayYmd(),
            startTimeUTC: new Date(Date.now() - 3600_000).toISOString(),
            gameState: 'PRE', // schedule lags; boxscore owns status
            homeTeam: { abbrev: abbr, name: { default: 'Home' } },
            awayTeam: { abbrev: 'BOS', name: { default: 'Away' } },
          },
        ],
      });
    origin.intercept({ path: `/v1/gamecenter/${gameId}/landing` }).reply(200, {});
    const calls = { n: 0 };
    origin
      .intercept({ path: `/v1/gamecenter/${gameId}/boxscore` })
      .reply(200, () => {
        const b = script[Math.min(calls.n, script.length - 1)]!;
        calls.n++;
        onBox?.(calls.n);
        return {
          gameState: b.gameState,
          homeTeam: { score: b.home ?? 0 },
          awayTeam: { score: b.away ?? 0 },
          periodDescriptor: { number: 2 },
          clock: { timeRemaining: '10:00', inIntermission: false },
        };
      })
      .persist();
    return calls;
  }

  it('does exactly one pass and never sleeps when no game is live', async () => {
    await resetDb([{ league: 'NHL', team: 'MTL' }]);
    const box = mockNhl('MTL', 2025990001, [{ gameState: 'FUT' }]);
    const clock = fakeClock();

    await runSportsCron(testEnv, clock);

    expect(box.n).toBe(1);
    expect(clock.sleeps).toEqual([]);
    expect((await readState('NHL', 'MTL'))?.status).toBe('pre');
  });

  it('re-polls a live game every interval until the deadline', async () => {
    await resetDb([{ league: 'NHL', team: 'TOR' }]);
    const box = mockNhl('TOR', 2025990002, [
      { gameState: 'LIVE' },
      { gameState: 'LIVE' },
      { gameState: 'LIVE', home: 1 }, // goal picked up mid-minute
      { gameState: 'LIVE', home: 1 },
    ]);
    const clock = fakeClock();
    const start = clock.t;

    await runSportsCron(testEnv, clock);

    const extra = Math.floor(LIVE_POLL_DEADLINE_MS / LIVE_POLL_INTERVAL_MS);
    expect(box.n).toBe(1 + extra);
    expect(clock.sleeps).toEqual(Array(extra).fill(LIVE_POLL_INTERVAL_MS));
    expect(clock.t - start).toBeLessThanOrEqual(LIVE_POLL_DEADLINE_MS);
    expect(await readState('NHL', 'TOR')).toEqual({ status: 'live', homeScore: 1, awayScore: 0 });
  });

  it('never starts a sub-pass after the deadline when passes run slow', async () => {
    await resetDb([{ league: 'NHL', team: 'OTT' }]);
    const clock = fakeClock();
    // Each boxscore fetch "takes" 20s of wall clock.
    const box = mockNhl('OTT', 2025990003, [{ gameState: 'LIVE' }], () => {
      clock.t += 20_000;
    });

    await runSportsCron(testEnv, clock);

    // Pass 1 0→20s, sub-pass 20→40s, sub-pass starting at 40s (== DEADLINE,
    // allowed). The next would be due at 60s, past DEADLINE → no 4th call.
    expect(box.n).toBe(3);
    expect(clock.sleeps).toEqual([]);
  });

  it('skips remaining games once the hard stop has elapsed', async () => {
    await resetDb([
      { league: 'NHL', team: 'CGY' },
      { league: 'NHL', team: 'EDM' },
    ]);
    const clock = fakeClock();
    const start = clock.t;
    // Wall-clock offset (from cron start) at which each boxscore fetch began.
    const fetchStarts: number[] = [];
    // Pass 1: each game's fetch takes 20s (slow first pass / cron jitter)
    // → pass 1 ends at 40s, so a sub-pass is still due (40s <= DEADLINE).
    // In that sub-pass the first game's fetch takes 12s → 52s, past the
    // hard stop, so the second game must be skipped, not fetched.
    const delays: Record<string, number[]> = { CGY: [20_000, 12_000], EDM: [20_000, 12_000] };
    const timed = (abbr: string) => (n: number) => {
      fetchStarts.push(clock.t - start);
      clock.t += delays[abbr]![Math.min(n - 1, delays[abbr]!.length - 1)]!;
    };
    const cgy = mockNhl('CGY', 2025990005, [{ gameState: 'LIVE' }], timed('CGY'));
    const edm = mockNhl('EDM', 2025990006, [{ gameState: 'LIVE' }], timed('EDM'));

    await runSportsCron(testEnv, clock);

    // Which team the DB returns first isn't guaranteed; total counts are.
    expect(cgy.n + edm.n).toBe(3); // 2 in pass 1, 1 in the sub-pass, 1 skipped
    expect(fetchStarts).toEqual([0, 20_000, 40_000]);
    for (const t of fetchStarts) expect(t).toBeLessThanOrEqual(LIVE_POLL_HARD_STOP_MS);
    expect(clock.sleeps).toEqual([]);
  });

  it('stops polling a game once it goes final (OVER counts as final)', async () => {
    await resetDb([{ league: 'NHL', team: 'WPG' }]);
    const box = mockNhl('WPG', 2025990004, [
      { gameState: 'LIVE', home: 2, away: 1 },
      { gameState: 'LIVE', home: 2, away: 1 },
      { gameState: 'OVER', home: 2, away: 1 },
      { gameState: 'OFF', home: 2, away: 1 },
    ]);
    const clock = fakeClock();

    await runSportsCron(testEnv, clock);

    expect(box.n).toBe(3); // pass 1 + two sub-passes; nothing after OVER
    expect(clock.sleeps).toEqual([LIVE_POLL_INTERVAL_MS, LIVE_POLL_INTERVAL_MS]);
    expect(await readState('NHL', 'WPG')).toEqual({ status: 'final', homeScore: 2, awayScore: 1 });
  });

  it('re-polls MLB through the schedule and stops at Final', async () => {
    await resetDb([{ league: 'MLB', team: String(TOR) }]);
    const game = (state: string, home: number, away: number) => ({
      gamePk: 700100,
      gameDate: '2026-08-07T22:10:00Z',
      gameType: 'R',
      status: { abstractGameState: state, detailedState: state },
      teams: {
        home: { team: { id: 141, name: 'Toronto Blue Jays', abbreviation: 'TOR' }, score: home },
        away: { team: { id: 143, name: 'Philadelphia Phillies', abbreviation: 'PHI' }, score: away },
      },
      linescore: { currentInning: 9, inningHalf: 'Bottom', outs: 2 },
      venue: { name: 'Rogers Centre' },
    });
    mockSchedule(game('Live', 3, 2));
    mockLinescore({ currentInning: 9, inningHalf: 'Bottom', outs: 2, teams: { home: { runs: 3 }, away: { runs: 2 } } });
    mockSchedule(game('Final', 4, 2));
    const clock = fakeClock();

    await runSportsCron(testEnv, clock);

    expect(clock.sleeps).toEqual([LIVE_POLL_INTERVAL_MS]);
    expect(await readState('MLB', String(TOR))).toEqual({ status: 'final', homeScore: 4, awayScore: 2 });
  });

  // ---- push assertions -------------------------------------------------

  type Pushed = { league: string; teamKey: string; kind: string };
  function pushRecorder() {
    const pushes: Pushed[] = [];
    const push: SportsPushFn = async (_env, league, teamKey, kind) => {
      pushes.push({ league, teamKey, kind });
    };
    return { pushes, push };
  }

  // Like mockNhl, but every boxscore response is its own single-use
  // interceptor, consumed in order — so a step can be a network error
  // (replyWithError), which a persistent scripted reply can't express.
  function mockNhlSeq(abbr: string, gameId: number, steps: (Box | 'error')[]) {
    const origin = fetchMock.get('https://api-web.nhle.com');
    origin.intercept({ path: `/v1/club-schedule/${abbr}/week/now` }).reply(200, {
      games: [
        {
          id: gameId,
          gameDate: todayYmd(),
          startTimeUTC: new Date(Date.now() - 3600_000).toISOString(),
          gameState: 'PRE',
          homeTeam: { abbrev: abbr, name: { default: 'Home' } },
          awayTeam: { abbrev: 'BOS', name: { default: 'Away' } },
        },
      ],
    });
    origin.intercept({ path: `/v1/gamecenter/${gameId}/landing` }).reply(200, {});
    for (const s of steps) {
      const i = origin.intercept({ path: `/v1/gamecenter/${gameId}/boxscore` });
      if (s === 'error') i.replyWithError(new Error('upstream reset'));
      else
        i.reply(200, {
          gameState: s.gameState,
          homeTeam: { score: s.home ?? 0 },
          awayTeam: { score: s.away ?? 0 },
          periodDescriptor: { number: 3 },
          clock: { timeRemaining: '05:00', inIntermission: false },
        });
    }
  }

  it('live → OVER → OFF sends exactly one final push across invocations', async () => {
    await resetDb([{ league: 'NHL', team: 'VAN' }]);
    const rec = pushRecorder();
    // Invocation 1: pass 1 LIVE (baseline, no push), sub-pass OVER → final.
    mockNhlSeq('VAN', 2025990010, [
      { gameState: 'LIVE', home: 3, away: 2 },
      { gameState: 'OVER', home: 3, away: 2 },
    ]);
    await runSportsCron(testEnv, { ...fakeClock(), push: rec.push });
    expect(rec.pushes).toEqual([{ league: 'NHL', teamKey: 'VAN', kind: 'final' }]);

    // Invocation 2 (next minute): league stamps OFF — still 'final', no push.
    mockNhlSeq('VAN', 2025990010, [{ gameState: 'OFF', home: 3, away: 2 }]);
    await runSportsCron(testEnv, { ...fakeClock(), push: rec.push });
    expect(rec.pushes).toEqual([{ league: 'NHL', teamKey: 'VAN', kind: 'final' }]);
    expect(await readState('NHL', 'VAN')).toEqual({ status: 'final', homeScore: 3, awayScore: 2 });
  });

  it('a goal first seen in a re-poll sends exactly one score push', async () => {
    await resetDb([{ league: 'NHL', team: 'SEA' }]);
    const rec = pushRecorder();
    mockNhlSeq('SEA', 2025990011, [
      { gameState: 'LIVE' },
      { gameState: 'LIVE' },
      { gameState: 'LIVE', home: 1 }, // goal at the 30s sub-pass
    ]);
    await runSportsCron(testEnv, { ...fakeClock(), push: rec.push });
    expect(rec.pushes).toEqual([{ league: 'NHL', teamKey: 'SEA', kind: 'score' }]);
    expect(await readState('NHL', 'SEA')).toEqual({ status: 'live', homeScore: 1, awayScore: 0 });
  });

  it('a fetch that errors mid-loop does not stop the other games', async () => {
    await resetDb([
      { league: 'NHL', team: 'NSH' },
      { league: 'NHL', team: 'DAL' },
    ]);
    const rec = pushRecorder();
    // Each game errors in a different sub-pass, so whichever order D1
    // returns the subs in, one sub-pass has the error ahead of the other
    // game. The errored game must also stay in the live set and be
    // re-polled on the next sub-pass.
    mockNhlSeq('NSH', 2025990012, [{ gameState: 'LIVE' }, 'error', { gameState: 'LIVE', home: 1 }]);
    mockNhlSeq('DAL', 2025990013, [{ gameState: 'LIVE' }, { gameState: 'LIVE', home: 1 }, 'error']);
    const clock = fakeClock();
    await runSportsCron(testEnv, { ...clock, push: rec.push });

    expect(clock.sleeps).toEqual([LIVE_POLL_INTERVAL_MS, LIVE_POLL_INTERVAL_MS]);
    expect(await readState('NHL', 'NSH')).toEqual({ status: 'live', homeScore: 1, awayScore: 0 });
    expect(await readState('NHL', 'DAL')).toEqual({ status: 'live', homeScore: 1, awayScore: 0 });
    expect(rec.pushes.map((p) => `${p.teamKey}:${p.kind}`).sort()).toEqual(['DAL:score', 'NSH:score']);
  });
});

// Two overlapping cron invocations can both read the same stale kv_state
// row. The compare-and-set write must let exactly one of them push.
describe('processGameUpdate compare-and-set', () => {
  const testEnv = env as unknown as Env;
  type Game = Parameters<typeof processGameUpdate>[3];

  const game = (home: number, away: number): Game => ({
    id: '2025990099',
    league: 'NHL',
    status: 'live',
    statusDetail: 'P2 10:00',
    startTime: 0,
    startTimeLocal: '7:00 PM ET',
    homeTeam: { abbr: 'MTL', name: 'Canadiens', logo: null, score: home },
    awayTeam: { abbr: 'BOS', name: 'Bruins', logo: null, score: away },
    venue: null,
    ourSide: 'home',
  });

  const YMD = '2026-11-08';
  const KEY = `sports:NHL:MTL:${YMD}`;
  const STALE = JSON.stringify({ status: 'live', homeScore: 0, awayScore: 0 });

  async function seed(value: string | null) {
    await testEnv.DB.prepare(
      `CREATE TABLE IF NOT EXISTS kv_state (
         key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
    ).run();
    await testEnv.DB.prepare(`DELETE FROM kv_state`).run();
    if (value !== null) {
      await testEnv.DB.prepare(`INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, 0)`)
        .bind(KEY, value)
        .run();
    }
  }

  // Resolves once `n` callers have arrived — lines both updates up on the
  // same read before either writes.
  function barrier(n: number) {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    return async () => {
      if (++arrived === n) release();
      await all;
    };
  }

  it('only the invocation that wins the write pushes', async () => {
    await seed(STALE);
    const pushes: string[] = [];
    const push: SportsPushFn = async (_e, _l, _t, kind) => {
      pushes.push(kind);
    };
    const afterRead = barrier(2);

    await Promise.all([
      processGameUpdate(testEnv, YMD, 'MTL', game(1, 0), { push, afterRead }),
      processGameUpdate(testEnv, YMD, 'MTL', game(1, 0), { push, afterRead }),
    ]);

    expect(pushes).toEqual(['score']); // the loser returned before push
    const row = await testEnv.DB.prepare(`SELECT value FROM kv_state WHERE key = ?`)
      .bind(KEY)
      .first<{ value: string }>();
    expect(JSON.parse(row!.value)).toEqual({ status: 'live', homeScore: 1, awayScore: 0 });
  });

  it('two different updates from the same stale read: exactly one lands and pushes', async () => {
    await seed(STALE);
    const pushes: string[] = [];
    const push: SportsPushFn = async (_e, _l, _t, kind) => {
      pushes.push(kind);
    };
    const afterRead = barrier(2);

    // Both read 0-0; one writes 1-0, the other 2-0. Exactly one lands and
    // pushes; the stored row is the winner's, not a blind last-writer.
    await Promise.all([
      processGameUpdate(testEnv, YMD, 'MTL', game(1, 0), { push, afterRead }),
      processGameUpdate(testEnv, YMD, 'MTL', game(2, 0), { push, afterRead }),
    ]);

    expect(pushes).toEqual(['score']);
    const row = await testEnv.DB.prepare(`SELECT value FROM kv_state WHERE key = ?`)
      .bind(KEY)
      .first<{ value: string }>();
    const stored = JSON.parse(row!.value) as { homeScore: number };
    expect([1, 2]).toContain(stored.homeScore);
  });

  it('first sighting racing itself sets one baseline and never pushes', async () => {
    await seed(null);
    const pushes: string[] = [];
    const push: SportsPushFn = async (_e, _l, _t, kind) => {
      pushes.push(kind);
    };
    const afterRead = barrier(2);

    await Promise.all([
      processGameUpdate(testEnv, YMD, 'MTL', game(1, 0), { push, afterRead }),
      processGameUpdate(testEnv, YMD, 'MTL', game(1, 0), { push, afterRead }),
    ]);

    expect(pushes).toEqual([]);
    const n = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM kv_state WHERE key = ?`)
      .bind(KEY)
      .first<{ n: number }>();
    expect(n!.n).toBe(1);
  });
});
