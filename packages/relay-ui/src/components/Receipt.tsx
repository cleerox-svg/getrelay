interface Props {
  delivered: boolean;
  read: boolean;
  onAccent?: boolean; // true when rendered on the iOS-blue (outgoing) bubble
}

export function Receipt({ delivered, read, onAccent = false }: Props) {
  const dimmed = onAccent ? 'rgba(255, 255, 255, 0.55)' : 'var(--receipt-d)';
  const active = onAccent ? '#FFFFFF' : 'var(--receipt-r)';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.06em',
        display: 'inline-flex',
        gap: 2,
      }}
    >
      <span style={{ color: delivered ? dimmed : 'transparent' }}>D</span>
      <span style={{ color: read ? active : 'transparent' }}>R</span>
    </span>
  );
}
