import type { CSSProperties } from 'react';

// "Frosted Fairway" HUD skin — the single source of truth for the golf playing
// HUD's translucent glass panels so Course + Range can't drift. The HUD always
// floats over the live 3D course, so these are EXPLICIT dark-translucent values
// (never the light theme vars): the rgba background is the graceful fallback
// wherever backdrop-filter is unsupported, and the blur/saturate layer frosts
// the course reading through it. Pure DOM / CSS — no `three`.

// Panel surface tokens, shared by every pill / card / chip.
export const FROST_BG = 'rgba(12,20,16,0.34)';
export const FROST_BORDER = '1px solid rgba(255,255,255,0.22)';
export const FROST_SHADOW = '0 6px 18px rgba(0,0,0,0.28)';
export const FROST_BLUR = 'blur(14px) saturate(1.2)';

// Text tokens: crisp white body, dimmed labels, and the bright mint accent used
// for "under par" readouts.
export const FROST_TEXT = '#ffffff';
export const FROST_DIM = 'rgba(255,255,255,0.72)';
export const FROST_MINT = '#b6f4c8';

// Corner radii by element class.
export const FROST_RADIUS_CARD = 18;
export const FROST_RADIUS_PILL = 14;
export const FROST_RADIUS_CHIP = 999;

// Mono + tabular numerals for every numeric read-out (the app bundles JetBrains
// Mono as var(--font-mono); Tailwind's font-mono only reaches ui-monospace).
export const MONO_NUM: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontVariantNumeric: 'tabular-nums',
};

// The frosted glass surface, ready to spread onto any panel/pill/chip. Pass the
// radius appropriate to the element (card 18 / pill 14 / chip 999). Includes
// BOTH backdrop-filter prefixes so it frosts on WebKit too.
export function frostedSurface(radius: number = FROST_RADIUS_PILL): CSSProperties {
  return {
    background: FROST_BG,
    backdropFilter: FROST_BLUR,
    WebkitBackdropFilter: FROST_BLUR,
    border: FROST_BORDER,
    boxShadow: FROST_SHADOW,
    borderRadius: radius,
  };
}
