// The Duel — the RULES: the format, the count, the bases, the arsenal and the
// pitcher's command map. Data and pure functions only; no state, no loop.
//
// Split from `duelSim.ts` before `duelSim.ts` was written, along the seam
// `derbyRules.ts` established and for the same reason: the DATA and its
// derivations on this side, the loop that consumes them on the other. Every
// constant carries its category — fixed / RULE OF BASEBALL / derived /
// calibrated / feel knob — and `validate*` makes bad data a test failure rather
// than a bad game.
//
// ⚠ THE SCOPE CAP IS THE DESIGN, and it is written here as well as in
// `fielding.ts` because this is the file a "just one more rule" edit lands in.
// Straight from the charter: **no stolen bases, no errors, no substitutions, no
// pitching changes, no defensive shifts, no pickoffs, no leads, no throws or
// cutoffs.** Baserunners advance by FORCE ONLY — see `advanceRunners`, which
// states the simplification, states which way it biases scoring, and is pinned
// by a test. Every one of those is a later milestone and none of them is a small
// addition here; BRANCHES GROWING IN THIS FILE IS THE SIGNAL TO DESIGN THE
// MILESTONE, not to add the branch.
//
// ⚠ AND `PITCH_TEMPO` IS NOT IMPORTED, here or in `duelSim.ts` or in `ai.ts`.
// `simulatePitch` precomputes the whole flight at TRUE physical time; the render
// layer plays that track back slowly. A swing takes TRUE physical seconds since
// release, and it is the RENDERER's job to MULTIPLY its wall clock by the tempo
// before calling in. `derbySim.ts`'s header carries the full argument, including
// why DIVIDING is the plausible-and-wrong direction, and `determinism.test.ts`
// reads these sources to keep the tempo out of them.

import type { ReticleAssist } from './batterAim';
import type { Park } from './parks';
import { HARBOURFRONT } from './parks';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { CALL_ZONE_HEIGHT_FT, CALL_ZONE_WIDTH_FT, armSideX } from './zone';
import type { Handedness } from './zone';

/** Where the loop is. `inFlight` is the only phase in which a swing is legal. */
export type DuelPhase = 'ready' | 'inFlight' | 'done';

/** Which half of an inning. `top` is the away team batting, as in baseball. */
export type Half = 'top' | 'bottom';

/** The two sides. The HUMAN is one of them; `DuelConfig.humanBats` says which. */
export type Team = 'away' | 'home';

/** How a game ended. `tie` is reachable only through `MAX_INNINGS`. */
export type Winner = 'away' | 'home' | 'tie';

// ---------------------------------------------------------------------------
// The format — three of these five numbers are rules of baseball
// ---------------------------------------------------------------------------

/**
 * Innings in a duel. FEEL KNOB, sized by session length exactly as
 * `DERBY_ROUNDS` is: six half-innings at ~4.5 plate appearances and ~4 pitches
 * each is a 2.5–4 min session, which is the brief. Nine would be a different
 * product.
 */
export const REGULATION_INNINGS = 3;

/** Outs in a half-inning. RULE OF BASEBALL. Not a knob and never scaled. */
export const OUTS_PER_HALF = 3;

/** Balls that walk the batter. RULE OF BASEBALL. */
export const BALLS_FOR_WALK = 4;

/** Strikes that retire him. RULE OF BASEBALL. */
export const STRIKES_FOR_K = 3;

/**
 * The strike count at and above which a FOUL BALL no longer adds a strike.
 * RULE OF BASEBALL — a foul with two strikes leaves the count at two, forever.
 * (A foul BUNT and a foul TIP are the rule's two exceptions and this game has
 * neither, so the rule here is the whole rule.)
 */
export const FOUL_PROTECTED_STRIKES = STRIKES_FOR_K - 1;

/**
 * The hard bound on innings played, including extras. ⚠ A BOUND, NOT A RULE.
 *
 * Baseball has no tie and no inning limit: a game level after regulation plays
 * on. That is the rule this file implements, and it is the right one — a 3-inning
 * duel that ends 2–2 with no resolution is a worse product than one extra
 * inning. But an unbounded loop in a game sim is a hang, so play stops here and
 * the game is scored on the board, tie included. It is deliberately far out of
 * reach — the printed outcome table reports the longest game any seed produced,
 * so the day this bound starts biting it is visible rather than silent.
 */
