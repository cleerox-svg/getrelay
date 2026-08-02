import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// Thin proxy in front of the iTunes Search API for the "Guess the Tune"
// game, modeled on gifs.ts / itunes.ts. Like itunes.ts this upstream
// needs no key, so the proxy exists to:
//   1. Project iTunes' ~30-field song rows down to the minimal shape the
//      Tune game needs (a preview clip + title/artist + artwork), and
//      drop rows with no playable preview (many songs lack one).
//   2. Edge-cache in caches.default so a seed term that recurs across
//      games doesn't re-hit Apple (they ask callers to cache and cap
//      traffic at roughly 20 req/min).
//
// Audio previews are streamed by an <audio> element on the client, so no
// CORS headers are required from the upstream.

interface TuneItem {
  trackId: string;
  previewUrl: string;
  title: string; // trackName
  artist: string; // artistName
  genre: string;
  artworkUrl: string; // 600x600 hi-res
  trackViewUrl: string; // canonical Apple Music / iTunes Store URL
}

interface TuneSearchResult {
  items: TuneItem[];
}

interface ItunesRawTrack {
  wrapperType?: string;
  trackId?: number;
  trackName?: string;
  artistName?: string;
  previewUrl?: string;
  artworkUrl100?: string;
  primaryGenreName?: string;
  trackViewUrl?: string;
}
interface ItunesRawResponse {
  resultCount?: number;
  results?: ItunesRawTrack[];
}

// iTunes serves album art at 100x100 by default; the size is encoded in
// the filename, so swapping 100x100bb → 600x600bb asks the same CDN for
// a crisp render (matches itunes.ts).
function hiRes(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1');
}

function project(r: ItunesRawTrack): TuneItem | null {
  // A row is only usable if it can actually be played and named.
  if (!r.previewUrl || !r.trackName || !r.artistName) return null;
  return {
    trackId: String(r.trackId ?? ''),
    previewUrl: r.previewUrl,
    title: r.trackName,
    artist: r.artistName,
    genre: r.primaryGenreName ?? '',
    artworkUrl: r.artworkUrl100 ? hiRes(r.artworkUrl100) : '',
    trackViewUrl: r.trackViewUrl ?? '',
  };
}

// Apple's Search API 403s requests from Cloudflare Workers unless they
// carry a browser-like User-Agent (the default Workers UA reads as a bot),
// so send one on every iTunes call. Without it the whole proxy returns 502
// and the Tune game goes "unavailable".
const ITUNES_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function callItunes(term: string): Promise<TuneSearchResult | null> {
  // entity=song gives one preview clip per record with trackName +
  // artistName. iTunes has no offset param, so there is no pagination —
  // variety comes from the client's seed pool.
  const params = new URLSearchParams({
    media: 'music',
    entity: 'song',
    limit: '25',
    term,
  });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  const r = await fetch(url, {
    headers: { 'user-agent': ITUNES_UA, accept: 'application/json' },
    cf: { cacheTtl: 3600 },
  } as RequestInit);
  if (!r.ok) return null;
  // iTunes answers with text/javascript; .json() parses the body fine.
  const data = (await r.json()) as ItunesRawResponse;
  const seen = new Set<string>();
  const items: TuneItem[] = [];
  for (const row of data.results ?? []) {
    const p = project(row);
    if (!p) continue;
    if (p.trackId && seen.has(p.trackId)) continue;
    if (p.trackId) seen.add(p.trackId);
    items.push(p);
  }
  return { items };
}

// --- Deezer (primary source) ---
//
// Apple's iTunes Search API 403s Cloudflare Workers' datacenter egress IPs
// (a browser User-Agent did not fix it), so Deezer is the primary music
// source: free, keyless, JSON, and reliably reachable from Workers. iTunes
// stays as a fallback below. Deezer's track rows carry the same facts the
// Tune game needs — a preview clip, title/artist, album art, and a link —
// so we project them into the exact TuneItem shape the client already reads.

