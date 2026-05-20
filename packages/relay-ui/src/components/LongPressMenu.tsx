import { useEffect } from 'react';

interface Action {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: Action[];
}

export function LongPressMenu({ open, onClose, actions }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-2)',
          width: '100%',
          maxWidth: 460,
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          padding: 8,
          paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
        }}
      >
        {actions.map((a) => (
          <button
            key={a.label}
            onClick={() => {
              a.onClick();
              onClose();
            }}
            disabled={a.disabled}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '16px 12px',
              borderRadius: 12,
              color: a.destructive ? 'var(--accent)' : 'var(--text)',
              fontWeight: 500,
              opacity: a.disabled ? 0.4 : 1,
            }}
          >
            {a.label}
          </button>
        ))}
        <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '8px 12px' }} />
        <button
          onClick={onClose}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '16px 12px',
            borderRadius: 12,
            color: 'var(--text-dim)',
            fontWeight: 500,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
