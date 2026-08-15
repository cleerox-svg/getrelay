// Compass wind chip: an arrow pointing the way the wind pushes the ball, plus a
// mph readout. Up = downrange; +cross pushes right. Shared by the Range and the
// Course so both HUDs read wind identically (rendered from st.windAlong/cross).
// Frosted-glass "Frosted Fairway" skin (no `three`, safe in the non-lazy HUD
// wrappers): the chip floats over the live course so it uses the shared frosted
// tokens, an explicit dark-translucent surface — never the light theme vars.

import { frostedSurface, FROST_RADIUS_CHIP, FROST_TEXT, FROST_DIM, FROST_MINT, MONO_NUM } from './frosted';
import { windMph } from '../../../lib/golf/wind';

export function WindChip({ along, cross }: { along: number; cross: number }) {
  const mph = Math.round(windMph(along, cross));
  const deg = (Math.atan2(cross, Math.max(0.0001, along)) * 180) / Math.PI;
  // Any meaningful breeze tints the arrow mint so it pops off the frosted glass;
  // dead calm keeps it plain white.
  const arrow = mph > 0 ? FROST_MINT : FROST_TEXT;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 10px 5px 6px',
        ...frostedSurface(FROST_RADIUS_CHIP),
      }}
    >
      <svg width={26} height={26} viewBox="0 0 26 26" style={{ transform: `rotate(${deg}deg)` }}>
        <circle cx={13} cy={13} r={12} fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth={1.5} />
        <path d="M13 4 L17 15 L13 12 L9 15 Z" fill={arrow} />
      </svg>
      <div style={{ lineHeight: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: FROST_TEXT, ...MONO_NUM }}>{mph}</div>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color: FROST_DIM }}>MPH</div>
      </div>
    </div>
  );
}
