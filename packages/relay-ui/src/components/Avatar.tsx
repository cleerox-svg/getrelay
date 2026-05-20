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
          }}
        />
      ) : (
        <span
          aria-hidden="true"
          style={{
            width: size,
            height: size,
            borderRadius: 999,
            background: bg,
            color: '#FFFFFF',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 600,
            fontSize: Math.floor(size * 0.46),
            letterSpacing: 0,
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
