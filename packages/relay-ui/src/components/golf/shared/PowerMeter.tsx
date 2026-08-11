// Vertical power meter pinned to the right edge, clear of the ball's central drag
// zone. Empty at rest; fills 0→100% as the player pulls back. The fill colour
// ramps GREEN (low) → AMBER (mid) → RED (max) — the SAME 3-stop gradient as the
// on-turf aim arrow — so the HUD and the 3D scene read the same power at a glance,
// with feedback across the WHOLE range (not just near the top). Near max it gains
// an elastic "rubber-band" strain: the track throbs + glows, conveying the
// slingshot straining against the band WITHOUT relying on haptics (iOS has none).
// Dial ticks at 25/50/75% make the middle finely readable. Display-only
// (pointer-transparent). Shared by the Range (always mounted) and the Course
// (mounted only while aiming/armed) — visibility is a prop. Pure DOM / theme.

// Solid colour for a given power, interpolated green→amber→red (matches CourseGL/
// RangeGL's aim arrow so the meter and the turf arrow never disagree).
function powerRGB(p: number): string {
  const c = Math.max(0, Math.min(1, p));
  const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
  let r: number, g: number, b: number;
  if (c < 0.5) {
    const t = c * 2; // green (70,214,107) → amber (255,213,74)
    r = lerp(70, 255, t);
    g = lerp(214, 213, t);
    b = lerp(107, 74, t);
  } else {
    const t = (c - 0.5) * 2; // amber (255,213,74) → red (255,67,38)
    r = lerp(255, 255, t);
    g = lerp(213, 67, t);
    b = lerp(74, 38, t);
  }
  return `rgb(${r}, ${g}, ${b})`;
}

export function PowerMeter({ power, visible = true }: { power: number; visible?: boolean }) {
  if (!visible) return null;
  const clamped = Math.max(0, Math.min(1, power));
  const pct = Math.round(clamped * 100);
  const fill = powerRGB(clamped);
  const straining = clamped > 0.72; // elastic strain zone → throb + glow
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
        gap: 7,
        pointerEvents: 'none',
        zIndex: 42,
      }}
    >
      {/* Local keyframes for the near-max rubber-band throb. */}
      <style>{`@keyframes pmStrain {
        0%,100% { transform: scaleX(1); box-shadow: 0 2px 8px rgba(0,0,0,0.25); }
        50% { transform: scaleX(1.22); box-shadow: 0 0 16px rgba(255,60,40,0.75); }
      }`}</style>
      <div
        style={{
          fontSize: 15,
          fontWeight: 900,
          letterSpacing: 0.5,
          color: fill,
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          minWidth: 38,
          textAlign: 'center',
        }}
      >
        {pct}%
      </div>
      <div
        style={{
          position: 'relative',
          width: 18,
          height: 210,
          borderRadius: 999,
          background: 'rgba(16,24,36,0.55)',
          border: '1px solid var(--separator)',
          overflow: 'hidden',
          animation: straining ? 'pmStrain 0.42s ease-in-out infinite' : undefined,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
        }}
      >
        {/* Dial ticks at 25 / 50 / 75% so the dialable middle is readable. */}
        {[25, 50, 75].map((t) => (
          <div
            key={t}
            style={{
              position: 'absolute',
              left: 2,
              right: 2,
              bottom: `${t}%`,
              height: 1,
              background: 'rgba(255,255,255,0.28)',
            }}
          />
        ))}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: `${pct}%`,
            background: fill,
            transition: 'height 55ms linear, background 55ms linear',
          }}
        />
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: 1,
          color: '#fff',
          textShadow: '0 1px 3px rgba(0,0,0,0.5)',
        }}
      >
        POWER
      </div>
    </div>
  );
}
