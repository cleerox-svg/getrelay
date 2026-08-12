// Headless mini-golf putting simulation — pure physics, input mapping,
// state and events, with NO canvas or rendering. PuttGL
// (components/golf/PuttGL.tsx) owns the Three.js scene and drives this sim
// on a fixed-timestep loop; the React HUD (components/golf/GolfGame.tsx)
// reacts to its events for stroke/hole scoring.
//
// Everything runs in the 100x125 virtual coordinate space the course data
// (lib/golf/puttCourses/*) is authored in — `x` right, `y` DOWN. The
// renderer maps that flat onto the 3D ground plane (X = x, Z = y).
//
// PHYSICS — real "mini-put" (revamped from the old flat arcade engine):
//   • Coulomb constant deceleration (speed -= PUTT_DECEL·h, clamped 0),
//     derived from the shared Stimpmeter model (greenPhysics.greenRollDecel)
//     — NOT the old exponential friction. So a slower ball breaks MORE.
//   • Slopes are PHYSICS-COUPLED: each grounded substep adds
//     puttSlopeAccel(hole,...) (puttField.ts) — the break, the downhill
//     run-out and the uphill check, all one term. Tilt planes + ramps +
//     undulation are a per-hole slope schema (see puttField.ts / the Hole
//     fields below).
//   • ONE static-rest rule (mirrors courseSim): rest only when the ball is
//     BOTH slow (speed ≤ REST_EPS) AND on a slope static friction can hold
//     (|slopeAccel| ≤ PUTT_STATIC_HOLD). A ball rests on a mild slope; on a
//     steep bank it keeps creeping/rolling.
//   • Speed-dependent cup capture via the shared greenPhysics.cupCaptured
//     (elliptic falloff), rescaled to mini speeds by PUTT_CAPTURE_SPEED.
//   • KEPT from the arcade engine: wall depenetrate+reflect+restitution (bank
//     shots), the slingshot input mapping, the event queue, and the fixed
//     substep loop. Banked rails (Wall.bank) additionally STEER the ball along
//     the rail (see the wall loop).
//   • A deterministic simTime accumulator (advanced by h each substep, even at
//     rest) so future moving obstacles (Phase 2) are a pure function of sim
//     time, never wall-clock — keeping vitest reproducible.
//
// Aim points arrive in VIRTUAL ground coordinates (raycast from the pointer by
// the 3D component); power comes from a CSS-pixel drag length so the MAX_PULL
// feel is screen-relative and camera-independent.

import {
  BALL_R,
  LIP_KICK,
  MAX_LAUNCH_SPEED,
  MAX_PULL,
  MIN_PULL,
  REST_EPS,
  RESTITUTION,
  BANK_RESTITUTION,
  BANK_STEER,
  PUTT_GRAVITY,
  PUTT_DECEL,
  PUTT_STATIC_HOLD,
  PUTT_CAPTURE_SPEED,
} from './tuning';
import { cupCaptured, CUP_CAPTURE_SPEED } from './greenPhysics';
import { puttSlopeAccel, type Ramp, type SlopePlane } from './puttField';

export interface Vec {
  x: number;
  y: number;
}

// A wall segment the ball bounces off (border loop + obstacle baffles). A
// `bank` wall is a lively banked RAIL: it reflects with a higher restitution
// and steers the ball to run ALONG the rail (see substep's wall loop).
export interface Wall {
  a: Vec;
  b: Vec;
  bank?: boolean;
}

// The hole target: centre + capture radius.
export interface Cup {
  c: Vec;
  r: number;
}

