export function TypingDots({ name }: { name?: string }) {
  return (
    <div
      style={{
        color: 'var(--text-dim)',
        fontSize: 13,
        padding: '4px 16px 8px',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <span>{name ? `${name} is composing` : 'composing'}</span>
      <span className="typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
    </div>
  );
}
