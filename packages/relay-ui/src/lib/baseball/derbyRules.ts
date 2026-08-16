// Home Run Derby — the RULES: the format, the payout, the serve mix and the
// swing-mapping constants. Data and pure functions only; no state, no loop.
//
// Split out of `derbySim.ts` at the 500-line cap — EXTRACTION, NOT A RAISED CAP,
// the same way `pitches.ts` is split from `pitchSim.ts` and `bat.ts` from
// `batSim.ts`. The seam is the same one those two use: the DATA and its
// derivations on this side, the loop that consumes them on the other. Every
// constant here carries its category (fixed / derived / calibrated / feel knob),
// and `validate*` turns bad data into a test failure rather than a bad game.

import { mulberry32 } from '../golf/wind';
import { BAT_LENGTH_IN, M_PER_FT, SWEET_SPOT_M } from './bat';
import { contactGeometry } from './batSim';
import { HARBOURFRONT } from './parks';
import type { Park } from './parks';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { MAX_POINTS_PER_ROUND, MAX_ROUNDS } from './tuning';
import { IN_TO_FT } from './units';
import { PLATE_WIDTH_FT, armSideX } from './zone';
import type { Handedness } from './zone';

/** How one swing ended. `resolveFence`'s five-way answer, folded to the format. */
export type DerbyOutcome = 'homeRun' | 'inPlay' | 'foul' | 'whiff' | 'take';

/** Where the loop is. `inFlight` is the only phase in which a swing is legal. */
export type DerbyPhase = 'ready' | 'inFlight' | 'done';

// ---------------------------------------------------------------------------
// The seeded stream — one PRNG, and it is SNAPSHOTTABLE
// ---------------------------------------------------------------------------
//
// `mulberry32` returns a closure over a hidden counter, which cannot be put in
// a snapshot. But its state after k calls is exactly `seed + k·STEP`, so the
// stream can be carried as a plain number instead. That is what makes
// `snapshot()` total: there is no hidden generator state anywhere in this file.
//
// ⚠ STEP IS AN UPSTREAM COUPLING and is pinned by a TRIPWIRE test that compares
// six draws of this against six calls of golf's own generator. If `wind.ts`
// changes its mixer, that test fails here rather than silently re-shaping every
// derby session.
const MULBERRY_STEP = 0x6d2b79f5;

/** One draw plus the next stream state. Pure — no hidden counter. */
export function derbyDraw(state: number): { value: number; next: number } {
  return { value: mulberry32(state)(), next: (state + MULBERRY_STEP) >>> 0 };
}

// ---------------------------------------------------------------------------
// The format — and the clamp arithmetic that fixes it
// ---------------------------------------------------------------------------
//
// ⚠ THE SERVER CLAMP IS `rounds × MAX_POINTS_PER_ROUND`, NOT `MAX_ROUNDS × …`.
// `packages/relay-worker/src/games.ts` rejects (400, never truncates) a score
// above `rounds × 2000` for the rounds actually submitted, and rejects `rounds`
// outside 1..MAX_ROUNDS. So `tuning.MAX_SUBMITTABLE_SCORE` (16000) describes the
// EIGHT-round case only and is the wrong thing for a 3-round derby to check
// itself against. The invariant this file holds is the real one: **2000 points
// per derby round**, at every point in a session, partial rounds included.
//
// One `rounds` unit is ONE DERBY ROUND, never one swing. Three rounds is well
// inside MAX_ROUNDS = 8, so no `MAX_COURSE_ROUNDS`-style escape hatch is needed.

/**
 * Rounds in a derby. FEEL KNOB, sized by session length: 3 × 8 = 24 pitches at
 * roughly 6–7 s of served pitch + flight + reset is a 2.5–3 min session, which
 * is the brief. It must stay ≤ MAX_ROUNDS (asserted).
 */
export const DERBY_ROUNDS = 3;

/**
 * Pitches in a round. FEEL KNOB. A FIXED pitch count rather than an out limit,
 * deliberately: the round then has a DETERMINISTIC length, so a bad round does
 * not end in 20 s and a good one does not run five minutes. Outs are still
 * counted and displayed — they are a statistic here, not the round's clock.
 */
export const PITCHES_PER_ROUND = 8;

