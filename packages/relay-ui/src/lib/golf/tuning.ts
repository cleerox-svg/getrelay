// Every tunable number for the Golf mini game lives here so the feel
// can be rebalanced without spelunking through the engine, the mode
// modules or the components.
//
// SCORING MUST MIRROR THE WORKER CLAMPS on POST /game/score: at most
// 8 holes (rounds) and at most 2000 points per hole. HOLES stays <= 8
// and holePoints() is clamped to MAX_HOLE_POINTS — if the client could
// produce more, the server would silently clip it and the local "best"
// would disagree with the leaderboard.

// --- Physics (all in the 100x125 virtual coordinate space) ---

// Fixed-timestep cadence: the simulation advances in 1/120s substeps so
// a fast putt integrates finely enough not to tunnel through a wall.
export const FIXED_MS = 1000 / 120;

// Per-substep exponential green friction. Applied as FRICTION**(h*60)
// (h in seconds) so the decay is framerate-independent: the ball loses
// the same fraction of speed per wall-clock second regardless of how
// many substeps ran.
export const FRICTION = 0.97;

// Wall bounce energy retention (<1 so a putt always settles).
export const RESTITUTION = 0.7;

// Below this speed (virtual units/sec) the ball is snapped to rest.
export const REST_EPS = 1.5;

// A ball crossing the cup slower than this drops in; faster lips out.
export const CAPTURE_SPEED = 60;

// Sideways/inward nudge felt over the cup rim on a lip-out, so a
// too-fast ball visibly curls instead of rolling dead straight over it.
export const LIP_KICK = 40;

// Launch speed at full pull (virtual units/sec). Tuned so a full-power
// putt can just cross the long axis of the board and overshoot.
export const MAX_LAUNCH_SPEED = 240;

// Aim drag geometry, in CSS pixels of finger travel.
export const MAX_PULL = 170;
export const MIN_PULL = 8;

// --- Elastic ("slingshot") power response ---------------------------------
// The RAW pull fraction (|drag| / maxPull, clamped 0..1) is shaped by this
// NEAR-LINEAR curve BEFORE it becomes shot power. The aiming camera now frames
// the ball high enough that a full swing gets ~180–240px of downward pull travel
// (see applyPull in CourseGL/RangeGL), so the curve no longer has to cram the
// whole range into a cramped drag. It's a GENTLE ease-out (EXP just above 1) so
// the MIDDLE is dialable — ~50% pull ≈ ~50% power — with only a mild strain in
// the last stretch to 100% (the elastic feel is carried by the VISUAL cues, not
// a twitchy curve). The maps are exact at the ends — f(0)=0, f(1)=1 — so a FULL
// pull is still power=1 and every club's full-power carry (and the whole ladder)
// is UNCHANGED. Pure function of the pull, so the sim stays deterministic.
//   f(t)     = 1 − (1 − t)^EXP          (EXP > 1 → gentle ease-out near the top)
//   f⁻¹(p)   = 1 − (1 − p)^(1/EXP)      (used by tools/tests to hit a given power)
// EXP 1.15 gives: 0.1→0.11, 0.25→0.28, 0.5→0.55, 0.65→0.70, 0.75→0.80,
//   0.9→0.93, 1→1.00 (dialable middle; a soft strain up top).
export const POWER_CURVE_EXP = 1.15;
export function powerCurve(pullFrac: number): number {
  const t = Math.max(0, Math.min(1, pullFrac));
  return 1 - Math.pow(1 - t, POWER_CURVE_EXP);
}
export function powerCurveInv(power: number): number {
  const p = Math.max(0, Math.min(1, power));
  return 1 - Math.pow(1 - p, 1 / POWER_CURVE_EXP);
}

// Radii in virtual units.
export const BALL_R = 1.6;
export const CUP_R = 2.8;

// --- Scoring ---

// Number of holes in a round. MUST stay <= 8 (the worker's rounds clamp).
export const HOLES = 6;

// Driving-range Target Challenge: balls per round. Doubles as the "rounds"
// value submitted to the worker, so it MUST stay <= 8 (the rounds clamp);
// with the per-shot ceiling at MAX_HOLE_POINTS the round total can't exceed
// the server's rounds*2000 cap.
export const RANGE_BALLS = 8;

// Per-hole point ceiling — mirrors the server (score <= rounds * 2000).
export const MAX_HOLE_POINTS = 2000;
const MIN_HOLE_POINTS = 200;

const BASE = 1000;
const PER_STROKE = 350;
const ACE_BONUS = 500;

// Points for finishing a hole: a flat base, a bonus/penalty for each
// stroke under/over par, and a hole-in-one bonus, clamped to the
// worker-mirrored [MIN, MAX] band.
export function holePoints(strokes: number, par: number): number {
  const pts = BASE + (par - strokes) * PER_STROKE + (strokes === 1 ? ACE_BONUS : 0);
  return Math.min(MAX_HOLE_POINTS, Math.max(MIN_HOLE_POINTS, pts));
}
