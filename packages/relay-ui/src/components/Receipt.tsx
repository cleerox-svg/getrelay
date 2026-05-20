interface Props {
  delivered: boolean;
  read: boolean;
  onAccent?: boolean; // when rendered on an iOS-blue bubble
}

// Single check for delivered, double check for read. Both green when
// active; gray when inactive (still occupy the same space so timestamps
// don't shift). Inspired by WhatsApp.
export function Receipt({ delivered, read, onAccent = false }: Props) {
  const inactive = onAccent ? 'rgba(255,255,255,0.45)' : '#C7C7CC';
  const active = '#34C759'; // iOS systemGreen
  const color = read ? active : delivered ? (onAccent ? '#FFFFFF' : '#8E8E93') : inactive;

  return (
    <span
      aria-label={read ? 'read' : delivered ? 'delivered' : 'pending'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        color,
        marginLeft: 2,
      }}
    >
      <svg width="16" height="11" viewBox="0 0 16 11" fill="none" aria-hidden="true">
        {/* First check */}
        <path
          d="M1 6 L4.5 9.5 L11 2.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Second check (only visible when read) */}
        {read ? (
          <path
            d="M5.5 6 L9 9.5 L15.5 2.5"
            stroke={active}
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        ) : null}
      </svg>
    </span>
  );
}
