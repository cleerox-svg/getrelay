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

// --- Ball & cup scale (world units = yards) --------------------------------
//
// The play-scale radii of the golf ball and the hole — the SINGLE SOURCE OF
// TRUTH for both the physics (the sim captures a grounded ball against CUP_R)
// and the render (Phase 3 draws the ball at BALL_R and the cup at CUP_R, so what
// you see is what drops). A regulation ball is ~21.3 mm radius and a cup ~54 mm
// (ball ≈ 0.4× cup); at TRUE scale both are sub-pixel on a yard-space green, so
// these are INFLATED for readability while keeping that same ~0.4 ratio — the
// ball visibly fits INSIDE the cup and can fall in. Keep BALL_R < CUP_R.
export const CUP_R = 0.5;
export const BALL_R = 0.2;

// --- Speed-dependent cup capture -------------------------------------------
//
// A ball does NOT simply "hole if it is within the cup". It holes only if it is
// (a) slower than a capture limit AND (b) within an EFFECTIVE radius that
// SHRINKS as speed rises: a dead-weight ball drops from anywhere over the cup, a
// quicker one only if it is nearer dead-centre, and anything at/over the limit
// lips out or rolls straight over. Research puts the real capture limit near
// 1.3–1.6 m/s for a regulation 108 mm cup; in the sim's yard-space that is
// ~1.6 yd/s (≈1.46 m/s).
export const CUP_CAPTURE_SPEED = 1.6;

// True if a ball `distToCup` from the pin, travelling at `speed`, is captured by
// a cup of radius `cupR`. The effective radius follows an ELLIPTIC falloff
// r_eff = cupR·√(1 − (speed/limit)²): it stays near the full cup radius through
// the slow/normal pace band (so an on-line putt at holing pace RELIABLY drops —
// the locked design rule) and only collapses toward zero as the speed nears the
// capture limit (a genuinely too-fast putt lips out / rolls over). Softer than
// the old linear shrink, which pinched the window so tight that on-pace putts
// skimmed the rim without dropping.
export function cupCaptured(distToCup: number, speed: number, cupR: number): boolean {
  if (speed >= CUP_CAPTURE_SPEED) return false;
  const ratio = speed / CUP_CAPTURE_SPEED;
  const rEff = cupR * Math.sqrt(1 - ratio * ratio);
  return distToCup <= rEff;
}

// --- Flagstick (pin) collision --------------------------------------------
//
// The pin is ALWAYS in the hole (no in/out toggle). Its pole has a real physical
// radius — much smaller than the RENDER radius (render-only, per scene) but big
// enough that a firm strike catches it. When a ball's horizontal distance to the
// pin centre is within POLE_R + ball radius it has STRUCK the flagstick:
//   • a slow strike DROPS (the pin sits at the cup centre, so the ordinary
//     cupCaptured() rule holes it — a dead-weight putt/approach that catches the
//     pin dead-centre falls in); a strike is right over the cup, so the capture
//     window is at its widest.
//   • a faster strike DEFLECTS off the pole (poleDeflect below) and stays out —
//     the classic "rattled the flagstick and bounced away".
// A yard-space radius (~cup/6). The Mini-Golf sim rescales it by its own cup
// radius so the pole/cup RATIO is identical at mini scale (course + putt can't
// drift). Distinct from — and slightly larger than — the thin decorative render
// pole, so the ball reliably feels the pin instead of tunnelling the sub-inch
// true pole.
export const POLE_R = 0.08;

// Coefficient of restitution for a flagstick carom. A real fibreglass pin kills
// a lot of pace — the ball reverses only a fraction of its INBOUND (normal)
// speed and keeps its tangential glide. ~0.45 reads as a firm knock that clearly
// stays out without pinging away like a wall.
export const POLE_RESTITUTION = 0.45;

