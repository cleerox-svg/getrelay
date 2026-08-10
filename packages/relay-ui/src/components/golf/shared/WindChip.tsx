// Compass wind chip: an arrow pointing the way the wind pushes the ball, plus a
// mph readout. Up = downrange; +cross pushes right. Shared by the Range and the
// Course so both HUDs read wind identically (rendered from st.windAlong/cross).
// Pure DOM / theme CSS-vars — no `three`, safe in the non-lazy HUD wrappers.

export function WindChip({ along, cross }: { along: number; cross: number }) {
  const mph = Math.round(Math.hypot(along, cross) * 2.5);
  const deg = (Math.atan2(cross, Math.max(0.0001, along)) * 180) / Math.PI;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        borderRadius: 999,
        padding: '5px 10px 5px 6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
      }}
    >
      <svg width={26} height={26} viewBox="0 0 26 26" style={{ transform: `rotate(${deg}deg)` }}>
        <circle cx={13} cy={13} r={12} fill="none" stroke="var(--separator)" strokeWidth={1.5} />
        <path d="M13 4 L17 15 L13 12 L9 15 Z" fill="var(--accent)" />
      </svg>
      <div style={{ lineHeight: 1 }}>
        <div className="tabular-nums" style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
          {mph}
        </div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: 'var(--text-dim)' }}>
          MPH
        </div>
      </div>
    </div>
  );
}
