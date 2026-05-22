// Platform detection for picking a Konsta theme (Material on Android,
// iOS elsewhere). Static — the platform doesn't change at runtime, so
// we resolve once at module load and never re-evaluate.

export type Platform = 'android' | 'ios' | 'web';

function detect(): Platform {
  if (typeof window === 'undefined') return 'web';

  // Capacitor exposes a globally-bridged getPlatform() inside the
  // Android/iOS WebView. Cheapest, most reliable signal when present.
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const capPlatform = cap?.getPlatform?.();
  if (capPlatform === 'android') return 'android';
  if (capPlatform === 'ios') return 'ios';

  // Browser fallback for users hitting relay.averrow.com without the
  // Capacitor wrapper (regular Chrome on a phone).
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'web';
}

export const PLATFORM: Platform = detect();

// Konsta has only two themes ('ios' and 'material'). Android gets
// Material so the app feels native inside the Capacitor shell; iOS and
// the desktop web view both default to iOS to preserve the current look
// (changing desktop out from under existing users would be too noisy).
export type KonstaTheme = 'ios' | 'material';
export const KONSTA_THEME: KonstaTheme = PLATFORM === 'android' ? 'material' : 'ios';
