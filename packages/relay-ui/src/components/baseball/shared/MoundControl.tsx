import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { PitchCommand } from '../../../lib/baseball/ai';
import type { PitchId } from '../../../lib/baseball/pitches';
import { PITCHES } from '../../../lib/baseball/pitches';
import { AccuracyBar } from '../../golf/shared/AccuracyBar';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';
import { CENTRE_AIM, aimFromPull, aimMoved } from './moundAim';
import type { MoundAim } from './moundAim';

// THE MOUND: pick a pitch, pull back to aim, release into the sweep, tap to stop.
//
// Three inputs and they are strictly sequential — a chip, a drag, a tap — which
// is why this is ONE component and one full-bleed capture layer switched by
// phase rather than two stacked ones. `ZoneReticle`'s header argues the same
// point for the batter's side: two stacked full-bleed layers is how a tap goes
// to the wrong one and the pitch the player is sure they threw never arrives.
//
// ⚠ IT PRODUCES A `PitchCommand` AND NOTHING ELSE. The aim math is
// `moundAim.ts` (pure, and its header says why it is not golf's `pullAim`), the
// sweep is golf's `AccuracyBar` VERBATIM, and the two numbers they produce —
// an intended plate location in REPORT ft and a signed stop error in [−1, 1] —
// are the whole of the sim's pitching API. No pointer, no phase and no pixel
// reaches `lib/baseball`.
//
// ⚠ AND IT HOLDS NO GAMEPLAY STATE. The selected pitch lives in the parent (it
// is on the readout), the aim lives in a ref until it is handed over, and the
// component is UNMOUNTED once the pitch is served — which is what resets it.
// There is no "last aim" carried between pitches, deliberately: a slingshot that
// remembers is a slingshot the player cannot see the state of.

/** Feel: how far the draw indicator's bar fills, px. Cosmetic only. */
const DRAW_W = 120;

export interface MoundControlProps {
  /** The pause sheet is up: the sweep freezes and taps do nothing. */
  paused?: boolean;
  /** The pitch the parent has selected. */
  pitchId: PitchId;
  onSelect: (id: PitchId) => void;
  /**
   * Live intent in REPORT ft as the pull moves — the HUD hands it to the
   * renderer's reticle so the player aims at the plate, not at a widget.
   * Quantised by `aimMoved`; see that function.
   */
  onAim: (x: number, h: number) => void;
  /** The finished command. Fired exactly once per mount. */
  onPitch: (cmd: PitchCommand) => void;
}

export function MoundControl({ paused = false, pitchId, onSelect, onAim, onPitch }: MoundControlProps) {
  const [armed, setArmed] = useState(false);
  const [draw, setDraw] = useState(0);
  const dragRef = useRef<{ id: number; x0: number; y0: number; dx: number; dy: number } | null>(null);
  const aimRef = useRef<MoundAim>(CENTRE_AIM);
  const firedRef = useRef(false);

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (armed || paused) return;
    dragRef.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!aimMoved(dx, dy, d.dx, d.dy)) return;
    d.dx = dx;
    d.dy = dy;
    const aim = aimFromPull(dx, dy);
    aimRef.current = aim;
    setDraw(aim.draw);
    onAim(aim.x, aim.h);
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    dragRef.current = null;
    // ⚠ A RELEASE WITH NO PULL IS STILL A RELEASE, and it aims down the middle.
    // `aimRef` is `CENTRE_AIM` until the first quantised move, so this needs no
    // special case — which is the point of the default being a real aim rather
    // than null.
    if (!paused) setArmed(true);
  };

  /** The sweep's stop → the sim's two numbers. THE mapping this file exists for. */
  const stop = (stopError: number) => {
    if (firedRef.current) return;
    firedRef.current = true;
    const aim = aimRef.current;
    onPitch({ id: pitchId, intentX: aim.x, intentH: aim.h, stopError });
  };

  return (
    <>
      {!armed && (
        <div
          data-mound-surface=""
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 20,
            touchAction: 'none',
            pointerEvents: paused ? 'none' : 'auto',
            cursor: 'grab',
          }}
        />
      )}

      {armed && <AccuracyBar paused={paused} onStop={stop} label="TAP TO RELEASE" />}

      {!armed && (
        <div
          style={{
            position: 'absolute',
            zIndex: 31,
            left: 0,
            right: 0,
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            pointerEvents: 'none',
          }}
        >
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center', maxWidth: 340 }}>
            {PITCHES.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-label={p.name}
                onClick={() => onSelect(p.id)}
                disabled={paused}
                style={{
                  ...frostedSurface(999),
                  ...MONO_NUM,
                  pointerEvents: 'auto',
                  color: p.id === pitchId ? '#0b1220' : '#fff',
                  background: p.id === pitchId ? '#ffd166' : undefined,
                  fontSize: 12,
                  fontWeight: 800,
                  letterSpacing: 0.6,
                  padding: '7px 11px',
                }}
              >
                {p.id.toUpperCase()}
              </button>
            ))}
          </div>

          {/* The draw indicator. Cosmetic: the aim itself is drawn at the plate
              by the renderer's reticle, which is where the player is looking. */}
          <div
            style={{
              width: DRAW_W,
              height: 5,
              borderRadius: 999,
              background: 'rgba(255,255,255,0.22)',
              overflow: 'hidden',
            }}
          >
            <div
              data-mound-draw={draw.toFixed(2)}
              style={{ width: `${draw * 100}%`, height: '100%', background: '#ffd166' }}
            />
          </div>

          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.78)',
              textShadow: '0 1px 4px rgba(0,0,0,0.7)',
              textAlign: 'center',
              maxWidth: 300,
            }}
          >
            Pick a pitch, then drag back from the mound — the ball goes the way you pull. Let go and
            tap to release.
          </div>
        </div>
      )}
    </>
  );
}
