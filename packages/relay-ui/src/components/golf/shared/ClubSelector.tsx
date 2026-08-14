import type { CSSProperties } from 'react';
import { CLUBS } from '../../../lib/golf/clubs';
import {
  frostedSurface,
  FROST_RADIUS_PILL,
  FROST_RADIUS_CHIP,
  FROST_TEXT,
  FROST_SHADOW,
} from './frosted';

// Shared club chooser for both HUDs, in two variants so the drift dies:
//  • 'strip'  — the Range's scrolling pill strip of every club (tap to select).
//  • 'cycle'  — the Course's ‹ [club] › cycle, or a "Putter" label on the green.
// "Frosted Fairway" skin — the pills/arrows float over the live course, so they
// use the shared frosted-glass tokens (explicit dark-translucent, not the light
// theme vars). Pure DOM — no `three`. Positioning is left to the caller via the
// optional `style` (spread onto the root), so each HUD places it as before.

// The club pill / Putter label surface (frosted glass, pill radius).
const clubPill: CSSProperties = {
  minWidth: 92,
  padding: '6px 12px',
  fontSize: 14,
  fontWeight: 700,
  color: FROST_TEXT,
  textAlign: 'center',
  ...frostedSurface(FROST_RADIUS_PILL),
};

// A circular ‹ › cycle arrow (frosted glass, fully round chip).
const cycleArrow: CSSProperties = {
  width: 32,
  height: 32,
  color: FROST_TEXT,
  fontSize: 18,
  fontWeight: 700,
  lineHeight: 1,
  ...frostedSurface(FROST_RADIUS_CHIP),
};

export function ClubSelector(props: StripProps | CycleProps) {
  if (props.variant === 'cycle') {
    const { clubName, putting, onCycle, style } = props;
    return (
      <div className="flex items-center gap-1" style={{ pointerEvents: 'auto', ...style }}>
        {putting ? (
          // On the green the stroke is a putt — no club choice, so just label it.
          <div style={clubPill}>Putter</div>
        ) : (
          <>
            <button type="button" onClick={() => onCycle(-1)} style={cycleArrow}>
              ‹
            </button>
            <div style={clubPill}>{clubName}</div>
            <button type="button" onClick={() => onCycle(1)} style={cycleArrow}>
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
        // Active chip takes the app accent (a solid pop against the frosted set);
        // the rest are frosted glass.
        const base: CSSProperties = active
          ? {
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: '#FFFFFF',
              boxShadow: FROST_SHADOW,
              borderRadius: FROST_RADIUS_PILL,
            }
          : { color: FROST_TEXT, ...frostedSurface(FROST_RADIUS_PILL) };
        return (
          <button
            key={c.id}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(c.id)}
            style={{
              pointerEvents: 'auto',
              flex: '0 0 auto',
              opacity: disabled && !active ? 0.5 : 1,
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: 700,
              ...base,
            }}
          >
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

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
