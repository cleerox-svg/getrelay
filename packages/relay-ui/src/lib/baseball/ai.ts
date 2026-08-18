// The Duel's opponent — ONE AI that plays BOTH ROLES.
//
// The human alternates halves: he bats one and pitches the other, so the AI must
// do both, and it is one file rather than two because the two roles share the
// only thing that is actually hard here — a difficulty parameter that has to
// reach real, measurable behaviour rather than a hidden multiplier on the
// scoreboard.
//
// ⚠ EVERY DECISION COMES FROM THE SEEDED STREAM AND NOTHING ELSE. These are pure
// functions of `(draw, difficulty, context)`; `draw` is the caller's
// `mulberry32` closure over the state `DuelSim` carries as a plain number, so a
// seed replays a game move for move. No `Math.random`, no clock, no module-level
// mutable state — `determinism.test.ts` reads this file.
//
// ⚠ THE DRAW COUNT IS FIXED PER DECISION, and that is a determinism property
// rather than tidiness. Both entry points take ALL of their randomness up front,
// before any branch, so the stream advances by the same amount whether the AI
// swings or takes and whether it throws a fastball or a sweeper. A decision path
// that consumed a variable number of draws would make the pitch AFTER a swing
// depend on whether the previous batter swung — a coupling nobody would look for
// and no test would name. `AI_DRAWS_PER_PITCH` / `AI_DRAWS_PER_SWING` are
// exported so the bench can assert it.
//
// ⚠ AND `PITCH_TEMPO` IS NOT IMPORTED. The AI's swing is expressed in TRUE
// physical seconds since release, exactly as the human's is — see
// `derbySim.ts`'s header for the full argument and for why dividing by the tempo
// is the plausible-and-wrong direction.
//
// ⚠ ONE STATED SIMPLIFICATION: THE AI BATTER READS THE PITCH'S TRUE PLATE
// CROSSING and works from noisy versions of it. There is no pitch-recognition
// model — no reading spin out of the first twenty feet, no learning a pitcher's
// tell. That is honest about what this is rather than dressed up.
//
// ⚠ BUT IT READS IT TWICE, WITH TWO DIFFERENT ERRORS, AND THAT IS THE WHOLE
// SHAPE OF THE AI BATTER. A human duel batter does two things at two different
// moments, and collapsing them into one noise term is what made the first cut of
// this file play like a home-run derby:
//
//   • HE SITS ON A LOCATION FIRST. The reticle is committed BEFORE the pitch —
//     that is the derby's rule and it is the duel's too — so its error is not
//     eyesight, it is a GUESS, and it stays large however good the hitter is.
//     `AI_READ_*` is how much of the real pitch he manages to adjust to before
//     committing.
//   • HE DECIDES TO SWING LATER, when the ball is most of the way there, so that
//     read is much better. `AI_SIGHT_*` is that one.
//
// The first cut used the eyesight number for both. The measured consequence:
// the reticle landed within ~2 in of the pitch at every difficulty, which puts
// the swing inside the flat top of `batterAim.reticleResidual`'s shoulder, which
// IS the reference swing — 101 mph at 27°, a 411 ft home run. 47 % of balls in
// play left the park. Separating the two is not a fudge; it is the difference
// between the two things a batter actually does.

import { contactWindowS } from './contactWindow';
import { DUEL_MIX, STRIKES_FOR_K } from './duelRules';
import type { DuelMixRow } from './duelRules';
import type { PitchId } from './pitches';
import { ZONE_CENTER, missDistance, reticleToPlate } from './zone';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);
/** A draw on [0,1) mapped to a symmetric [−1, 1]. */
const signed = (u: number) => 2 * u - 1;

/** Draws consumed by one pitch decision, whatever it decides. */
export const AI_DRAWS_PER_PITCH = 4;

/** Draws consumed by one swing decision, whatever it decides. */
export const AI_DRAWS_PER_SWING = 6;

// ---------------------------------------------------------------------------
// THE PITCHER
// ---------------------------------------------------------------------------

/** What the AI (or a HUD, for the human) hands `DuelSim.servePitch`. */
export interface PitchCommand {
  id: PitchId;
  /** Intended plate location, ft, REPORT frame. `zone.reticleToPlate` maps a HUD drag onto it. */
  intentX: number;
  intentH: number;
  /** The accuracy sweep's signed stop, [−1, 1]. See `duelRules.pitchLocation`. */
  stopError: number;
}

export interface PitchContext {
  balls: number;
  strikes: number;
}

