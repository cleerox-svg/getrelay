interface Props {
  src?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
  // Optional cosmetic frame overlay (golf economy avatar frames). A 'ring'
  // draws a coloured border just OUTSIDE the disc; a 'glow' draws a soft halo.
  // Rendered absolutely on the wrapper so it never shifts layout; null / absent
  // → nothing (the default frame_none). The shape is inlined (not imported from
  // the golf lib) so Avatar stays domain-agnostic.
  frame?: { color: string; style: 'ring' | 'glow' } | null;
}

// Hard cap (px) on how far a frame ring/glow may extend BEYOND the avatar disc.
// The old overlay scaled its outward inset/glow radius with `size`, so a big
// profile frame looked right but a 32px leaderboard avatar packed in a tight row
// bled its ring/halo into the neighbouring row/avatar. Clamping the OUTWARD
// extent to a small absolute max keeps small avatars self-contained while large
// avatars still read as framed (the ring stays proportionally thick, it just
// hugs the disc instead of ballooning outward). Overlay is absolute → no layout
// shift at any size.
const FRAME_MAX_OUT = 3;

const PALETTE = [
  '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE',
  '#30B0C7', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55',
];

function hashIndex(s: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}

function initials(name: string): string {
  const first = name.trim()[0];
  return first ? first.toUpperCase() : '?';
}

export function Avatar({ src, name, size = 40, online = false, frame = null }: Props) {
  const label = name?.trim() || 'Relay user';
  const bg = PALETTE[hashIndex(label, PALETTE.length)] ?? '#8E8E93';
  const dotSize = Math.max(10, Math.floor(size * 0.28));

  // Frame overlay geometry. The OUTWARD extent is always clamped to
  // FRAME_MAX_OUT (no neighbour bleed on tight 32px leaderboard rows). To keep
  // the epic `glow` frame striking on a large profile/header avatar without
  // breaking that clamp, its prominence grows INWARD with size: the halo blur
  // (softness) scales and a soft inner rim thickens toward the centre, while the
  // outward seat + halo edge stay pinned at ~FRAME_MAX_OUT. All values collapse
  // to the previous small-avatar look at size 32 (seat 2, blur 6, no inner rim),
  // so leaderboard rows render exactly as before.
  const glowSeat = Math.min(FRAME_MAX_OUT, Math.max(2, Math.round(size * 0.04)));
  const glowBlur = Math.max(4, Math.round(size * 0.18));
  const glowInner = Math.max(0, Math.round(size * 0.09) - 3);
  const ringInset = Math.min(FRAME_MAX_OUT, Math.max(2, Math.round(size * 0.06)));
  const ringBorder = Math.max(2, Math.round(size * 0.05));

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size,
        flex: '0 0 auto',
      }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          style={{
            width: size,
            height: size,
            borderRadius: 999,
            objectFit: 'cover',
            display: 'block',
            // Faint inner ring + soft drop reads as a slightly-lifted
            // circle, the iOS-system-avatar treatment. Doesn't compete
            // with the avatar art at all — tiny alpha values.
            boxShadow:
              'inset 0 0 0 1px rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.18)',
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: size,
            height: size,
            borderRadius: 999,
            // Light-from-above tonal lift on the hash-derived color
            // bubble. The gradient stays in the same hue family (the
            // top is +14% lightness via color-mix) so the avatar
            // identity is preserved.
            background: `linear-gradient(180deg, color-mix(in srgb, ${bg} 86%, white) 0%, ${bg} 70%, color-mix(in srgb, ${bg} 92%, black) 100%)`,
            color: '#FFFFFF',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: Math.floor(size * 0.46),
            letterSpacing: 0,
            boxShadow:
              'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.18)',
            // Tiny inner-highlight on the initial too so it reads as
            // lit rather than printed flat on the disc.
            textShadow: '0 1px 0 rgba(0,0,0,0.10)',
          }}
        >
          {initials(label)}
        </span>
      )}
      {frame ? (
        <span
          aria-hidden="true"
          style={
            frame.style === 'glow'
              ? {
                  position: 'absolute',
                  inset: 0,
                  borderRadius: 999,
                  // Three stacked shadows, none reaching past FRAME_MAX_OUT
                  // outward: (1) a solid seat at the disc edge (scales 2→3px with
                  // size, clamped); (2) a soft outer halo whose blur scales for
                  // softness while a NEGATIVE spread (FRAME_MAX_OUT − blur) pins
                  // its visible outer edge to ~3px at any size; (3) an INSET glow
                  // rim that thickens toward the centre with size so a big
                  // profile/header frame reads as a luminous halo, not a hairline
                  // ring. At size 32 the inset term is 0 (no-op) → unchanged.
                  boxShadow: `0 0 0 ${glowSeat}px ${frame.color}, 0 0 ${glowBlur}px ${FRAME_MAX_OUT - glowBlur}px ${frame.color}, inset 0 0 ${glowInner}px 0 ${frame.color}`,
                  pointerEvents: 'none',
                }
              : {
                  position: 'absolute',
                  // Ring sits just OUTSIDE the disc (negative inset), clamped to
                  // FRAME_MAX_OUT so its outer edge never reaches beyond 3px —
                  // absolute → no layout shift. The border WIDTH still scales, so
                  // a large avatar keeps a proportionally bold ring (it just
                  // overlaps the disc edge inward rather than ballooning out).
                  inset: -ringInset,
                  borderRadius: 999,
                  border: `${ringBorder}px solid ${frame.color}`,
                  pointerEvents: 'none',
                }
          }
        />
      ) : null}
      {online ? (
        <span
          aria-label="online"
          style={{
            position: 'absolute',
            right: -1,
            bottom: -1,
            width: dotSize,
            height: dotSize,
            background: 'var(--online)',
            borderRadius: 999,
            border: '2px solid var(--bg)',
          }}
        />
      ) : null}
    </span>
  );
}
