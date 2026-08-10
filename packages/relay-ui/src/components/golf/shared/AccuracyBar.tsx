import { useEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

// Tap-timing accuracy UI (Golf-Clash style): a horizontal track with a
// highlighted centre sweet-spot and a marker that ping-pongs left↔right at a
// steady, readable rate. Tapping anywhere on the full-bleed overlay stops the
// marker and reports the error e ∈ [-1..1] (0 = dead centre). The marker is
// animated via its own rAF writing straight to the element's style (no React
// re-render per frame, no per-frame allocation); the rAF is cancelled on unmount.
// `paused` freezes the sweep in place (phase persists across the pause). The
// overlay captures the tap so it can never also register as a canvas drag.
//
// Shared by the Range and Course: `label` is the caption ("TAP TO STOP IN THE
// CENTER" / "Tap to strike"); `paused` support is kept for the Range's pause
// sheet (the Course simply never pauses it, passing paused={false} / omitting).
export function AccuracyBar({
  paused = false,
  onStop,
  label = 'TAP TO STOP IN THE CENTER',
}: {
  paused?: boolean;
  onStop: (e: number) => void;
  label?: string;
}) {
  const markerRef = useRef<HTMLDivElement | null>(null);
  // Triangle phase in [0..2): 0→1 sweeps L→R, 1→2 sweeps R→L. Persisted in a ref
  // so pausing/resuming continues from where it stopped.
  const phaseRef = useRef(0);
  const firedRef = useRef(false);
  const SWEEP_MS = 950; // one side→side pass

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      if (!paused) {
        let ph = phaseRef.current + dt / SWEEP_MS;
        ph %= 2;
        phaseRef.current = ph;
        const p = ph < 1 ? ph : 2 - ph; // 0..1 marker position
        const m = markerRef.current;
        if (m) m.style.left = `${p * 100}%`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused]);

  const stop = (ev: ReactPointerEvent<HTMLDivElement>) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (firedRef.current || paused) return;
    firedRef.current = true;
    const ph = phaseRef.current;
    const p = ph < 1 ? ph : 2 - ph;
    onStop((p - 0.5) * 2); // e ∈ [-1..1]
  };

  return (
    <div
      onPointerDown={stop}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 45,
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-end',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 120px)',
        touchAction: 'none',
      }}
    >
      <div style={{ width: 'min(78vw, 340px)' }}>
        <div
          className="text-[12px] font-bold text-center"
          style={{
            color: '#fff',
            marginBottom: 8,
            letterSpacing: 0.4,
            textShadow: '0 1px 4px rgba(0,0,0,0.6)',
          }}
        >
          {label}
        </div>
        <div
          style={{
            position: 'relative',
            height: 22,
            borderRadius: 999,
            background: 'rgba(20,28,40,0.7)',
            border: '1px solid var(--separator)',
            boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
            overflow: 'hidden',
          }}
        >
          {/* Centre sweet-spot band. */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 0,
              bottom: 0,
              width: '13%',
              transform: 'translateX(-50%)',
              background:
                'linear-gradient(90deg, rgba(74,222,128,0), rgba(74,222,128,0.6), rgba(74,222,128,0))',
            }}
          />
          {/* Centre line. */}
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: 3,
              bottom: 3,
              width: 2,
              transform: 'translateX(-50%)',
              background: 'rgba(255,255,255,0.55)',
            }}
          />
          {/* Sweeping marker (left set each frame by the rAF above). */}
          <div
            ref={markerRef}
            style={{
              position: 'absolute',
              top: -2,
              bottom: -2,
              left: '50%',
              width: 5,
              marginLeft: -2.5,
              borderRadius: 3,
              background: '#fff',
              boxShadow: '0 0 8px rgba(255,255,255,0.95)',
            }}
          />
        </div>
      </div>
    </div>
  );
}
