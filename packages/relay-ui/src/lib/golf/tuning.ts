// Every tunable number for the Golf mini game lives here so the feel
// can be rebalanced without spelunking through the engine, the mode
// modules or the components.
//
// SCORING MUST MIRROR THE WORKER CLAMPS on POST /game/score: at most
// 8 holes (rounds) and at most 2000 points per hole. HOLES stays <= 8
// and holePoints() is clamped to MAX_HOLE_POINTS — if the client could
// produce more, the server would silently clip it and the local "best"
// would disagree with the leaderboard.

import { greenRollDecel } from './greenPhysics';

// --- Physics (all in the 100x125 virtual coordinate space) ---

// Fixed-timestep cadence: the simulation advances in 1/120s substeps so
// a fast putt integrates finely enough not to tunnel through a wall.
export const FIXED_MS = 1000 / 120;

// Wall bounce energy retention (<1 so a putt always settles).
export const RESTITUTION = 0.7;

// --- Banked rails ----------------------------------------------------------
// A banked wall (Wall.bank) is a lively rail that keeps a ball moving ALONG it
// rather than caroming off at the mirror angle. On contact it reflects the
// inward velocity with a HIGHER restitution than a plain wall, then STEERS the
// post-bounce velocity a fraction toward the rail's tangent (the direction the
// ball is already travelling along the wall). The steer is a deterministic
// slerp-by-blend of unit vectors, speed preserved — so the ball hugs and runs
// the rail. BANK_STEER 0 = plain reflection; 1 = fully redirected along the rail.
export const BANK_RESTITUTION = 0.88;
export const BANK_STEER = 0.4;

// Below this speed (virtual units/sec) the ball is a candidate for rest — it is
// only actually snapped to rest if the local slope is also shallow enough for
// static friction to HOLD it (see PUTT_STATIC_HOLD). A dying putt rolls its
// last inch before this trips.
export const REST_EPS = 3.5;

// Sideways/inward nudge felt over the cup rim on a lip-out, so a
// too-fast ball visibly curls instead of rolling dead straight over it.
export const LIP_KICK = 40;

// Launch speed at full pull (virtual units/sec). Tuned so a full-power
// putt can just cross the long axis of the board (tee→cup ≈ 80 units) and
// overshoot: flat roll-out d = v²/(2·PUTT_DECEL) ≈ 240²/(2·192) ≈ 150 units.
export const MAX_LAUNCH_SPEED = 240;

// --- Mini-golf slope physics (the "real mini-put" engine) ------------------
// The putting board is the 100x125 virtual space with CUP_R=2.8 (below). These
// mirror the way the Course green is calibrated (greenPhysics.ts) but at
// MINI-GOLF SCALE — the Course constants are yard-space (CUP_R=0.5, GRAVITY=16)
// and must NOT be reused directly (~8× scale difference). greenPhysics's
// FUNCTIONS are reused, its CONSTANTS are not.
//
// PUTT_GRAVITY is the sim's slope-gravity scale. It is not 9.8 (nor the
// yard-space 16) — it is chosen together with PUTT_STIMP so the Coulomb roll
// decel lands the full-power roll-out (~150 units) and gives a satisfyingly
// strong break at mini-golf scale. Only two ratios actually drive feel, and
// PUTT_GRAVITY cancels from BOTH:
//   • break strength  = slopeAccel/decel = grade/μ   (independent of gravity);
//   • max holdable grade = μ·STATIC_HOLD_FACTOR      (independent of gravity).
// So PUTT_STIMP (→ μ) sets how hard a given grade breaks a putt and how steep a
// slope can still hold a rest; PUTT_GRAVITY only sets the absolute time-scale of
// the slope term against the launch speed / decel (i.e. the roll-out distance).
export const PUTT_GRAVITY = 3150;

// Green speed (Stimpmeter). μ = 0.611/stimp ≈ 0.0611 at 10 → a resting putt can
// only hold where grade ≲ μ·STATIC_HOLD_FACTOR ≈ 7.9%. Mini-golf carpet is
// quick, so 10 gives a lively break while still letting mild slopes settle.
export const PUTT_STIMP = 10;

