import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initLegacyUi } from './lib/legacy';
import { registerServiceWorker } from './lib/register-sw';
import { initTheme } from './lib/theme';
import './styles/global.css';
import './styles/legacy.css';

initTheme();
initLegacyUi();

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
