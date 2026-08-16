import { useEffect, useRef } from 'react';
import { MONO_NUM, frostedSurface } from '../../golf/shared/frosted';

// The swing-timing readout: a sweep during the pitch, a signed error after it.
//
// ⚠ THERE IS NO "PERFECT" TICK, AND THAT IS THE WHOLE DESIGN NOTE. The obvious
// widget is a hairline at 0 ms with a green flash when you hit it. The sim says
// that would be a lie. `derbySim.test.ts`'s TIMING SWEEP, 40 seeds × 24 swings
// per row, reticle on the ball:
//
//     -10 ms  HR 69.4 %   barrel 88.1 %
//      -5 ms  HR 72.4 %   barrel 98.8 %
//       0 ms  HR 81.5 %   barrel 99.1 %
//      +5 ms  HR 76.1 %   barrel 97.7 %
//     +10 ms  HR 81.0 %   barrel 88.2 %
//
// Dead-on is the peak, but +10 ms is 81.0 % against 81.5 % and +5 ms is BELOW
// both. A hairline would tell the player that a half-percent difference is the
// game and that +5 is better than +10, and the second of those is not even the
// right ordering. So the good zone is drawn as a BAND, and the number — the
// signed error in ms — is what carries the precision.
//
// ⚠ AND THE BAND EDGES ARE NOT CHOSEN HERE. There are two of them and they now
// arrive by different routes, for a reason:
//   • The CONTACT window is a PROP, computed per pitch by
//     `derbyRules.contactWindowS` — `contactGeometry` drives contact toward the
//     tip as |Δt| grows in EITHER direction, so the bat's own length closes the
//     window, and the number depends on how fast the pitch is arriving. It used
//     to be `const CONTACT_MS = 26.4`, hand-copied out of a `console.log` in
//     `derbySim.test.ts` ("TIMING WINDOW … half-width 26.4 ms, asymmetry
//     0.00 ms") while this header claimed "nothing here may widen it; it is
//     drawn, not set". Nothing enforced that: a change to `contactGeometry` or
//     to the bat's length moved the real window and left the drawn band lying.
//     Now the sim is asked. Nothing here may widen it, and now that is true.
//   • ±10 ms is where barrel rate is still ≥ 88 % — the plateau above. That one
//     IS a hand-read number, and it is allowed to be: it is a DISPLAY threshold
//     which decides a colour and never an outcome, and it has no closed form to
//     ask for. If the table moves it moves with it.
// Neither is read by anything in `lib/baseball`; neither can reach a result.

/** Barrel plateau half-width, ms — MEASURED. Display threshold only. */
const BAND_MS = 10;

/** How far past the plate crossing the track runs, as a fraction of it. */
const TAIL_FRAC = 0.14;

const GOOD = '#4ade80';
const OK = '#fbbf24';
const MISS = '#f87171';

const TRACK_H = 16;

export interface TimingBarProps {
  /** A pitch is in flight: sweep. */
  live: boolean;
  /** TRUE physical seconds from release to the plate crossing. */
  flightTimeS: number;
  /**
   * Contact-window half-width, ms, for THIS pitch — `derbyRules.contactWindowS`
   * converted at the call site. DERIVED; the widget draws it and never sets it.
   */
  contactMs: number;
  /**
   * TRUE physical seconds since release, read every frame.
   *
   * ⚠ A GETTER, NOT A NUMBER. A `nowS` prop would mean one React render per
   * frame for a widget whose only job is to move 4 px. The parent owns the one
   * play clock (`DerbyGame`); this reads it from inside its own rAF and writes
   * `style.left`. No re-render, no allocation in the loop.
   */
  getElapsedS: () => number;
  /** Signed timing error of the swing just taken, ms. + = LATE. */
  errorMs: number | null;
  /** The swing made contact — a whiff colours the readout differently. */
  contact: boolean;
}

const pctFor = (tS: number, flightTimeS: number): number => {
  const span = flightTimeS * (1 + TAIL_FRAC);
  return Math.max(0, Math.min(100, (tS / span) * 100));
};

export function TimingBar({
  live,
  flightTimeS,
  contactMs,
  getElapsedS,
  errorMs,
  contact,
}: TimingBarProps) {
  const markerRef = useRef<HTMLDivElement | null>(null);

  // The sweep. Own rAF, straight to `style.left`, cancelled on unmount and
  // whenever the pitch ends — the AccuracyBar idiom, which is the one animation
  // pattern in the app that has never cost a re-render.
  useEffect(() => {
    if (!live || flightTimeS <= 0) return;
    let raf = 0;
    const loop = () => {
      const m = markerRef.current;
      if (m) m.style.left = `${pctFor(getElapsedS(), flightTimeS)}%`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, flightTimeS, getElapsedS]);

  if (flightTimeS <= 0) return null;

  const span = flightTimeS * (1 + TAIL_FRAC);
  const plateP = (flightTimeS / span) * 100;
  const msToPct = (ms: number) => (ms / 1000 / span) * 100;
  const err = errorMs;
  const abs = err === null ? 0 : Math.abs(err);
  const tint = !contact ? MISS : abs <= BAND_MS ? GOOD : OK;

  // Frozen at the tap once the swing is taken, sweeping until then.
  const frozenP = err === null ? null : pctFor(flightTimeS + err / 1000, flightTimeS);

  return (
    <div style={{ width: 'min(84vw, 340px)', pointerEvents: 'none' }}>
      <div
        style={{
          ...frostedSurface(999),
          position: 'relative',
          height: TRACK_H,
          overflow: 'hidden',
        }}
      >
        {/* Contact window — anywhere in here the bat reaches the ball. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${plateP - msToPct(contactMs)}%`,
            width: `${2 * msToPct(contactMs)}%`,
            background: 'rgba(255,255,255,0.16)',
          }}
        />
        {/* The barrel BAND. Not a tick — see the header. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${plateP - msToPct(BAND_MS)}%`,
            width: `${2 * msToPct(BAND_MS)}%`,
            background:
              'linear-gradient(90deg, rgba(74,222,128,0.25), rgba(74,222,128,0.65), rgba(74,222,128,0.25))',
          }}
        />
        <div
          ref={markerRef}
          style={{
            position: 'absolute',
            top: -1,
            bottom: -1,
            left: frozenP === null ? '0%' : `${frozenP}%`,
            width: 4,
            marginLeft: -2,
            borderRadius: 2,
            background: err === null ? '#fff' : tint,
            boxShadow: `0 0 8px ${err === null ? 'rgba(255,255,255,0.9)' : tint}`,
          }}
        />
      </div>
      <div
        style={{
          ...MONO_NUM,
          marginTop: 5,
          textAlign: 'center',
          fontSize: 12,
          fontWeight: 700,
          color: err === null ? 'rgba(255,255,255,0.72)' : tint,
          textShadow: '0 1px 4px rgba(0,0,0,0.6)',
        }}
      >
        {err === null
          ? live
            ? 'TAP TO SWING'
            : 'TIMING'
          : `${err > 0 ? '+' : ''}${err.toFixed(0)} ms ${err > 0 ? 'LATE' : err < 0 ? 'EARLY' : ''}`}
      </div>
    </div>
  );
}