/**
 * How hard the count tilts the arsenal toward put-away offerings. FEEL KNOB.
 * At full tilt a sweeper (`chase` 0.9) is 2.35× its base weight and a
 * four-seamer (`chase` 0) is unchanged — the mix leans, it does not switch.
 */
export const AI_CHASE_TILT = 1.5;

/**
 * How much an EASY pitcher leans back on the pitches that are easy to hit. FEEL
 * KNOB, and it is the only lever difficulty has on SELECTION. At difficulty 0
 * and an even count the breaking balls run at 0.28× weight; at difficulty 1 the
 * published mix is thrown as written.
 */
export const AI_EASY_FASTBALL_TILT = 0.8;

/**
 * Aim radius in RETICLE units at an even count. FEEL KNOB.
 *
 * 0.85 is the corner of the painted plate — near the black, not the middle. A
 * pitcher ahead of nobody is trying to throw a STRIKE, which is why this sits
 * inside 1.0 rather than off it; but he works the edge to get one, which is why
 * it is not near zero. Combined with the command spread it is what sets the
 * duel's in-zone rate (53–64 % across the difficulty range, printed by the
 * bench), against MLB's ~48 %.
 *
 * ⚠ THE DOC USED TO DESCRIBE 0.18 while the constant said 0.85 — a leftover from
 * the tuning pass, and exactly the drift the bench's printed "0-0 aim r" column
 * exists to make visible.
 */
export const AI_AIM_CENTRE = 0.85;

/**
 * Aim radius with two strikes, at difficulty 0 and 1. FEEL KNOBS, and the pair
 * is the clearest thing difficulty does on the mound: a weak pitcher's waste
 * pitch is still over the middle of the plate (0.55), a strong one's finishes
 * just off the corner where a strike is not on offer and only a chase is.
 *
 * ⚠ 1.2 IS MEASURED AGAINST THE **CALLED** ZONE, NOT THE PAINTED ONE, and the
 * distinction is load-bearing. Reticle units are normalised on the RULE zone, so
 * `1.0` is the black — but `zone.ts` calls a strike on the rule zone grown by a
 * BALL RADIUS, i.e. out to 1.17 units. An earlier value of 1.05 read as "past
 * the corner" and was in fact a called strike every time; the bench prints the
 * in-zone percentage of the intent so that cannot happen quietly again.
 */
export const AI_AIM_EDGE_WEAK = 0.55;
export const AI_AIM_EDGE_STRONG = 1.2;

/**
 * The command spread — the half-width of the stop error the AI releases with, at
 * difficulty 0 and 1. FEEL KNOBS on a DERIVED scale: 1.0 is a full
 * `duelRules.pitchLocation` miss, which by construction moves a pitch from dead
 * centre to the called-zone corner. So a weak pitcher misses by up to a whole
 * half-zone and a strong one by a fifth of it.
 */
export const AI_COMMAND_SPREAD_WEAK = 0.9;
export const AI_COMMAND_SPREAD_STRONG = 0.38;

/**
 * How far ahead the pitcher is, 0..1. DERIVED from the count: `(S − B)/2` puts
 * 0-0 and every count the batter is even or ahead in at 0, 0-1 at 0.5 and 0-2 at
 * 1. It is what makes the waste pitch self-correcting — a wasted 0-2 becomes 1-2
 * and the aim comes back toward the plate.
 */
export const putAway = (ctx: PitchContext): number =>
  clamp((ctx.strikes - ctx.balls) / 2, 0, 1);

/** Weighted draw over the count-tilted arsenal. Exported so the bench can sweep it. */
export function pickPitch(
  u: number,
  difficulty: number,
  ctx: PitchContext,
  mix: readonly DuelMixRow[] = DUEL_MIX,
): PitchId {
  const tilt = AI_CHASE_TILT * putAway(ctx) - AI_EASY_FASTBALL_TILT * (1 - clamp(difficulty, 0, 1));
  // A floor rather than a clamp to zero: no published pitch is ever made
  // unreachable by a count, which is what keeps `pitches.ts` the one arsenal.
  const w = mix.map((m) => m.weight * Math.max(0.05, 1 + tilt * m.chase));
  const total = w.reduce((s, x) => s + x, 0);
  let roll = clamp(u, 0, 1) * total;
  for (let i = 0; i < mix.length; i++) {
    roll -= w[i] ?? 0;
    if (roll < 0) return mix[i]?.id ?? 'ff';
  }
  return mix[mix.length - 1]?.id ?? 'ff';
}

/**
 * The AI on the mound: a pitch, a place to put it, and how badly it released.
 *
 * Four draws, taken before any branch — see the header. Difficulty reaches three
 * separate things here (the arsenal's lean, the aim's edge, the command spread),
 * and `duelSim.test.ts` asserts that a difficulty change moves the decision
 * rather than merely being accepted.
 */
