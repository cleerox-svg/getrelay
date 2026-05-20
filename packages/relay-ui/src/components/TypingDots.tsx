export function TypingDots({ name }: { name?: string }) {
  return (
    <div style={{ color: 'var(--text-dim)', fontSize: 13, padding: '4px 16px' }}>
      {name ? `${name} is composing···` : 'composing···'}
    </div>
  );
}
