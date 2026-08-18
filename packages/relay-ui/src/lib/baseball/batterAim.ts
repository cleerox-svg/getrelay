// THE BATTER'S AIM — the reticle/tap mapping, and the ONE implementation of it.
//
// Two player inputs (a reticle placed between pitches, a single tap during the
// flight) become the FOUR geometric axes `batSim.Swing` already has, plus the
// derived "is the ball actually over the bat" verdict. Nothing in this file is a
// channel invented for a game mode; every one of them is a field the collision
// solve has always taken.
//
// ⚠ IT IS SHARED BY THE DERBY AND THE DUEL, AND THAT IS WHY IT IS ITS OWN FILE.
// It began inside `derbyRules.ts`, and when `duelSim.ts` landed the choice was
// to import the derby's format module into the duel, or to copy nine lines of
// mapping into a second loop. Both are the failure the charter names — "one
// implementation per concept … one core, many modulators, never a fork per
// case" — so the mapping moved UP to a module that knows about the BAT and the
// ZONE and about no game mode at all. `derbyRules.ts` keeps the derby's format,
// its serve mix and its payout; the duel keeps its own. They share this.
//
// ⚠ AND THE MOVE WAS MECHANICAL. Not one number, sign or expression changed —
// the derby's ~180 golden assertions (the timing sweep, the reticle sweep, the
// aim-vs-home-run table, the reference swing's two published bands) are the
// regression check on that, and they were run before and after.
//
// No three, no Math.random, no wall clock, no state.

import { LOC_DISTANCE_IN, M_PER_FT, SWEET_SPOT_M } from './bat';
import { contactGeometry } from './batSim';
import type { Swing } from './batSim';
import { BAT_HANDLE_LIMIT_M, BAT_TIP_M } from './contactWindow';
import { FT_TO_IN, IN_TO_FT } from './units';
import { PLATE_WIDTH_FT, RULE_ZONE, armSideX } from './zone';
import type { Handedness } from './zone';

/**
 * The undercut a WELL-AIMED swing carries, in. CALIBRATED — this is `bat.ts`'s
 * reference undercut, the swing parameter chosen so the collision meets BOTH
 * published bands at once (LA 25.0–25.9°, backspin 2350–2500 rpm) at the derived
 * `e_T = 0`. It is duplicated here rather than imported because `bat.ts` owns
 * the bat, not the swing; `derbySim.test.ts` re-derives both bands from it so a
 * drift is a test failure.
 */
export const SWING_UNDERCUT_IN = 0.56;

/**
 * How far outside the rule zone the reticle may be placed, ft. FEEL KNOB —
 * the batter's plate coverage. It only bounds a HUD drag; the contact test
 * below is what actually decides anything.
 */
export const RETICLE_REACH_FT = 0.5;

