// Vertical power meter pinned to the right edge, clear of the ball's central drag
// zone. Empty at rest; fills 0→100% as the player pulls back, ramping from accent
// to red near max. Display-only (pointer-transparent). Shared by the Range (always
// mounted) and the Course (mounted only while aiming/armed) — visibility is a
// prop so the Course can hide it between shots. Pure DOM / theme CSS-vars.
export function PowerMeter({ power, visible = true }: { power: number; visible?: boolean }) {
  if (!visible) return null;
  const pct = Math.round(Math.max(0, Math.min(1, power)) * 100);
  const hot = power > 0.8;
  const fill = hot ? '#ff4d4d' : 'var(--accent)';
  return (
    <div
      style={{
        position: 'absolute',
        right: 'calc(env(safe-area-inset-right, 0px) + 10px)',
        top: '50%',
        transform: 'translateY(-50%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        pointerEvents: 'none',
        zIndex: 42,
      }}
    >
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        {pct}%
      </div>
      <div
        style={{
          position: 'relative',
          width: 12,
          height: 168,
          borderRadius: 999,
          background: 'rgba(20,28,40,0.5)',
          border: '1px solid var(--separator)',
          overflow: 'hidden',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${pct}%`,
            background: fill,
            transition: 'height 60ms linear',
          }}
        />
      </div>
      <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: '#fff', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
        POWER
      </div>
    </div>
  );
}
