import type { CSSProperties } from 'react';
import { CLUBS } from '../../../lib/golf/clubs';

// Shared club chooser for both HUDs, in two variants so the drift dies:
//  • 'strip'  — the Range's scrolling pill strip of every club (tap to select).
//  • 'cycle'  — the Course's ‹ [club] › cycle, or a "Putter" label on the green.
// Pure DOM / theme CSS-vars — no `three`. Positioning is left to the caller via
// the optional `style` (spread onto the root), so each HUD places it as before.

interface StripProps {
  variant: 'strip';
  clubId: string;
  disabled?: boolean;
  onSelect: (id: string) => void;
  style?: CSSProperties;
}

interface CycleProps {
  variant: 'cycle';
  clubName: string;
  putting: boolean;
  onCycle: (dir: 1 | -1) => void;
  style?: CSSProperties;
}

export function ClubSelector(props: StripProps | CycleProps) {
  if (props.variant === 'cycle') {
    const { clubName, putting, onCycle, style } = props;
    return (
      <div className="flex items-center gap-1" style={{ pointerEvents: 'auto', ...style }}>
        {putting ? (
          // On the green the stroke is a putt — no club choice, so just label it.
          <div
            className="text-center"
            style={{
              minWidth: 92,
              background: 'var(--card-bg)',
              border: '1px solid var(--separator)',
              borderRadius: 12,
              padding: '6px 12px',
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--text)',
              boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
            }}
          >
            Putter
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onCycle(-1)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: 'var(--card-bg)',
                border: '1px solid var(--separator)',
                color: 'var(--text)',
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 1,
                boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
              }}
            >
              ‹
            </button>
            <div
              className="text-center"
              style={{
                minWidth: 92,
                background: 'var(--card-bg)',
                border: '1px solid var(--separator)',
                borderRadius: 12,
                padding: '6px 12px',
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--text)',
                boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
              }}
            >
              {clubName}
            </div>
            <button
              type="button"
              onClick={() => onCycle(1)}
              style={{
                width: 32,
                height: 32,
                borderRadius: 999,
                background: 'var(--card-bg)',
                border: '1px solid var(--separator)',
                color: 'var(--text)',
                fontSize: 18,
                fontWeight: 700,
                lineHeight: 1,
                boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
              }}
            >
              ›
            </button>
          </>
        )}
      </div>
    );
  }

  const { clubId, disabled, onSelect, style } = props;
  return (
    // The scroll container is pointer-transparent so it can't swallow a drag that
    // starts over it; each chip opts back into pointer events.
    <div
      style={{
        display: 'flex',
        gap: 6,
        overflowX: 'auto',
        paddingBottom: 2,
        scrollbarWidth: 'none',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {CLUBS.map((c) => {
        const active = c.id === clubId;
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(c.id)}
            style={{
              pointerEvents: 'auto',
              flex: '0 0 auto',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
              background: active ? 'var(--accent)' : 'var(--card-bg)',
              color: active ? '#FFFFFF' : 'var(--text)',
              opacity: disabled && !active ? 0.5 : 1,
              borderRadius: 12,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 700,
              boxShadow: '0 2px 8px rgba(0,0,0,0.14)',
            }}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}
