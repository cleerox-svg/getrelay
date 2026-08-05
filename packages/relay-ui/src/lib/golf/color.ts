// Shared, render-safe colour helpers for the Golf modes. Both PuttingMode
// and RangeMode read theme CSS vars each frame and blend them here, so a
// mid-round theme flip just works. Everything falls back gracefully (never
// throws) for tokens it can't parse — e.g. a color-mix()/oklch() var.

// Blend two CSS colours `mix` (0..1) of the way from a -> b. Supports
// #rgb / #rrggbb and rgb()/rgba(); returns `a` unchanged if either side is
// unparseable, so it can be called straight from a hot render path.
export function colorMix(a: string, b: string, mix: number): string {
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (!pa || !pb) return a;
  const t = Math.min(1, Math.max(0, mix));
  const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
  return `rgb(${r},${g},${bl})`;
}

// Like colorMix but returns an rgba(...) string with the given alpha (0..1).
// Built straight from parsed channels, so it never emits an invalid color
// string for an unparseable token (returns a transparent-safe fallback of
// `a` at the requested alpha, or fully transparent if `a` is unparseable).
export function rgbaMix(a: string, b: string, mix: number, alpha: number): string {
  const pa = parseColor(a);
  const pb = parseColor(b);
  const al = Math.min(1, Math.max(0, alpha));
  if (!pa) return `rgba(0,0,0,0)`;
  const src = pb ?? pa;
  const t = Math.min(1, Math.max(0, mix));
  const r = Math.round(pa[0] + (src[0] - pa[0]) * t);
  const g = Math.round(pa[1] + (src[1] - pa[1]) * t);
  const bl = Math.round(pa[2] + (src[2] - pa[2]) * t);
  return `rgba(${r},${g},${bl},${al.toFixed(3)})`;
}

export function parseColor(c: string): [number, number, number] | null {
  const s = c.trim();
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const a = hex.charAt(0);
      const b = hex.charAt(1);
      const d = hex.charAt(2);
      return [parseInt(a + a, 16), parseInt(b + b, 16), parseInt(d + d, 16)];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
    return null;
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m && m[1]) {
    const parts = m[1].split(',').map((p) => parseFloat(p));
    const [r, g, b] = parts;
    if (r != null && g != null && b != null) return [r, g, b];
  }
  return null;
}
