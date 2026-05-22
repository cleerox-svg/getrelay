import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// Thin proxy in front of Tenor v2 and Giphy v1. Two reasons we don't
// call them directly from the browser:
//   1. Keeps the API keys off the client.
//   2. Lets us cache responses in caches.default so a popular search
//      term doesn't burn quota on every keystroke.
//
// Both providers project into one common shape so the UI doesn't have
// to know which one served the response.

export type GifProvider = 'tenor' | 'giphy';

interface GifItem {
  id: string;
  provider: GifProvider;
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
  provider: GifProvider;
}

// ---- Tenor ---------------------------------------------------------------

interface TenorMediaFormat {
  url?: string;
  dims?: number[];
}
interface TenorResult {
  id?: string;
  content_description?: string;
  media_formats?: Record<string, TenorMediaFormat>;
}
interface TenorResponse {
  results?: TenorResult[];
  next?: string;
}

function projectTenor(r: TenorResult): GifItem | null {
  const tiny = r.media_formats?.tinygif;
  const gif = r.media_formats?.gif;
  if (!tiny?.url || !gif?.url) return null;
  return {
    id: String(r.id ?? ''),
    provider: 'tenor',
    description: r.content_description ?? '',
    previewUrl: tiny.url,
    previewWidth: tiny.dims?.[0] ?? 0,
    previewHeight: tiny.dims?.[1] ?? 0,
    gifUrl: gif.url,
    gifWidth: gif.dims?.[0] ?? 0,
    gifHeight: gif.dims?.[1] ?? 0,
  };
}

async function callTenor(
  env: Env,
  q: string,
  limit: number,
  pos: string,
): Promise<GifSearchResult | null> {
  const key = env.TENOR_API_KEY;
  if (!key) return null;
  const endpoint = q ? 'search' : 'featured';
  const params = new URLSearchParams({
    key,
    client_key: 'getrelay',
    media_filter: 'gif,tinygif',
    contentfilter: 'medium', // PG-13
    limit: String(limit),
  });
  if (q) params.set('q', q);
  if (pos) params.set('pos', pos);
  const url = `https://tenor.googleapis.com/v2/${endpoint}?${params.toString()}`;
  const r = await fetch(url, { cf: { cacheTtl: 60 } } as RequestInit);
  if (!r.ok) return null;
  const data = (await r.json()) as TenorResponse;
  const items: GifItem[] = [];
  for (const row of data.results ?? []) {
    const p = projectTenor(row);
    if (p) items.push(p);
  }
  return { items, next: data.next ?? null, provider: 'tenor' };
}

// ---- Giphy ---------------------------------------------------------------

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

function projectGiphy(r: GiphyResult): GifItem | null {
  const tiny = r.images?.fixed_width;
  const full = r.images?.original;
  if (!tiny?.url || !full?.url) return null;
  return {
    id: String(r.id ?? ''),
    provider: 'giphy',
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
    const p = projectGiphy(row);
    if (p) items.push(p);
  }
  // Giphy uses numeric offsets, expose the next page as a string for
  // consistency with Tenor's `next` token.
  const next =
    (data.pagination?.offset ?? 0) + (data.pagination?.count ?? items.length);
  return { items, next: items.length > 0 ? String(next) : null, provider: 'giphy' };
}

// ---- Provider selection --------------------------------------------------

function pickProvider(env: Env, requested: string | undefined): GifProvider | null {
  // Honour the explicit choice if its key is configured; otherwise fall
  // back to whichever provider IS configured. Returns null when neither
  // is set so the caller can 404.
  if (requested === 'giphy' && env.GIPHY_API_KEY) return 'giphy';
  if (requested === 'tenor' && env.TENOR_API_KEY) return 'tenor';
  if (env.TENOR_API_KEY) return 'tenor';
  if (env.GIPHY_API_KEY) return 'giphy';
  return null;
}

// ---- Routes --------------------------------------------------------------

export function gifsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Empty q falls back to trending so the picker can open with content.
  // `provider=tenor|giphy` selects the source (default: whichever is
  // configured first, preferring Tenor since Gboard uses it).
  app.get('/gifs/search', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    const q = (c.req.query('q') ?? '').trim();
    const limit = Math.min(Number(c.req.query('limit') ?? '24'), 50);
    const pos = c.req.query('pos') ?? '';
    const provider = pickProvider(c.env, c.req.query('provider'));
    if (!provider) return c.json({ error: 'gifs_not_configured' }, 404);

    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = new Request(
      `https://relay-cache.local/gifs/${provider}/${q ? 'search' : 'trending'}?q=${encodeURIComponent(q)}&limit=${limit}&pos=${encodeURIComponent(pos)}`,
    );
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const result =
      provider === 'tenor'
        ? await callTenor(c.env, q, limit, pos)
        : await callGiphy(c.env, q, limit, pos);
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

  // Surfaces which providers are available so the UI can hide the
  // toggle when only one is wired up.
  app.get('/gifs/providers', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    return c.json({
      tenor: !!c.env.TENOR_API_KEY,
      giphy: !!c.env.GIPHY_API_KEY,
    });
  });

  return app;
}
