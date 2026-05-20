interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
}

export function SegmentedControl({ value, options, onChange }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        background: 'var(--surface-2)',
        borderRadius: 9,
        padding: 2,
        margin: '0 var(--space-4) var(--space-3)',
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.value)}
            style={{
              flex: 1,
              background: active ? 'var(--bg)' : 'transparent',
              borderRadius: 7,
              padding: '7px 12px',
              fontSize: 14,
              fontWeight: 600,
              color: opt.disabled ? 'var(--text-dim)' : 'var(--text)',
              boxShadow: active ? '0 1px 3px rgba(0, 0, 0, 0.08)' : 'none',
              minHeight: 'auto',
              minWidth: 'auto',
              opacity: opt.disabled ? 0.5 : 1,
              cursor: opt.disabled ? 'not-allowed' : 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
