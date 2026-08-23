// THE ONE PLAY CLOCK, shared by every baseball HUD.
//
// Extracted from `DerbyGame.tsx` when `DuelGame.tsx` needed the identical
// arithmetic — the charter's "one implementation per concept", applied to the
// wall→true mapping. Two copies of `trueTimeOf` in two sibling modes is exactly
// how the ball on screen and the instant the sim resolves contact drift apart,
// and the failure mode is invisible to a type-check and to every printed table.
//
// Pure. No React, no `three`, no gameplay: it converts one number into another.
//
// ⚠ THE DIRECTION OF THE TEMPO. `pitchSim` integrates at TRUE physical time and
// cannot see `PITCH_TEMPO`; the playback here is
//
//     trueS = wallElapsedS × PITCH_TEMPO           (0.45 → slow motion)
//
// so a 0.41 s pitch takes 0.91 s of wall clock, and `swing()` is called with the
// TRUE time. It is a MULTIPLY. Dividing instead (wall / 0.45) would hand the sim
// 2.02 s at the moment the ball reached the plate — 4.9× past the crossing,
// which is 1600 ms of "late" against a ±26.4 ms contact window, i.e. every
// single swing a whiff and the bug looking like broken collision physics.
// `StadiumGL`'s own live-playback branch multiplies for the same reason.

import { PITCH_TEMPO } from '../../../lib/baseball/tuning';

/** HUD poll period, ms. The charter's number: a HUD does not render per frame. */
export const POLL_MS = 120;

/**
 * Wall-clock beat between asking for a pitch and the ball leaving the hand, ms.
 *
 * ⚠ FEEL KNOB — and it is also load-bearing. `flight` reaches `StadiumGL` on the
 * next React commit, so a clock that started at `performance.now()` would ask
 * the renderer for a time on a track it had not been given yet. The lead makes
 * the play clock NEGATIVE until release (the ball is simply not drawn), which
 * covers the commit with room to spare and reads as a wind-up.
 */
export const PITCH_LEAD_MS = 380;

/** How long the result sits on screen before the next aim, ms. FEEL KNOB. */
export const RESULT_HOLD_MS = 1500;

/** Extra true-physical seconds a late tap is still accepted for. FEEL KNOB. */
export const SWING_TAIL_S = 0.06;

/**
 * Shortest hang time that earns the pull-back to the deck camera, s. FEEL KNOB.
 *
 * ⚠ IT EXISTS BECAUSE THE EASE HAS A LENGTH. `stadium/camera.ts` takes
 * `CAMERA_EASE_S = 0.8` to travel from the box to the upper deck, so on a ball
 * hanging 1.0 s the camera arrives as the ball lands and immediately reverses —
 * a swoop out and straight back, spent on a routine grounder the batter camera
 * already contains (it lands inside the infield arc, 128–156 ft out, dead
 * ahead). A presentation decision, which is the HUD's to make: no sim, score or
 * fielding number reads it. `DerbyGame.camera.test.tsx` asserts both sides.
 */
export const FOLLOW_MIN_HANG_S = 1.2;

/** The play clock: a WALL ms origin, and the crossing it changes rate at. */
export interface PlayClock {
  t0: number;
  endS: number;
  plateT: number;
  /** Wall seconds from `t0` to the plate crossing — DERIVED, see `trueTimeOf`. */
  wallAtPlate: number;
}

/** Build one from a served pitch's crossing time. The one place `/ PITCH_TEMPO` appears. */
export function playClockFor(t0: number, plateT: number): PlayClock {
  return { t0, endS: plateT + SWING_TAIL_S, plateT, wallAtPlate: plateT / PITCH_TEMPO };
}

/**
 * Wall ms since `t0` → TRUE PHYSICAL seconds since release.
 *
 * ⚠ THE PLAYBACK RATE IS PIECEWISE, AND `dt` IS STILL NEVER TOUCHED. Before the
 * plate the track is played at `PITCH_TEMPO`, which is what makes a 0.41 s pitch
 * reactable at all. AFTER it the batted ball plays at REAL TIME, because a fly
 * ball hangs 5.7 s and nothing about that needs slowing down — at 0.45 the same
 * home run takes 12.7 s of wall clock and a 24-pitch session becomes five
 * minutes of watching a dot. Measured on `derbySim.test.ts`'s own numbers
 * (hang 5.66 s on the 105 mph reference fly); real time makes it 6.4 s of play
 * and the session about three minutes.
 *
 * This is a RENDER-LAYER clock and nothing else. Both branches ask the sim's
 * precomputed track for a TRUE physical instant, so no integration step, no
 * gravity/aero weighting and no break, exit-velocity or carry number moves by a
 * single digit. `PITCH_TEMPO` still cannot reach `lib/baseball` — a source guard
 * enforces it — and `swing()` is still handed the output of THIS function.
 */
export function trueTimeOf(c: PlayClock, wallS: number): number {
  const t = wallS <= c.wallAtPlate ? wallS * PITCH_TEMPO : c.plateT + (wallS - c.wallAtPlate);
  return Math.min(c.endS, t);
}
