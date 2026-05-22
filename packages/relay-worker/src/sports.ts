import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { sendPush, type VapidKeys } from './lib/web-push';

// Per-user sports feed. Each user follows zero-or-more (league, team)
// pairs in user_sports_subs; the feed and the cron broadcast both pivot
// off those rows. The Canadiens and Blue Jays remain the default seed
// for legacy users — see the deploy-worker.yml backfill — but nothing
// in this module is hardcoded to either team.
//
// External APIs we proxy:
//   - NHL: api-web.nhle.com (schedule, gamecenter landing + boxscore).
//   - MLB: statsapi.mlb.com (schedule with hydrate, feed/live for detail).
//
// All upstream responses are cached in caches.default — 30s during a
// live game, 5 min otherwise.

const DEFAULT_NHL_ABBR = 'MTL';
const DEFAULT_MLB_ID = '141'; // Toronto Blue Jays — string for storage parity.

interface Team {
  abbr: string;
  name: string;
  logo: string | null;
  score: number | null;
}

// Playoff context, attached to a Game when both the schedule and league
// API expose it. `gameLabel` is "Game 4" / "Game 7 (if necessary)";
// `seriesLabel` is "MTL leads 2-1" / "Series tied 1-1" / "MTL wins 4-2".
interface Series {
  round: string | null; // "First Round" / "ALDS" — null when unknown
  gameLabel: string; // "Game 4 of 7"
  seriesLabel: string; // "MTL leads series 2-1"
}

interface Game {
  // Per-league native id (NHL gameId, MLB gamePk) as a string. The
  // client uses this to look up `/sports/nhl/:id` and `/sports/mlb/:id`.
  id: string;
  league: 'NHL' | 'MLB';
  status: 'pre' | 'live' | 'final';
  statusDetail: string; // short single-line summary
  startTime: number; // ms epoch
  startTimeLocal: string; // "7:00 PM ET"
  homeTeam: Team;
  awayTeam: Team;
  venue: string | null;
  ourSide: 'home' | 'away';
  series?: Series; // playoffs only
}

// One entry in /sports — combines today's game (if any) with the most
// recent final, so the feed can always show *something* relevant for
// each followed team.
interface SubGames {
  league: 'NHL' | 'MLB';
  teamKey: string; // NHL: abbrev. MLB: numeric team id as string.
  current: Game | null;
  previous: Game | null;
}

interface LinescoreTotal {
  label: string; // "R", "H", "E" (MLB) | "G", "SOG" (NHL)
  home: number;
  away: number;
}

interface LinescorePeriod {
  label: string; // "1st" / "2nd" / "OT" / "SO" (NHL) | "1" / "2" ... (MLB)
  home: number | null;
  away: number | null;
}

interface ScoringPlay {
  period: string; // "1st" or "Top 5"
  clock?: string; // NHL only, "12:34"
  teamAbbr: string;
  description: string;
  homeScore: number;
  awayScore: number;
}

interface ThreeStar {
  star: 1 | 2 | 3;
  name: string;
  teamAbbr: string;
  note?: string; // e.g. "2G 1A" for NHL
}

// One row in a per-team box-score table. `line` is the league's
// conventional one-line stat summary, formatted on the worker so the
// UI doesn't have to re-implement it.
interface BoxPlayer {
  name: string;
  pos?: string; // C / G / SP / RP / etc.
  line: string; // "2-4, HR, 2 RBI" or "1G 2A +2"
  decision?: 'W' | 'L' | 'SV' | 'BS'; // MLB pitcher
}

interface TeamBox {
  teamAbbr: string;
  // MLB
  batters?: BoxPlayer[];
  pitchers?: BoxPlayer[];
  // NHL
  skaters?: BoxPlayer[];
  goalies?: BoxPlayer[];
  // Team-level summary stats. Pre-formatted, e.g. "Power play: 1/4".
  stats?: { label: string; value: string }[];
}

interface GameDetail extends Game {
  linescore: LinescorePeriod[];
  totals: LinescoreTotal[];
  scoringPlays: ScoringPlay[];
  threeStars?: ThreeStar[]; // NHL only
  homeBox: TeamBox;
  awayBox: TeamBox;
}

