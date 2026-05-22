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

  // Per-game detail. Cached by id so a tap on the card doesn't fan out
  // to the league API every time. TTL matches the list endpoint: short
  // while the game's live so the line score / scoring summary updates.
  app.get('/sports/nhl/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) return c.json({ error: 'bad id' }, 400);
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(`https://relay-cache.local/sports/nhl/${id}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const detail = await fetchNhlDetail(id);
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
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(`https://relay-cache.local/sports/mlb/${id}`);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    const detail = await fetchMlbDetail(id);
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
  id?: number;
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
  gamePk?: number;
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
  url?: string; // deep-link path for the SW's notificationclick handler
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
  // Deep-link target — empty when the upstream API didn't expose the
  // game id (shouldn't happen in practice; the SW falls back to /chats).
  const url = g.id ? `/sports/${g.league.toLowerCase()}/${g.id}` : undefined;

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
      url,
    });
  } else if (theirScore > prevTheirScore) {
    events.push({
      title: `${emoji} ${theirs.name} ${goalWord}`,
      body: `${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr} · ${g.statusDetail}`,
      tag: `sports-${g.league}-score`,
      url,
    });
  }

  if (prev.status !== 'final' && cur.status === 'final') {
    const won = ourScore > theirScore;
    events.push({
      title: won ? `${emoji} ${ours.name} win!` : `${emoji} ${ours.name} fall`,
      body: `Final · ${ours.abbr} ${ourScore} – ${theirScore} ${theirs.abbr}`,
      tag: `sports-${g.league}-final`,
      url,
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

// ---- NHL detail ---------------------------------------------------------

async function fetchNhlDetail(gameId: string): Promise<GameDetail | null> {
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
    return parseNhlDetail(landing, box);
  } catch {
    return null;
  }
}

interface NhlLanding {
  id?: number;
  gameState?: string;
  gameDate?: string;
  startTimeUTC?: string;
  period?: number;
  clock?: { timeRemaining?: string; inIntermission?: boolean };
  awayTeam?: NhlRawTeam & { sog?: number };
  homeTeam?: NhlRawTeam & { sog?: number };
  venue?: { default?: string };
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

function parseNhlDetail(landing: NhlLanding, box: NhlBoxscore | null): GameDetail {
  const state = String(landing.gameState ?? '');
  const status: 'pre' | 'live' | 'final' =
    state === 'LIVE' || state === 'CRIT'
      ? 'live'
      : state === 'OFF' || state === 'FINAL'
        ? 'final'
        : 'pre';
  const homeRaw = landing.homeTeam ?? {};
  const awayRaw = landing.awayTeam ?? {};
  const ourSide: 'home' | 'away' = homeRaw.abbrev === NHL_TEAM_ABBR ? 'home' : 'away';
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

async function fetchMlbDetail(gamePk: string): Promise<GameDetail | null> {
  try {
    const r = await fetch(
      `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
      { cf: { cacheTtl: 30 } } as RequestInit,
    );
    if (!r.ok) return null;
    const data = (await r.json()) as MlbFeedLive;
    return parseMlbDetail(gamePk, data);
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

function parseMlbDetail(gamePk: string, d: MlbFeedLive): GameDetail {
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
  const ourSide: 'home' | 'away' = home.id === MLB_TEAM_ID ? 'home' : 'away';

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
