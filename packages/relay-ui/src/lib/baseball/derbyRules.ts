// Home Run Derby — the RULES: the format and the serve mix. Data and pure
// functions only; no state, no loop.
//
// Split out of `derbySim.ts` at the 500-line cap — EXTRACTION, NOT A RAISED CAP,
// the same way `pitches.ts` is split from `pitchSim.ts` and `bat.ts` from
// `batSim.ts`. The seam is the same one those two use: the DATA and its
// derivations on this side, the loop that consumes them on the other. Every
// constant here carries its category (fixed / derived / calibrated / feel knob),
// and `validate*` turns bad data into a test failure rather than a bad game.
//
// ⚠ TWO MORE EXTRACTIONS, TAKEN AT THE CAP AGAIN RATHER THAN RAISING IT. The
// M2 feel pass needed to add a second scorer here, at 484/500 lines. It went out
// instead:
//
//   `contactWindow.ts`  the BAT GEOMETRY — `BAT_TIP_M`, `BAT_HANDLE_LIMIT_M`
//                       and the bisection that inverts `contactGeometry`. Pure
//                       geometry, three unrelated consumers, no knowledge of
//                       the format.
//   `derbyScoring.ts`   the PAYOUT — every points constant and the one clamped
//                       scorer. A LEAF: it imports nothing from the game, so
//                       `validateDerbyFormat` can check the payout against this
//                       file's derived cap with no cycle.
//
//   `batterAim.ts`      the RETICLE/TAP MAPPING — `SWING_UNDERCUT_IN`, the
//                       reticle shoulder, the pull/oppo intent and the
//                       `aimSwing` that turns two player inputs into four
//                       geometric axes. It moved out when `duelSim.ts` landed:
//                       the DUEL needs the identical mapping, and the choice was
//                       to import a rival mode's FORMAT module or to fork nine
//                       lines of geometry. Both are the charter's named failure,
//                       so the mapping went UP to a module that knows the bat
//                       and the zone and no game mode at all. Not one number
//                       moved — the derby's goldens are the proof.
//
// What is left here is what is genuinely about THIS GAME: how long it is and
// what gets thrown.

import { validatePayoutCap } from './derbyScoring';
import { HARBOURFRONT } from './parks';
import type { Park } from './parks';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { simDraw } from './rng';
import { DERBY_POINTS_PER_ROUND, MAX_ROUNDS } from './tuning';
import type { Handedness } from './zone';

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
//
// ⚠ THE IMPLEMENTATION MOVED TO `rng.ts` WHEN THE DUEL LANDED. It is the same
// three lines and the same constant; what changed is that the DUEL needs the
// identical stream, and a second copy of a mixer in a sibling game mode is the
// "one implementation per concept" rule failing quietly. The name stays here so
// no call site and no test moved, and the tripwire still points at this symbol.

/** One draw plus the next stream state. Pure — no hidden counter. */
export function derbyDraw(state: number): { value: number; next: number } {
  return simDraw(state);
}

// ---------------------------------------------------------------------------
// The format — and the clamp arithmetic that fixes it
// ---------------------------------------------------------------------------
//
// ⚠ THE SERVER CLAMP IS `rounds × DERBY_POINTS_PER_ROUND`, NOT `MAX_ROUNDS × …`.
// `packages/relay-worker/src/games.ts` rejects (400, never truncates) a score
// above `rounds × 4000` for the rounds actually submitted, and rejects `rounds`
// outside 1..MAX_ROUNDS. So `tuning.MAX_SUBMITTABLE_SCORE` (16000) describes the
// ARCADE eight-round case only and is the wrong thing for a 3-round derby to
// check itself against. The invariant this file holds is the real one: **4000
// points per derby round**, at every point in a session, partial rounds
// included.
//
// ⚠ 4000 AND NOT 2000, AND IT IS A PER-GAME NUMBER. The worker branches on the
// game id (`game === 'bbderby' ? DERBY_POINTS_PER_ROUND : MAX_POINTS_PER_ROUND`)
// exactly the way it branches the rounds ceiling for `golfcourse`, so the derby
// getting a wider clamp did not widen anything for fog, tune or golf. The reason
// it needed one is in `derbyScoring.ts`'s chain section: a multiplier has only
// `cap − base` of room, and at 250/pitch against a ~190-point barrelled home run
// there was 1.32× of it — measured, not enough to move the top of the skill
// curve without cutting the base payout and undoing the M2 contact fix.
//
// One `rounds` unit is ONE DERBY ROUND, never one swing. Three rounds is well
// inside MAX_ROUNDS = 8, so no `MAX_COURSE_ROUNDS`-style rounds escape hatch is
// needed — the points ceiling is the one that moved.

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
 * DERBY_POINTS_PER_ROUND` exactly, so no reachable sequence of swings can put a
 * round over 4000 regardless of what the distance term or the chain multiplier
 * does.
 */
export const MAX_POINTS_PER_PITCH = DERBY_POINTS_PER_ROUND / PITCHES_PER_ROUND;

/**
 * The cap for a session whose format was overridden. DERIVED, and it is the ONE
 * place the arithmetic is written: `derbySim` and every bench ask this rather
 * than dividing again, so the "cap re-derives from the CONFIG" property has a
 * single implementation to mutate and a single one to assert.
 */
export const perPitchCap = (pitchesPerRound: number): number =>
  DERBY_POINTS_PER_ROUND / pitchesPerRound;

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

/** The format's own invariants. Asserted as a test, never at runtime. */
export function validateDerbyFormat(rounds = DERBY_ROUNDS, perRound = PITCHES_PER_ROUND): string[] {
  const bad: string[] = [];
  if (!Number.isInteger(rounds) || rounds < 1) bad.push(`rounds ${rounds} is not ≥ 1`);
  if (rounds > MAX_ROUNDS) bad.push(`rounds ${rounds} exceeds the worker's MAX_ROUNDS ${MAX_ROUNDS}`);
  if (!Number.isInteger(perRound) || perRound < 1) bad.push(`pitchesPerRound ${perRound} < 1`);
  const perPitch = perPitchCap(perRound);
  // ⚠ `perPitch * perRound === DERBY_POINTS_PER_ROUND` CANNOT FIRE, and that is
  // not a style point: (2000/3)*3 is exactly 2000 in IEEE-754, so 3, 6, 7 and 9
  // pitches all passed this check while producing a FRACTIONAL per-pitch cap —
  // and `packages/relay-worker/src/games.ts` requires `Number.isInteger` on what
  // it is handed. Test the thing the worker tests.
  if (!Number.isInteger(perPitch)) {
    bad.push(
      `${perRound} pitches do not divide DERBY_POINTS_PER_ROUND ${DERBY_POINTS_PER_ROUND} ` +
        `(per-pitch cap ${perPitch})`,
    );
  }
  // ⚠ AND THE PAYOUT IS CHECKED FOR **EVERY** OUTCOME, NOT JUST HOME RUNS. This
  // used to be a single `homeRunPoints(MAX_SAFE_INTEGER) > perPitch` line, which
  // was sufficient only while home runs were the only thing that scored. The M2
  // feel pass added a payout for solid contact, for fouls and for barrels, and
  // the worker's rejection is on the SUBMITTED TOTAL — so the invariant has to
  // be a property over the whole outcome ENUM, which is what `validatePayoutCap`
  // loops over. Its heavier sibling `validateDerbyPayout` (ordering,
  // monotonicity, the barrel bonus) is TEST-ONLY: this function runs on the live
  // config path, and those are statements about constants that cannot move
  // between two constructions.
  bad.push(...validatePayoutCap(perPitch));
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