export const MAX_INNINGS = 9;

/**
 * What ONE pitch did to the count. Five words and there is no sixth.
 *
 * ⚠ A CAUGHT FOUL POP IS `inPlay`, NOT `foul`, and that is not a slip of the
 * label. `foul` in this enum means "the ball went foul AND nobody caught it",
 * which is the only case the count cares about — it is a strike unless there are
 * already two. A foul pop that `fielding.ts` rules an OUT has retired the
 * batter, so it belongs with every other batted ball that ended the plate
 * appearance. `record.fence` still carries `resolveFence`'s raw `'foul'`, so
 * nothing is lost in the mapping and a HUD can still say "caught in foul
 * ground".
 */
export type PitchOutcome = 'ball' | 'calledStrike' | 'swingingStrike' | 'foul' | 'inPlay';

// ---------------------------------------------------------------------------
// The arsenal — CONTENT AS DATA
// ---------------------------------------------------------------------------

/**
 * What a DUEL pitcher throws, and how much of a put-away offering each pitch is.
 *
 * FEEL KNOB (the columns), DATA (the shape): all eight published rows stay
 * reachable, so `pitches.ts` remains the one arsenal and a ninth pitch is a row
 * THERE, not a branch here.
 *
 * ⚠ IT IS NOT `DERBY_MIX`, AND THE DIFFERENCE IS THE WHOLE POINT OF THE MODE.
 * A derby server is cooperating — 34 % four-seamers and everything located in
 * the zone. A duel pitcher is trying to get the batter out, so the breaking
 * balls roughly double (sl+st+cu: 32 % here against 19 % there) and the mix is
 * re-weighted by the COUNT through `chase` below rather than by a branch.
 *
 * `chase` ∈ [0,1] is how much a pitch is a two-strike offering — something that
 * finishes off the plate and is meant to be swung at rather than hit. A
 * four-seamer is 0 (you throw it for a strike), a sweeper is 0.9. It is a
 * COLUMN and not a rule so that `ai.ts` can tilt one weighted draw instead of
 * carrying a decision tree.
 */
export interface DuelMixRow {
  id: PitchId;
  weight: number;
  chase: number;
}

export const DUEL_MIX: readonly DuelMixRow[] = [
  { id: 'ff', weight: 0.3, chase: 0.0 },
  { id: 'si', weight: 0.14, chase: 0.1 },
  { id: 'fc', weight: 0.1, chase: 0.4 },
  { id: 'sl', weight: 0.14, chase: 0.9 },
  { id: 'st', weight: 0.08, chase: 0.9 },
  { id: 'cu', weight: 0.1, chase: 0.8 },
  { id: 'ch', weight: 0.09, chase: 0.6 },
  { id: 'fs', weight: 0.05, chase: 0.8 },
];

/** Bad mix data is a TEST FAILURE, not a runtime surprise. */
export function validateDuelMix(mix: readonly DuelMixRow[] = DUEL_MIX): string[] {
  const bad: string[] = [];
  const total = mix.reduce((s, m) => s + m.weight, 0);
  if (Math.abs(total - 1) > 1e-9) bad.push(`weights sum to ${total}, not 1`);
  for (const m of mix) {
    if (!(m.weight > 0)) bad.push(`${m.id}: weight ${m.weight} is not positive`);
    if (!(m.chase >= 0 && m.chase <= 1)) bad.push(`${m.id}: chase ${m.chase} is outside [0,1]`);
    if (!PITCHES.some((p) => p.id === m.id)) bad.push(`${m.id}: not in PITCHES`);
  }
  for (const p of PITCHES) {
    if (!mix.some((m) => m.id === p.id)) bad.push(`${p.id}: in PITCHES but not in the mix`);
  }
  if (new Set(mix.map((m) => m.id)).size !== mix.length) bad.push('duplicate pitch id');
  return bad;
}

