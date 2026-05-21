import { Hono } from 'hono';
import type { Env } from './env';

// Today's game (if any) for the Montreal Canadiens (NHL) and Toronto
// Blue Jays (MLB). No D1 usage — we hit the official league APIs and
// cache responses in caches.default (~30s live, ~5 min otherwise).

const NHL_TEAM_ABBR = 'MTL';
const MLB_TEAM_ID = 141; // Toronto Blue Jays

interface Team {
  abbr: string;
  name: string;
  logo: string | null;
  score: number | null;
}

interface Game {
  league: 'NHL' | 'MLB';
  status: 'pre' | 'live' | 'final';
  statusDetail: string; // short single-line summary
  startTime: number; // ms epoch
  startTimeLocal: string; // "7:00 PM ET"
  homeTeam: Team;
  awayTeam: Team;
  venue: string | null;
  ourSide: 'home' | 'away';
}

export function sportsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/sports', async (c) => {
    const ymd = todayInToronto();
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(`https://relay-cache.local/sports/${ymd}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const [nhl, mlb] = await Promise.all([fetchNhlMtl(ymd), fetchMlbTor(ymd)]);
    const games: Game[] = [];
    if (nhl) games.push(nhl);
    if (mlb) games.push(mlb);

    const hasLive = games.some((g) => g.status === 'live');
    const ttl = hasLive ? 30 : 300;
    const resp = new Response(JSON.stringify({ games }), {
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

async function fetchNhlMtl(ymd: string): Promise<Game | null> {
  try {
    const r = await fetch('https://api-web.nhle.com/v1/score/now', {
      cf: { cacheTtl: 30 },
    } as RequestInit);
    if (!r.ok) return null;
    const data = (await r.json()) as { games?: NhlRawGame[] };
    const ev = (data.games ?? []).find(
      (g) =>
        g?.gameDate === ymd &&
        (g?.homeTeam?.abbrev === NHL_TEAM_ABBR || g?.awayTeam?.abbrev === NHL_TEAM_ABBR),
    );
    if (!ev) return null;
    return parseNhlGame(ev);
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
  gameDate?: string;
  startTimeUTC?: string;
  homeTeam?: NhlRawTeam;
  awayTeam?: NhlRawTeam;
  gameState?: string;
  period?: number;
  clock?: { timeRemaining?: string; running?: boolean; inIntermission?: boolean };
  venue?: { default?: string };
}

function parseNhlGame(ev: NhlRawGame): Game {
  const state = String(ev.gameState ?? '');
  const status: 'pre' | 'live' | 'final' =
    state === 'LIVE' || state === 'CRIT'
      ? 'live'
      : state === 'OFF' || state === 'FINAL'
        ? 'final'
        : 'pre';
  const home = ev.homeTeam ?? {};
  const away = ev.awayTeam ?? {};
  const ourSide: 'home' | 'away' = home.abbrev === NHL_TEAM_ABBR ? 'home' : 'away';
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

async function fetchMlbTor(ymd: string): Promise<Game | null> {
  try {
    const url =
      'https://statsapi.mlb.com/api/v1/schedule?sportId=1' +
      `&teamId=${MLB_TEAM_ID}&date=${ymd}&hydrate=linescore,team,venue`;
    const r = await fetch(url, { cf: { cacheTtl: 30 } } as RequestInit);
    if (!r.ok) return null;
    const data = (await r.json()) as { dates?: { games?: MlbRawGame[] }[] };
    const game = data.dates?.[0]?.games?.[0];
    if (!game) return null;
    return parseMlbGame(game);
  } catch {
    return null;
  }
}

interface MlbRawTeam {
  team?: { id?: number; name?: string; abbreviation?: string };
  score?: number;
}
interface MlbRawGame {
  gameDate?: string;
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

function parseMlbGame(g: MlbRawGame): Game {
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
  const ourSide: 'home' | 'away' = home.team?.id === MLB_TEAM_ID ? 'home' : 'away';

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

  return {
    league: 'MLB',
    status,
    statusDetail,
    startTime,
    startTimeLocal,
    homeTeam: parseMlbTeam(home, homeScore),
    awayTeam: parseMlbTeam(away, awayScore),
    venue: g.venue?.name ?? null,
    ourSide,
  };
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
