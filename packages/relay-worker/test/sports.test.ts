// Sports cron / feed live-state tests. The important invariant: a
// "game starting" push must fire at FIRST PITCH, not during pregame.
// MLB's /linescore endpoint pre-populates currentInning=1 ("Top 1st")
// while a game is still in Preview/Warmup, so the feed must NOT treat
// currentInning > 0 as "the game is live" — it has to trust the
// schedule's abstractGameState. These tests pin that behavior.
import { beforeAll, describe, expect, it } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { fetchMlbForTeam } from '../src/sports';

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
