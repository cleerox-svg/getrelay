import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

// Sit-and-Swing's ONE input surface: drag to aim between pitches, tap to swing
// during the flight.
//
// ⚠ THE RETICLE ITSELF IS NOT IN HERE. It is geometry, at the plate, in
// perspective — `components/baseball/stadium/reticle.ts`. This file is the
// pointer surface and the drag→feet mapping, and it draws nothing at all. A DOM
// circle would be pinned to the screen and would therefore agree with the plate
// for exactly one camera at one aspect ratio.
//
// ⚠ ONE SURFACE, NOT TWO, and that is a correctness point rather than tidiness.
// Aiming and swinging are mutually exclusive in time (you aim in `ready`, you
// swing in `inFlight`), so they are one full-bleed capture layer switched by
// `mode`. Two stacked full-bleed layers is how a tap goes to the wrong one and
// the swing that the player is sure they made never reaches the sim.
//
// ⚠ THE DRAG IS RELATIVE, NOT ABSOLUTE. An absolute map — "your finger IS the
// reticle" — has to claim a screen rectangle for the zone, and the zone's actual
// screen rectangle depends on the camera, the aspect and the FOV. The moment the
// two disagree the aid points somewhere the sim was not told about. A relative
// drag makes no claim it can break, and it means the finger never covers the
// thing it is placing.
//
// ⚠ AND IT DOES NOT CLAMP. `DerbySim.setReticle` clamps to
// `RULE_ZONE ± RETICLE_REACH_FT`; this reads the sim's post-clamp value back
// through `getReticle` before every increment, so the bound has ONE
// implementation and a drag that runs into it cannot build up invisible slack
// that has to be dragged back out.

/**
 * Feet of reticle travel per CSS pixel of drag.
 *
 * ⚠ FEEL KNOB, labelled. At 0.010 the 1.417 ft plate is 142 px wide and the
 * 1.8 ft zone height is 180 px — about a thumb's comfortable travel on a phone,
 * and it puts `RETICLE_FULL_MISS_IN` (8 in, where the aim residual has faded in
 * completely) 67 px away, so the difference between a barrel and a can of corn
 * is a movement the hand can actually resolve.
 */
const AIM_FT_PER_PX = 0.01;

/**
 * Movement quantum, CSS px. Below this a `pointermove` does nothing at all.
 *
 * ⚠ THIS IS THE QUANTISED INPUT GATE, and it is here BEFORE it is needed. What
 * hangs off `onAim` today is two clamps and two writes to a Vector3, which is
 * free; what obviously hangs off it next is `DerbySim.predict()`, which is a
 * full contact solve plus a batted-ball integration. The golf audit measured the
 * ungated version of exactly this at 8–16 ms per move event on a mid-range
 * phone — a dropped frame per event — against 0.55 ms for the gated one. The
 * gate goes in while it is one `if`.
 */
const QUANT_PX = 2;

export type ZoneMode = 'idle' | 'aim' | 'swing';

export interface ZoneReticleProps {
  mode: ZoneMode;
  /** The sim's CURRENT reticle, post-clamp. Read on every increment. */
  getReticle: () => { x: number; h: number };
  /** Hand the sim an absolute REPORT (x, h) in ft. It clamps; this does not. */
  onAim: (x: number, h: number) => void;
  /** One tap, anywhere, during the flight. */
  onSwing: () => void;
}

export function ZoneReticle({ mode, getReticle, onAim, onSwing }: ZoneReticleProps) {
  const dragRef = useRef<{ id: number; x: number; y: number } | null>(null);
  // Sub-quantum drag that has not been spent yet, CSS px. Without this a slow
  // drag would be silently discarded one pixel at a time and never move at all.
  const accRef = useRef({ x: 0, y: 0 });
  const swungRef = useRef(false);

  if (mode !== 'swing' && swungRef.current) swungRef.current = false;

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mode === 'swing') {
      if (swungRef.current) return;
      swungRef.current = true;
      onSwing();
      return;
    }
    if (mode !== 'aim') return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    accRef.current.x = 0;
    accRef.current.y = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId || mode !== 'aim') return;
    const acc = accRef.current;
    acc.x += e.clientX - d.x;
    acc.y += e.clientY - d.y;
    d.x = e.clientX;
    d.y = e.clientY;
    if (Math.abs(acc.x) < QUANT_PX && Math.abs(acc.y) < QUANT_PX) return;
    const cur = getReticle();
    // Screen +x is the umpire's right, which is REPORT +x (zone.ts says so and
    // says it has no mirror in it). Screen +y is DOWN, height is UP: one sign.
    onAim(cur.x + acc.x * AIM_FT_PER_PX, cur.h - acc.y * AIM_FT_PER_PX);
    acc.x = 0;
    acc.y = 0;
  };

  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.id !== e.pointerId) return;
    dragRef.current = null;
  };

  return (
    <div
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 20,
        touchAction: 'none',
        pointerEvents: mode === 'idle' ? 'none' : 'auto',
        cursor: mode === 'aim' ? 'grab' : 'pointer',
      }}
    />
  );
}
