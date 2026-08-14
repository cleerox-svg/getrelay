import { useRef } from 'react';
import { frostedSurface, FROST_RADIUS_CARD } from './frosted';

// Circular "ball face" spin selector — the dot is the CONTACT POINT on the ball.
// Strike LOW (drag down) = backspin; strike HIGH (drag up) = topspin; left/right
// = draw/fade. Centre = no spin. Value persists across shots. onChange gets
// (back, side) in [-1..1] with back>0 = backspin, side>0 = fade (curves right) —
// the sim's sign convention is unchanged; only the puck axis maps contact-point
// (low = backspin) so it reads the natural way. Shared by the Range and Course so
// both wire it to sim.setSpin. Pure DOM / theme CSS-vars — no `three`.
export function SpinPuck({
  value,
  onChange,
}: {
  value: { back: number; side: number };
  onChange: (back: number, side: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const SIZE = 84;
  const R = SIZE / 2 - 12; // dot travel radius (px)
  const dotX = SIZE / 2 + value.side * R;
  // Contact-point mapping: backspin (back>0) is a LOW strike, so the dot sits
  // BELOW centre. (Kept in sync with `apply` below.)
  const dotY = SIZE / 2 + value.back * R;

  const apply = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy);
    if (len > R) {
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    // dy>0 (drag DOWN, a low strike) → back>0 = backspin; drag UP → topspin.
    onChange(Math.max(-1, Math.min(1, dy / R)), Math.max(-1, Math.min(1, dx / R)));
  };

  return (
    // Frosted ring frame seats the white ball-face puck so it belongs to the
    // "Frosted Fairway" set. The frame is display-only; the ball inside keeps the
    // pointer capture + drag logic. The label moves onto the frame.
    <div
      style={{
        display: 'inline-block',
        padding: 8,
        pointerEvents: 'none',
        ...frostedSurface(FROST_RADIUS_CARD),
      }}
    >
      <div
        style={{
          textAlign: 'center',
          fontSize: 8,
          fontWeight: 800,
          letterSpacing: 1,
          color: 'rgba(255,255,255,0.72)',
          marginBottom: 5,
        }}
      >
        SPIN
      </div>
      <div
        ref={ref}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          apply(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) apply(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onDoubleClick={() => onChange(0, 0)}
        style={{
          position: 'relative',
          width: SIZE,
          height: SIZE,
          borderRadius: '50%',
          background: 'radial-gradient(circle at 50% 42%, #ffffff, #d9dee4)',
          border: '1px solid var(--separator)',
          boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
          pointerEvents: 'auto',
          touchAction: 'none',
          cursor: 'grab',
        }}
      >
        {/* Cross-hair baked onto the ball face (the SPIN label now lives on the
            frosted frame above). */}
        <div style={{ position: 'absolute', left: '50%', top: 4, bottom: 4, width: 1, background: 'rgba(0,0,0,0.10)' }} />
        <div style={{ position: 'absolute', top: '50%', left: 4, right: 4, height: 1, background: 'rgba(0,0,0,0.10)' }} />
        <div
          style={{
            position: 'absolute',
            left: dotX,
            top: dotY,
            width: 16,
            height: 16,
            marginLeft: -8,
            marginTop: -8,
            borderRadius: '50%',
            background: 'var(--accent)',
            border: '2px solid #fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
          }}
        />
      </div>
    </div>
  );
}
