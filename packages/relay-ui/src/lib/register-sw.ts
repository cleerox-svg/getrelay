export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Skip in dev — Vite's HMR doesn't want a SW in the way.
  if (import.meta.env.DEV) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