interface DeezerRawTrack {
  id?: number;
  title?: string;
  preview?: string;
  link?: string;
  artist?: { name?: string };
  album?: { title?: string; cover_big?: string; cover_xl?: string };
}
interface DeezerTrackResponse {
  data?: DeezerRawTrack[];
  error?: unknown;
}

function projectDeezer(r: DeezerRawTrack): TuneItem | null {
  // Same usability filter as the iTunes projection: playable + named.
  const previewUrl = r.preview ?? '';
  const title = r.title ?? '';
  const artist = r.artist?.name ?? '';
  if (!previewUrl || !title || !artist) return null;
  return {
    trackId: String(r.id ?? ''),
    previewUrl,
    title,
    artist,
    // Deezer track rows expose no genre name; the client backfills
    // distractors, so an empty genre is fine.
    genre: '',
    artworkUrl: r.album?.cover_xl || r.album?.cover_big || '',
    trackViewUrl: r.link ?? '',
  };
}

async function callDeezer(term: string): Promise<TuneSearchResult | null> {
  const params = new URLSearchParams({ q: term, limit: '25' });
  const url = `https://api.deezer.com/search?${params.toString()}`;
  let data: DeezerTrackResponse;
  try {
    // No cf.cacheTtl here: Deezer answers rate-limit/quota with HTTP 200 +
    // { error }, and edge-caching that for an hour would extend an outage
    // (every term would fall through to the 403ing iTunes fallback → 502).
    // Successful { items } results are still cached hard at the route level.
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    data = (await r.json()) as DeezerTrackResponse;
  } catch {
    return null;
  }
  // Deezer signals failure with { error: {...} } instead of a data array.
  if (!data || data.error || !Array.isArray(data.data)) return null;
  const seen = new Set<string>();
  const items: TuneItem[] = [];
  for (const row of data.data) {
    const p = projectDeezer(row);
    if (!p) continue;
    if (p.trackId && seen.has(p.trackId)) continue;
    if (p.trackId) seen.add(p.trackId);
    items.push(p);
  }
  // Zero usable rows counts as a Deezer miss so we fall back to iTunes.
  return items.length ? { items } : null;
}

// Deezer first, iTunes as fallback. Returns null only when BOTH sources
// yield nothing usable, which the route surfaces as 502.
async function searchTunes(term: string): Promise<TuneSearchResult | null> {
  return (await callDeezer(term)) ?? (await callItunes(term));
}

// --- Exact Spotify track-link resolution (Guess the Tune reveal screen) ---
//
// The reveal screen wants a canonical open.spotify.com/track/... link. We
// resolve it server-side via the Spotify Web API rather than shipping a
// search deep-link, but keep it strictly best-effort: both Spotify secrets
// are OPTIONAL, and any failure degrades to { url: null } so the client can
// fall back to its own search link. We only ever touch the two fixed Spotify
// hosts below — no request-controlled URLs, no SSRF surface.

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SEARCH_HOST = 'https://api.spotify.com';
// Fixed internal cache key for the minted client-credentials token so we
// don't mint one per request.
const SPOTIFY_TOKEN_CACHE_KEY = 'https://relay-cache.local/spotify/token';

interface SpotifyTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface SpotifySearchResponse {
  tracks?: {
    items?: { external_urls?: { spotify?: string } }[];
  };
}