// Cosmetic rounded-rect fairway fill (virtual units) — the mown putting
// surface. The 3D renderer lays each as a striped turf panel.
export interface Green {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

// --- Hazards (region + kind). Phase 1 carries the DATA (authored + validated
// in bounds) but does NOT yet run hazard physics — that is Phase 2. Kept
// axis-aligned for a terse, checkable schema. ------------------------------
export interface Hazard {
  kind: 'water' | 'sand';
  region: { x0: number; y0: number; x1: number; y1: number };
}

// --- Moving obstacles (Phase 2 STUB). A minimal, clearly-typed placeholder
// union so the Hole shape and the authoring/validation layer are forward-
// compatible; NO moving-obstacle physics runs in this slice. Phase 2 will drive
// each from the deterministic simTime accumulator. ------------------------
export interface WindmillObstacle {
  kind: 'windmill';
  pivot: Vec;
  blades: number;
  bladeLen: number;
  omega: number; // rad/s about the pivot, phase = omega·simTime
}
export interface PendulumObstacle {
  kind: 'pendulum';
  pivot: Vec;
  length: number;
  amp: number; // swing amplitude (rad)
  omega: number; // rad/s
}
export interface PortalObstacle {
  kind: 'portal';
  a: Vec;
  b: Vec; // ball entering mouth `a` re-emerges at `b` (and vice-versa)
  r: number;
}
export type Obstacle = WindmillObstacle | PendulumObstacle | PortalObstacle;

export interface Hole {
  id: number;
  par: number;
  tee: Vec;
  cup: Cup;
  walls: Wall[];
  greens: Green[];
  // --- Optional, additive (existing holes work with these absent) ---
  name?: string;
  theme?: string;
  // Slope schema (puttField.ts): tilt planes break the putt, ramps raise/lower
  // it, undulation is a gentle board-wide wobble amplitude.
  tilts?: SlopePlane[];
  ramps?: Ramp[];
  undulation?: number;
  // Reset+penalty / slow zones — DATA only in Phase 1 (physics is Phase 2).
  hazards?: Hazard[];
  // Moving colliders — Phase 2 STUB (no physics yet).
  obstacles?: Obstacle[];
}

// The live ball. Mutated in place; PuttGL reads it every frame (no alloc).
export interface Ball {
  pos: Vec;
  vel: Vec;
  r: number;
  resting: boolean;
}

export type PuttEventType = 'stroke' | 'sink' | 'rest';
export interface PuttEvent {
  type: PuttEventType;
}

// Aim/state snapshot for the renderer's in-scene aim line + power meter.
export interface PuttState {
  resting: boolean;
  aiming: boolean;
  // Power 0..1 (screen-drag length clamped to MAX_PULL).
  power: number;
  // Unit launch direction in VIRTUAL ground space (only meaningful while
  // aiming with power > 0); the ball travels this way on release.
  aimX: number;
  aimY: number;
}

const EMPTY_EVENTS: readonly PuttEvent[] = Object.freeze([]);

// Rescale a mini-scale speed into the yard-space band greenPhysics.cupCaptured
// expects, so PUTT_CAPTURE_SPEED maps onto the helper's internal limit.
const CAPTURE_SPEED_SCALE = CUP_CAPTURE_SPEED / PUTT_CAPTURE_SPEED;

// Minimal Vec math (subset of the retired engine's helpers).
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
const len = (a: Vec): number => Math.hypot(a.x, a.y);
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y;
function normalize(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y);
  return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
}
// Nearest point to `p` on segment a->b, clamped to the endpoints.
function closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-9) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: a.x + abx * t, y: a.y + aby * t };
}

export class PuttSim {
  private readonly hole: Hole;

  // Public so the renderer can read the ball position each frame (no alloc).
  readonly ball: Ball;

  // Deterministic accumulated sim time (seconds), advanced by h EVERY substep
  // (even while the ball rests / the player aims) so Phase-2 moving obstacles
  // are a pure function of it and the renderer reads the same phase. Public
  // read-only for the scene; reset on construction.
  private _simTime = 0;
  get simTime(): number {
    return this._simTime;
  }

  // Aim state. `dragStart` is the virtual ground point first grabbed; while
  // aiming `aim` is the unit launch direction and `power` its 0..1 strength.
  private aiming = false;
  private dragStart: Vec = { x: 0, y: 0 };
  private aim: Vec = { x: 0, y: 0 };
  private power = 0;

  // Event queue, drained by the renderer once per frame.
  private events: PuttEvent[] = [];

  constructor(hole: Hole) {
    this.hole = hole;
    this._simTime = 0;
    this.ball = {
      pos: { x: hole.tee.x, y: hole.tee.y },
      vel: { x: 0, y: 0 },
      r: BALL_R,
      resting: true,
    };
  }

  getState(): PuttState {
    return {
      resting: this.ball.resting,
      aiming: this.aiming,
      power: this.power,
      aimX: this.aim.x,
      aimY: this.aim.y,
    };
  }

  drainEvents(): readonly PuttEvent[] {
    if (this.events.length === 0) return EMPTY_EVENTS;
    const out = this.events;
    this.events = [];
    return out;
  }

  // --- Simulation ------------------------------------------------------

