interface Props {
  src?: string | null;
  name?: string | null;
  size?: number;
  online?: boolean;
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

export function Avatar({ src, name, size = 40, online = false }: Props) {
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