// Mint (or reuse) a client-credentials bearer token. Cached in caches.default
// as a synthetic Response whose Cache-Control max-age tracks the token's own
// lifetime (minus a 60s safety margin), so a hot game re-uses one token.
async function spotifyToken(
  env: Env,
  cache: Cache,
  ctx: ExecutionContext,
): Promise<string | null> {
  const id = env.SPOTIFY_CLIENT_ID;
  const secret = env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  const tokenKey = new Request(SPOTIFY_TOKEN_CACHE_KEY);
  const cached = await cache.match(tokenKey);
  if (cached) {
    const t = ((await cached.json()) as { access_token?: string }).access_token;
    if (t) return t;
  }

  try {
    const r = await fetch(SPOTIFY_TOKEN_URL, {
      method: 'POST',
      headers: {
        authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!r.ok) return null;
    const data = (await r.json()) as SpotifyTokenResponse;
    const token = data.access_token;
    if (!token) return null;
    const ttl = Math.max((data.expires_in ?? 3600) - 60, 60);
    const toCache = new Response(JSON.stringify({ access_token: token }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': `max-age=${ttl}`,
      },
    });
    ctx.waitUntil(cache.put(tokenKey, toCache));
    return token;
  } catch {
    return null;
  }
}

// Resolve the exact track URL for a title+artist.
//   { resolved: true,  url }  — the search completed (url is the hit, or
//                               null for a genuine no-match): safe to cache.
//   { resolved: false, url: null } — the search itself failed (upstream
//                               error / network): must NOT be hard-cached,
//                               or a transient blip poisons the track for a
//                               day at the edge.
async function resolveSpotifyUrl(
  token: string,
  title: string,
  artist: string,
): Promise<{ resolved: boolean; url: string | null }> {
  const q = `track:"${title}" artist:"${artist}"`;
  const params = new URLSearchParams({ type: 'track', limit: '1', q });
  const url = `${SPOTIFY_SEARCH_HOST}/v1/search?${params.toString()}`;
  try {
    const r = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) return { resolved: false, url: null };
    const data = (await r.json()) as SpotifySearchResponse;
    return { resolved: true, url: data.tracks?.items?.[0]?.external_urls?.spotify ?? null };
  } catch {
    return { resolved: false, url: null };
  }
}

export function tunesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Resolve an exact open.spotify.com/track/... URL for the reveal screen.
  // Graceful by design: returns { url: null } (200) when Spotify isn't
  // configured or anything upstream fails, so a missing optional secret can
  // never break the game — the client just falls back to its search link.
  app.get('/tunes/spotify', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const title = (c.req.query('title') ?? '').trim();
    const artist = (c.req.query('artist') ?? '').trim();
    if (!title || !artist) return c.json({ error: 'bad_request' }, 400);

    const cache = (caches as unknown as { default: Cache }).default;

    // If the app isn't configured, short-circuit with the fallback state
    // before touching the network — a missing optional secret is a 200, not
    // an error.
    if (!c.env.SPOTIFY_CLIENT_ID || !c.env.SPOTIFY_CLIENT_SECRET) {
      return c.json({ url: null });
    }

    // track -> URL is stable, so cache resolved answers hard, keyed on the
    // normalized (lowercased) title+artist.
    const cacheKey = new Request(
      `https://relay-cache.local/tunes/spotify?title=${encodeURIComponent(
        title.toLowerCase(),
      )}&artist=${encodeURIComponent(artist.toLowerCase())}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const token = await spotifyToken(c.env, cache, c.executionCtx);
    // On any upstream trouble we still answer 200 { url: null } — never throw
    // the game into a broken state. We only cache positive/negative resolves
    // once we actually reached the search step.
    if (!token) return c.json({ url: null });

    const res = await resolveSpotifyUrl(token, title, artist);
    // Only hard-cache a COMPLETED search (a hit or a genuine no-match). An
    // upstream failure answers { url: null } uncached, so a transient
    // Spotify blip can't poison this track's link for the full 24h TTL.
    if (!res.resolved) return c.json({ url: null });
    const resp = new Response(JSON.stringify({ url: res.url }), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=86400',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  app.get('/tunes/search', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const term = (c.req.query('term') ?? '').trim();
    if (!term) return c.json({ error: 'bad_request' }, 400);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/tunes/search?term=${encodeURIComponent(term)}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const result = await searchTunes(term);
    if (!result) return c.json({ error: 'upstream_failed' }, 502);

    const resp = new Response(JSON.stringify(result), {
      headers: {
        'content-type': 'application/json',
        // Previews and track metadata are effectively static, so cache
        // hard — a recurring seed is then near-free.
        'cache-control': 'public, max-age=86400',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  return app;
}
