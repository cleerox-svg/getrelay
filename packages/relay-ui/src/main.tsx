import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initAudio } from './lib/audio/prefs';
import { initLegacyUi } from './lib/legacy';
import { CHUNK_RECOVER_KEY, hardRecover } from './lib/recover';
import { registerServiceWorker } from './lib/register-sw';
import { initTheme } from './lib/theme';
import './styles/global.css';
import './styles/legacy.css';

initTheme();
initAudio();
initLegacyUi();

// Self-heal stale clients. When a lazy chunk fails to load — e.g. an older
// client still holding an index.html that references an asset hash a newer
// deploy has pruned — Vite fires 'vite:preloadError'. Run hardRecover() ONCE
// to wipe the poisoned SW cache + unregister the SW, then reload to pull the
// fresh index.html + current chunks instead of surfacing a crash. A plain
// reload would just re-serve the stale asset set from the SW cache and loop.
//
// The one-shot guard lives in sessionStorage (survives the reload) under the
// SHARED CHUNK_RECOVER_KEY, so this path and the ErrorBoundary backstop share a
// single budget: whichever fires first recovers, the other short-circuits. That
// way a genuinely-dead chunk triggers AT MOST ONE wipe+reload cycle before the
// error UI shows. If storage is unavailable we do NOT recover — a reload with no
// persistable guard could loop forever on a genuinely-unfetchable chunk; better
// to let the error surface to the ErrorBoundary. A module-level flag also caps
// multiple events within a single page-load to one recovery.
let preloadReloadTried = false;
window.addEventListener('vite:preloadError', (e) => {
  if (preloadReloadTried) return;
  let canGuard = false;
  let alreadyReloaded = false;
  try {
    alreadyReloaded = sessionStorage.getItem(CHUNK_RECOVER_KEY) === '1';
    sessionStorage.setItem(CHUNK_RECOVER_KEY, '1');
    canGuard = true;
  } catch {
    canGuard = false; // storage blocked — don't risk a reload loop
  }
  // If recovery already ran this session (either path) or we can't persist the
  // guard, return WITHOUT preventDefault so React.lazy's rejection propagates to
  // the ErrorBoundary, which will show the error UI (its guard is now set too).
  if (!canGuard || alreadyReloaded) return;
  preloadReloadTried = true;
  e.preventDefault();
  void hardRecover();
});

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

registerServiceWorker();
