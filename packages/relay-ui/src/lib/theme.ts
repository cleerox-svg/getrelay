export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'relay.theme';

export function getTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setTheme(mode: ThemeMode): void {
  try {
    if (mode === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  applyTheme(mode);
}

function applyTheme(mode: ThemeMode): void {
  const html = document.documentElement;
  if (mode === 'auto') html.removeAttribute('data-theme');
  else html.setAttribute('data-theme', mode);
  syncMetaThemeColor();
}

function isDarkActive(): boolean {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function syncMetaThemeColor(): void {
  // Remove any media-scoped theme-color metas and replace with a single
  // unscoped one whose content matches the resolved theme. This keeps the
  // iOS PWA status bar and Android nav bar tinted correctly regardless of
  // whether the user picked auto/light/dark.
  Array.from(document.head.querySelectorAll('meta[name="theme-color"]')).forEach((el) =>
    el.remove(),
  );
  const meta = document.createElement('meta');
  meta.name = 'theme-color';
  meta.content = isDarkActive() ? '#000000' : '#FFFFFF';
  document.head.appendChild(meta);
}

export function initTheme(): void {
  applyTheme(getTheme());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'auto') syncMetaThemeColor();
  });
}