// ---------------------------------------------------------------------------
// COMMAND — the pitcher's input error becomes a location displacement
// ---------------------------------------------------------------------------
//
// The human pitches with golf's slingshot: a pull to set the intent, released
// into an `AccuracyBar` sweep whose stop is a signed scalar. THIS FILE TAKES
// NUMBERS, NOT GESTURES — the HUD owns the pull and the bar, and hands in an
// intended plate location plus a stop error in [−1, 1]. Nothing about a pointer
// reaches the sim, which is what lets the outcome bench play a hundred games
// without a DOM.
//
// ⚠ THE MISS SCALE IS DERIVED FROM THE ZONE, NOT PICKED. One scalar has to become
// a two-dimensional displacement, so it needs a magnitude AND an axis, and both
// come out of `zone.ts`'s CALLED zone with no free number in between:
//
//     displacement(e) = e · ( armSide · CALL_ZONE_WIDTH/2 ,  CALL_ZONE_HEIGHT/2 )
//
// At |e| = 1 that is exactly the half-width and half-height of the called zone,
// so **a full miss on a pitch aimed at dead centre lands exactly on the called
// corner** — the boundary between a strike and a ball. That single sentence
// fixes the scale (1.3153 ft of displacement, 0.8293 lateral and 1.0210
// vertical), fixes the axis, and is the assertion `duelSim.test.ts` pins it
// with. Nothing here was chosen to feel right; it was chosen to make the worst
// legal miss the first pitch that is not a strike.
//
// ⚠ THE AXIS IS THE ARM SLOT, AND THE SIGN IS `armSideX`'s, READ ONCE. A pitcher
// does not miss randomly in a disc — he misses along his arm slot. Releasing
// early sends the ball UP and to the ARM side; late sends it DOWN and to the
// GLOVE side. So `e > 0` is the early miss and its lateral sign is the pitcher's
// arm side (a RHP's is REPORT −x, the third-base side, per BASEBALL.md § Frame),
// and a left-hander mirrors with no second code path. A model that missed
// straight up and down, or straight sideways, would make one axis of the plate
// free.

/** Lateral half-span of a full command miss, ft. DERIVED from the called zone. */
export const COMMAND_MISS_X_FT = CALL_ZONE_WIDTH_FT / 2;

/** Vertical half-span of a full command miss, ft. DERIVED from the called zone. */
export const COMMAND_MISS_H_FT = CALL_ZONE_HEIGHT_FT / 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Where the pitch actually goes: the intended plate location displaced by the
 * pitcher's stop error along his arm slot.
 *
 * `stopError ∈ [−1, 1]` (clamped): 0 is a perfectly-timed release, + is early
 * (up and arm side), − is late (down and glove side). `missScale` is the one
 * modulator — a COMMAND card stat, 1.0 being the derived full-corner miss and
 * lower being better command. It multiplies the displacement and nothing else.
 */
export function pitchLocation(
  intent: { x: number; h: number },
  stopError: number,
  hand: Handedness,
  missScale = 1,
): { x: number; h: number } {
  const e = clamp(stopError, -1, 1) * missScale;
  return {
    x: intent.x + e * armSideX(hand) * COMMAND_MISS_X_FT,
    h: intent.h + e * COMMAND_MISS_H_FT,
  };
}

