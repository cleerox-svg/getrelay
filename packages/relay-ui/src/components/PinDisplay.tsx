import { formatPin } from '../lib/pin';

export function PinDisplay({ pin, size = 'md' }: { pin: string; size?: 'sm' | 'md' | 'lg' }) {
  const fontSize = size === 'lg' ? '28px' : size === 'sm' ? '13px' : '17px';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        letterSpacing: '0.08em',
        fontSize,
        textTransform: 'uppercase',
      }}
    >
      {formatPin(pin)}
    </span>
  );
}
