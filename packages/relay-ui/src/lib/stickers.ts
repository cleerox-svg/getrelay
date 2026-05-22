// The default sticker pack. Each entry maps to an SVG bundled with the
// PWA under /public/stickers/, so the picker is instant (no API call)
// and the message_url stored in the wire is a stable public URL that
// any client on any device can resolve.
//
// Adding a sticker: drop the SVG in public/stickers/, add an entry
// here, ship. No schema change, no migration, no backend deploy.

export interface Sticker {
  id: string;
  label: string;
  path: string;
}

export const STICKERS: ReadonlyArray<Sticker> = [
  { id: 'wink', label: 'Wink', path: '/stickers/wink.svg' },
  { id: 'laugh', label: 'Laugh', path: '/stickers/laugh.svg' },
  { id: 'heart', label: 'Heart', path: '/stickers/heart.svg' },
  { id: 'sad', label: 'Sad', path: '/stickers/sad.svg' },
  { id: 'fire', label: 'Fire', path: '/stickers/fire.svg' },
  { id: 'star', label: 'Star', path: '/stickers/star.svg' },
  { id: 'check', label: 'Check', path: '/stickers/check.svg' },
  { id: 'hundred', label: '100', path: '/stickers/hundred.svg' },
];

// Absolute URL form for the wire — recipients on other devices need a
// reachable host, not a relative path. Resolved at send time against
// window.location.origin.
export function stickerUrl(sticker: Sticker, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}${sticker.path}`;
}

// Reverse lookup: does this mediaUrl point at one of our bundled
// stickers? Used by the renderer to apply sticker-specific styling
// (no bubble background, transparent, capped size).
export function isStickerUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const path = new URL(url).pathname;
    return path.startsWith('/stickers/') && path.endsWith('.svg');
  } catch {
    return false;
  }
}
