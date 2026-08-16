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
import { HARBOURFRONT } from './parks';
import type { Park } from './parks';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { MAX_POINTS_PER_ROUND, MAX_ROUNDS } from './tuning';
import { IN_TO_FT } from './units';
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
 * making no two the same. It is sized AGAINST `RETICLE_RADIUS_IN` below — the
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
 * How far outside the rule zone the reticle may be placed, ft. FEEL KNOB —
 * the batter's plate coverage. It only bounds a HUD drag; the contact test
 * below is what actually decides anything.
 */
export const RETICLE_REACH_FT = 0.5;

/**
 * The reticle's RADIUS, in — the charter's named feel knob, and the one place
 * this game is an arcade game rather than a simulation.
 *
 * ⚠ IT IS LOAD-BEARING AND HERE IS THE MEASUREMENT THAT MAKES IT SO. The
 * collision's line-of-centres distance is only 2.70 in, so launch angle sweeps
 * the whole useful 0–50° range over about two inches of undercut: aiming 1.2 in
 * high launches at −8.7°, 1.2 in low at +69.5°. Meanwhile the reticle is placed
 * BEFORE the pitch — it is a guess at a location that varies by ±4.9 in of
 * height. Asking a player to guess to the inch is not a difficulty setting, it
 * is a lottery, so inside this radius the batter is taken to adjust his hands
 * and contact is made at the reference undercut; outside it the miss is measured
 * from the RIM, not the centre. Skill still pays continuously — the residual is
 * a real geometric miss the moment the rim is cleared.
 *
 * 4 in against `SERVE_SPREAD = 0.45` leaves a CENTRED reticle able to make
 * contact with every serve the mix can produce, by a margin the test measures
 * and prints (0.425 in of undercut on the worst corner). Move either knob and
 * that assertion is what fails.
 */
export const RETICLE_RADIUS_IN = 4;
export const RETICLE_RADIUS_FT = RETICLE_RADIUS_IN * IN_TO_FT;


/** The format's own invariants. Asserted as a test, never at runtime. */
export function validateDerbyFormat(rounds = DERBY_ROUNDS, perRound = PITCHES_PER_ROUND): string[] {
  const bad: string[] = [];
  if (!Number.isInteger(rounds) || rounds < 1) bad.push(`rounds ${rounds} is not ≥ 1`);
  if (rounds > MAX_ROUNDS) bad.push(`rounds ${rounds} exceeds the worker's MAX_ROUNDS ${MAX_ROUNDS}`);
  if (!Number.isInteger(perRound) || perRound < 1) bad.push(`pitchesPerRound ${perRound} < 1`);
  const perPitch = MAX_POINTS_PER_ROUND / perRound;
  if (perPitch * perRound !== MAX_POINTS_PER_ROUND) {
    bad.push(`${perRound} pitches do not divide MAX_POINTS_PER_ROUND ${MAX_POINTS_PER_ROUND}`);
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

export function resolveDerbyConfig(c: DerbyConfig): ResolvedConfig {
  return {
    seed: c.seed >>> 0,
    park: c.park ?? HARBOURFRONT,
    roofClosed: c.roofClosed ?? true,
    batterHand: c.batterHand ?? 'R',
    pitcherHand: c.pitcherHand ?? 'R',
    rounds: c.rounds ?? DERBY_ROUNDS,
    pitchesPerRound: c.pitchesPerRound ?? PITCHES_PER_ROUND,
    batSpeedMph: c.batSpeedMph,
  };
}
