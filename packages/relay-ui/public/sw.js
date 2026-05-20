// Relay service worker — v0 polish.
// Strategy:
//  - Cache static shell on install.
//  - Network-first for navigation requests with a cached fallback (shell).
//  - Never intercept WebSocket upgrades or any cross-origin requests.
//  - Never intercept API calls (they go to relay-api.* — different origin).
//  - Stale-while-revalidate for same-origin static assets.

const SHELL_CACHE = 'relay-shell-v1';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(SHELL_URLS).catch(() => undefined),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Don't intercept anything off-origin (API calls live on relay-api.*).
  if (url.origin !== self.location.origin) return;
  // Don't intercept WS upgrades (would never hit GET here, but be safe).
  if (req.headers.get('Upgrade') === 'websocket') return;

  // Navigation requests: network-first, fall back to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(SHELL_CACHE);
          cache.put('/index.html', res.clone()).catch(() => undefined);
          return res;
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const cached =
            (await cache.match('/index.html')) ?? (await cache.match('/'));
          return cached ?? Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets (Vite-hashed under /assets/): stale-while-revalidate.
  if (url.pathname.startsWith('/assets/') || url.pathname.match(/\.(svg|webmanifest|js|css|woff2?)$/)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone()).catch(() => undefined);
            return res;
          })
          .catch(() => cached ?? Response.error());
        return cached ?? network;
      })(),
    );
  }
});