export function sportsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/sports', async (c) => {
    const ymd = todayInToronto();
    const me = await readAuthedUser(c.env, c.req.raw);
    const subs = await loadSubs(c.env, me?.id ?? null);

    // Per-user cache key — anonymous shares one entry, authed users get
    // their own. Still cheap because the upstream API responses are
    // cached separately and reused across cache misses here.
    const subKey = subs.map((s) => `${s.league}:${s.teamKey}`).join(',');
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/sports/${ymd}?subs=${encodeURIComponent(subKey)}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const items = await Promise.all(
      subs.map(async (s) => ({
        league: s.league,
        teamKey: s.teamKey,
        current:
          s.league === 'NHL'
            ? await fetchNhlForTeam(s.teamKey, ymd)
            : await fetchMlbForTeam(s.teamKey, ymd),
        previous:
          s.league === 'NHL'
            ? await fetchNhlPrevious(s.teamKey, ymd)
            : await fetchMlbPrevious(s.teamKey, ymd),
      })),
    );

    // Backwards-compat: clients that only know `.games` still see a flat
    // array of today's games. The new `.subs` carries the full
    // current+previous per team.
    const games = items
      .map((i) => i.current)
      .filter((g): g is Game => g !== null);

    const hasLive = games.some((g) => g.status === 'live');
    const ttl = hasLive ? 30 : 300;
    const resp = new Response(JSON.stringify({ games, subs: items }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${ttl}`,
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  // Static-ish list of selectable teams. The NHL teams endpoint and MLB
  // teams endpoint don't change often, so we lean on the upstream cache
  // headers — 24h is plenty.
  app.get('/sports/teams', async (c) => {
    const cache = (caches as unknown as { default: Cache }).default;
    // Cache key is versioned so we can bust stale responses without
    // waiting for max-age. v2 forces a refetch after switching the NHL
    // source from /stats/rest/en/team (all franchises ever) to
    // /v1/standings/now (active 32 only) — without this, browsers
    // would keep seeing the Atlanta Flames etc for up to 24h.
    const cacheKey = new Request('https://relay-cache.local/sports/teams?v=2');
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const [nhl, mlb] = await Promise.all([fetchNhlTeams(), fetchMlbTeams()]);
    const resp = new Response(JSON.stringify({ nhl, mlb }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=86400',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  // Per-game detail. Cached by id so a tap on the card doesn't fan out
  // to the league API every time. TTL matches the list endpoint: short
  // while the game's live so the line score / scoring summary updates.
  // `?abbr=` / `?teamId=` overrides which side gets the "ours" highlight
  // so a fan of either team in the matchup sees their own perspective.
  app.get('/sports/nhl/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const ourAbbr = (c.req.query('abbr') ?? DEFAULT_NHL_ABBR).toUpperCase();
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/sports/nhl/${id}?abbr=${ourAbbr}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const detail = await fetchNhlDetail(id, ourAbbr);
    if (!detail) return c.json({ error: 'not found' }, 404);
    const ttl = detail.status === 'live' ? 30 : 300;
    const resp = new Response(JSON.stringify(detail), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${ttl}`,
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  app.get('/sports/mlb/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const ourTeamId = c.req.query('teamId') ?? DEFAULT_MLB_ID;
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/sports/mlb/${id}?teamId=${ourTeamId}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const detail = await fetchMlbDetail(id, Number(ourTeamId) || Number(DEFAULT_MLB_ID));
    if (!detail) return c.json({ error: 'not found' }, 404);
    const ttl = detail.status === 'live' ? 30 : 300;
    const resp = new Response(JSON.stringify(detail), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${ttl}`,
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  return app;
}

// ---- Subscriptions -----------------------------------------------------

interface SubRow {
  league: 'NHL' | 'MLB';
  teamKey: string;
}

async function loadSubs(env: Env, userId: string | null): Promise<SubRow[]> {
  if (userId) {
    const rows = await env.DB.prepare(
      `SELECT league, team_key FROM user_sports_subs
        WHERE user_id = ? ORDER BY league, team_key`,
    )
      .bind(userId)
      .all<{ league: 'NHL' | 'MLB'; team_key: string }>();
    const list = (rows.results ?? []).map((r) => ({ league: r.league, teamKey: r.team_key }));
    if (list.length > 0) return list;
  }
  // Anon viewers (and authed users with no rows yet) get the legacy
  // MTL + TOR pair so the feed always has content.
  return [
    { league: 'NHL', teamKey: DEFAULT_NHL_ABBR },
    { league: 'MLB', teamKey: DEFAULT_MLB_ID },
  ];
}

function todayInToronto(): string {
  // en-CA gives ISO YYYY-MM-DD format in the requested timezone.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function localTime(ts: number): string {
  if (!ts) return '';
  return (
    new Date(ts).toLocaleTimeString('en-US', {
      timeZone: 'America/Toronto',
      hour: 'numeric',
      minute: '2-digit',
    }) + ' ET'
  );
}

function nhlPeriodLabel(p: number | undefined | null): string {
  const n = Number(p);
  if (!Number.isFinite(n)) return '';
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  if (n === 4) return 'OT';
  if (n === 5) return 'SO';
  return `${n}th OT`;
}

function ordinalInning(n: number): string {
  if (!Number.isFinite(n) || n < 1) return '';
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
}

// ---- NHL ----------------------------------------------------------------

async function fetchNhlForTeam(abbr: string, ymd: string): Promise<Game | null> {
  try {
    // Team-specific weekly schedule. Includes every game for `abbr` in
    // the current week regardless of state (FUT / PRE / LIVE / OFF /
    // FINAL), unlike /score/now which only surfaces games already
    // underway. That's why pre-game evening games weren't appearing.
    const r = await fetch(
      `https://api-web.nhle.com/v1/club-schedule/${abbr}/week/now`,
      { cf: { cacheTtl: 30 } } as RequestInit,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as {
      games?: NhlRawGame[];
      gamesByDate?: { date?: string; games?: NhlRawGame[] }[];
    };
    const flat: NhlRawGame[] =
      data.games ?? (data.gamesByDate ?? []).flatMap((d) => d.games ?? []);
    const ev = flat.find((g) => g?.gameDate === ymd);
    if (!ev) return null;
    const game = parseNhlGame(ev, abbr);
    if (ev.gameType === 3) {
      game.series = (await fetchNhlSeries(String(ev.id ?? ''), abbr)) ?? undefined;
    }
    return game;
  } catch {
    return null;
  }
}

async function fetchNhlPrevious(abbr: string, beforeYmd: string): Promise<Game | null> {
  try {
    // Full-season schedule. The "previous" definition is "most recent
    // game that has finished" — gameState in (OFF, FINAL) and gameDate
    // < today. We sort the result client-side rather than trusting the
    // API to give them back in any particular order.
    const r = await fetch(
      `https://api-web.nhle.com/v1/club-schedule-season/${abbr}/now`,
      { cf: { cacheTtl: 300 } } as RequestInit,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as { games?: NhlRawGame[] };
    const candidates = (data.games ?? []).filter(
      (g) =>
        g?.gameDate &&
        g.gameDate < beforeYmd &&
        (g.gameState === 'OFF' || g.gameState === 'FINAL'),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.gameDate ?? '').localeCompare(b.gameDate ?? ''));
    const ev = candidates[candidates.length - 1]!;
    const game = parseNhlGame(ev, abbr);
    if (ev.gameType === 3) {
      game.series = (await fetchNhlSeries(String(ev.id ?? ''), abbr)) ?? undefined;
    }
    return game;
  } catch {
    return null;
  }
}

// Series info for an NHL playoff game. Pulled from gamecenter/landing
// which carries `seriesStatus` with topSeed/bottomSeed wins and game
// number. Best-effort — returns null if either endpoint fails.
async function fetchNhlSeries(gameId: string, ourAbbr: string): Promise<Series | null> {
  if (!gameId) return null;
  try {
    const r = await fetch(
      `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`,
      { cf: { cacheTtl: 300 } } as RequestInit,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as {
      seriesStatus?: {
        round?: number;
        seriesAbbrev?: string;
        seriesLetter?: string;
        seriesTitle?: string;
        gameNumberOfSeries?: number;
        topSeedTeamAbbrev?: string;
        topSeedWins?: number;
        bottomSeedTeamAbbrev?: string;
        bottomSeedWins?: number;
        neededToWin?: number;
      };
    };
    const s = data.seriesStatus;
    if (!s) return null;
    return buildSeries({
      title: s.seriesTitle ?? null,
      gameNumber: s.gameNumberOfSeries ?? null,
      neededToWin: s.neededToWin ?? 4,
      a: { abbr: s.topSeedTeamAbbrev ?? '', wins: s.topSeedWins ?? 0 },
      b: { abbr: s.bottomSeedTeamAbbrev ?? '', wins: s.bottomSeedWins ?? 0 },
      ourAbbr,
    });
  } catch {
    return null;
  }
}

interface NhlRawTeam {
  abbrev?: string;
  name?: { default?: string };
  placeName?: { default?: string };
  logo?: string;
  score?: number;
}
interface NhlRawGame {
  id?: number;
  gameDate?: string;
  startTimeUTC?: string;
  homeTeam?: NhlRawTeam;
  awayTeam?: NhlRawTeam;
  gameState?: string;
  gameType?: number; // 2 = regular, 3 = playoffs
  period?: number;
  clock?: { timeRemaining?: string; running?: boolean; inIntermission?: boolean };
  venue?: { default?: string };
}

function parseNhlGame(ev: NhlRawGame, ourAbbr: string): Game {
  const state = String(ev.gameState ?? '');
  const status: 'pre' | 'live' | 'final' =
    state === 'LIVE' || state === 'CRIT'
      ? 'live'
      : state === 'OFF' || state === 'FINAL'
        ? 'final'
        : 'pre';
  const home = ev.homeTeam ?? {};
  const away = ev.awayTeam ?? {};
  const ourSide: 'home' | 'away' = home.abbrev === ourAbbr ? 'home' : 'away';
  const start = Date.parse(ev.startTimeUTC ?? '');
  const startTime = Number.isFinite(start) ? start : 0;
  const startTimeLocal = localTime(startTime);

  let statusDetail = '';
  if (status === 'pre') {
    statusDetail = startTimeLocal;
  } else if (status === 'live') {
    if (ev?.clock?.inIntermission) {
      statusDetail = `${nhlPeriodLabel(ev.period)} INT`;
    } else {
      const clock = ev?.clock?.timeRemaining ?? '';
      statusDetail = `${nhlPeriodLabel(ev.period)} ${clock}`.trim();
    }
  } else {
    statusDetail = 'Final';
  }

  return {
    id: ev.id != null ? String(ev.id) : '',
    league: 'NHL',
    status,
    statusDetail,
    startTime,
    startTimeLocal,
    homeTeam: parseNhlTeam(home),
    awayTeam: parseNhlTeam(away),
    venue: ev?.venue?.default ?? null,
    ourSide,
  };
}

function parseNhlTeam(t: NhlRawTeam): Team {
  const name = t.name?.default || t.placeName?.default || t.abbrev || '';
  return {
    abbr: t.abbrev ?? '',
    name,
    logo: t.logo ?? null,
    score: typeof t.score === 'number' ? t.score : null,
  };
}

// ---- MLB ----------------------------------------------------------------

async function fetchMlbForTeam(teamKey: string, ymd: string): Promise<Game | null> {
  const teamId = Number(teamKey);
  if (!Number.isFinite(teamId)) return null;
  try {
    const url =
      'https://statsapi.mlb.com/api/v1/schedule?sportId=1' +
      `&teamId=${teamId}&date=${ymd}&hydrate=linescore,team,venue,seriesStatus`;
    const r = await fetch(url, { cf: { cacheTtl: 30 } } as RequestInit);
    if (!r.ok) return null;
    const data = (await r.json()) as { dates?: { games?: MlbRawGame[] }[] };
    const game = data.dates?.[0]?.games?.[0];
    if (!game) return null;
    return parseMlbGame(game, teamId);
  } catch {
    return null;
  }
}

async function fetchMlbPrevious(teamKey: string, beforeYmd: string): Promise<Game | null> {
  const teamId = Number(teamKey);
  if (!Number.isFinite(teamId)) return null;
  try {
    // 14-day backstop covers regular-season off days and post-season
    // travel days. The schedule API will return only days that have
    // games; we sort and pick the most recent final.
    const end = beforeYmd;
    const start = shiftYmd(beforeYmd, -14);
    const url =
      'https://statsapi.mlb.com/api/v1/schedule?sportId=1' +
      `&teamId=${teamId}&startDate=${start}&endDate=${end}` +
      `&hydrate=linescore,team,venue,seriesStatus`;
    const r = await fetch(url, { cf: { cacheTtl: 300 } } as RequestInit);
    if (!r.ok) return null;
    const data = (await r.json()) as {
      dates?: { date?: string; games?: MlbRawGame[] }[];
    };
    const candidates: MlbRawGame[] = [];
    for (const d of data.dates ?? []) {
      for (const g of d.games ?? []) {
        if (!g.gameDate) continue;
        // Skip today — we want games strictly before today.
        const ymdOfGame = (g.gameDate ?? '').slice(0, 10);
        if (ymdOfGame >= beforeYmd) continue;
        const abs = g.status?.abstractGameState ?? '';
        const det = g.status?.detailedState ?? '';
        if (abs === 'Final' || det === 'Final' || det === 'Game Over') {
          candidates.push(g);
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => (a.gameDate ?? '').localeCompare(b.gameDate ?? ''));
    return parseMlbGame(candidates[candidates.length - 1]!, teamId);
  } catch {
    return null;
  }
}

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

interface MlbRawTeam {
  team?: { id?: number; name?: string; abbreviation?: string };
  score?: number;
  // Hydrated when ?hydrate includes seriesStatus.
  seriesStatus?: MlbSeriesStatus;
}
interface MlbSeriesStatus {
  shortName?: string; // "Wild Card" / "ALDS"
  gameNumber?: number;
  totalGames?: number; // best-of
  description?: string; // "MTL leads 2-1"
  wins?: number;
  losses?: number;
  result?: string; // "win" / "lose" / "tied"
}
interface MlbRawGame {
  gamePk?: number;
  gameDate?: string;
  gameType?: string; // "R" regular, "F"/"D"/"L"/"W" postseason rounds
  seriesDescription?: string;
  seriesGameNumber?: number;
  gamesInSeries?: number;
  status?: { abstractGameState?: string; detailedState?: string };
  teams?: { home?: MlbRawTeam; away?: MlbRawTeam };
  linescore?: {
    currentInning?: number;
    inningHalf?: string; // "Top" | "Bottom"
    outs?: number;
    teams?: {
      home?: { runs?: number };
      away?: { runs?: number };
    };
  };
  venue?: { name?: string };
}

function parseMlbGame(g: MlbRawGame, ourTeamId: number): Game {
  const abs = String(g.status?.abstractGameState ?? '');
  const detailed = String(g.status?.detailedState ?? '');
  const status: 'pre' | 'live' | 'final' =
    abs === 'Live'
      ? 'live'
      : abs === 'Final' || detailed === 'Final' || detailed === 'Game Over'
        ? 'final'
        : 'pre';
  const start = Date.parse(g.gameDate ?? '');
  const startTime = Number.isFinite(start) ? start : 0;
  const startTimeLocal = localTime(startTime);

  const home = g.teams?.home ?? {};
  const away = g.teams?.away ?? {};
  const ourSide: 'home' | 'away' = home.team?.id === ourTeamId ? 'home' : 'away';

  // statsapi schedule's per-team score may be missing during a live game;
  // linescore.teams has the running run total.
  const ls = g.linescore ?? {};
  const homeScore =
    typeof home.score === 'number'
      ? home.score
      : typeof ls.teams?.home?.runs === 'number'
        ? ls.teams.home.runs
        : null;
  const awayScore =
    typeof away.score === 'number'
      ? away.score
      : typeof ls.teams?.away?.runs === 'number'
        ? ls.teams.away.runs
        : null;

  let statusDetail = '';
  if (status === 'pre') {
    statusDetail = startTimeLocal;
  } else if (status === 'live') {
    const half = ls.inningHalf === 'Bottom' ? 'Bot' : 'Top';
    const inn = ls.currentInning ?? 0;
    const outs = ls.outs ?? 0;
    statusDetail = inn
      ? `${half} ${ordinalInning(inn)} · ${outs} out${outs === 1 ? '' : 's'}`
      : detailed;
  } else {
    statusDetail = 'Final';
  }

  // Series context for postseason games. statsapi exposes either a
  // per-team seriesStatus (with wins/losses + a pre-formatted
  // description) or schedule-level seriesGameNumber/gamesInSeries.
  // gameType "R" is regular season; anything else is post.
  let series: Series | undefined;
  const isPost = !!g.gameType && g.gameType !== 'R';
  if (isPost) {
    const ourSS = ourSide === 'home' ? home.seriesStatus : away.seriesStatus;
    const total =
      ourSS?.totalGames ??
      g.gamesInSeries ??
      // Default best-of for MLB rounds: WC=3, DS=5, LCS/WS=7. Fall back to
      // 7 when unknown so the label still reads sensibly.
      7;
    const ourTeam = ourSide === 'home' ? home : away;
    const oppTeam = ourSide === 'home' ? away : home;
    const ourWins = ourSS?.wins ?? 0;
    const oppWins = ourSS?.losses ?? 0;
    series = buildSeries({
      title: ourSS?.shortName ?? g.seriesDescription ?? null,
      gameNumber: ourSS?.gameNumber ?? g.seriesGameNumber ?? null,
      neededToWin: Math.ceil(total / 2),
      a: { abbr: ourTeam.team?.abbreviation ?? '', wins: ourWins },
      b: { abbr: oppTeam.team?.abbreviation ?? '', wins: oppWins },
      ourAbbr: ourTeam.team?.abbreviation ?? '',
    });
  }

  return {
    id: g.gamePk != null ? String(g.gamePk) : '',
    league: 'MLB',
    status,
    statusDetail,
    startTime,
    startTimeLocal,
    homeTeam: parseMlbTeam(home, homeScore),
    awayTeam: parseMlbTeam(away, awayScore),
    venue: g.venue?.name ?? null,
    ourSide,
    series,
  };
}

// Shared series-label builder. Either side can be passed first; the
// `ourAbbr` argument resolves the perspective so the output reads
// naturally from the user's team's POV.
function buildSeries(input: {
  title: string | null;
  gameNumber: number | null;
  neededToWin: number;
  a: { abbr: string; wins: number };
  b: { abbr: string; wins: number };
  ourAbbr: string;
}): Series {
  const { title, gameNumber, neededToWin, a, b, ourAbbr } = input;
  const totalGames = neededToWin * 2 - 1; // best-of
  const ours = a.abbr === ourAbbr ? a : b;
  const theirs = a.abbr === ourAbbr ? b : a;

  let seriesLabel: string;
  if (ours.wins === neededToWin) {
    seriesLabel = `${ours.abbr} wins series ${ours.wins}-${theirs.wins}`;
  } else if (theirs.wins === neededToWin) {
    seriesLabel = `${theirs.abbr} wins series ${theirs.wins}-${ours.wins}`;
  } else if (ours.wins === theirs.wins) {
    seriesLabel = `Series tied ${ours.wins}-${theirs.wins}`;
  } else if (ours.wins > theirs.wins) {
    seriesLabel = `${ours.abbr} leads series ${ours.wins}-${theirs.wins}`;
  } else {
    seriesLabel = `${theirs.abbr} leads series ${theirs.wins}-${ours.wins}`;
  }

  const gameLabel = gameNumber
    ? `Game ${gameNumber} of ${totalGames}`
    : `Best of ${totalGames}`;

  return { round: title ?? null, gameLabel, seriesLabel };
}

function parseMlbTeam(t: MlbRawTeam, score: number | null): Team {
  const id = t.team?.id;
  // MLB statsapi doesn't return a logo URL in this hydrate, but their
  // public CDN serves team SVGs at a stable path keyed by team id.
  const logo = id ? `https://www.mlbstatic.com/team-logos/${id}.svg` : null;
  return {
    abbr: t.team?.abbreviation ?? '',
    name: t.team?.name ?? '',
    logo,
    score,
  };
}

// ---- Cron + notifications ----------------------------------------------
//
// runSportsCron is called every minute by the worker's scheduled handler.
// It compares each team's current state to the last-seen state stored in
// the kv_state D1 table; when the score changes or the game ends, it
// broadcasts a Web Push to every subscriber with sports notifications
// enabled. Persisting state *before* sending means a transient push
// failure won't re-fire the same notification next minute.

interface PersistedState {
  status: 'pre' | 'live' | 'final';
  homeScore: number;
  awayScore: number;
}

interface SportsEvent {
  title: string;
  body: string;
  tag: string;
  url?: string; // deep-link path for the SW's notificationclick handler
}

export async function runSportsCron(env: Env): Promise<void> {
  const ymd = todayInToronto();
  // Union of every (league, team) that at least one user follows. The
  // cron does zero work for a team nobody follows.
  const subRows = await env.DB.prepare(
    `SELECT DISTINCT league, team_key FROM user_sports_subs`,
  ).all<{ league: 'NHL' | 'MLB'; team_key: string }>();
  const subs = subRows.results ?? [];
  if (subs.length === 0) return;

  for (const sub of subs) {
    const g =
      sub.league === 'NHL'
        ? await fetchNhlForTeam(sub.team_key, ymd)
        : await fetchMlbForTeam(sub.team_key, ymd);
    if (g) await processGameUpdate(env, ymd, sub.team_key, g);
  }
}

async function processGameUpdate(
  env: Env,
  ymd: string,
  teamKey: string,
  g: Game,
): Promise<void> {
  // Per-team kv key so multiple followed teams don't clobber each
  // other's state in the same league on the same date.
  const key = `sports:${g.league}:${teamKey}:${ymd}`;
  // 1 read per game per tick.
  const prevRow = await env.DB.prepare(
    `SELECT value FROM kv_state WHERE key = ?`,
  )
    .bind(key)
    .first<{ value: string }>();

  const prev: PersistedState | null = prevRow
    ? (() => {
        try {
          return JSON.parse(prevRow.value) as PersistedState;
        } catch {
          return null;
        }
      })()
    : null;

  const cur: PersistedState = {
    status: g.status,
    homeScore: g.homeTeam.score ?? 0,
    awayScore: g.awayTeam.score ?? 0,
  };

  // No-op when nothing changed since last tick. Steady state during a
  // game (between goals) and after Final means most cron ticks are
  // read-only — no D1 writes, no push-sub query, no fan-out fetch.
  const unchanged =
    prev !== null &&
    prev.status === cur.status &&
    prev.homeScore === cur.homeScore &&
    prev.awayScore === cur.awayScore;
  if (unchanged) return;

  const value = JSON.stringify(cur);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();

  if (!prev) return; // First sighting — set baseline; never push on cold start.

  interface QueuedEvent {
    payload: SportsEvent;
    kind: 'start' | 'score' | 'final';
  }
  const events: QueuedEvent[] = [];
  const emoji = g.league === 'NHL' ? '🏒' : '⚾';
  const goalWord = g.league === 'NHL' ? 'goal' : 'score';
  // Deep-link target — empty when the upstream API didn't expose the
  // game id (shouldn't happen in practice; the SW falls back to /chats).
  const url = g.id ? `/sports/${g.league.toLowerCase()}/${g.id}` : undefined;

  const ours = g.ourSide === 'home' ? g.homeTeam : g.awayTeam;
  const theirs = g.ourSide === 'home' ? g.awayTeam : g.homeTeam;
  const ourScore = g.ourSide === 'home' ? cur.homeScore : cur.awayScore;
  const theirScore = g.ourSide === 'home' ? cur.awayScore : cur.homeScore;
  const prevOurScore = g.ourSide === 'home' ? prev.homeScore : prev.awayScore;
  const prevTheirScore = g.ourSide === 'home' ? prev.awayScore : prev.homeScore;

  // Pre-game → in-progress transition triggers the optional "start" push.
  if (prev.status === 'pre' && cur.status === 'live') {
    events.push({
      kind: 'start',
      payload: {
        title: `${emoji} ${ours.name} game starting`,
        body: `${ours.abbr} vs ${theirs.abbr} · ${g.statusDetail}`,
        tag: `sports-${g.league}-${teamKey}-start`,
        url,
      },
    });
  }

  if (ourScore > prevOurScore) {
    events.push({
      kind: 'score',
      payload: {
        title: `${emoji} ${ours.name} ${goalWord}!`,
        body: `${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr} · ${g.statusDetail}`,
        tag: `sports-${g.league}-${teamKey}-score`,
        url,
      },
    });
  } else if (theirScore > prevTheirScore) {
    events.push({
      kind: 'score',
      payload: {
        title: `${emoji} ${theirs.name} ${goalWord}`,
        body: `${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr} · ${g.statusDetail}`,
        tag: `sports-${g.league}-${teamKey}-score`,
        url,
      },
    });
  }

  if (prev.status !== 'final' && cur.status === 'final') {
    const won = ourScore > theirScore;
    events.push({
      kind: 'final',
      payload: {
        title: won ? `${emoji} ${ours.name} win!` : `${emoji} ${ours.name} fall`,
        body: `Final · ${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr}`,
        tag: `sports-${g.league}-${teamKey}-final`,
        url,
      },
    });
  }

  for (const ev of events) {
    await broadcastSportsPush(env, g.league, teamKey, ev.kind, ev.payload);
  }
}

async function broadcastSportsPush(
  env: Env,
  league: 'NHL' | 'MLB',
  teamKey: string,
  kind: 'start' | 'score' | 'final',
  payload: SportsEvent,
): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) {
    console.warn('sports: VAPID not configured; skipping push');
    return;
  }
  // The right per-event toggle gates this push. The master switch
  // (sports_notifications) still applies — turning it off silences all
  // sports pushes regardless of the per-event toggles.
  const toggleCol =
    kind === 'start'
      ? 'sports_notify_start'
      : kind === 'score'
        ? 'sports_notify_score'
        : 'sports_notify_final';
  const rows = await env.DB.prepare(
    `SELECT ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     JOIN user_sports_subs s ON s.user_id = u.id
     WHERE COALESCE(u.sports_notifications, 1) = 1
       AND COALESCE(u.${toggleCol}, 1) = 1
       AND s.league = ?
       AND s.team_key = ?`,
  )
    .bind(league, teamKey)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const subs = rows.results ?? [];
  if (subs.length === 0) return;

  const dead: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        const r = await sendPush(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          keys,
        );
        if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
      } catch (err) {
        console.warn('sports: push failed', err);
      }
    }),
  );
  if (dead.length > 0) {
    const ph = dead.map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint IN (${ph})`,
    )
      .bind(...dead)
      .run();
  }
}

function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}

// ---- NHL detail ---------------------------------------------------------

async function fetchNhlDetail(gameId: string, ourAbbr: string): Promise<GameDetail | null> {
  try {
    const [landingResp, boxResp] = await Promise.all([
      fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/landing`, {
        cf: { cacheTtl: 30 },
      } as RequestInit),
      fetch(`https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`, {
        cf: { cacheTtl: 30 },
      } as RequestInit),
    ]);
    if (!landingResp.ok) return null;
    const landing = (await landingResp.json()) as NhlLanding;
    const box = boxResp.ok ? ((await boxResp.json()) as NhlBoxscore) : null;
    return parseNhlDetail(landing, box, ourAbbr);
  } catch {
    return null;
  }
}