/**
 * The reticle's ASSIST SHOULDER — two radii, in. The charter's named feel knob,
 * and the one place this game is an arcade game rather than a simulation.
 *
 * ⚠ IT IS LOAD-BEARING AND HERE IS THE MEASUREMENT THAT MAKES IT SO. The
 * collision's line-of-centres distance is only 2.70 in, so launch angle sweeps
 * the whole useful 0–50° range over about two inches of undercut: aiming 1.2 in
 * high launches at −8.7°, 1.2 in low at +69.5°. Meanwhile the reticle is placed
 * BEFORE the pitch — it is a guess at a location that varies by ±4.9 in of
 * height. Asking a player to guess to the inch is not a difficulty setting, it
 * is a lottery, so near the centre the batter is taken to adjust his hands and
 * contact is made at the reference undercut, and the residual only grows into a
 * real geometric miss as the aim gets worse.
 *
 * ⚠ SUPERSEDES A HARD DISC OF RADIUS 4 in, AND THE REASON IS MEASURED. That disc
 * set `k = 0` IDENTICALLY inside itself, so five aim rows at 0.0 / 2.4 / 4.0 in
 * returned BYTE-IDENTICAL results (411.0 ft of carry, every one) — placement did
 * not matter at all — and then barrel rate fell 100 % → 8.3 % between 4.0 and
 * 5.4 in. That is a two-state mechanic dressed as a continuous one: the intent
 * above is fully served without it, by an assist that FADES.
 *
 *   • `RETICLE_FULL_MISS_IN` — CALIBRATED, against the property this pair has
 *     always had to hold: a CENTRED reticle must still make contact with the
 *     worst serve `SERVE_SPREAD` can produce. That corner sits 6.185 in away
 *     with 4.86 in of it vertical, and the overlap test allows 2.14 in of extra
 *     undercut, so the residual there must stay under k = 0.440. 8 in puts it at
 *     0.357 — within 0.005 of the 0.353 the old 4 in disc gave, so the reach
 *     margin is preserved to the third decimal and the change is genuinely a
 *     REDISTRIBUTION rather than a difficulty increase. `derbySim.test.ts`
 *     measures and prints that margin; move `SERVE_SPREAD` or this and it is the
 *     assertion that fails.
 *   • `RETICLE_FADE_POWER` — FEEL KNOB, and the one number here that is taste.
 *     It sets how fast the assist fades. Measured at 4, on a pure vertical miss:
 *     2.4 in of aim error costs 0.019 in of undercut (0.6° of launch angle,
 *     under a foot of carry — forgiving, as intended), 4.0 in costs 0.25 in
 *     (8°, and the barrel survives at about half the approach angles), and past
 *     8 in there is no assist at all.
 *
 * ⚠ NOT A FLAT INNER DISC, AND THAT IS THE WHOLE POINT. The obvious two-radius
 * form — `smoothstep(R_inner, R_outer, r) · (1 − R_inner/r)` — is EXACTLY ZERO
 * for r ≤ R_inner, so it keeps a dead zone and dead centre stays merely
 * tied-best rather than best. Any law with a flat middle has that defect by
 * construction, however small the flat is, so this one has no flat: `k > 0` for
 * every `r > 0`, strictly monotone, and `derbySim.test.ts` asserts both with
 * strict inequalities.
 *
 * ⚠ AND THE FAR FIELD IS UNTOUCHED PHYSICS, more literally than the disc ever
 * managed: beyond `RETICLE_FULL_MISS_IN` the residual is 1, i.e. the WHOLE miss
 * reaches the swing. The assist is gone, not scaled and not measured from a rim.
 */
export const RETICLE_FULL_MISS_IN = 8;
export const RETICLE_FULL_MISS_FT = RETICLE_FULL_MISS_IN * IN_TO_FT;
export const RETICLE_FADE_POWER = 4;

/**
 * The shoulder's two numbers, as a MODULATOR rather than a constant.
 *
 * ⚠ THE ASSIST IS PER-MODE, AND THE MEASUREMENT THAT FORCED IT IS THE DUEL'S.
 * The pair above is calibrated for a HOME RUN DERBY, where a home run is the
 * point; `DUEL_ASSIST` in `duelRules.ts` carries a different pair, calibrated
 * against a different stated property, and the argument is on that constant.
 * This is ONE implementation with a modulator, not a fork: the law, the two
 * radii, the strict monotonicity and the "no flat middle" property are all still
 * written once, here, and both modes go through this function.
 */
export interface ReticleAssist {
  fullMissIn: number;
  fadePower: number;
}

/** The derby's pair — and the DEFAULT, so no existing call site moved. */
export const DERBY_ASSIST: ReticleAssist = {
  fullMissIn: RETICLE_FULL_MISS_IN,
  fadePower: RETICLE_FADE_POWER,
};

/**
 * The fraction of an aim miss that reaches the swing. `rMissFt` is the reticle's
 * distance from where the pitch actually crossed; the return value multiplies
 * BOTH components of that miss, so the geometry beyond the knob is untouched.
 */
export function reticleResidual(rMissFt: number, assist: ReticleAssist = DERBY_ASSIST): number {
  if (!(rMissFt > 0)) return 0;
  return Math.min(1, (rMissFt / (assist.fullMissIn * IN_TO_FT)) ** assist.fadePower);
}

/**
 * The aim error, in inches, at which a well-aimed swing's undercut has moved by
 * `deltaIn` — the inverse of the shoulder. DERIVED by bisection on the one
 * implementation above rather than by re-solving `a·(a/F)^p = δ` in closed form,
 * for the reason `contactWindowS` gives: a closed form copied out of the same
 * derivation drifts from it, an inversion cannot.
 *
 * Two `deltaIn` are load-bearing and both are asserted:
 *  • `LOC_DISTANCE_IN − SWING_UNDERCUT_IN` (2.14 in) is the CONTACT EDGE — past
 *    it there is no bat under the ball.
 *  • a tenth of an inch (~0.35° of launch angle, invisible) is the REFERENCE
 *    PLATEAU — inside it every swing is the same calibrated 411 ft swing.
 * Their ratio is what each mode's assist is chosen on.
 */