/**
 * The per-swing payout ceiling. DERIVED, and it is what makes the round clamp
 * STRUCTURAL rather than checked: `PITCHES_PER_ROUND × this ≡
 * MAX_POINTS_PER_ROUND` exactly, so no reachable sequence of swings can put a
 * round over 2000 regardless of what the distance term does.
 */
export const MAX_POINTS_PER_PITCH = MAX_POINTS_PER_ROUND / PITCHES_PER_ROUND;

/** Points for clearing the wall at all. FEEL KNOB. */
export const HR_BASE_POINTS = 100;

/**
 * Where the distance bonus starts, ft. FEEL KNOB pinned to park data: the
 * shortest home run this game can produce is down a foul line, and the shortest
 * sampled fence in `PARKS` is 328 ft, so a datum at 350 pays every home run
 * something and pays a wall-scraper almost nothing.
 */
export const DISTANCE_DATUM_FT = 350;

/** Points per foot of projected carry past the datum. FEEL KNOB. */
export const POINTS_PER_FT = 1;

/**
 * Points for one home run of `carryFt` PROJECTED carry (Statcast's convention —
 * where the ball would have landed, which is what `BattedFlight.carryFt` is
 * because the sim flies it to z = 0 unobstructed).
 *
 * The `Math.min` is a guard, not a gameplay ceiling: it binds above 500 ft and
 * this model's hardest reachable swing carries ~440. The test measures that
 * headroom so the day a card modulator eats it is a test failure.
 *
 * `cap` is a parameter rather than the constant so that a config which overrides
 * `pitchesPerRound` re-derives its own cap and the round invariant survives it.
 */
export function homeRunPoints(carryFt: number, cap = MAX_POINTS_PER_PITCH): number {
  const bonus = Math.max(0, carryFt - DISTANCE_DATUM_FT) * POINTS_PER_FT;
  return Math.min(cap, Math.round(HR_BASE_POINTS + bonus));
}

// ---------------------------------------------------------------------------
// The serve — CONTENT AS DATA
// ---------------------------------------------------------------------------

/**
 * What a derby server throws. FEEL KNOB (the mix), and it is DATA: all eight
 * published rows stay reachable so `pitches.ts` remains the one arsenal and a
 * new pitch is a row there, not a branch here. Fastball-heavy because the
 * pitcher in this format is cooperating.
 */
export const DERBY_MIX: readonly { id: PitchId; weight: number }[] = [
  { id: 'ff', weight: 0.34 },
  { id: 'si', weight: 0.18 },
  { id: 'ch', weight: 0.14 },
  { id: 'fc', weight: 0.1 },
  { id: 'sl', weight: 0.08 },
  { id: 'cu', weight: 0.06 },
  { id: 'st', weight: 0.05 },
  { id: 'fs', weight: 0.05 },
];

/**
 * How far off dead centre a served pitch may be located, in reticle units
 * (1.0 = the rule-zone edge). FEEL KNOB: 0.45 keeps every serve a strike while
 * making no two the same. It is sized AGAINST `RETICLE_FULL_MISS_IN` below — the
 * pair has a joint property the test measures, so neither moves alone.
 */
export const SERVE_SPREAD = 0.45;

/** Bad mix data is a TEST FAILURE, not a runtime surprise. */
export function validateDerbyMix(mix = DERBY_MIX): string[] {
  const bad: string[] = [];
  const total = mix.reduce((s, m) => s + m.weight, 0);
  if (Math.abs(total - 1) > 1e-9) bad.push(`weights sum to ${total}, not 1`);
  for (const m of mix) {
    if (!(m.weight > 0)) bad.push(`${m.id}: weight ${m.weight} is not positive`);
    if (!PITCHES.some((p) => p.id === m.id)) bad.push(`${m.id}: not in PITCHES`);
  }
  for (const p of PITCHES) {
    if (!mix.some((m) => m.id === p.id)) bad.push(`${p.id}: in PITCHES but not in the mix`);
  }
  if (new Set(mix.map((m) => m.id)).size !== mix.length) bad.push('duplicate pitch id');
  return bad;
}

// ---------------------------------------------------------------------------
// The swing — the reticle/tap mapping, argued
// ---------------------------------------------------------------------------

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
 * The fraction of an aim miss that reaches the swing. `rMissFt` is the reticle's
 * distance from where the pitch actually crossed; the return value multiplies
 * BOTH components of that miss, so the geometry beyond the knob is untouched.
 */