// ---------------------------------------------------------------------------
// THE RETICLE ASSIST — the duel's own shoulder, and why it is not the derby's
// ---------------------------------------------------------------------------
//
// ⚠ THE MEASUREMENT FIRST, BECAUSE IT IS THE WHOLE JUSTIFICATION. The derby's
// shoulder (`batterAim.DERBY_ASSIST`, 8 in at power 4) is deliberately very
// forgiving near the middle: an aim error under ~3.3 in moves the swing's
// undercut by less than a tenth of an inch, i.e. produces the CALIBRATED
// reference swing — 101 mph at 27°, 411 ft, over the wall at every bearing at
// Harbourfront. And 3.33 in is **54 %** of the 6.147 in at which contact is lost
// altogether, so more than half of all contact-making aims are the same
// home-run swing. In a home run derby that is the design. Played as a DUEL it
// gave, measured over 24 seeded games: 40 % of balls in play leaving the park,
// 6 singles against 47 home runs, and 21 runs a game at difficulty 0.85.
//
// ⚠ AND NO AI KNOB FIXES IT, WHICH IS WHY THIS IS THE THING THAT MOVED. The
// plateau's share of the contact range is `(0.10/2.14)^(1/(p+1))` — it depends
// on the fade POWER alone. Narrowing `fullMissIn` rescales both edges together
// and leaves the ratio at 54 %; widening the AI's aim or timing spread only adds
// whiffs, because `P(home run | contact)` is a ratio the spread cancels out of.
// The eight AI feel knobs were swept and none of them moves it.
//
// So the duel gets its own pair. ⚠ THE TWO NUMBERS ARE NOT THE SAME CATEGORY,
// and an earlier draft of this comment called both of them calibrated, which
// dressed a knob in a badge it had not earned:
//
//   • `fadePower = 1.5` — **FEEL KNOB, WITH A MEASURED CONSEQUENCE.** It is not
//     calibrated and cannot be: the plateau's share of the contact range is
//     `(δ/2.14)^(1/(p+1))` in which `fullMissIn` cancels exactly, so it is a
//     pure function of `p` and EVERY `p` "is chosen so the plateau is whatever
//     that `p` gives". Neither the 29 % it lands on nor the δ = 0.10 in that
//     defines "plateau" is independently motivated — 0.10 in is ~0.35° of launch
//     angle, i.e. a threshold picked because it is invisible, not because
//     anything published says so. What IS real is the consequence, and it is
//     measured rather than asserted: the plateau falls from 54 % to 29 % of the
//     contact range, and `P(home run | contact)` roughly HALVES. ⚠ That second
//     figure is protocol-dependent, so the protocol is quoted with it — over an
//     area-uniform 8 in aim disc against a 4-seamer down the middle at
//     Harbourfront, it is **40.1 % → 19.0 %** at perfect timing and
//     **24.2 % → 12.1 %** with the tap swept across ±1.2× the contact window.
//     The ratio moves with the sampling; the direction and the rough factor of
//     two do not. The bench prints both plateau fractions every run.
//   • `fullMissIn = 12` — **CALIBRATED**, and it is the one number here that is,
//     because it is solved against a target outside itself: the derby's contact
//     edge. Once `p` is fixed, the `fullMissIn` that reproduces 6.147 in exactly
//     is **12.42**; 12 is that rounded, and it lands at 6.02 in — **2.0 %**
//     short. So the duel is NOT harder to make contact with, only harder to
//     SQUARE UP, and separating those two is the point of having two numbers.
//     (Measured 2-D rather than on the vertical alone, the duel edge is equal or
//     WIDER in eleven of twelve directions and narrows only straight up and
//     down, so that claim is if anything understated.)
//
// ⚠ IT IS STILL ONE IMPLEMENTATION. `batterAim.reticleResidual` is the only
// place the law lives; this is a modulator on it, exactly as `batSpeedMph` is a
// modulator on the swing. The strict monotonicity, the absence of a flat middle
// and the untouched far field are properties of the law and hold for both pairs.
export const DUEL_ASSIST: ReticleAssist = { fullMissIn: 12, fadePower: 1.5 };