export function aiPitchCommand(
  draw: () => number,
  difficulty: number,
  ctx: PitchContext,
): PitchCommand {
  const d0 = draw();
  const d1 = draw();
  const d2 = draw();
  const d3 = draw();
  const k = clamp(difficulty, 0, 1);

  const id = pickPitch(d0, k, ctx);
  const edge = lerp(AI_AIM_EDGE_WEAK, AI_AIM_EDGE_STRONG, k);
  const r = lerp(AI_AIM_CENTRE, edge, putAway(ctx));
  // Aim at one of the four quadrants of the zone at radius `r`. A radius plus a
  // quadrant rather than two independent offsets, because a pitcher works a
  // CORNER — an aim point that wandered independently in x and h would spend
  // most of its draws on the edges of the plate, which is nobody's plan.
  const intent = reticleToPlate(d1 < 0.5 ? -r : r, d2 < 0.5 ? -r : r);
  const spread = lerp(AI_COMMAND_SPREAD_WEAK, AI_COMMAND_SPREAD_STRONG, k);
  return { id, intentX: intent.x, intentH: intent.h, stopError: signed(d3) * spread };
}

// ---------------------------------------------------------------------------
// THE BATTER
// ---------------------------------------------------------------------------

/** What the AI (or a HUD, for the human) hands `DuelSim.swing`/`take`. */
export interface SwingDecision {
  swing: boolean;
  /** TRUE PHYSICAL seconds since release. Null on a take. */
  tapTimeS: number | null;
  /** Where the batter thought the pitch would be, ft, REPORT — his reticle. */
  reticleX: number;
  reticleH: number;
}

export interface SwingContext extends PitchContext {
  /** The pitch's TRUE plate crossing — see the header's simplification note. */
  plateX: number;
  plateH: number;
  plateT: number;
  plateSpeedFps: number;
  batSpeedMph?: number;
}

/**
 * The batter's EYESIGHT at the moment he DECIDES, ft, at difficulty 0 and 1.
 * FEEL KNOBS on a scale taken from `zone.ts`: 0.45 ft is about a fifth of the
 * called zone's diagonal — a batter who cannot tell a corner from a ball — and
 * 0.05 ft is under an inch. It reaches the swing/take decision ALONE; where he
 * puts the bat is `AI_READ_*`'s business, for the reason the header gives.
 */
export const AI_SIGHT_WEAK_FT = 0.45;
export const AI_SIGHT_STRONG_FT = 0.05;

/**
 * How far off dead centre the batter SITS, ft. FEEL KNOBS, sized against the
 * pitcher's own target spread: a duel pitcher works a corner out to
 * `AI_AIM_EDGE_STRONG` reticle units before his command miss, so a batter
 * guessing a location is guessing over roughly the plate's width and the zone's
 * height. It does NOT scale with difficulty — a better hitter does not guess
 * better, he ADJUSTS better, which is `AI_READ_*`.
 *
 * ⚠ CITED BY SYMBOL, NOT BY VALUE. This sentence used to quote "~1.05", which
 * was stale the moment `AI_AIM_EDGE_STRONG` moved to 1.2 — and 1.05 is
 * specifically the value that constant's own note records as having been WRONG
 * (it read as "past the corner" and was a called strike every time).
 */
export const AI_GUESS_SPREAD_X_FT = 0.5;
export const AI_GUESS_SPREAD_H_FT = 0.6;

/**
 * How much of the real pitch the batter picks up in time to move his hands, at
 * difficulty 0 and 1. FEEL KNOBS, and THE most load-bearing pair in this file:
 * `1 − read` multiplies the whole guess error, and `batterAim.reticleResidual`
 * turns that into the swing's undercut. Measured on a fastball down the middle
 * (`duelSim.test.ts` prints the ladder): an aim error inside ~3 in is the
 * reference swing and a 411 ft home run, 4–6 in is a fly ball or a pop-up, 5–6.5
 * in the other way is a ground ball, and past ~6.5 in there is no bat under the
 * ball at all. So this pair decides, more than anything else here, what the
 * duel's run environment is.
 */
export const AI_READ_WEAK = 0.4;
export const AI_READ_STRONG = 0.68;

/**
 * How far outside the called zone the AI will chase, ft, before the count
 * adjusts it. FEEL KNOB.
 */
export const AI_CHASE_BASE_FT = 0.13;

/** Two strikes and he protects the plate; a ball or three and he sits. FEEL KNOBS. */
export const AI_CHASE_PER_STRIKE_FT = 0.16;
export const AI_CHASE_PER_BALL_FT = 0.09;

