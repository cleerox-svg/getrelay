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
// deploy has pruned — Vite fires 'vite:preloadError'. Reload once to pull the
// fresh index.html + current chunks instead of surfacing a crash. A
// sessionStorage guard prevents a reload loop if reloading doesn't help.
window.addEventListener('vite:preloadError', (e) => {
  const KEY = 'relay.preloadReloaded';
  try {
    if (sessionStorage.getItem(KEY)) return; // already tried once this session
    sessionStorage.setItem(KEY, '1');
  } catch {
    /* sessionStorage unavailable — fall through and reload anyway */
  }
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