interface NhlLanding {
  id?: number;
  gameState?: string;
  gameDate?: string;
  gameType?: number;
  startTimeUTC?: string;
  period?: number;
  clock?: { timeRemaining?: string; inIntermission?: boolean };
  awayTeam?: NhlRawTeam & { sog?: number };
  homeTeam?: NhlRawTeam & { sog?: number };
  venue?: { default?: string };
  seriesStatus?: {
    round?: number;
    seriesAbbrev?: string;
    seriesTitle?: string;
    gameNumberOfSeries?: number;
    topSeedTeamAbbrev?: string;
    topSeedWins?: number;
    bottomSeedTeamAbbrev?: string;
    bottomSeedWins?: number;
    neededToWin?: number;
  };
  summary?: {
    linescore?: {
      byPeriod?: {
        periodDescriptor?: { number?: number; periodType?: string };
        home?: number;
        away?: number;
      }[];
      shotsByPeriod?: {
        periodDescriptor?: { number?: number };
        home?: number;
        away?: number;
      }[];
      totals?: { home?: number; away?: number };
    };
    scoring?: {
      periodDescriptor?: { number?: number; periodType?: string };
      goals?: {
        timeInPeriod?: string;
        teamAbbrev?: { default?: string } | string;
        name?: { default?: string };
        firstName?: { default?: string };
        lastName?: { default?: string };
        shotType?: string;
        strength?: string; // "ev" | "pp" | "sh"
        awayScore?: number;
        homeScore?: number;
        assists?: { name?: { default?: string } }[];
      }[];
    }[];
    threeStars?: {
      star?: number;
      name?: { default?: string } | string;
      firstName?: { default?: string };
      lastName?: { default?: string };
      teamAbbrev?: string;
      goals?: number;
      assists?: number;
      points?: number;
      savePctg?: string;
    }[];
    teamGameStats?: {
      category?: string;
      awayValue?: number | string;
      homeValue?: number | string;
    }[];
  };
}

