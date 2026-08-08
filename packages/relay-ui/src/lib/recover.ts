// Hard-recovery from a poisoned service-worker cache / stale asset set.
//
// The classic failure: an older client still holds an index.html (or a lazy
// chunk) that references an asset hash a newer deploy has pruned. A hand-rolled
// SW that serves those assets stale-while-revalidate keeps re-serving the dead
// asset set, so a plain window.location.reload() re-crashes forever. To truly
// escape, we must wipe Cache Storage AND unregister every SW, THEN reload so
// the browser fetches a fresh index.html + the current SW and chunk set.
//
// Every step is best-effort, feature-detected, and try/caught: on iOS Safari /
// older PWAs the caches or serviceWorker APIs may be missing — we must never
// throw, just fall through to the reload.
//
// A hung caches/unregister promise must never wedge the recovery (which would
// leave the "Clearing cache…" button stuck with no reload). So we race the
// cleanup against a short timeout and reload unconditionally afterward.
const CLEANUP_TIMEOUT_MS = 2500;

// Shared one-shot session key used by BOTH the ErrorBoundary backstop and the
// vite:preloadError handler. Whichever fires first sets it; every other path
// (and any repeat) short-circuits. Net: at most ONE auto-recovery per session,
// so a genuinely-dead chunk can't trigger multiple wipe+reload cycles.
export const CHUNK_RECOVER_KEY = 'relay.chunkRecover';

async function cleanup(): Promise<void> {
  // 1) Delete ALL Cache Storage entries (the poisoned shell/asset cache lives
  //    here). We nuke everything, not just the current cache name, so this
  //    still works if the cache name changes across versions.
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => caches.delete(k).catch(() => undefined)),
      );
    }
  } catch {
    /* ignore — best effort */
  }

  // 2) Unregister ALL service workers so a new one is installed fresh on the
  //    next load (and can't keep intercepting fetches with old logic).
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.serviceWorker &&
      navigator.serviceWorker.getRegistrations
    ) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(
        regs.map((reg) => reg.unregister().catch(() => undefined)),
      );
    }
  } catch {
    /* ignore — best effort */
  }
}

export async function hardRecover(): Promise<void> {
  // Race the cleanup against a timeout so a hung caches/unregister promise can
  // never prevent the reload below. Both the race and any throw fall through to
  // the reload — it is ALWAYS reached.
  try {
    await Promise.race([
      cleanup(),
      new Promise<void>((resolve) => {
        setTimeout(resolve, CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } catch {
    /* ignore — reload regardless */
  }

  // Reload to pull the fresh index.html + current chunks and re-register the
  // SW from scratch.
  try {
    window.location.reload();
  } catch {
    /* ignore — nothing more we can do */
  }
}

// Recognize a dynamic-import / chunk-load failure across browsers. React.lazy's
// import() rejection surfaces to the ErrorBoundary as one of these messages
// (Chrome/Firefox/Safari word it differently); the MIME-type variant is what a
// 404'd chunk that falls back to index.html HTML looks like.
export function isChunkLoadError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  if (!message) return false;
  return (
    message.includes('Failed to fetch dynamically imported module') ||
    message.includes('error loading dynamically imported module') ||
    message.includes('Importing a module script failed') ||
    message.includes("'text/html' is not a valid JavaScript MIME type") ||
    // Secondary failure: when main.tsx's preloadError handler calls
    // preventDefault(), Vite resolves the failed module as `undefined`, so
    // React.lazy then throws "Cannot read properties of undefined (reading
    // 'default')" instead of one of the strings above. Match it so the
    // ErrorBoundary backstop still treats it as a chunk-load failure.
    /reading 'default'/.test(message)
  );
}
