import { useEffect, useRef } from 'react';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';
import type { SwingResult } from '../../../lib/baseball/derbyState';

// The broadcast tag — `104.2 MPH · 28° · 418 FT` — that flies with the ball.
//
// ⚠ IT FOLLOWS THE BALL WITHOUT A SINGLE REACT RENDER. `getBallScreen` is
// `StadiumApi.ballScreen()`: the DRAWN ball, projected by the SAME camera that
// drew it, in 0…1 viewport coordinates. This component's rAF reads it and writes
// one `style.transform`. The alternative — lifting the ball's position into
// React state — is 60 renders a second of the whole HUD to move a label, and it
// would also be a second copy of the camera model living outside the GL layer.
//
// ⚠ AND IT REPORTS THE SIM'S OWN NUMBERS. Every field is a scalar `swingContact`
// and `simulateBattedBall` produced; nothing here rounds a distance into a
// nicer one or re-derives a launch angle from a carry.
//
// When the ball is not being drawn (before contact, after it is parked) the
// projection returns null and the tag simply HOLDS its last position — which is
// where the ball finished, i.e. exactly where a broadcast leaves the graphic.
//
// ⚠ AND `follow` IS THE SAME RULE APPLIED TO A MOVING CAMERA. The projection is
// correct in world space, so once the camera EASES BACK to the box after a play
// (`stadium/camera.ts`) a tag that kept following would sail across the screen
// chasing a ball that had already stopped. Holding is the same behaviour the
// null branch above already had; `follow` just lets the HUD say when the play is
// over, which is knowledge this widget has no other way to get.

export interface ExitVeloTagProps {
  result: SwingResult | null;
  /** Track the ball, or hold the last position. See the note above. */
  follow: boolean;
  /** `StadiumApi.ballScreen()` — 0…1 viewport, y down, or null. */
  getBallScreen: () => [number, number] | null;
}

/** Where the tag sits before the ball has ever been projected. */
const FALLBACK: [number, number] = [0.5, 0.42];
/** Offset from the ball, px, so the tag never sits on top of it. */
const OFFSET_Y_PX = -34;

export function ExitVeloTag({ result, follow, getBallScreen }: ExitVeloTagProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<[number, number]>(FALLBACK);
  const visible = !!result && result.contactZM !== null;

  // ⚠ A REF, NOT A DEP. Re-running the effect on `follow` would restart the rAF
  // mid-flight; the loop reads the current value each frame instead.
  const followRef = useRef(follow);
  followRef.current = follow;

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const loop = () => {
      const host = hostRef.current;
      if (host) {
        const p = followRef.current ? getBallScreen() : null;
        if (p) lastRef.current = p;
        const [u, v] = lastRef.current;
        // translate(-50%, -100%) anchors the tag's bottom centre on the ball;
        // the two percentages are of the TAG, the two of `u`/`v` are of the
        // host, which is why this is one transform and not a left/top write.
        host.style.transform = `translate(calc(${(u * 100).toFixed(2)}vw - 50%), calc(${(
          v * 100
        ).toFixed(2)}vh - 100% + ${OFFSET_Y_PX}px))`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [visible, getBallScreen]);

  if (!result || !visible) return null;

  return (
    <div
      ref={hostRef}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none',
        willChange: 'transform',
      }}
    >
      <div
        style={{
          ...frostedSurface(12),
          ...MONO_NUM,
          color: '#fff',
          padding: '5px 10px',
          fontSize: 13,
          fontWeight: 800,
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {`${result.evMph.toFixed(1)} MPH · ${result.laDeg.toFixed(0)}° · ${result.distFt.toFixed(
          0,
        )} FT`}
        {result.barrel && (
          <div
            style={{
              fontSize: 11,
              letterSpacing: 1,
              color: '#b6f4c8',
              marginTop: 2,
            }}
          >
            BARREL!
          </div>
        )}
      </div>
    </div>
  );
}