interface NhlBoxSkater {
  playerId?: number;
  sweaterNumber?: number;
  name?: { default?: string };
  position?: string;
  goals?: number;
  assists?: number;
  points?: number;
  plusMinus?: number;
  pim?: number;
  sog?: number;
  hits?: number;
  toi?: string;
}
interface NhlBoxGoalie {
  playerId?: number;
  name?: { default?: string };
  position?: string;
  decision?: 'W' | 'L' | 'OT' | '';
  shotsAgainst?: number;
  saves?: number;
  savePctg?: number;
  toi?: string;
}
interface NhlBoxTeam {
  forwards?: NhlBoxSkater[];
  defense?: NhlBoxSkater[];
  goalies?: NhlBoxGoalie[];
}
interface NhlBoxscore {
  playerByGameStats?: {
    awayTeam?: NhlBoxTeam;
    homeTeam?: NhlBoxTeam;
  };
}

function parseNhlDetail(
  landing: NhlLanding,
  box: NhlBoxscore | null,
  ourAbbr: string,
): GameDetail {
  const state = String(landing.gameState ?? '');
  const status: 'pre' | 'live' | 'final' =
    state === 'LIVE' || state === 'CRIT'
      ? 'live'
      : state === 'OFF' || state === 'FINAL'
        ? 'final'
        : 'pre';
  const homeRaw = landing.homeTeam ?? {};
  const awayRaw = landing.awayTeam ?? {};
  const ourSide: 'home' | 'away' = homeRaw.abbrev === ourAbbr ? 'home' : 'away';
  const start = Date.parse(landing.startTimeUTC ?? '');
  const startTime = Number.isFinite(start) ? start : 0;
  const startTimeLocal = localTime(startTime);

  let statusDetail: string;
  if (status === 'pre') {
    statusDetail = startTimeLocal;
  } else if (status === 'live') {
    if (landing.clock?.inIntermission) {
      statusDetail = `${nhlPeriodLabel(landing.period)} INT`;
    } else {
      statusDetail = `${nhlPeriodLabel(landing.period)} ${landing.clock?.timeRemaining ?? ''}`.trim();
    }
  } else {
    statusDetail = 'Final';
  }

  // Linescore: align by period number across goals/shots, so a row
  // exists even if one stream is missing it (rare but possible during a
  // live game).
  const byPeriod = landing.summary?.linescore?.byPeriod ?? [];
  const shotsByPeriod = landing.summary?.linescore?.shotsByPeriod ?? [];
  const periodNums = Array.from(
    new Set([
      ...byPeriod.map((b) => b.periodDescriptor?.number ?? 0),
      ...shotsByPeriod.map((b) => b.periodDescriptor?.number ?? 0),
    ]),
  )
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  const linescore: LinescorePeriod[] = periodNums.map((n) => {
    const row = byPeriod.find((b) => b.periodDescriptor?.number === n);
    const type = row?.periodDescriptor?.periodType;
    const label =
      type === 'OT' ? (n > 4 ? `${n - 3}OT` : 'OT') : type === 'SO' ? 'SO' : nhlPeriodLabel(n);
    return {
      label,
      home: typeof row?.home === 'number' ? row.home : null,
      away: typeof row?.away === 'number' ? row.away : null,
    };
  });

  const totals: LinescoreTotal[] = [
    {
      label: 'G',
      home:
        landing.summary?.linescore?.totals?.home ??
        (typeof homeRaw.score === 'number' ? homeRaw.score : 0),
      away:
        landing.summary?.linescore?.totals?.away ??
        (typeof awayRaw.score === 'number' ? awayRaw.score : 0),
    },
    {
      label: 'SOG',
      home: typeof homeRaw.sog === 'number' ? homeRaw.sog : sumShots(shotsByPeriod, 'home'),
      away: typeof awayRaw.sog === 'number' ? awayRaw.sog : sumShots(shotsByPeriod, 'away'),
    },
  ];

  const scoringPlays: ScoringPlay[] = [];
  for (const period of landing.summary?.scoring ?? []) {
    const periodLabel = nhlPeriodLabel(period.periodDescriptor?.number);
    for (const g of period.goals ?? []) {
      const scorerName = g.name?.default || joinName(g.firstName?.default, g.lastName?.default);
      const teamAbbr =
        typeof g.teamAbbrev === 'string' ? g.teamAbbrev : g.teamAbbrev?.default || '';
      const assists = (g.assists ?? [])
        .map((a) => a.name?.default ?? '')
        .filter(Boolean)
        .join(', ');
      const strength = g.strength && g.strength !== 'ev' ? ` (${g.strength.toUpperCase()})` : '';
      const desc = assists
        ? `${scorerName}${strength} — assists: ${assists}`
        : `${scorerName}${strength}`;
      scoringPlays.push({
        period: periodLabel,
        clock: g.timeInPeriod,
        teamAbbr,
        description: desc,
        homeScore: typeof g.homeScore === 'number' ? g.homeScore : 0,
        awayScore: typeof g.awayScore === 'number' ? g.awayScore : 0,
      });
    }
  }

  const threeStars: ThreeStar[] = [];
  for (const s of landing.summary?.threeStars ?? []) {
    const star = (s.star === 1 || s.star === 2 || s.star === 3 ? s.star : 0) as 0 | 1 | 2 | 3;
    if (!star) continue;
    const name =
      (typeof s.name === 'string' ? s.name : s.name?.default) ||
      joinName(s.firstName?.default, s.lastName?.default);
    let note = '';
    if (typeof s.goals === 'number' || typeof s.assists === 'number') {
      const g = s.goals ?? 0;
      const a = s.assists ?? 0;
      note = `${g}G ${a}A`;
    } else if (s.savePctg) {
      note = `Sv% ${s.savePctg}`;
    }
    threeStars.push({ star, name, teamAbbr: s.teamAbbrev ?? '', note: note || undefined });
  }
  threeStars.sort((a, b) => a.star - b.star);

  const teamStats = landing.summary?.teamGameStats ?? [];
  const homeStatRows = nhlTeamStatRows(teamStats, 'home');
  const awayStatRows = nhlTeamStatRows(teamStats, 'away');

  const homeBox: TeamBox = {
    teamAbbr: homeRaw.abbrev ?? '',
    skaters: nhlSkaters(box?.playerByGameStats?.homeTeam),
    goalies: nhlGoalies(box?.playerByGameStats?.homeTeam),
    stats: homeStatRows,
  };
  const awayBox: TeamBox = {
    teamAbbr: awayRaw.abbrev ?? '',
    skaters: nhlSkaters(box?.playerByGameStats?.awayTeam),
    goalies: nhlGoalies(box?.playerByGameStats?.awayTeam),
    stats: awayStatRows,
  };

  // Landing exposes seriesStatus directly on playoff games. Cheaper than
  // the secondary fetch the list endpoint uses.
  let series: Series | undefined;
  const ss = landing.seriesStatus;
  if (ss && (ss.topSeedTeamAbbrev || ss.bottomSeedTeamAbbrev)) {
    series = buildSeries({
      title: ss.seriesTitle ?? null,
      gameNumber: ss.gameNumberOfSeries ?? null,
      neededToWin: ss.neededToWin ?? 4,
      a: { abbr: ss.topSeedTeamAbbrev ?? '', wins: ss.topSeedWins ?? 0 },
      b: { abbr: ss.bottomSeedTeamAbbrev ?? '', wins: ss.bottomSeedWins ?? 0 },
      ourAbbr,
    });
  }

  return {
    id: landing.id != null ? String(landing.id) : '',
    league: 'NHL',
    status,
    statusDetail,
    startTime,
    startTimeLocal,
    homeTeam: parseNhlTeam(homeRaw),
    awayTeam: parseNhlTeam(awayRaw),
    venue: landing.venue?.default ?? null,
    ourSide,
    series,
    linescore,
    totals,
    scoringPlays,
    threeStars: threeStars.length ? threeStars : undefined,
    homeBox,
    awayBox,
  };
}

