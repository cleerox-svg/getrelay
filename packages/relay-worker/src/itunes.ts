import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// Thin proxy in front of the iTunes Search API, mirroring gifs.ts.
// Unlike Giphy this upstream needs no key, so the proxy exists for two
// other reasons:
//   1. Projects iTunes' ~30-field rows down to the minimal shape the
//      Fog game needs (album art + artist + genre).
//   2. Edge-caches in caches.default so a genre seed that recurs across
//      games doesn't re-hit Apple (they ask callers to cache and cap
//      traffic at roughly 20 req/min).
//
// Album art is shown via <img> in the Fog game (never drawn into the
// fog canvas), so no CORS headers are required from the upstream.

interface ItunesItem {
  id: string;
  artistName: string;
  collectionName: string;
  artworkUrl: string; // 600x600 album art
  genre: string;
}

interface ItunesSearchResult {
  items: ItunesItem[];
}

interface ItunesRawResult {
  wrapperType?: string;
  collectionId?: number;
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
  primaryGenreName?: string;
}
interface ItunesRawResponse {
  resultCount?: number;
  results?: ItunesRawResult[];
}

// iTunes serves album art at 100x100 by default; the size is encoded in
// the filename, so swapping 100x100bb → 600x600bb asks the same CDN for
// a crisp render (the Fog game scales the cover up).
function hiRes(url: string): string {
  return url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1');
}

function project(r: ItunesRawResult): ItunesItem | null {
  const art = r.artworkUrl100;
  if (!art || !r.artistName) return null;
  return {
    id: String(r.collectionId ?? ''),
    artistName: r.artistName,
    collectionName: r.collectionName ?? '',
    artworkUrl: hiRes(art),
    genre: r.primaryGenreName ?? '',
  };
}

// Apple's Search API 403s requests from Cloudflare Workers unless they
// carry a browser-like User-Agent (the default Workers UA reads as a bot),
// so send one on every iTunes call. Without it the whole proxy returns 502
// and iTunes-backed features go "unavailable".
const ITUNES_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

async function callItunes(term: string, limit: number): Promise<ItunesSearchResult | null> {
  // entity=album gives one artwork per record with artistName +
  // primaryGenreName and no per-track duplication.
  const params = new URLSearchParams({
    term,
    media: 'music',
    entity: 'album',
    limit: String(limit),
  });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  // iTunes has no offset param, so variety comes from a wide seed pool
  // plus a random pick within each batch on the client.
  const r = await fetch(url, {
    headers: { 'user-agent': ITUNES_UA, accept: 'application/json' },
    cf: { cacheTtl: 3600 },
  } as RequestInit);
  if (!r.ok) return null;
  // iTunes answers with text/javascript; .json() parses the body fine.
  const data = (await r.json()) as ItunesRawResponse;
  const seen = new Set<string>();
  const items: ItunesItem[] = [];
  for (const row of data.results ?? []) {
    const p = project(row);
    if (!p) continue;
    if (p.id && seen.has(p.id)) continue;
    if (p.id) seen.add(p.id);
    items.push(p);
  }
  return { items };
}

export function itunesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/itunes/search', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const term = (c.req.query('term') ?? '').trim();
    if (!term) return c.json({ error: 'bad_request' }, 400);
    // Guard the parse so a NaN/zero/negative can't reach the upstream:
    // fall back to 25 for anything non-positive, floor at 1, cap at 50.
    const limit = Math.min(Math.max(1, Number(c.req.query('limit')) || 25), 50);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/itunes/search?term=${encodeURIComponent(term)}&limit=${limit}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const result = await callItunes(term, limit);
    if (!result) return c.json({ error: 'upstream_failed' }, 502);

    const resp = new Response(JSON.stringify(result), {
      headers: {
        'content-type': 'application/json',
        // Album art and genre membership are effectively static, so
        // cache hard — a recurring seed is then near-free.
        'cache-control': 'public, max-age=86400',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  return app;
}
