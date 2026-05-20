// Letter-on-color square avatar used to represent group chats. The color
// is hash-derived from the subject so the same group keeps the same hue
// across renders + devices.

const PALETTE = [
  '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#00C7BE',
  '#30B0C7', '#007AFF', '#5856D6', '#AF52DE', '#FF2D55',
];

function hashIndex(s: string, modulo: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % modulo;
}

interface Props {
  subject: string;
  size?: number;
}

export function GroupAvatar({ subject, size = 44 }: Props) {
  const trimmed = subject.trim();
  const letter = (trimmed[0] ?? '#').toUpperCase();
  const bg = PALETTE[hashIndex(trimmed || 'group', PALETTE.length)] ?? '#8E8E93';

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: bg,
        color: '#FFFFFF',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: Math.floor(size * 0.46),
        flex: '0 0 auto',
      }}
    >
      {letter}
    </span>
  );
}