// ---------------------------------------------------------------------------
// THE BASES — forced advance only, and that is a stated RULE, not a model
// ---------------------------------------------------------------------------
//
// ⚠ THIS IS A DELIBERATE SIMPLIFICATION AND IT IS THE SCOPE CAP, NOT AN
// APPROXIMATION AWAITING A FIX. A hit advances EVERY runner by exactly the
// number of bases the batter took, and a walk advances only the runners who are
// forced. There is no probabilistic extra advancement, no first-to-third, no
// runner held, no sacrifice fly, no tagging up, no throw and no error, because
// this game has no baserunner state to hang any of those on and inventing one
// here is the milestone this file's header refuses.
//
// ⚠ WHICH WAY **THIS** RULE BIASES SCORING: **DOWN**. Every one of the missing
// mechanics pushes the same way. A real single scores a runner from second more
// often than not (~55–60 % league-wide); here he stops at third. A real double
// nearly always scores a runner from first; here he stops at third too. A real
// fly ball with a runner on third and fewer than two out often scores him; here
// it never does. Nothing missing from this list ADDS an out or removes a run.
//
// ⚠ AND IT IS NOW THE ONLY BIAS ON THE RUN ENVIRONMENT, WHICH IS A CHANGE. This
// paragraph used to net it against a much larger one pushing the other way —
// `fielding.ts`'s landing-point limitation, which the derby never exercised
// because a derby has no defence, and which made **every ground ball a base
// hit**: 274 balls in play at difficulty 0.50, 87 of them ground balls, of which
// **84 singles and 3 outs**, a **3.4 %** ground-ball out rate against MLB's
// ~72 %. That is gone. `groundBall.ts` is the rolling phase `fielding.ts`
// predicted for itself, the bench now retires **72.5 %** of ground balls, and
// runs/game fell from 5.06/6.19/8.25 to 4.69/3.50/3.13 across the three
// difficulties.
//
// So the netting is over and what is left is this rule, on its own, biasing
// scoring **DOWN** by perhaps half a run a game. The outcome table's `runs/game`
// and 1B columns are READABLE now rather than dominated — they are still not
// calibrated to anything, because nothing in this game is fitted to a run
// environment, and this rule is the reason they should read a little low.
//
// It is stated rather than corrected, because a fudge factor on runs would be a
// fifth category of number.

/** Occupancy of first, second, third. Immutable — every helper returns a new one. */
export type Bases = readonly [boolean, boolean, boolean];

export const EMPTY_BASES: Bases = [false, false, false];

/** Runners on, for a readout and for the AI's situational awareness. */
export const runnersOn = (bases: Bases): number => bases.filter(Boolean).length;

/**
 * A HIT: every runner advances exactly `basesGained`, and so does the batter.
 * 1 = single, 2 = double, 3 = triple, 4 = home run (which clears the bases by
 * construction rather than by a special case).
 */
export function advanceRunners(
  bases: Bases,
  basesGained: number,
): { bases: Bases; runs: number } {
  if (!Number.isInteger(basesGained) || basesGained < 1 || basesGained > 4) {
    throw new Error(`basesGained ${basesGained} is not 1..4`);
  }
  const next: [boolean, boolean, boolean] = [false, false, false];
  let runs = 0;
  // Existing runners first, from third down to first. Order does not matter —
  // nobody can be passed when everybody moves the same distance — but running
  // lead-runner-first is how a scorer reads it and how the test reads it.
  for (let i = 2; i >= 0; i--) {
    if (!bases[i]) continue;
    const to = i + basesGained;
    if (to >= 3) runs++;
    else next[to] = true;
  }
  if (basesGained >= 4) runs++;
  else next[basesGained - 1] = true;
  return { bases: next, runs };
}

/**
 * A WALK: the batter takes first, and a runner moves ONLY if the runner behind
 * him has nowhere else to go. That cascade is the whole rule — a runner on
 * second with first empty does not move, and a bases-loaded walk forces in
 * exactly one run and leaves the bases loaded.
 */
export function forceWalk(bases: Bases): { bases: Bases; runs: number } {
  const next: [boolean, boolean, boolean] = [bases[0], bases[1], bases[2]];
  let runs = 0;
  if (bases[0]) {
    if (bases[1]) {
      if (bases[2]) runs = 1;
      else next[2] = true;
      next[1] = true;
    } else next[1] = true;
  }
  next[0] = true;
  return { bases: next, runs };
}

// ---------------------------------------------------------------------------
// The session's configuration — defaults live with the rules, not the loop
// ---------------------------------------------------------------------------

