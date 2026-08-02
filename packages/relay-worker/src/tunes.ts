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
  };
}

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
  const r = await fetch(url, { cf: { cacheTtl: 3600 } } as RequestInit);
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

export function tunesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

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

    const result = await callItunes(term);
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