export function aimErrorForUndercutIn(deltaIn: number, assist: ReticleAssist = DERBY_ASSIST): number {
  const moved = (aIn: number) => aIn * reticleResidual(aIn * IN_TO_FT, assist);
  let lo = 0;
  let hi = 1;
  while (hi < 1024 && moved(hi) < deltaIn) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (moved(mid) < deltaIn) lo = mid;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// PULL / OPPO INTENT — the second half of the reticle, and the fix for the
// home-run trough at perfect timing
// ---------------------------------------------------------------------------
//
// ⚠ THE DEFECT THIS EXISTS FOR, MEASURED. With spray a function of TIMING ALONE,
// timing set both the exit velocity and the direction, so the player could not
// trade one against the other — and the two wanted opposite things. Perfect
// timing sprayed near dead centre, which is the DEEPEST part of the park
// (400 ft + a 10 ft wall), while a 10–15 ms miss sprayed into a 375 ft alley.
// The timing sweep therefore read: 100 % home runs at ∓10–15 ms and 54.2 % at
// 0 ms, with 0 ms simultaneously holding the highest exit velocity, the highest
// carry and a 100 % barrel rate. A HUD would have printed "PERFECT" over the
// worst outcome on the board.
//
// ⚠ AND IT IS NOT FIXED BY SCORING CARRY WITH A HOME-RUN BONUS. That was the
// other candidate and the arithmetic rules it out: the measured carry gap
// between 0 ms and ∓10 ms is 6.0 ft while the home-run-rate gap is 0.458, so
// E[points] at 0 ms only overtakes ∓10 ms once the home-run bonus falls below
// 6.0 / 0.458 = 13 points. A 13-point home run in a home run derby is not a
// payout curve, it is an admission. The trough is a CONTROL problem, so the fix
// is a control.
//
// ⚠ NO NEW PHYSICS, AND NO FOURTH CHANNEL. `batSim.swingContact` has always
// taken `horizontalOffsetIn` — the line-of-centres tilt ACROSS the swing plane,
// governed by the same `asin(offset / LOC_DISTANCE_IN)` law as the undercut —
// and `derbySim` simply never set it. It is what "hitting the inside of the
// ball" is, it is orthogonal to `contactGeometry` (so it moves spray without
// moving where on the bat contact lands), and every consequence falls out of the
// one collision solve, sidespin included. Measured on the reference swing:
//
//     offset   spray     EV      carry    fence at that bearing
//      0.00     0.0°   101.60   416.3 ft   400 ft   ← dead centre, deepest
//      0.20    -6.2°   101.39   411.2 ft   388 ft
//      0.30    -9.3°   101.12   404.9 ft   379 ft
//      0.50   -15.5°   100.25   386.3 ft   361 ft
//      0.70   -21.9°    98.93   364.2 ft   342 ft
//      0.90   -28.5°    97.14   342.0 ft   hooks foul (4411 rpm of sidespin)
//
// So pulling costs real carry and buys a shorter fence: a TRADE, made with a
// different input from the one that sets exit velocity. That is the whole fix.

/**
 * Line-of-centres tilt at FULL intent, in. FEEL KNOB, sized off the sweep above
 * and against `SERVE_SPREAD`, the way `RETICLE_OUTER_IN` is.
 *
 * Full intent is the painted edge of the plate, and a serve only reaches
 * `u = ±0.45`, so simply TRACKING the pitch — placing the reticle where the ball
 * is, which is the naive correct play — spends at most ±0.405 of it: an inside
 * pitch is pulled toward the 375 ft alley and an outside one goes the other way,
 * which is the published inside/outside spray relationship arriving for free
 * rather than as a rule. Committing further than the pitch is where it starts to
 * cost, and at 0.9 in the sidespin hooks the ball foul — so over-pulling is a
 * foul ball, which is what over-pulling is.
 */
export const PULL_INTENT_MAX_IN = 0.9;

/**
 * The batter's declared pull/oppo intent from the reticle's ABSOLUTE lateral
 * placement, as a line-of-centres offset in inches for `Swing`.
 *
 * The reticle is placed BEFORE the pitch and under no time pressure, so where it
 * sits in the zone is a PLAN, not a reaction: a batter looking on the inner half
 * is looking to get the barrel out front and pull, one looking away is looking
 * to let it travel. Normalised on the RULE zone's half-width, so full intent is
 * the painted edge of the plate, and mirrored through `armSideX` exactly once —
 * a RHB's inner half is the third-base side, so the same placement gives a
 * left-handed batter the mirrored spray with no second code path.
 *
 * ⚠ INTENT IS ONLY FREE WHEN THE PITCH IS ACTUALLY THERE, and that is the
 * mechanic rather than a limitation: declaring a big pull on a pitch that comes
 * back over the middle leaves a large aim miss, which `reticleResidual` charges
 * for. You can only pull an inside pitch.
 */
export function pullIntentOffsetIn(reticleX: number, hand: Handedness): number {
  const u = Math.max(-1, Math.min(1, reticleX / (PLATE_WIDTH_FT / 2)));
  const off = armSideX(hand) * u * PULL_INTENT_MAX_IN;
  // ⚠ NORMALISE THE SIGNED ZERO. A centred reticle for a RHB is `−1 × 0`, which
  // is −0: it compares equal under `===` but NOT under `Object.is`, and it
  // JSON-round-trips to `0`. Both of those matter here — the snapshot guard
  // compares stringified sims, and `-0` in a swing record would make a restored
  // session differ from the one it restored.
  return off === 0 ? 0 : off;
}

// ---------------------------------------------------------------------------
// The mapping itself
// ---------------------------------------------------------------------------

/** Where the batter says he is looking. REPORT ft. */
export interface AimInput {
  /** The BATTER's handedness. */
  hand: Handedness;
  /** Where the pitch ACTUALLY crossed, ft, and how fast it was going, ft/s. */
  plateX: number;
  plateH: number;
  plateSpeedFps: number;
  /** Where he was looking, ft — already clamped by `clampReticle`. */
  reticleX: number;
  reticleH: number;
  /** + = LATE, TRUE physical s against the plate crossing. */
  timingErrorS: number;
  /** Bat-speed modulator, mph. `undefined` means the published swing. */
  batSpeedMph?: number;
  /** The mode's shoulder. Defaults to the derby's — see `ReticleAssist`. */
  assist?: ReticleAssist;
}

export interface AimedSwing {
  /** The `Swing` to hand `batSim.swingContact`. */
  swing: Swing;
  undercutIn: number;
  /** + = the pitch was further from the batter than the reticle, in. */
  lateralIn: number;
  /** Where on the bat it would land, m from the knob. */
  contactZM: number;
  /** Did the ball fit on the bat at all? False ⇒ a whiff, and no collision. */
  onBat: boolean;
}

/**
 * The reticle/tap → `Swing` mapping. Two player inputs, FOUR geometric axes, and
 * the geometry decides which is which:
 *
 *  • VERTICAL (reticle h). The bat's centre line passes `undercutIn` below the
 *    ball's. A well-aimed swing carries `SWING_UNDERCUT_IN`; aiming above the
 *    pitch adds to it, below subtracts. Contact needs the two circles to
 *    overlap, `|offset| <= LOC_DISTANCE_IN` = R_ball + R_bat = 2.70 in — a
 *    DERIVED whiff test with no knob in it.
 *  • ALONG THE BAT (reticle x). At contact the bat is a rod across the plate, so
 *    a lateral aim error moves contact up or down the barrel: `aimZM`. The sign
 *    is the batter's, and it is `zone.armSideX`'s mirror read ONCE — a RHB
 *    stands on the third-base side, so a pitch further out is contact further
 *    toward the tip.
 *  • DEPTH (the tap). `timingErrorS` rotates the bat and `contactGeometry`
 *    returns where on the bat that lands. Because `R_c = d/cos θ_c > d` for a
 *    miss in EITHER direction, ANY mistiming drives contact toward the tip — so
 *    the SAME "is the ball still over the bat" test closes the timing window
 *    too, at roughly ±26 ms. The window is DERIVED from the bat's length; it is
 *    not a knob, and it is symmetric early/late exactly as stage 3 asserted the
 *    collision is.
 *  • ACROSS THE BALL (reticle x, ABSOLUTE). The reticle's placement in the zone
 *    is a declared PULL/OPPO INTENT and becomes `horizontalOffsetIn` — the
 *    line-of-centres tilt across the swing plane. It is the ONLY input that moves
 *    spray without moving where on the bat contact lands, which is what lets a
 *    player trade direction against exit velocity. `pullIntentOffsetIn` above
 *    carries the argument, the measured sweep and the trough it exists to close.
 *
 * ⚠ RETICLE x IS READ TWICE, AND THE TWO READINGS ARE DIFFERENT QUANTITIES. Its
 * RESIDUAL against where the pitch actually crossed is a MISS, paid for along
 * the bat; its ABSOLUTE position is a PLAN, made before the pitch, and buys
 * spray. That is the before and after of one placement, not one input doing two
 * jobs — and it is what makes intent free only when the guess was right.
 *
 * ⚠ THE OVERLAP TEST IS THE RESULTANT, NOT THE VERTICAL ALONE. `undercutIn` and
 * `horizontalOffsetIn` are the two components of ONE line-of-centres offset in
 * the plane across the bat — `swingContact` tilts n̂ by
 * `asin(component / LOC_DISTANCE_IN)` on each — so what has to stay inside
 * R_ball + R_bat is their HYPOTENUSE. Testing only the vertical would let a
 * full-intent swing on a badly missed pitch make contact through the corner of a
 * square it has no business being in.
 *
 * ⚠ THE MODEL HAS NO JAMMING, and this mapping inherits it. Contact inside the
 * sweet spot RAISES exit velocity (BASEBALL.md § "The collision"), so an aim
 * error toward the hands is rewarded until it runs off the handle bound. The
 * benches measure and print the asymmetry rather than papering over it; the fix
 * is a measured `e(z)`, not a knob here.
 *
 * ⚠ CONTACT IS TAKEN AT THE PLATE CROSSING STATE, not at the contact instant's
 * interpolated height. Sampling the ball lower on a late swing is physically
 * real (1.46 ft deeper at 25 ms ⇒ ~1.4 in of extra undercut) but it would break
 * the early/late exit-velocity symmetry stage 3 proved and asserts.
 */
export function aimSwing(inp: AimInput): AimedSwing {
  // The reticle's aim MISS, faded through the two-radius shoulder: near the
  // centre the batter adjusts and the swing carries its reference undercut, and
  // the residual grows smoothly into the real geometric miss, so the geometry
  // beyond the knob is untouched physics. See `reticleResidual`.
  const dx = inp.plateX - inp.reticleX;
  const dh = inp.plateH - inp.reticleH;
  const k = reticleResidual(Math.hypot(dx, dh), inp.assist ?? DERBY_ASSIST);
  const undercutIn = SWING_UNDERCUT_IN + dh * k * FT_TO_IN;
  // The batter stands on his own arm side of the plate, so "away from the
  // batter" is the opposite sign. One mirror, read from zone.ts.
  const away = -armSideX(inp.hand);
  const lateralIn = away * dx * k * FT_TO_IN;
  const horizontalOffsetIn = pullIntentOffsetIn(inp.reticleX, inp.hand);
  const swing: Swing = {
    hand: inp.hand,
    timingErrorS: inp.timingErrorS,
    undercutIn,
    horizontalOffsetIn,
    aimZM: SWEET_SPOT_M + lateralIn * IN_TO_FT * M_PER_FT,
    batSpeedMph: inp.batSpeedMph,
  };
  const geom = contactGeometry(inp.plateSpeedFps, swing);
  const missIn = Math.hypot(undercutIn, horizontalOffsetIn);
  const onBat =
    Number.isFinite(geom.contactZM) &&
    geom.contactZM <= BAT_TIP_M &&
    geom.contactZM >= BAT_HANDLE_LIMIT_M &&
    missIn <= LOC_DISTANCE_IN;
  return { swing, undercutIn, lateralIn, contactZM: geom.contactZM, onBat };
}

/**
 * Clamp a reticle placement to the batter's plate coverage. The SIM clamps, so
 * every reader of `reticleX`/`reticleH` sees a legal value and a HUD that drags
 * past the edge is corrected by the one authority rather than by itself.
 */
export function clampReticle(x: number, h: number): { x: number; h: number } {
  if (!Number.isFinite(x) || !Number.isFinite(h)) throw new Error('reticle must be finite');
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    x: c(x, RULE_ZONE.left - RETICLE_REACH_FT, RULE_ZONE.right + RETICLE_REACH_FT),
    h: c(h, RULE_ZONE.bottom - RETICLE_REACH_FT, RULE_ZONE.top + RETICLE_REACH_FT),
  };
}
