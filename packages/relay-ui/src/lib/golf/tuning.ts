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
