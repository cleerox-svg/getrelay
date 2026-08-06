import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { initLegacyUi } from './lib/legacy';
import { registerServiceWorker } from './lib/register-sw';
import { initTheme } from './lib/theme';
import './styles/global.css';
import './styles/legacy.css';

initTheme();
initLegacyUi();

// Self-heal stale clients. When a lazy chunk fails to load — e.g. an older
// client still holding an index.html that references an asset hash a newer
// deploy has pruned — Vite fires 'vite:preloadError'. Reload ONCE to pull the
// fresh index.html + current chunks instead of surfacing a crash.
//
// The one-shot guard lives in sessionStorage (survives the reload). If storage
// is unavailable we do NOT reload — a reload with no persistable guard could
// loop forever on a genuinely-unfetchable chunk; better to let the error
// surface to the ErrorBoundary. A module-level flag also caps multiple events
// within a single page-load to one reload.
let preloadReloadTried = false;
window.addEventListener('vite:preloadError', (e) => {
  if (preloadReloadTried) return;
  const KEY = 'relay.preloadReloaded';
  let canGuard = false;
  let alreadyReloaded = false;
  try {
    alreadyReloaded = sessionStorage.getItem(KEY) === '1';
    sessionStorage.setItem(KEY, '1');
    canGuard = true;
  } catch {
    canGuard = false; // storage blocked — don't risk a reload loop
  }
  if (!canGuard || alreadyReloaded) return;
  preloadReloadTried = true;
  e.preventDefault();
  window.location.reload();
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