function sumShots(
  rows: { periodDescriptor?: { number?: number }; home?: number; away?: number }[],
  side: 'home' | 'away',
): number {
  let sum = 0;
  for (const r of rows) {
    const v = side === 'home' ? r.home : r.away;
    if (typeof v === 'number') sum += v;
  }
  return sum;
}

function nhlTeamStatRows(
  rows: { category?: string; homeValue?: number | string; awayValue?: number | string }[],
  side: 'home' | 'away',
): { label: string; value: string }[] {
  // Pick a few high-signal stat rows out of the team-stats list; ignore
  // the rest so the box doesn't become a wall of numbers.
  const labels: Record<string, string> = {
    sog: 'Shots on goal',
    powerPlay: 'Power play',
    powerPlayPctg: 'PP %',
    faceoffWinningPctg: 'Faceoff %',
    hits: 'Hits',
    blockedShots: 'Blocks',
    pim: 'PIM',
    giveaways: 'Giveaways',
    takeaways: 'Takeaways',
  };
  const out: { label: string; value: string }[] = [];
  for (const r of rows) {
    const cat = r.category ?? '';
    const label = labels[cat];
    if (!label) continue;
    const v = side === 'home' ? r.homeValue : r.awayValue;
    if (v == null) continue;
    out.push({ label, value: String(v) });
  }
  return out;
}

