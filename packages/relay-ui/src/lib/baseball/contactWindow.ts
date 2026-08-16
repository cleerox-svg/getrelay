// The CONTACT WINDOW — where on the bat the ball may be, and the timing
// half-width that follows from it.
//
// Split out of `derbyRules.ts` at the 500-line cap — EXTRACTION, NOT A RAISED
// CAP, the third time this game has met the cap that way (`pitches.ts` from
// `pitchSim.ts`, `bat.ts` from `batSim.ts`, `pchip.ts` from `parks.ts`). The
// seam was identified twice before it was taken: this file is pure GEOMETRY —
// two bounds on the bat and one bisection that inverts `contactGeometry` — and
// it knows nothing about the derby's format, its serve mix, its payout or its
// reticle. `derbyRules.ts` kept everything that is about the GAME.
//
// It is imported by three unrelated consumers, which is the other half of why it
// is its own module: `derbySim.resolveSwing` (the live overlap test),
// `shared/TimingBar.tsx` (the band it DRAWS), and the benches.

import { BAT_LENGTH_IN, M_PER_FT, SWEET_SPOT_M } from './bat';
import { contactGeometry } from './batSim';
import { IN_TO_FT } from './units';

/**
 * Contact requires the ball's centre to be OVER THE BAT. Both bounds are in
 * metres from the knob, matching `Swing.aimZM`.
 *
 * The tip is DERIVED — a 33 in bat, and past its end there is no bat. The handle
 * bound is its MIRROR about the sweet spot and is a FEEL KNOB, because the real
 * limit near the hands is `e(z)` collapsing on the bending node and this model
 * has no `e(z)` (BASEBALL.md § "The collision"). Stated rather than hidden: the
 * handle side of this window is the one number in the contact test that physics
 * is not carrying.
 */
export const BAT_TIP_M = BAT_LENGTH_IN * IN_TO_FT * M_PER_FT;
export const BAT_HANDLE_LIMIT_M = 2 * SWEET_SPOT_M - BAT_TIP_M;

/**
 * The CONTACT WINDOW's half-width, TRUE physical seconds: the largest |Δt| at
 * which a WELL-AIMED swing still has the ball over the bat, against a pitch
 * arriving at `pitchSpeedFps`.
 *
 * DERIVED, by INVERTING `contactGeometry` rather than by re-solving its algebra.
 * `R_c = d/cos θ_c > d` for a miss in either direction, so contact walks
 * monotonically toward the tip with |Δt| and a bisection on the ONE
 * implementation is exact — and, unlike a closed form copied out of the same
 * derivation, cannot drift from it when the bat's length or the swing radius
 * moves. Symmetric in ±Δt by construction (cos is even).
 *
 * ⚠ IT EXISTS BECAUSE THE WINDOW IS DRAWN. `shared/TimingBar.tsx` paints the
 * contact band from this and promises "nothing here may widen it; it is drawn,
 * not set" — which was a `CONTACT_MS = 26.4` hand-copied out of a `console.log`
 * in `derbySim.test.ts`, i.e. a promise with nothing holding it. Now the widget
 * asks, per pitch, and the test asserts this against its 0.1 ms sweep of the
 * live `predict()` path.
 *
 * ⚠ THIS IS TRUE PHYSICAL TIME, AND THE PLAYER LIVES IN WALL TIME. The band the
 * HUD draws is this divided by `PITCH_TEMPO` — 26.4 ms of physics is 48.0 ms of
 * wall clock at 0.55 and 58.7 ms at 0.45. Widening the window the PLAYER
 * experiences is `PITCH_TEMPO`'s job and only `PITCH_TEMPO`'s job; nothing in
 * this file may move to make a tap easier.
 *
 * It is the window for a swing that was AIMED right: a lateral miss moves
 * `aimZM` along the bat and moves this with it, and a big enough vertical miss
 * or pull intent fails the overlap test at every Δt. Those are `resolveSwing`'s
 * business; a drawn band is a statement about timing alone.
 */
export function contactWindowS(pitchSpeedFps: number, batSpeedMph?: number): number {
  const onBat = (dt: number): boolean => {
    const z = contactGeometry(pitchSpeedFps, {
      hand: 'R',
      timingErrorS: dt,
      undercutIn: 0,
      ...(batSpeedMph === undefined ? {} : { batSpeedMph }),
    }).contactZM;
    // ⚠ THE HANDLE HALF NEVER FIRES HERE, AND IS KEPT ANYWAY. `z = aimZM +
    // (d/cos θ_c − d)` with `aimZM` at the sweet spot, so while |θ_c| < π/2
    // contact only walks OUT and the TIP bound is what closes the window
    // (measured at every rung of the bracket, at 55/71.5/130 mph of bat). It is
    // `resolveSwing`'s overlap test written the same way on purpose — the ONE
    // statement of "the ball is over the bat", not a narrowed copy of it.
    return Number.isFinite(z) && z <= BAT_TIP_M && z >= BAT_HANDLE_LIMIT_M;
  };
  // Bracket first, from 1 ms, doubling. The window is ~26 ms, where the bat has
  // turned ~0.46 rad, so the bracket closes long before `cos θ_c` leaves its
  // monotone quadrant and the bisection below stays well-posed.
  let hi = 0.001;
  while (hi < 0.128 && onBat(hi)) hi *= 2;
  let lo = onBat(hi) ? hi : 0;
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2;
    if (onBat(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}
