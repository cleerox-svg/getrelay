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
                  // Soft coloured halo hugging the disc, plus a thin solid
                  // seat so the frame reads even on a busy avatar.
                  boxShadow: `0 0 0 2px ${frame.color}, 0 0 ${Math.max(6, Math.round(size * 0.22))}px 1px ${frame.color}`,
                  pointerEvents: 'none',
                }
              : {
                  position: 'absolute',
                  // Ring sits just OUTSIDE the disc (negative inset) so it never
                  // clips the avatar art; absolute → no layout shift.
                  inset: -Math.max(2, Math.round(size * 0.06)),
                  borderRadius: 999,
                  border: `${Math.max(2, Math.round(size * 0.05))}px solid ${frame.color}`,
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
