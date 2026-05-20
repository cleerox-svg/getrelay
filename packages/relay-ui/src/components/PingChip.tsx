export function PingChip() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--ping)',
        color: '#FFFFFF',
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