/**
 * How much of the chase a MAXIMALLY skilled AI gives up. FEEL KNOB. 0.55 means a
 * difficulty-1 batter chases 45 % as far off the plate as a difficulty-0 one —
 * plate discipline is the second thing difficulty buys the AI at the plate, and
 * it is the one a human notices, because it is what turns a 3-1 count into a
 * walk instead of a weak fly.
 */
export const AI_CHASE_DISCIPLINE = 0.55;

/**
 * Chance the AI takes a pitch it read as a strike, before two strikes. FEEL
 * KNOB. Without it the AI swings at literally every strike, which reads as a
 * machine rather than a hitter and makes a first-pitch strike free.
 */
export const AI_TAKE_STRIKE_PROB = 0.28;

/**
 * The AI's timing spread as a MULTIPLE of the bat's own contact half-window, at
 * difficulty 0 and 1. FEEL KNOBS on a DERIVED scale — `contactWindowS` inverts
 * `contactGeometry` for the pitch actually thrown, so this tracks the bat's
 * geometry and the pitch's speed instead of a hard-coded millisecond count.
 *
 * The strong end is deliberately NOT 1.0 or below: an AI that never misses a
 * swing is not a difficulty setting, it is a wall.
 */
export const AI_TIMING_K_WEAK = 2.0;
export const AI_TIMING_K_STRONG = 1.25;

/**
 * The AI at the plate: swing or take, when, and where he put his hands.
 *
 * Six draws, taken before any branch — see the header.
 */
export function aiSwingDecision(
  draw: () => number,
  difficulty: number,
  ctx: SwingContext,
): SwingDecision {
  const d0 = draw();
  const d1 = draw();
  const d2 = draw();
  const d3 = draw();
  const d4 = draw();
  const d5 = draw();
  const k = clamp(difficulty, 0, 1);

  // (1) THE DECISION, made late and therefore on a good read.
  const sight = lerp(AI_SIGHT_WEAK_FT, AI_SIGHT_STRONG_FT, k);
  const seenX = ctx.plateX + signed(d0) * sight;
  const seenH = ctx.plateH + signed(d1) * sight;
  const chase =
    Math.max(
      0,
      AI_CHASE_BASE_FT + AI_CHASE_PER_STRIKE_FT * ctx.strikes - AI_CHASE_PER_BALL_FT * ctx.balls,
    ) *
    (1 - AI_CHASE_DISCIPLINE * k);
  // `missDistance` is 0 for a pitch he read as a strike, so this is "swing at
  // everything you think is a strike, plus `chase` feet of everything else".
  let swing = missDistance(seenX, seenH) <= chase;
  // …and take the odd strike, but never with two.
  if (swing && missDistance(seenX, seenH) === 0 && ctx.strikes < STRIKES_FOR_K - 1) {
    if (d2 < AI_TAKE_STRIKE_PROB) swing = false;
  }

  // (2) THE HANDS, committed early and therefore on a GUESS he only partly
  // adjusted. This is the reticle, and it is a different number from (1).
  const guessX = ZONE_CENTER.x + signed(d3) * AI_GUESS_SPREAD_X_FT;
  const guessH = ZONE_CENTER.h + signed(d4) * AI_GUESS_SPREAD_H_FT;
  const read = lerp(AI_READ_WEAK, AI_READ_STRONG, k);
  const reticleX = guessX + read * (ctx.plateX - guessX);
  const reticleH = guessH + read * (ctx.plateH - guessH);

  const window = contactWindowS(ctx.plateSpeedFps, ctx.batSpeedMph);
  const spread = window * lerp(AI_TIMING_K_WEAK, AI_TIMING_K_STRONG, k);
  return {
    swing,
    tapTimeS: swing ? ctx.plateT + signed(d5) * spread : null,
    reticleX,
    reticleH,
  };
}

// ---------------------------------------------------------------------------
// THE FIELD
// ---------------------------------------------------------------------------

/**
 * The AI's defensive rating for `fielding.fieldBattedBall`. FEEL KNOBS, and one
 * scalar because `fielding.ts` takes exactly one and may never be made to take
 * more — its `DEFENSE_SPAN` note is the rule this respects. 0.2 → 0.85 spans
 * most of the ±15 % reach band, worth roughly ±8 ft on a four-second fly.
 */
export const AI_DEFENSE_WEAK = 0.2;
export const AI_DEFENSE_STRONG = 0.85;

export const aiDefenseRating = (difficulty: number): number =>
  lerp(AI_DEFENSE_WEAK, AI_DEFENSE_STRONG, difficulty);