// Reflect a 2D velocity (v1,v2) about a unit normal (n1,n2) with restitution e:
// the component ALONG the normal reverses and is scaled by e (pace lost to the
// pole), the tangential component is preserved (the ball glances on). Returns the
// post-carom velocity components. Axis-agnostic — the caller names the axes
// (courseSim: d/x; puttSim: x/y). Pure math: no sim state, stays deterministic.
export function poleDeflect(
  v1: number,
  v2: number,
  n1: number,
  n2: number,
  restitution: number = POLE_RESTITUTION,
): { v1: number; v2: number } {
  const vn = v1 * n1 + v2 * n2; // inbound speed along the normal (< 0 = approaching)
  const j = (1 + restitution) * vn;
  return { v1: v1 - j * n1, v2: v2 - j * n2 };
}

// SWEPT collision of a moving point (the ball's centre travelling prev→cur this
// substep) against the pin, treated as a circle of radius R = POLE_R + ball
// radius centred at (c1,c2). A single per-substep POINT test (dist(cur,pin) ≤ R)
// misses a fast strike: at > ~2R·stepRate the ball steps clean OVER the ~0.56-yd
// pin zone in one substep and tunnels through undeflected. This tests the whole
// segment instead, so the pin is live for powered approach shots / liners too.
// Returns:
//   • minDist    — the closest the segment passes to the pin centre (the hit
//                  test is minDist ≤ R, and the capture test reads this distance);
//   • approaching — was the point moving TOWARD the pin at the start of the
//                  segment (d/dt |P−pin|² < 0)? Only carom when true, so a ball
//                  sitting at / leaving the pin isn't shoved by a pole it's
//                  departing (the inbound guard, generalised to the swept case);
//   • (n1,n2)    — the unit contact NORMAL (pin→first-contact point, i.e. where
//                  the segment first crosses radius R) for the reflection, so the
//                  bounce uses a real inbound normal instead of the near-tangent
//                  normal at closest approach.
// Pure geometry; both sims share it. Axis-agnostic (course d/x, putt x/y).
export interface PoleSweep {
  minDist: number;
  approaching: boolean;
  n1: number;
  n2: number;
}
export function poleSweep(
  prev1: number,
  prev2: number,
  cur1: number,
  cur2: number,
  c1: number,
  c2: number,
  R: number,
): PoleSweep {
  const e1 = prev1 - c1; // prev − centre
  const e2 = prev2 - c2;
  const d1 = cur1 - prev1; // travel this substep
  const d2 = cur2 - prev2;
  const A = d1 * d1 + d2 * d2;
  const ed = e1 * d1 + e2 * d2;
  // Closest approach: minimise |e + t·d| over t∈[0,1] → t = −(e·d)/|d|².
  let tC = A > 1e-12 ? -ed / A : 0;
  tC = tC < 0 ? 0 : tC > 1 ? 1 : tC;
  const cp1 = e1 + tC * d1;
  const cp2 = e2 + tC * d2;
  const minDist = Math.hypot(cp1, cp2);
  const approaching = ed < 0; // distance to the centre decreasing at t=0
  // First contact: smallest t with |e + t·d| = R (the entry to the pin circle).
  // If prev already sits inside R (C ≤ 0) the entry is at/behind t=0 → use t=0.
  const C = e1 * e1 + e2 * e2 - R * R;
  let tHit = 0;
  if (C > 0 && A > 1e-12) {
    const B = 2 * ed;
    const disc = Math.max(0, B * B - 4 * A * C);
    tHit = (-B - Math.sqrt(disc)) / (2 * A);
    tHit = tHit < 0 ? 0 : tHit > 1 ? 1 : tHit;
  }
  let n1 = e1 + tHit * d1;
  let n2 = e2 + tHit * d2;
  const nl = Math.hypot(n1, n2);
  if (nl > 1e-6) {
    n1 /= nl;
    n2 /= nl;
  } else {
    n1 = 1;
    n2 = 0;
  }
  return { minDist, approaching, n1, n2 };
}
