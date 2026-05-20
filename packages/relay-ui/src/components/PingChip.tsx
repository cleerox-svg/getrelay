export function PingChip() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--accent)',
        color: '#0A0A0E',
        padding: '6px 12px',
        borderRadius: 999,
        fontWeight: 700,
        fontSize: 14,
      }}
    >
      ⚡ PING!!
    </span>
  );
}
