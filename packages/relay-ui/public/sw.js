// Relay service worker — v0 polish.
// Strategy:
//  - Cache static shell on install.
//  - Network-first for navigation requests with a cached fallback (shell).
//  - Never intercept WebSocket upgrades or any cross-origin requests.
//  - Never intercept API calls (they go to relay-api.* — different origin).
//  - Stale-while-revalidate for same-origin static assets.

// Bump this on any caching-logic change: activate() purges every cache whose
// name isn't the current one, so bumping also clears a previously poisoned shell
// (e.g. an error page cached as /index.html) from every device on next load.
const SHELL_CACHE = 'relay-shell-v5';
const SHELL_URLS = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/icon.svg'];

// Upper bound on how many hashed assets SHELL_CACHE may hold.
//
// WHY THIS EXISTS: the /assets/ branch below caches every ok response and
// `activate` only purges a cache when its NAME changes. Asset URLs are
// content-hashed, so every deploy mints new URLs and the old entries are never
// requested again — but they are also never deleted. Left uncapped the cache
// grows without limit across deploys until the browser hits its origin quota.
// That is not a soft failure: Safari evicts the WHOLE ORIGIN under storage
// pressure, which takes the app shell and IndexedDB with it and strands the app
// offline. A ceiling costs one extra `cache.keys()` per asset miss.
// NOT bumping SHELL_CACHE for this change, deliberately. The bump convention
// above exists to clear a POISONED shell; adding a ceiling cannot poison
// anything, and the trim self-applies on the next asset response, so an
// over-cap cache heals without one. Bumping would instead force every device to
// re-download the whole shell and asset set over cellular — the exact cost this
// cap is meant to reduce.
const SHELL_ASSET_MAX = 96;

/**
 * Evict oldest-first until at most `max` non-shell entries remain.
 *
 * ⚠ The shell URLs are EXCLUDED from eviction, and that exclusion is the whole
 * correctness of this function. Cache Storage returns keys in insertion order,
 * and the shell is inserted first (during `install`) — so a naive FIFO trim
 * would delete `/index.html` before any asset, breaking the offline fallback
 * that the navigation handler depends on.
 */
async function trimShellAssets(cache, max) {
  const keys = await cache.keys();
  const evictable = keys.filter((req) => {
    try {
      return !SHELL_URLS.includes(new URL(req.url).pathname);
    } catch {
      return false;
    }
  });
  for (let i = 0; i < evictable.length - max; i++) {
    await cache.delete(evictable[i]);
  }
}

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
          // Only cache a REAL, ok navigation as the shell. Never cache an error
          // page / SPA-fallback HTML for a bad response — that's how a transient
          // blip used to get pinned as a broken shell and survive reloads.
          if (res.ok) {
            const cache = await caches.open(SHELL_CACHE);
            cache.put('/index.html', res.clone()).catch(() => undefined);
          }
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

  // Never intercept the SW script itself — it must always be managed by the
  // browser's own update mechanism (byte-compared on navigation), never served
  // stale from Cache Storage, or the SW could pin its own old logic forever.
  if (url.pathname === '/sw.js') return;

  // Static assets (Vite-hashed under /assets/): stale-while-revalidate.
  //
  // INVARIANT: /assets/ chunks are content-hashed and therefore immutable — a
  // given URL never changes content, so serving the cached copy first is safe
  // and fast. Because a new deploy PRUNES old hashes, a request for a pruned
  // chunk must SURFACE its failure (404/non-ok) rather than be masked: we only
  // cache res.ok responses, and a non-ok network result propagates unchanged so
  // the app's chunk-load recovery (vite:preloadError / ErrorBoundary) can fire
  // and hardRecover() the client onto the current asset set. Never cache a 404.
  if (url.pathname.startsWith('/assets/') || url.pathname.match(/\.(svg|webmanifest|js|css|woff2?)$/)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL_CACHE);
        const cached = await cache.match(req);
        const network = fetch(req)
          .then((res) => {
            // Write-then-trim is kept alive past the response with waitUntil:
            // returning `cached` short-circuits this promise, so without it the
            // SW could be killed before the trim runs and the cap would only
            // apply on cold misses.
            if (res.ok) {
              event.waitUntil(
                cache
                  .put(req, res.clone())
                  .then(() => trimShellAssets(cache, SHELL_ASSET_MAX))
                  .catch(() => undefined),
              );
            }
            return res;
          })
          .catch(() => cached ?? Response.error());
        return cached ?? network;
      })(),
    );
  }
});

// ---------- Web Push ----------

self.addEventListener('push', (event) => {
  // showNotification MUST be called on every push event or Chrome will
  // revoke the subscription after a few violations. So wrap everything
  // in waitUntil with a fallback notification if anything throws.
  const work = (async () => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = { body: event.data ? event.data.text() : '' };
    }
    const title = data.title || 'Relay';
    const body = data.body || '';
    const chatId = data.chatId || '';
    const url = typeof data.url === 'string' ? data.url : '';
    const tag = data.tag || chatId || 'relay-message';

    // If a Relay tab is currently focused on THIS device, silence the
    // notification — the user is already looking at Relay. Other devices
    // will still get the full notification because each receives its own
    // push and runs its own SW.
    let focused = false;
    try {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      focused = all.some((c) => c.focused);
    } catch {
      /* ignore */
    }

    try {
      // Use PNG icons — Android Chrome silently drops SVG icons on the
      // notification surface, so the notification can fail to render or
      // appear without an icon. iOS PWA prefers PNG too.
      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: !focused,
        silent: focused,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { chatId, url },
      });
    } catch (err) {
      // Last-ditch fallback so Chrome doesn't revoke the sub.
      await self.registration.showNotification('Relay', {
        body: 'New activity',
        tag: 'relay-fallback',
      });
    }
  })();
  event.waitUntil(work);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  // Prefer an explicit deep-link path when the producer set one
  // (e.g. /sports/nhl/:id). Falls back to the chat that fired the
  // push, or the chats list when there's nothing better.
  const explicitUrl = typeof data.url === 'string' ? data.url : '';
  const chatId = data.chatId || '';
  const targetPath = explicitUrl
    ? explicitUrl
    : chatId
      ? `/chats/${encodeURIComponent(chatId)}`
      : '/chats';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        try {
          const u = new URL(client.url);
          if (u.origin === self.location.origin) {
            await client.focus();
            client.postMessage({ type: 'navigate', path: targetPath });
            return;
          }
        } catch {
          /* ignore */
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetPath);
    })(),
  );
});