export interface DuelConfig {
  seed: number;
  park?: Park;
  /** Roof shut by default: exactly-zero wind and pinned air ⇒ ranked-safe. */
  roofClosed?: boolean;
  /**
   * Which half the HUMAN bats. Default `home` — he bats LAST, which is the only
   * arrangement in which a walk-off exists.
   */
  humanBats?: Team;
  /**
   * ⚠ ONE HANDEDNESS PER ROLE, NOT PER TEAM. Both batters are `batterHand` and
   * both pitchers are `pitcherHand`. A duel has one batter and one pitcher a
   * side; per-team handedness is a LINEUP feature, lineups belong to
   * `baseball-progression`, and the mirror itself is `zone.armSideX`'s job and
   * is already read exactly once on each side.
   */
  batterHand?: Handedness;
  pitcherHand?: Handedness;
  /** AI skill, 0..1. FEEL KNOB — `ai.ts` owns the whole curve. */
  difficulty?: number;
  /** The HUMAN side's fielding rating, 0..1 — `fielding.ts`'s one dial. */
  defense?: number;
  /** Bat-speed modulator, mph, for the HUMAN batter — the hook `cards.ts` drives. */
  batSpeedMph?: number;
  /** Command modulator for the HUMAN pitcher — see `pitchLocation`. */
  missScale?: number;
  /** Innings override. Tests play 1-inning games; the product plays 3. */
  innings?: number;
}

/** The same thing with every default applied. Immutable for a session. */
export interface ResolvedDuelConfig {
  seed: number;
  park: Park;
  roofClosed: boolean;
  humanBats: Team;
  batterHand: Handedness;
  pitcherHand: Handedness;
  difficulty: number;
  defense: number;
  batSpeedMph: number | undefined;
  missScale: number;
  innings: number;
}

/** The format's own invariants. Asserted as a test AND on the live config path. */
export function validateDuelFormat(innings = REGULATION_INNINGS): string[] {
  const bad: string[] = [];
  if (!Number.isInteger(innings) || innings < 1) bad.push(`innings ${innings} is not >= 1`);
  if (innings > MAX_INNINGS) bad.push(`innings ${innings} exceeds MAX_INNINGS ${MAX_INNINGS}`);
  if (OUTS_PER_HALF !== 3) bad.push(`OUTS_PER_HALF ${OUTS_PER_HALF} is not the rule's 3`);
  if (BALLS_FOR_WALK !== 4) bad.push(`BALLS_FOR_WALK ${BALLS_FOR_WALK} is not the rule's 4`);
  if (STRIKES_FOR_K !== 3) bad.push(`STRIKES_FOR_K ${STRIKES_FOR_K} is not the rule's 3`);
  bad.push(...validateDuelMix());
  return bad;
}

/**
 * ⚠ IT VALIDATES, AND IT THROWS. A config is player-adjacent input (a card, a
 * URL, a saved session), so it is checked at the one place it enters the sim and
 * refuses rather than silently repairing — `derbyRules.resolveDerbyConfig`
 * carries the measurement that made that non-negotiable: an unvalidated
 * `rounds: -5` produced a session reporting a NEGATIVE maximum score.
 */
export function resolveDuelConfig(c: DuelConfig): ResolvedDuelConfig {
  const innings = c.innings ?? REGULATION_INNINGS;
  const bad = validateDuelFormat(innings);
  if (!Number.isFinite(c.seed)) bad.push(`seed ${c.seed} is not finite`);
  if (c.difficulty !== undefined && !(c.difficulty >= 0 && c.difficulty <= 1)) {
    bad.push(`difficulty ${c.difficulty} is outside [0,1]`);
  }
  if (c.defense !== undefined && !(c.defense >= 0 && c.defense <= 1)) {
    bad.push(`defense ${c.defense} is outside [0,1]`);
  }
  if (c.batSpeedMph !== undefined && !(c.batSpeedMph > 0)) {
    bad.push(`batSpeedMph ${c.batSpeedMph} is not positive`);
  }
  if (c.missScale !== undefined && !(c.missScale >= 0)) {
    bad.push(`missScale ${c.missScale} is negative`);
  }
  if (bad.length) throw new Error(`invalid duel config: ${bad.join('; ')}`);
  return {
    seed: c.seed >>> 0,
    park: c.park ?? HARBOURFRONT,
    roofClosed: c.roofClosed ?? true,
    humanBats: c.humanBats ?? 'home',
    batterHand: c.batterHand ?? 'R',
    pitcherHand: c.pitcherHand ?? 'R',
    difficulty: c.difficulty ?? 0.5,
    defense: c.defense ?? 0.5,
    batSpeedMph: c.batSpeedMph,
    missScale: c.missScale ?? 1,
    innings,
  };
}
