import { Hono } from 'hono';
import type { Env } from './env';
import { sendPush, type VapidKeys } from './lib/web-push';

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
    // Team-specific weekly schedule. Includes every Canadiens game in the
    // current week regardless of state (FUT / PRE / LIVE / OFF / FINAL),
    // unlike /score/now which only surfaces games already underway. That's
    // why pre-game evening games for the Habs weren't appearing.
    const r = await fetch(
      `https://api-web.nhle.com/v1/club-schedule/${NHL_TEAM_ABBR}/week/now`,
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
}

export async function runSportsCron(env: Env): Promise<void> {
  const ymd = todayInToronto();
  const [nhl, mlb] = await Promise.all([fetchNhlMtl(ymd), fetchMlbTor(ymd)]);
  // Short-circuit when neither team plays today — zero D1 work.
  if (!nhl && !mlb) return;
  for (const g of [nhl, mlb]) {
    if (g) await processGameUpdate(env, ymd, g);
  }
}

async function processGameUpdate(env: Env, ymd: string, g: Game): Promise<void> {
  const key = `sports:${g.league}:${ymd}`;
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

  const events: SportsEvent[] = [];
  const emoji = g.league === 'NHL' ? '🏒' : '⚾';
  const goalWord = g.league === 'NHL' ? 'goal' : 'score';

  const ours = g.ourSide === 'home' ? g.homeTeam : g.awayTeam;
  const theirs = g.ourSide === 'home' ? g.awayTeam : g.homeTeam;
  const ourScore = g.ourSide === 'home' ? cur.homeScore : cur.awayScore;
  const theirScore = g.ourSide === 'home' ? cur.awayScore : cur.homeScore;
  const prevOurScore = g.ourSide === 'home' ? prev.homeScore : prev.awayScore;
  const prevTheirScore = g.ourSide === 'home' ? prev.awayScore : prev.homeScore;

  if (ourScore > prevOurScore) {
    events.push({
      title: `${emoji} ${ours.name} ${goalWord}!`,
      body: `${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr} · ${g.statusDetail}`,
      tag: `sports-${g.league}-score`,
    });
  } else if (theirScore > prevTheirScore) {
    events.push({
      title: `${emoji} ${theirs.name} ${goalWord}`,
      body: `${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr} · ${g.statusDetail}`,
      tag: `sports-${g.league}-score`,
    });
  }

  if (prev.status !== 'final' && cur.status === 'final') {
    const won = ourScore > theirScore;
    events.push({
      title: won ? `${emoji} ${ours.name} win!` : `${emoji} ${ours.name} fall`,
      body: `Final · ${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr}`,
      tag: `sports-${g.league}-final`,
    });
  }

  for (const ev of events) {
    await broadcastSportsPush(env, ev);
  }
}

async function broadcastSportsPush(env: Env, payload: SportsEvent): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) {
    console.warn('sports: VAPID not configured; skipping push');
    return;
  }
  const rows = await env.DB.prepare(
    `SELECT ps.endpoint, ps.p256dh, ps.auth
     FROM push_subscriptions ps
     JOIN users u ON u.id = ps.user_id
     WHERE COALESCE(u.sports_notifications, 1) = 1`,
  ).all<{ endpoint: string; p256dh: string; auth: string }>();
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