function nhlSkaters(side: NhlBoxTeam | undefined): BoxPlayer[] {
  if (!side) return [];
  const all = [...(side.forwards ?? []), ...(side.defense ?? [])];
  // Sort by points desc, take top 6 so the table stays glanceable.
  all.sort((a, b) => (b.points ?? 0) - (a.points ?? 0));
  return all.slice(0, 6).map((p) => ({
    name: p.name?.default ?? '',
    pos: p.position,
    line: `${p.goals ?? 0}G ${p.assists ?? 0}A · ${formatPlusMinus(p.plusMinus)} · ${p.sog ?? 0} SOG · ${p.toi ?? ''}`.trim(),
  }));
}

function nhlGoalies(side: NhlBoxTeam | undefined): BoxPlayer[] {
  if (!side) return [];
  return (side.goalies ?? []).map((g) => {
    const sa = g.shotsAgainst ?? 0;
    const sv = g.saves ?? 0;
    const pct = typeof g.savePctg === 'number' ? (g.savePctg * 1000).toFixed(0).padStart(3, '0') : '';
    const sgPct = pct ? `.${pct}` : '';
    return {
      name: g.name?.default ?? '',
      pos: 'G',
      decision: g.decision === 'W' || g.decision === 'L' ? g.decision : undefined,
      line: `${sv}-${sa} saves${sgPct ? ` · Sv% ${sgPct}` : ''} · ${g.toi ?? ''}`.trim(),
    };
  });
}

function formatPlusMinus(n: number | undefined): string {
  if (typeof n !== 'number') return '';
  if (n > 0) return `+${n}`;
  return String(n);
}

function joinName(first?: string, last?: string): string {
  return [first, last].filter(Boolean).join(' ');
}

// ---- MLB detail ---------------------------------------------------------

