import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

// Thin proxy in front of Giphy v1. Two reasons we don't call Giphy
// directly from the browser:
//   1. Keeps the API key off the client.
//   2. Lets us cache responses in caches.default so a popular search
//      term doesn't burn quota on every keystroke.

interface GifAnalytics {
  // Giphy "Action Register" pingback URLs. We forward these to the client
  // and ping them back (via POST /gifs/register) when the user clicks/sends
  // a GIF so Giphy can attribute usage. Required before Giphy will issue a
  // non-rate-limited production key.
  onload?: string;
  onclick?: string;
  onsent?: string;
}

interface GifItem {
  id: string;
  description: string;
  previewUrl: string; // small inline preview, animated
  previewWidth: number;
  previewHeight: number;
  gifUrl: string; // full-quality, what we send through chat
  gifWidth: number;
  gifHeight: number;
  analytics: GifAnalytics;
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
interface GiphyAnalyticsEvent {
  url?: string;
}
interface GiphyResult {
  id?: string;
  title?: string;
  images?: {
    fixed_width?: GiphyImage; // ~200px wide animated GIF — good preview
    original?: GiphyImage; // full-quality
  };
  // Per-result pingback URLs for the Action Register flow.
  analytics?: {
    onload?: GiphyAnalyticsEvent;
    onclick?: GiphyAnalyticsEvent;
    onsent?: GiphyAnalyticsEvent;
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
    analytics: {
      onload: r.analytics?.onload?.url,
      onclick: r.analytics?.onclick?.url,
      onsent: r.analytics?.onsent?.url,
    },
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

  // Giphy Action Register endpoint.
  //
  // Each search result carries onload/onclick/onsent pingback URLs. We ping
  // the relevant one when the user interacts with a GIF so Giphy can tune
  // results and attribute usage — a prerequisite for getting off the beta
  // key. We proxy this server-side rather than firing from the browser for
  // two reasons:
  //   1. *.giphy-analytics.giphy.com is on most ad/tracker blocklists, so
  //      a client-side ping is silently dropped for a large share of users.
  //   2. It keeps every Giphy hop behind the worker, matching the search proxy.
  //
  // Best-effort and fire-and-forget: analytics must never block sending a GIF,
  // so we validate, kick off the ping via waitUntil, and return 204 right away.
  app.post('/gifs/register', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    let body: { url?: unknown; randomId?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'bad_request' }, 400);
    }

    const raw = typeof body.url === 'string' ? body.url : '';
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return c.json({ error: 'bad_url' }, 400);
    }
    // Only ever fetch Giphy's own analytics hosts — never let the worker be
    // turned into an open redirect/SSRF proxy for arbitrary URLs.
    if (target.protocol !== 'https:' || !/(^|\.)giphy\.com$/.test(target.hostname)) {
      return c.json({ error: 'bad_url' }, 400);
    }

    // Giphy wants ts (ms) and a per-session random_id appended at ping time.
    // The random_id is a stable, non-PII id minted per device by the client.
    target.searchParams.set('ts', String(Date.now()));
    if (typeof body.randomId === 'string' && body.randomId) {
      target.searchParams.set('random_id', body.randomId);
    }

    c.executionCtx.waitUntil(
      fetch(target.toString(), { method: 'GET' }).then(
        () => undefined,
        () => undefined,
      ),
    );
    return c.body(null, 204);
  });

  return app;
}
