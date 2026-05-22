import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// Thin proxy in front of Giphy v1. Two reasons we don't call Giphy
// directly from the browser:
//   1. Keeps the API key off the client.
//   2. Lets us cache responses in caches.default so a popular search
//      term doesn't burn quota on every keystroke.

interface GifItem {
  id: string;
  description: string;
  previewUrl: string; // small inline preview, animated
  previewWidth: number;
  previewHeight: number;
  gifUrl: string; // full-quality, what we send through chat
  gifWidth: number;
  gifHeight: number;
}

interface GifSearchResult {
  items: GifItem[];
  next: string | null;
}

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyResult {
  id?: string;
  title?: string;
  images?: {
    fixed_width?: GiphyImage; // ~200px wide animated GIF — good preview
    original?: GiphyImage; // full-quality
  };
}
interface GiphyResponse {
  data?: GiphyResult[];
  pagination?: { offset?: number; total_count?: number; count?: number };
}

function project(r: GiphyResult): GifItem | null {
  const tiny = r.images?.fixed_width;
  const full = r.images?.original;
  if (!tiny?.url || !full?.url) return null;
  return {
    id: String(r.id ?? ''),
    description: r.title ?? '',
    previewUrl: tiny.url,
    previewWidth: Number(tiny.width ?? 0),
    previewHeight: Number(tiny.height ?? 0),
    gifUrl: full.url,
    gifWidth: Number(full.width ?? 0),
    gifHeight: Number(full.height ?? 0),
  };
}

async function callGiphy(
  env: Env,
  q: string,
  limit: number,
  pos: string,
): Promise<GifSearchResult | null> {
  const key = env.GIPHY_API_KEY;
  if (!key) return null;
  const endpoint = q ? 'search' : 'trending';
  const offset = Number(pos) || 0;
  const params = new URLSearchParams({
    api_key: key,
    limit: String(limit),
    offset: String(offset),
    rating: 'pg-13',
  });
  if (q) params.set('q', q);
  const url = `https://api.giphy.com/v1/gifs/${endpoint}?${params.toString()}`;
  const r = await fetch(url, { cf: { cacheTtl: 60 } } as RequestInit);
  if (!r.ok) return null;
  const data = (await r.json()) as GiphyResponse;
  const items: GifItem[] = [];
  for (const row of data.data ?? []) {
    const p = project(row);
    if (p) items.push(p);
  }
  // Giphy uses numeric offsets — expose the next page as a string for
  // pagination consistency.
  const next =
    (data.pagination?.offset ?? 0) + (data.pagination?.count ?? items.length);
  return { items, next: items.length > 0 ? String(next) : null };
}

export function gifsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Empty q falls back to trending so the picker can open with content.
  app.get('/gifs/search', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    if (!c.env.GIPHY_API_KEY) return c.json({ error: 'gifs_not_configured' }, 404);

    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(Number(c.req.query('limit') ?? '24'), 50);
    const pos = c.req.query('pos') ?? '';

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/gifs/${q ? 'search' : 'trending'}?q=${encodeURIComponent(q)}&limit=${limit}&pos=${encodeURIComponent(pos)}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const result = await callGiphy(c.env, q, limit, pos);
    if (!result) return c.json({ error: 'upstream_failed' }, 502);

    const resp = new Response(JSON.stringify(result), {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'public, max-age=60',
      },
    });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  });

  return app;
}