async function fetchMlbDetail(
  gamePk: string,
  ourTeamId: number,
): Promise<GameDetail | null> {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
      { cf: { cacheTtl: 30 } } as RequestInit,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as MlbFeedLive;
    return parseMlbDetail(gamePk, data, ourTeamId);
  } catch {
    return null;
  }
}

interface MlbFeedTeam {
  id?: number;
  name?: string;
  abbreviation?: string;
}
interface MlbInning {
  num?: number;
  ordinalNum?: string;
  home?: { runs?: number; hits?: number; errors?: number };
  away?: { runs?: number; hits?: number; errors?: number };
}
interface MlbPlay {
  result?: {
    description?: string;
    awayScore?: number;
    homeScore?: number;
    eventType?: string;
  };
  about?: {
    halfInning?: 'top' | 'bottom';
    inning?: number;
    isScoringPlay?: boolean;
  };
  matchup?: {
    batter?: { fullName?: string };
    pitcher?: { fullName?: string };
  };
}
interface MlbBoxStat {
  batting?: {
    atBats?: number;
    runs?: number;
    hits?: number;
    rbi?: number;
    homeRuns?: number;
    baseOnBalls?: number;
    strikeOuts?: number;
  };
  pitching?: {
    inningsPitched?: string;
    hits?: number;
    runs?: number;
    earnedRuns?: number;
    baseOnBalls?: number;
    strikeOuts?: number;
    homeRuns?: number;
    note?: string;
    saves?: number;
    holds?: number;
    blownSaves?: number;
  };
}
interface MlbBoxPlayer {
  person?: { id?: number; fullName?: string };
  position?: { abbreviation?: string };
  stats?: MlbBoxStat;
  battingOrder?: string;
  gameStatus?: { isCurrentBatter?: boolean; isCurrentPitcher?: boolean };
}
interface MlbBoxTeam {
  team?: MlbFeedTeam;
  teamStats?: MlbBoxStat;
  players?: Record<string, MlbBoxPlayer>;
  batters?: number[]; // player ids in batting order, by appearance
  battingOrder?: number[];
  pitchers?: number[]; // pitching order
}
interface MlbDecisions {
  winner?: { id?: number; fullName?: string };
  loser?: { id?: number; fullName?: string };
  save?: { id?: number; fullName?: string };
}
interface MlbFeedLive {
  gameData?: {
    status?: { abstractGameState?: string; detailedState?: string };
    teams?: { home?: MlbFeedTeam; away?: MlbFeedTeam };
    venue?: { name?: string };
    datetime?: { dateTime?: string };
  };
  liveData?: {
    linescore?: {
      currentInning?: number;
      inningHalf?: string;
      outs?: number;
      innings?: MlbInning[];
      teams?: {
        home?: { runs?: number; hits?: number; errors?: number };
        away?: { runs?: number; hits?: number; errors?: number };
      };
    };
    plays?: {
      allPlays?: MlbPlay[];
      scoringPlays?: number[];
    };
    boxscore?: {
      teams?: { home?: MlbBoxTeam; away?: MlbBoxTeam };
    };
    decisions?: MlbDecisions;
  };
}

function parseMlbDetail(
  gamePk: string,
  d: MlbFeedLive,
  ourTeamId: number,
): GameDetail {
  const abs = String(d.gameData?.status?.abstractGameState ?? '');
  const detailed = String(d.gameData?.status?.detailedState ?? '');
  const status: 'pre' | 'live' | 'final' =
    abs === 'Live'
      ? 'live'
      : abs === 'Final' || detailed === 'Final' || detailed === 'Game Over'
        ? 'final'
        : 'pre';
  const home = d.gameData?.teams?.home ?? {};
  const away = d.gameData?.teams?.away ?? {};
  const ourSide: 'home' | 'away' = home.id === ourTeamId ? 'home' : 'away';

  const start = Date.parse(d.gameData?.datetime?.dateTime ?? '');
  const startTime = Number.isFinite(start) ? start : 0;
  const startTimeLocal = localTime(startTime);

  const ls = d.liveData?.linescore ?? {};
  const inningRuns = (ls.teams?.home?.runs ?? 0) + (ls.teams?.away?.runs ?? 0);

  let statusDetail: string;
  if (status === 'pre') {
    statusDetail = startTimeLocal;
  } else if (status === 'live') {
    const half = ls.inningHalf === 'Bottom' ? 'Bot' : 'Top';
    const inn = ls.currentInning ?? 0;
    const outs = ls.outs ?? 0;
    statusDetail = inn
      ? `${half} ${ordinalInning(inn)} · ${outs} out${outs === 1 ? '' : 's'}`
      : detailed;
  } else {
    statusDetail = 'Final';
  }

  const linescore: LinescorePeriod[] = (ls.innings ?? []).map((i) => ({
    label: String(i.num ?? ''),
    home: typeof i.home?.runs === 'number' ? i.home.runs : null,
    away: typeof i.away?.runs === 'number' ? i.away.runs : null,
  }));

  const totals: LinescoreTotal[] = [
    {
      label: 'R',
      home: ls.teams?.home?.runs ?? 0,
      away: ls.teams?.away?.runs ?? 0,
    },
    {
      label: 'H',
      home: ls.teams?.home?.hits ?? 0,
      away: ls.teams?.away?.hits ?? 0,
    },
    {
      label: 'E',
      home: ls.teams?.home?.errors ?? 0,
      away: ls.teams?.away?.errors ?? 0,
    },
  ];

  const all = d.liveData?.plays?.allPlays ?? [];
  const scoringIdx = d.liveData?.plays?.scoringPlays ?? [];
  const scoringPlays: ScoringPlay[] = [];
  for (const i of scoringIdx) {
    const p = all[i];
    if (!p) continue;
    const half = p.about?.halfInning === 'bottom' ? 'Bot' : 'Top';
    const inn = p.about?.inning ?? 0;
    const teamAbbr = p.about?.halfInning === 'bottom' ? (home.abbreviation ?? '') : (away.abbreviation ?? '');
    scoringPlays.push({
      period: `${half} ${ordinalInning(inn)}`,
      teamAbbr,
      description: p.result?.description ?? '',
      homeScore: p.result?.homeScore ?? 0,
      awayScore: p.result?.awayScore ?? 0,
    });
  }
  // Ignore inningRuns (kept to avoid unused-var) — we get runs from linescore.
  void inningRuns;

  const homeBox = mlbBoxFor(d.liveData?.boxscore?.teams?.home, d.liveData?.decisions);
  const awayBox = mlbBoxFor(d.liveData?.boxscore?.teams?.away, d.liveData?.decisions);

  // Logos for MLB come from a stable CDN keyed by team id.
  const homeLogo = home.id ? `https://www.mlbstatic.com/team-logos/${home.id}.svg` : null;
  const awayLogo = away.id ? `https://www.mlbstatic.com/team-logos/${away.id}.svg` : null;

  return {
    id: gamePk,
    league: 'MLB',
    status,
    statusDetail,
    startTime,
    startTimeLocal,
    homeTeam: {
      abbr: home.abbreviation ?? '',
      name: home.name ?? '',
      logo: homeLogo,
      score: ls.teams?.home?.runs ?? null,
    },
    awayTeam: {
      abbr: away.abbreviation ?? '',
      name: away.name ?? '',
      logo: awayLogo,
      score: ls.teams?.away?.runs ?? null,
    },
    venue: d.gameData?.venue?.name ?? null,
    ourSide,
    linescore,
    totals,
    scoringPlays,
    homeBox,
    awayBox,
  };
}

