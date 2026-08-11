// Sports cron / feed live-state tests. The important invariant: a
// "game starting" push must fire at FIRST PITCH, not during pregame.
// MLB's /linescore endpoint pre-populates currentInning=1 ("Top 1st")
// while a game is still in Preview/Warmup, so the feed must NOT treat
// currentInning > 0 as "the game is live" — it has to trust the
// schedule's abstractGameState. These tests pin that behavior.
import { beforeAll, describe, expect, it } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { fetchMlbForTeam, pregameStartPassed, todayCacheMaxAge } from '../src/sports';

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
