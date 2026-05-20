export function Receipt({ delivered, read }: { delivered: boolean; read: boolean }) {
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
      <span style={{ color: delivered ? 'var(--receipt-d)' : 'transparent' }}>D</span>
      <span style={{ color: read ? 'var(--receipt-r)' : 'transparent' }}>R</span>
    </span>
  );
}
