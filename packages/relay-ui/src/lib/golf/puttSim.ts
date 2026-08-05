// Headless mini-golf putting simulation — pure physics, input mapping,
// state and events, with NO canvas or rendering. PuttGL
// (components/golf/PuttGL.tsx) owns the Three.js scene and drives this sim
// on a fixed-timestep loop; the React HUD (components/golf/GolfGame.tsx)
// reacts to its events for stroke/hole scoring.
//
// This is the top-down putting physics lifted out of the old 2D
// PuttingMode: everything runs in the 100x125 virtual coordinate space the
// course data (lib/golf/course.ts) is authored in — `x` right, `y` down.
// The renderer maps that flat onto the 3D ground plane (X = x, Z = y).
//
// Fixed-timestep integration, exponential green friction, segment wall
// reflection (depenetrate + reflect, RESTITUTION < 1), cup capture (sink if
// slow, lip-out if fast) and rest detection are all identical in feel to
// the retired Canvas-2D mode — only the input plumbing changed: aim points
// arrive in VIRTUAL ground coordinates (raycast from the pointer by the 3D
// component) while power still comes from a CSS-pixel drag length so the
// MAX_PULL feel is screen-relative and camera-independent.

import {
  BALL_R,
  CAPTURE_SPEED,
  FRICTION,
  LIP_KICK,
  MAX_LAUNCH_SPEED,
  MAX_PULL,
  MIN_PULL,
  REST_EPS,
  RESTITUTION,
} from './tuning';

export interface Vec {
  x: number;
  y: number;
}

// A wall segment the ball bounces off (border loop + obstacle baffles).
export interface Wall {
  a: Vec;
  b: Vec;
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

export interface Hole {
  id: number;
  par: number;
  tee: Vec;
  cup: Cup;
  walls: Wall[];
  greens: Green[];
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
    const ball = this.ball;
    if (ball.resting) return;

    // Integrate.
    ball.pos = add(ball.pos, scale(ball.vel, h));

    // Exponential green friction, framerate-independent.
    const decay = Math.pow(FRICTION, h * 60);
    ball.vel = scale(ball.vel, decay);

    // Wall collisions: depenetrate + reflect (only when moving inward).
    for (const w of this.hole.walls) {
      const cp = closestPointOnSegment(ball.pos, w.a, w.b);
      const d = sub(ball.pos, cp);
      const dist = len(d);
      if (dist >= ball.r) continue;
      const n = dist > 1e-6 ? scale(d, 1 / dist) : { x: 0, y: -1 };
      // Push the ball back out to just touching the wall.
      ball.pos = add(ball.pos, scale(n, ball.r - dist));
      const vn = dot(ball.vel, n);
      if (vn < 0) {
        // Reflect the inward component with restitution.
        ball.vel = sub(ball.vel, scale(n, (1 + RESTITUTION) * vn));
      }
    }

    // Cup interaction.
    const dc = sub(this.hole.cup.c, ball.pos);
    const cupDist = len(dc);
    const speed = len(ball.vel);
    if (cupDist <= this.hole.cup.r) {
      if (speed <= CAPTURE_SPEED) {
        ball.pos = { x: this.hole.cup.c.x, y: this.hole.cup.c.y };
        ball.vel = { x: 0, y: 0 };
        ball.resting = true;
        this.events.push({ type: 'sink' });
        return;
      }
      // Lip-out: an inward tug proportional to rim depth curls a too-fast
      // ball toward the hole without stopping it.
      const depth = (this.hole.cup.r - cupDist) / this.hole.cup.r;
      const toCenter = cupDist > 1e-6 ? scale(dc, 1 / cupDist) : { x: 0, y: 0 };
      ball.vel = add(ball.vel, scale(toCenter, LIP_KICK * depth * (h * 60)));
    }

    // Rest threshold.
    if (len(ball.vel) <= REST_EPS) {
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