function mlbBoxFor(t: MlbBoxTeam | undefined, dec: MlbDecisions | undefined): TeamBox {
  if (!t)
    return {
      teamAbbr: '',
      batters: [],
      pitchers: [],
      stats: [],
    };
  const players = t.players ?? {};
  // Batters: keep order from `batters` array (each player's appearance order).
  const seenBatters = new Set<number>();
  const batters: BoxPlayer[] = [];
  for (const id of t.batters ?? []) {
    if (seenBatters.has(id)) continue;
    seenBatters.add(id);
    const p = players[`ID${id}`];
    if (!p) continue;
    const b = p.stats?.batting;
    if (!b || (b.atBats == null && b.hits == null)) continue;
    const ab = b.atBats ?? 0;
    const h = b.hits ?? 0;
    const extras: string[] = [];
    if ((b.homeRuns ?? 0) > 0) extras.push(`${b.homeRuns} HR`);
    if ((b.rbi ?? 0) > 0) extras.push(`${b.rbi} RBI`);
    if ((b.baseOnBalls ?? 0) > 0) extras.push(`${b.baseOnBalls} BB`);
    if ((b.strikeOuts ?? 0) > 0) extras.push(`${b.strikeOuts} K`);
    batters.push({
      name: p.person?.fullName ?? '',
      pos: p.position?.abbreviation,
      line: extras.length ? `${h}-${ab}, ${extras.join(', ')}` : `${h}-${ab}`,
    });
  }

  const pitchers: BoxPlayer[] = [];
  for (const id of t.pitchers ?? []) {
    const p = players[`ID${id}`];
    if (!p) continue;
    const pi = p.stats?.pitching;
    if (!pi) continue;
    let decision: BoxPlayer['decision'];
    if (dec?.winner?.id === id) decision = 'W';
    else if (dec?.loser?.id === id) decision = 'L';
    else if (dec?.save?.id === id) decision = 'SV';
    pitchers.push({
      name: p.person?.fullName ?? '',
      pos: p.position?.abbreviation ?? 'P',
      decision,
      line: `${pi.inningsPitched ?? '0.0'} IP · ${pi.hits ?? 0}H ${pi.runs ?? 0}R ${pi.earnedRuns ?? 0}ER ${pi.baseOnBalls ?? 0}BB ${pi.strikeOuts ?? 0}K`,
    });
  }

  const ts = t.teamStats;
  const stats: { label: string; value: string }[] = [];
  if (ts?.batting) {
    stats.push({ label: 'Runs', value: String(ts.batting.runs ?? 0) });
    stats.push({ label: 'Hits', value: String(ts.batting.hits ?? 0) });
    stats.push({ label: 'AB', value: String(ts.batting.atBats ?? 0) });
    if ((ts.batting.homeRuns ?? 0) > 0) stats.push({ label: 'HR', value: String(ts.batting.homeRuns) });
    if ((ts.batting.strikeOuts ?? 0) > 0) stats.push({ label: 'K', value: String(ts.batting.strikeOuts) });
  }

  return {
    teamAbbr: t.team?.abbreviation ?? '',
    batters,
    pitchers,
    stats,
  };
}

// ---- Team lists ---------------------------------------------------------

export interface TeamMeta {
  key: string; // value the picker writes into user_sports_subs.team_key
  abbr: string;
  name: string;
  logo: string | null;
}

async function fetchNhlTeams(): Promise<TeamMeta[]> {
  // Active franchises only. The /stats/rest/en/team list we used to hit
  // returns every franchise the NHL has ever recognised — including the
  // Atlanta Flames, Atlanta Thrashers, California Golden Seals,
  // Cleveland Barons, Brooklyn Americans, Detroit Cougars / Falcons,
  // Hartford Whalers, Quebec Nordiques, etc. Those rendered as
  // followable teams in Sports settings, which is just noise.
  //
  // The v1 web standings endpoint only contains the 32 currently-active
  // franchises (since they have to have a current win/loss record to
  // appear in the standings), so it's the right authority for "is this
  // team an NHL team you can follow today".
  try {
    const r = await fetch('https://api-web.nhle.com/v1/standings/now', {
      cf: { cacheTtl: 86400 },
    } as RequestInit);
    if (!r.ok) return fallbackNhlTeams();
    const data = (await r.json()) as {
      standings?: {
        teamAbbrev?: { default?: string };
        teamName?: { default?: string };
        teamCommonName?: { default?: string };
        placeName?: { default?: string };
      }[];
    };
    const out: TeamMeta[] = [];
    const seen = new Set<string>();
    for (const row of data.standings ?? []) {
      const abbr = (row.teamAbbrev?.default ?? '').toUpperCase();
      if (!abbr || seen.has(abbr)) continue;
      seen.add(abbr);
      // teamName.default reads as "Anaheim Ducks"; fall back to
      // place + common name and finally the abbr.
      const name =
        row.teamName?.default ??
        (row.placeName?.default && row.teamCommonName?.default
          ? `${row.placeName.default} ${row.teamCommonName.default}`
          : abbr);
      out.push({
        key: abbr,
        abbr,
        name,
        logo: `https://assets.nhle.com/logos/nhl/svg/${abbr}_light.svg`,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.length > 0 ? out : fallbackNhlTeams();
  } catch {
    return fallbackNhlTeams();
  }
}

function fallbackNhlTeams(): TeamMeta[] {
  // Pared-down hardcoded list for outages. Just covers the most likely
  // picks; the full list returns from the live endpoint normally.
  const teams: [string, string][] = [
    ['MTL', 'Montreal Canadiens'],
    ['TOR', 'Toronto Maple Leafs'],
    ['BOS', 'Boston Bruins'],
    ['NYR', 'New York Rangers'],
    ['EDM', 'Edmonton Oilers'],
    ['VAN', 'Vancouver Canucks'],
    ['OTT', 'Ottawa Senators'],
  ];
  return teams.map(([abbr, name]) => ({
    key: abbr,
    abbr,
    name,
    logo: `https://assets.nhle.com/logos/nhl/svg/${abbr}_light.svg`,
  }));
}

async function fetchMlbTeams(): Promise<TeamMeta[]> {
  try {
    const r = await fetch(
      'https://statsapi.mlb.com/api/v1/teams?sportId=1&activeStatus=Y',
      { cf: { cacheTtl: 86400 } } as RequestInit,
    );
    if (!r.ok) return fallbackMlbTeams();
    const data = (await r.json()) as {
      teams?: { id?: number; abbreviation?: string; name?: string }[];
    };
    const out: TeamMeta[] = [];
    for (const t of data.teams ?? []) {
      const id = t.id;
      const abbr = t.abbreviation ?? '';
      const name = t.name ?? abbr;
      if (id == null || !abbr || !name) continue;
      out.push({
        key: String(id),
        abbr,
        name,
        logo: `https://www.mlbstatic.com/team-logos/${id}.svg`,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out.length > 0 ? out : fallbackMlbTeams();
  } catch {
    return fallbackMlbTeams();
  }
}

function fallbackMlbTeams(): TeamMeta[] {
  const teams: [number, string, string][] = [
    [141, 'TOR', 'Toronto Blue Jays'],
    [147, 'NYY', 'New York Yankees'],
    [111, 'BOS', 'Boston Red Sox'],
    [119, 'LAD', 'Los Angeles Dodgers'],
    [137, 'SF', 'San Francisco Giants'],
    [110, 'BAL', 'Baltimore Orioles'],
    [117, 'HOU', 'Houston Astros'],
  ];
  return teams.map(([id, abbr, name]) => ({
    key: String(id),
    abbr,
    name,
    logo: `https://www.mlbstatic.com/team-logos/${id}.svg`,
  }));
}