export function reticleResidual(rMissFt: number): number {
  if (!(rMissFt > 0)) return 0;
  return Math.min(1, (rMissFt / RETICLE_FULL_MISS_FT) ** RETICLE_FADE_POWER);
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

/** The format's own invariants. Asserted as a test, never at runtime. */
export function validateDerbyFormat(rounds = DERBY_ROUNDS, perRound = PITCHES_PER_ROUND): string[] {
  const bad: string[] = [];
  if (!Number.isInteger(rounds) || rounds < 1) bad.push(`rounds ${rounds} is not ≥ 1`);
  if (rounds > MAX_ROUNDS) bad.push(`rounds ${rounds} exceeds the worker's MAX_ROUNDS ${MAX_ROUNDS}`);
  if (!Number.isInteger(perRound) || perRound < 1) bad.push(`pitchesPerRound ${perRound} < 1`);
  const perPitch = MAX_POINTS_PER_ROUND / perRound;
  // ⚠ `perPitch * perRound === MAX_POINTS_PER_ROUND` CANNOT FIRE, and that is
  // not a style point: (2000/3)*3 is exactly 2000 in IEEE-754, so 3, 6, 7 and 9
  // pitches all passed this check while producing a FRACTIONAL per-pitch cap —
  // and `packages/relay-worker/src/games.ts` requires `Number.isInteger` on what
  // it is handed. Test the thing the worker tests.
  if (!Number.isInteger(perPitch)) {
    bad.push(
      `${perRound} pitches do not divide MAX_POINTS_PER_ROUND ${MAX_POINTS_PER_ROUND} ` +
        `(per-pitch cap ${perPitch})`,
    );
  }
  if (homeRunPoints(Number.MAX_SAFE_INTEGER, perPitch) > perPitch) {
    bad.push('a swing can exceed the per-pitch cap');
  }
  return bad;
}

// ---------------------------------------------------------------------------
// The session's configuration — defaults live with the rules, not the loop
// ---------------------------------------------------------------------------

export interface DerbyConfig {
  seed: number;
  park?: Park;
  /** Roof shut by default: exactly-zero wind and pinned air ⇒ ranked-safe. */
  roofClosed?: boolean;
  batterHand?: Handedness;
  pitcherHand?: Handedness;
  rounds?: number;
  pitchesPerRound?: number;
  /** Bat-speed modulator, mph — the hook `cards.ts` will drive. */
  batSpeedMph?: number;
}

/** The same thing with every default applied. Immutable for a session. */
export interface ResolvedConfig {
  seed: number;
  park: Park;
  roofClosed: boolean;
  batterHand: Handedness;
  pitcherHand: Handedness;
  rounds: number;
  pitchesPerRound: number;
  batSpeedMph: number | undefined;
}

/**
 * ⚠ IT VALIDATES, AND IT USED NOT TO. `validateDerbyFormat` existed and was
 * never called on this path, so `new DerbySim({ rounds: -5 })` was accepted and
 * `getState()` then reported `maxScore = −10000` — because `clamp(v, 1, -5)`
 * returns the HIGH bound when `lo > hi`, so `roundsPlayed` came back as −5. A
 * config is player-adjacent input (a card, a URL, a saved session), so it is
 * checked at the one place it enters the sim, and it THROWS rather than
 * silently repairing: a derby that quietly played a different format than the
 * one it was asked for is worse than one that refused.
 */
export function resolveDerbyConfig(c: DerbyConfig): ResolvedConfig {
  const rounds = c.rounds ?? DERBY_ROUNDS;
  const pitchesPerRound = c.pitchesPerRound ?? PITCHES_PER_ROUND;
  const bad = validateDerbyFormat(rounds, pitchesPerRound);
  if (!Number.isFinite(c.seed)) bad.push(`seed ${c.seed} is not finite`);
  if (c.batSpeedMph !== undefined && !(c.batSpeedMph > 0)) {
    bad.push(`batSpeedMph ${c.batSpeedMph} is not positive`);
  }
  if (bad.length) throw new Error(`invalid derby config: ${bad.join('; ')}`);
  return {
    seed: c.seed >>> 0,
    park: c.park ?? HARBOURFRONT,
    roofClosed: c.roofClosed ?? true,
    batterHand: c.batterHand ?? 'R',
    pitcherHand: c.pitcherHand ?? 'R',
    rounds,
    pitchesPerRound,
    batSpeedMph: c.batSpeedMph,
  };
}
