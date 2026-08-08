// Shared "real green" putting physics — the Stimpmeter friction model, its
// roll-out calibration, and speed-dependent cup capture. Pure math: no three,
// no canvas, no sim state — safe to import from any sim or scene.
//
// WHY THIS EXISTS. There are two putting implementations in the game — the
// Course green (courseSim/CourseGL) and the standalone Mini-Golf mode
// (puttSim/PuttGL) — and they had drifted into two hand-tuned engines. The
// Course green now sources its green speed, roll friction and cup capture from
// HERE so the numbers are principled (calibrated off the Stimpmeter, not
// guessed) and can be shared. Mini-Golf is still an arcade model (flat, unit-
// less, walls, no slopes) so it does not consume these yet; when it is brought
// onto a real heightfield it should adopt these same helpers instead of forking
// a second set of constants.

// --- Green speed (Stimpmeter) → rolling friction ---------------------------
//
// The Stimpmeter reads a green's speed as the distance (FEET) a ball rolls from
// a fixed launch. On the flat, a rolling ball decelerates at a = g·μ (Coulomb
// friction), so roll-out distance d = v²/(2·g·μ). Calibrating that against the
// Stimpmeter gives μ ≈ 0.611 / stimp(ft): a faster green (higher stimp) has a
// LOWER μ and the ball rolls further for the same launch speed.
//
// ~9–11 is a pleasant members' green; 12+ is tournament-fast. This is THE dial
// for how far a putt rolls.
export const GREEN_STIMP = 10;

// Coulomb friction coefficient μ for a green of the given Stimpmeter speed.
export function frictionCoef(stimp: number = GREEN_STIMP): number {
  return 0.611 / stimp;
}

// Rolling deceleration a = g·μ (world-units/s²) on a flat green. `gravity` is
// the SIM's tuned gravity constant (the golf world is yard-space and does NOT
// use 9.8 — it is tuned for ball flight), passed in so the green friction and
// the slope-break acceleration share one, internally-consistent g.
export function greenRollDecel(gravity: number, stimp: number = GREEN_STIMP): number {
  return gravity * frictionCoef(stimp);
}

// Flat-green roll-out distance for a launch speed v, given the rolling decel a:
// d = v²/(2a). Its inverse `launchSpeedForRoll` turns a TARGET roll distance
// into the launch speed to calibrate a putt's power band.
export function rollOutDistance(v: number, decel: number): number {
  return (v * v) / (2 * decel);
}
export function launchSpeedForRoll(dist: number, decel: number): number {
  return Math.sqrt(2 * decel * Math.max(0, dist));
}

// --- Speed-dependent cup capture -------------------------------------------
//
// A ball does NOT simply "hole if it is within the cup". It holes only if it is
// (a) slower than a capture limit AND (b) within an EFFECTIVE radius that
// SHRINKS as speed rises: a dead-weight ball drops from anywhere over the cup, a
// quicker one only if it is nearly dead-centre, and anything at/over the limit
// lips out or rolls straight over. Research puts the real capture limit near
// 1.3–1.6 m/s for a regulation 108 mm cup; in the sim's yard-space that is
// ~1.6 yd/s (≈1.46 m/s).
export const CUP_CAPTURE_SPEED = 1.6;

// True if a ball `distToCup` from the pin, travelling at `speed`, is captured by
// a cup of radius `cupR`. Replaces the old pure within-radius test.
export function cupCaptured(distToCup: number, speed: number, cupR: number): boolean {
  if (speed >= CUP_CAPTURE_SPEED) return false;
  // frac: 1 at a standstill → 0 at the capture limit.
  const frac = 1 - speed / CUP_CAPTURE_SPEED;
  return distToCup <= cupR * frac;
}
