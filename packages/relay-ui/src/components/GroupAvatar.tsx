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
  // Optional uploaded group avatar (already-resolved URL from
  // `chat.avatarUrl`). When present, renders as a rounded-square
  // image. Falls back to the hashed-letter tile when null/undefined.
  src?: string | null;
  size?: number;
}

export function GroupAvatar({ subject, src, size = 44 }: Props) {
  const trimmed = subject.trim();
  const letter = (trimmed[0] ?? '#').toUpperCase();
  const bg = PALETTE[hashIndex(trimmed || 'group', PALETTE.length)] ?? '#8E8E93';
  const radius = Math.round(size * 0.28);

  if (src) {
    return (
      <img
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          objectFit: 'cover',
          display: 'inline-block',
          flex: '0 0 auto',
          // Mirror the depth treatment we apply to image-variant
          // user avatars so groups feel consistent in the chat list.
          boxShadow:
            'inset 0 0 0 1px rgba(255,255,255,0.10), 0 1px 2px rgba(0,0,0,0.18)',
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        // Subtle tonal lift in the same hue family — top edge +14%
        // lightness, bottom -8% — so the square reads as a slightly-
        // raised tile rather than printed flat on the page.
        background: `linear-gradient(180deg, color-mix(in srgb, ${bg} 86%, white) 0%, ${bg} 70%, color-mix(in srgb, ${bg} 92%, black) 100%)`,
        color: '#FFFFFF',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 600,
        fontSize: Math.floor(size * 0.46),
        flex: '0 0 auto',
        boxShadow:
          'inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.18)',
        textShadow: '0 1px 0 rgba(0,0,0,0.10)',
      }}
    >
      {letter}
    </span>
  );
}