  substep(h: number): void {
    // Sim clock advances every substep, even at rest (Phase-2 obstacles read
    // it), so the world keeps a single deterministic timeline.
    this._simTime += h;

    const ball = this.ball;
    if (ball.resting) return;

    // Slope acceleration at the CURRENT position — the break / downhill run /
    // uphill check. Sampled once and reused for the rest-hold test below, so
    // the "can it settle here?" gate sees the same slope the ball is rolling on.
    const { ax, ay } = puttSlopeAccel(this.hole, ball.pos.x, ball.pos.y, PUTT_GRAVITY);
    ball.vel = { x: ball.vel.x + ax * h, y: ball.vel.y + ay * h };

    // Coulomb constant deceleration: shave PUTT_DECEL·h off the SPEED (clamped
    // at 0), direction preserved. Constant decel while the slope bends a
    // shrinking velocity → a dying putt breaks hardest (emergent).
    const preSpeed = len(ball.vel);
    if (preSpeed > 1e-6) {
      const k = Math.max(0, (preSpeed - PUTT_DECEL * h) / preSpeed);
      ball.vel = scale(ball.vel, k);
    }

    // Integrate.
    ball.pos = add(ball.pos, scale(ball.vel, h));

    // Wall collisions: depenetrate + reflect (only when moving inward). A
    // banked rail additionally steers the ball to run ALONG the wall.
    for (const w of this.hole.walls) {
      const cp = closestPointOnSegment(ball.pos, w.a, w.b);
      const d = sub(ball.pos, cp);
      const dist = len(d);
      if (dist >= ball.r) continue;
      const n = dist > 1e-6 ? scale(d, 1 / dist) : { x: 0, y: -1 };
      // Push the ball back out to just touching the wall.
      ball.pos = add(ball.pos, scale(n, ball.r - dist));
      const vn = dot(ball.vel, n);
      if (vn >= 0) continue;
      if (w.bank) {
        // Banked rail: reflect with a livelier restitution, then blend the
        // post-bounce direction toward the rail's tangent (in the sense the
        // ball is already travelling) so it hugs and runs the rail.
        let v = sub(ball.vel, scale(n, (1 + BANK_RESTITUTION) * vn));
        const speed = len(v);
        if (speed > 1e-6) {
          const tan = normalize(sub(w.b, w.a));
          const s = dot(v, tan) >= 0 ? 1 : -1;
          const desired = scale(tan, s);
          const cur = scale(v, 1 / speed);
          const bx = cur.x + (desired.x - cur.x) * BANK_STEER;
          const by = cur.y + (desired.y - cur.y) * BANK_STEER;
          v = scale(normalize({ x: bx, y: by }), speed);
        }
        ball.vel = v;
      } else {
        // Plain wall: reflect the inward component with restitution.
        ball.vel = sub(ball.vel, scale(n, (1 + RESTITUTION) * vn));
      }
    }

    // Cup interaction. Elliptic, speed-dependent capture from the shared green
    // model (rescaled to mini speeds). A ball over the rim that is too fast to
    // capture still feels a lip-out tug so it visibly curls instead of rolling
    // dead straight over the hole.
    const dc = sub(this.hole.cup.c, ball.pos);
    const cupDist = len(dc);
    const speed = len(ball.vel);
    if (cupDist <= this.hole.cup.r) {
      if (cupCaptured(cupDist, speed * CAPTURE_SPEED_SCALE, this.hole.cup.r)) {
        ball.pos = { x: this.hole.cup.c.x, y: this.hole.cup.c.y };
        ball.vel = { x: 0, y: 0 };
        ball.resting = true;
        this.events.push({ type: 'sink' });
        return;
      }
      const depth = (this.hole.cup.r - cupDist) / this.hole.cup.r;
      const toCenter = cupDist > 1e-6 ? scale(dc, 1 / cupDist) : { x: 0, y: 0 };
      ball.vel = add(ball.vel, scale(toCenter, LIP_KICK * depth * (h * 60)));
    }

    // ONE static-rest rule (mirrors courseSim): settle only when the ball is
    // BOTH slow AND on a slope its static friction can hold. On a steeper bank
    // the slope keeps feeding it downhill, so it never falsely stops on a hill.
    if (len(ball.vel) <= REST_EPS && Math.hypot(ax, ay) <= PUTT_STATIC_HOLD) {
      ball.vel = { x: 0, y: 0 };
      ball.resting = true;
      this.events.push({ type: 'rest' });
    }
  }

  // --- Input (aim points arrive in VIRTUAL ground coords) --------------
  //
  // The grab-radius test (is the pointer on the ball?) lives in the 3D
  // component, which knows the ball's projected screen position; the sim
  // only gates on the ball being at rest. `pullPx` is the CSS-pixel drag
  // length, mapped to power through MAX_PULL so the feel is screen-relative.

  // Arm the shot at virtual point `vp`. Returns true if aiming started
  // (ball was at rest), so the caller can capture the pointer.
  onPointerDown(vp: Vec): boolean {
    if (!this.ball.resting) return false;
    this.aiming = true;
    this.dragStart = { x: vp.x, y: vp.y };
    this.aim = { x: 0, y: 0 };
    this.power = 0;
    return true;
  }

  onPointerMove(vp: Vec, pullPx: number): void {
    if (!this.aiming) return;
    // Direction: opposite the drag, i.e. from the current point back toward
    // the grab point (slingshot). Computed in the ground plane so it's
    // exact under any camera angle.
    this.aim = normalize(sub(this.dragStart, vp));
    this.power = Math.min(pullPx, MAX_PULL) / MAX_PULL;
  }

  onPointerUp(vp: Vec, pullPx: number): void {
    if (!this.aiming) return;
    this.aiming = false;
    // Sub-min-pull tap cancels the aim — no wasted stroke.
    if (pullPx < MIN_PULL) {
      this.aim = { x: 0, y: 0 };
      this.power = 0;
      return;
    }
    const dir = normalize(sub(this.dragStart, vp));
    const power = Math.min(pullPx, MAX_PULL) / MAX_PULL;
    this.ball.vel = scale(dir, power * MAX_LAUNCH_SPEED);
    this.ball.resting = false;
    this.aim = { x: 0, y: 0 };
    this.power = 0;
    this.events.push({ type: 'stroke' });
  }

  // Cancel any in-flight aim without launching (pause / pointer lost).
  cancelAim(): void {
    this.aiming = false;
    this.aim = { x: 0, y: 0 };
    this.power = 0;
  }
}