// Coulomb constant roll deceleration (virtual units/s²), derived — NOT guessed —
// from the shared Stimpmeter model: a = gravity·μ = greenRollDecel(g, stimp).
// The ball's speed drops by PUTT_DECEL·h each substep (clamped at 0), so a
// slower ball breaks MORE (constant decel while the slope-accel bends a shrinking
// velocity) — the "a dying putt breaks hardest" behaviour, emergent, unscripted.
export const PUTT_DECEL = greenRollDecel(PUTT_GRAVITY, PUTT_STIMP);

// STATIC friction exceeds kinetic (a stopped ball resists starting more than a
// moving one resists continuing). A ball rolls to rest at the kinetic-repose
// contour, then static friction HOLDS it — so it does NOT creep forever down a
// legit slope. The rest gate holds where |slopeAccel| ≤ PUTT_STATIC_HOLD; a
// steeper bank keeps the ball rolling. ~1.3 is a typical grass static/kinetic
// ratio (mirrors courseSim's STATIC_HOLD_FACTOR).
export const STATIC_HOLD_FACTOR = 1.3;
export const PUTT_STATIC_HOLD = PUTT_DECEL * STATIC_HOLD_FACTOR;

// Cup capture (mini scale). A ball crossing the cup holes only if it is BOTH
// slow enough AND within an effective radius that shrinks with speed — the
// shared greenPhysics.cupCaptured() elliptic falloff. That helper's speed
// threshold is yard-space (1.6 yd/s), so the sim rescales the mini speed by
// CUP_CAPTURE_SPEED/PUTT_CAPTURE_SPEED before calling it: a putt at exactly
// PUTT_CAPTURE_SPEED maps to the helper's limit (lips out), and anything slower
// is captured within the elliptic radius. ~90 units/s ≈ a putt that would
// overrun the cup by ~21 units still drops (forgiving but not a magnet).
export const PUTT_CAPTURE_SPEED = 90;

// --- Moving obstacles + hazards (Phase 2) ----------------------------------
// All obstacle motion is a pure function of the sim's deterministic simTime, so
// these only tune FEEL, never determinism.
//
// Blade/arm bounce: a windmill blade or pendulum arm reflects the ball like a
// lively wall (its own restitution) AND imparts its surface velocity at the
// contact point (ω × r) so a swinging blade can KNOCK the ball. BLADE_RESTITUTION
// mirrors the plain-wall RESTITUTION (a blade is a solid barrier, not a springy
// bumper); the imparted surface speed is CLAMPED to BLADE_MAX_SURFACE_SPEED so a
// fast blade gives a satisfying shove without flinging the ball off the board
// (a bit under MAX_LAUNCH_SPEED).
export const BLADE_RESTITUTION = 0.7;
export const BLADE_MAX_SURFACE_SPEED = 130;

// Tunnel re-entry guard: after a portal teleport the ball is placed just past
// the exit mouth, but if the two mouths sit close together it could immediately
// cross back. For PORTAL_COOLDOWN seconds of SIM time after a teleport the sim
// skips all tunnel checks, so it can't ping-pong within a shot. simTime-based →
// deterministic. ~0.18s ≈ a couple of substeps of clearance at any pace.
export const PORTAL_COOLDOWN = 0.18;

// Sand hazard: while the ball is over a sand region it decelerates at
// PUTT_DECEL·PUTT_SAND_DECEL_MULT (a HIGHER effective Coulomb decel — same
// constant-decel model, no second friction system), so it bogs down and stops
// short. ~4× reads as heavy sand while still letting a firm putt escape.
export const PUTT_SAND_DECEL_MULT = 4;

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

// Legacy round length for Mini-Golf. The scored round now drives off the
// actual course's hole count (GolfGame iterates `course.holes.length`), so this
// constant only backs GolfScreen's "ended early — n/HOLES" copy. It MUST equal
// the DEFAULT mini-golf course length (puttCourses GARDEN = 8 holes) and stay
// <= 8 (the worker's rounds clamp). Kept a literal (not an import of GARDEN) to
// avoid a tuning↔puttCourses↔builder circular import; puttCourses.test.ts
// asserts GARDEN has exactly HOLES holes so the two can never silently drift.
export const HOLES = 8;

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
