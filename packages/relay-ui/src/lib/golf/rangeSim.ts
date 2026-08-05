// Headless driving-range simulation — pure physics, input mapping, state and
// events, with NO canvas or rendering. RangeGL (components/golf/RangeGL.tsx)
// owns the Three.js scene and drives this sim on a fixed-timestep loop; the
// React HUD (components/golf/RangeGame.tsx) polls getState() for readouts and
// scoring. This is the world-space ballistics lifted out of the old 2.5D
// RangeMode: `d` = downrange yards (0..RANGE_YD), `x` = lateral yards (+right),
// `h` = height yards above the ground plane.
//
// Feel: FORGIVING and roughly LINEAR in power. Effective launch uses a floor
// (POWER_FLOOR) so even a modest drag flies, and launch speed is
//   s = baseSpeed * sqrt(sPow),  sPow = POWER_FLOOR + (1-POWER_FLOOR)*power
// so carry (∝ s²) tracks sPow ~linearly. GRAVITY/AIR_DRAG/baseSpeed are tuned
// (see clubs.ts) so full-power carries land on the club ladder within ±1yd.

import { CLUBS, DEFAULT_CLUB_ID, clubById } from './clubs';
import type { Club } from './clubs';
import { RANGE_YD, surfaceAt } from './rangeTargets';
import type { Pin } from './rangeTargets';
import { MIN_PULL } from './tuning';

// --- Physics constants (world space, yards & seconds) ---

// Downrange gravity. Low enough to keep flight times airy (~4.3s driver,
// ~5.7s wedge) and give the tracer a readable arc, while the club ladder
// still carries to spec.
export const GRAVITY = 16;
// Per-substep air drag, applied as AIR_DRAG**(dt*60) — framerate-independent
// gentle bleed. Much lighter than the old 0.992 so full-power carries reach
// the club-ladder targets.
export const AIR_DRAG = 0.996;
// Forgiving power floor: effective launch power never drops below this, so a
// short drag still produces a real shot. sPow = FLOOR + (1-FLOOR)*power.
export const POWER_FLOOR = 0.35;

// First-bounce vertical restitution (grass/island).
const BOUNCE_RESTITUTION = 0.42;
// Below this post-bounce upward speed the ball stops hopping and rolls.
const BOUNCE_MIN = 4;
// Base roll friction per (dt*60); backspin subtracts up to BITE_K from it so
// wedges check up and the driver runs out.
const ROLL_FRICTION = 0.95;
const BITE_K = 0.16;
// Below this ground speed a rolling ball is snapped to rest.
const ROLL_REST = 2.5;
// Max lateral aim swing from the drag idiom (radians ~= 19deg each way).
const MAX_AIM_RAD = 0.33;

// --- Spin (player-controlled, bounded & forgiving) ---
// Side spin → a steady lateral acceleration while airborne (yd/s²) at full
// draw/fade; over a full flight this curves a drive a believable ~15-30yd, and
// only bananas when maxed. Comparable in scale to the round's cross-wind.
const SPIN_SIDE_ACC = 1.9;
// Back/top spin → a vertical acceleration while airborne (yd/s²) at full spin:
// backspin (+) lifts, raising apex and adding a touch of carry; topspin (−)
// presses the flight down for a lower, shorter shot. Kept well under GRAVITY.
const SPIN_LIFT_ACC = 2.2;
// Backspin bite added to the roll-friction term at the settle (checks up).
const SPIN_BITE = 0.18;
// Topspin roll boost: extra fraction of forward speed kept through the bounce.
const SPIN_ROLL = 0.5;
// Recent-positions tracer length (world-space samples).
const TRAIL_MAX = 48;
// Default drag distance (CSS px) for full power; RangeGL overrides this with a
// value relative to the canvas so a natural drag reaches 100%.
const DEFAULT_MAX_PULL = 220;

export type ShotResult = 'grass' | 'island' | 'water' | 'fence';

export type RangeEventType = 'launch' | 'land' | 'splash' | 'fence' | 'rest';
export interface RangeEvent {
  type: RangeEventType;
  // World-space location of the event (landing/splash/rest point), for the
  // renderer's splash/burst effects. Absent for 'launch'.
  d?: number;
  x?: number;
}

// Shared immutable empty result for drainEvents()' common no-event frame.
const EMPTY_EVENTS: readonly RangeEvent[] = Object.freeze([]);

export interface Vec2 {
  x: number;
  y: number;
}

// The live ball. Mutated in place by the sim; RangeGL reads it every frame
// (allocation-free) to place the 3D ball + tracer head.
export interface Ball {
  d: number;
  x: number;
  h: number;
  vd: number;
  vx: number;
  vh: number;
  inFlight: boolean;
  resting: boolean;
  grounded: boolean;
}

export interface TrailPt {
  d: number;
  x: number;
  h: number;
}

export interface RangeState {
  clubId: string;
  clubName: string;
  windAlong: number;
  windCross: number;
  inFlight: boolean;
  resting: boolean;
  aiming: boolean;
  power: number;
  aimDeg: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  longestDrive: number;
  lastResult: ShotResult | null;
  nearestPin: number | null;
  onTarget: boolean;
  hasTarget: boolean;
  spinBack: number;
  spinSide: number;
}

export interface RangeSimOptions {
  initialClubId?: string;
  windAlong?: number;
  windCross?: number;
  pins: Pin[];
  target?: Pin | null;
}

export class RangeSim {
  private readonly pins: Pin[];
  private target: Pin | null;
  private clubId: string;
  private windAlong: number;
  private windCross: number;

  // Public so the renderer can read positions each frame without allocating.
  readonly ball: Ball;
  readonly trail: TrailPt[] = [];

  // Aim state, surfaced for the renderer's ground aim/power indicator.
  aiming = false;
  power = 0;
  aimRad = 0;

  // Player spin, set from the HUD spin puck before a swing and PERSISTED across
  // shots (teeUp does not clear it). spinBack>0 = backspin, <0 = topspin;
  // spinSide>0 = fade (curves right), <0 = draw (curves left). Each in [-1..1].
  spinBack = 0;
  spinSide = 0;

  // Per-shot readouts.
  private carry = 0;
  private total = 0;
  private apex = 0;
  private ballSpeed = 0;
  private longestDrive = 0;
  private lastResult: ShotResult | null = null;
  private firstLanding = true;
  private rollDecay = ROLL_FRICTION;

  // Drag input (CSS pixels).
  private dragStart: Vec2 = { x: 0, y: 0 };
  private maxPull = DEFAULT_MAX_PULL;

  // Event queue, drained by the renderer once per frame.
  private events: RangeEvent[] = [];

  constructor(opts: RangeSimOptions) {
    this.pins = opts.pins;
    this.target = opts.target ?? null;
    this.clubId = opts.initialClubId ?? DEFAULT_CLUB_ID;
    this.windAlong = opts.windAlong ?? 0;
    this.windCross = opts.windCross ?? 0;
    this.ball = this.teedBall();
  }

  private teedBall(): Ball {
    return {
      d: 0,
      x: 0,
      h: 0,
      vd: 0,
      vx: 0,
      vh: 0,
      inFlight: false,
      resting: true,
      grounded: false,
    };
  }

  private club(): Club {
    return clubById(this.clubId);
  }

  // --- Control surface (RangeGame / RangeGL) -----------------------------

  selectClub(id: string): void {
    if (this.ball.inFlight) return;
    if (CLUBS.some((c) => c.id === id)) this.clubId = id;
  }

  cycleClub(dir: 1 | -1): void {
    if (this.ball.inFlight) return;
    const i = CLUBS.findIndex((c) => c.id === this.clubId);
    const n = (i + dir + CLUBS.length) % CLUBS.length;
    this.clubId = CLUBS[n]!.id;
  }

  setWind(along: number, cross: number): void {
    this.windAlong = along;
    this.windCross = cross;
  }

  // Point the challenge at a new pin. Does NOT move the ball: the just-landed
  // ball stays put so the player sees the result; the next drag re-tees it.
  setTarget(pin: Pin | null): void {
    this.target = pin;
  }

  // Set the player's spin for the next shot. Persists until changed. Each axis
  // is clamped to [-1..1]; center (0,0) = no spin.
  setSpin(back: number, side: number): void {
    this.spinBack = Math.max(-1, Math.min(1, back));
    this.spinSide = Math.max(-1, Math.min(1, side));
  }

  // Full-power drag distance in CSS pixels. RangeGL sets this from the canvas
  // height so a natural drag reaches 100% power on any screen.
  setMaxPull(px: number): void {
    this.maxPull = Math.max(40, px);
  }

  // Return the ball to the tee, ready to aim. Keeps the last shot's readouts
  // visible until the next swing clears them.
  teeUp(): void {
    const b = this.ball;
    b.d = b.x = b.h = 0;
    b.vd = b.vx = b.vh = 0;
    b.inFlight = false;
    b.resting = true;
    b.grounded = false;
    this.trail.length = 0;
    this.aiming = false;
    this.power = 0;
    this.aimRad = 0;
  }

  getState(): RangeState {
    const club = this.club();
    return {
      clubId: this.clubId,
      clubName: club.name,
      windAlong: this.windAlong,
      windCross: this.windCross,
      inFlight: this.ball.inFlight,
      resting: this.ball.resting,
      aiming: this.aiming,
      power: this.power,
      aimDeg: (this.aimRad * 180) / Math.PI,
      carry: Math.round(this.carry),
      total: Math.round(this.total),
      apex: Math.round(this.apex),
      ballSpeed: Math.round(this.ballSpeed),
      longestDrive: Math.round(this.longestDrive),
      lastResult: this.lastResult,
      nearestPin: this.nearestPinDist(),
      onTarget: this.isOnTarget(),
      hasTarget: this.target != null,
      spinBack: this.spinBack,
      spinSide: this.spinSide,
    };
  }

  drainEvents(): readonly RangeEvent[] {
    // Called every render frame; avoid a fresh [] alloc on the common empty case.
    if (this.events.length === 0) return EMPTY_EVENTS;
    const out = this.events;
    this.events = [];
    return out;
  }

  // --- Simulation --------------------------------------------------------

  substep(dt: number): void {
    const b = this.ball;
    if (!b.inFlight) return;

    // Wind pushes as a steady acceleration on both ground and air paths.
    b.vd += this.windAlong * dt;
    b.vx += this.windCross * dt;

    if (b.grounded) {
      const decay = Math.pow(this.rollDecay, dt * 60);
      b.vd *= decay;
      b.vx *= decay;
      b.d += b.vd * dt;
      b.x += b.vx * dt;
      this.total = b.d;
      const surf = surfaceAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'fence' || b.d >= RANGE_YD) return this.stop('fence');
      if (Math.hypot(b.vd, b.vx) <= ROLL_REST) return this.stop('rest');
      this.pushTrail();
      return;
    }

    // Airborne: gravity + spin (Magnus-ish) + drag, then integrate. Side spin
    // adds a steady lateral push that curves the flight (draw one way, fade the
    // other); back/top spin lifts or presses the ball. Both are bounded so they
    // shape the trajectory rather than dominate it.
    b.vh -= GRAVITY * dt;
    b.vh += this.spinBack * SPIN_LIFT_ACC * dt;
    b.vx += this.spinSide * SPIN_SIDE_ACC * dt;
    const drag = Math.pow(AIR_DRAG, dt * 60);
    b.vd *= drag;
    b.vx *= drag;
    b.vh *= drag;
    b.d += b.vd * dt;
    b.x += b.vx * dt;
    b.h += b.vh * dt;
    if (b.h > this.apex) this.apex = b.h;
    this.pushTrail();

    if (b.h <= 0 && b.vh < 0) {
      b.h = 0;
      if (this.firstLanding) {
        this.carry = b.d;
        this.firstLanding = false;
        this.events.push({ type: 'land', d: b.d, x: b.x });
      }
      const surf = surfaceAt(b.d, b.x);
      if (surf === 'fence' || b.d >= RANGE_YD) return this.stop('fence');
      if (surf === 'water') return this.stop('water');
      // Grass / island: bounce, or settle into a roll if the hop is spent.
      const club = this.club();
      const up = -b.vh * BOUNCE_RESTITUTION;
      if (up < BOUNCE_MIN) {
        b.grounded = true;
        b.vh = 0;
        // Topspin runs out more (keeps more forward speed); backspin bites and
        // adds roll friction so wedge-y spin checks up near the pitch mark.
        const top = Math.max(0, -this.spinBack);
        const rollF = Math.min(0.95, club.rollFactor * (1 + top * SPIN_ROLL));
        b.vd *= rollF;
        b.vx *= rollF;
        const biteExtra = Math.max(0, this.spinBack) * SPIN_BITE;
        this.rollDecay = Math.max(0.6, ROLL_FRICTION - club.backspin * BITE_K - biteExtra);
      } else {
        b.vh = up;
        const keep = 0.55 + 0.4 * club.rollFactor;
        b.vd *= keep;
        b.vx *= keep;
      }
    }
  }

  private stop(kind: 'rest' | 'water' | 'fence'): void {
    const b = this.ball;
    b.inFlight = false;
    b.resting = true;
    b.grounded = false;
    b.vd = b.vx = b.vh = 0;
    b.h = 0;
    this.total = b.d;
    if (kind === 'water') {
      this.lastResult = 'water';
      this.events.push({ type: 'splash', d: b.d, x: b.x });
    } else if (kind === 'fence') {
      this.lastResult = 'fence';
      this.events.push({ type: 'fence', d: b.d, x: b.x });
    } else {
      this.lastResult = surfaceAt(b.d, b.x) === 'island' ? 'island' : 'grass';
      this.events.push({ type: 'rest', d: b.d, x: b.x });
    }
    this.longestDrive = Math.max(this.longestDrive, b.d);
  }

  private pushTrail(): void {
    const b = this.ball;
    this.trail.push({ d: b.d, x: b.x, h: b.h });
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  private nearestPinDist(): number | null {
    const b = this.ball;
    if (b.inFlight) return null;
    if (this.lastResult == null) return null;
    if (this.target) {
      return Math.round(Math.hypot(b.d - this.target.d, b.x - this.target.x));
    }
    let best = Infinity;
    for (const p of this.pins) best = Math.min(best, Math.hypot(b.d - p.d, b.x - p.x));
    return Number.isFinite(best) ? Math.round(best) : null;
  }

  private isOnTarget(): boolean {
    if (!this.target || this.lastResult == null) return false;
    if (this.lastResult === 'water' || this.lastResult === 'fence') return false;
    const b = this.ball;
    return Math.hypot(b.d - this.target.d, b.x - this.target.x) <= this.target.r;
  }

  // --- Input (drag back to aim/power, in CSS pixels) ---------------------

  private aimAngleFrom(pullX: number): number {
    const t = Math.max(-1, Math.min(1, pullX / this.maxPull));
    return t * MAX_AIM_RAD;
  }

  onPointerDown(p: Vec2): void {
    if (this.ball.inFlight) return;
    // Re-tee for the next shot the moment the player starts a new drag, so the
    // ball always launches from the tee and the aim reference is fixed.
    this.teeUp();
    this.aiming = true;
    this.dragStart = { x: p.x, y: p.y };
    this.power = 0;
    this.aimRad = 0;
  }

  onPointerMove(p: Vec2): void {
    if (!this.aiming) return;
    const rawX = this.dragStart.x - p.x;
    const rawY = this.dragStart.y - p.y;
    this.power = Math.min(Math.hypot(rawX, rawY), this.maxPull) / this.maxPull;
    this.aimRad = this.aimAngleFrom(rawX);
  }

  onPointerUp(p: Vec2): void {
    if (!this.aiming) return;
    this.aiming = false;
    const pullX = this.dragStart.x - p.x;
    const pullY = this.dragStart.y - p.y;
    const len = Math.hypot(pullX, pullY);
    if (len < MIN_PULL) {
      this.power = 0;
      this.aimRad = 0;
      return;
    }
    this.power = Math.min(len, this.maxPull) / this.maxPull;
    this.aimRad = this.aimAngleFrom(pullX);
    this.swing();
  }

  private swing(): void {
    const club = this.club();
    const b = this.ball;
    // Forgiving/linear power map: floor the effective power, then take sqrt so
    // launch speed² (≈ carry) tracks sPow roughly linearly.
    const sPow = POWER_FLOOR + (1 - POWER_FLOOR) * this.power;
    const s = club.baseSpeed * Math.sqrt(sPow);
    const loft = (club.loft * Math.PI) / 180;
    const aim = this.aimRad;
    const sH = s * Math.cos(loft);
    b.d = 0;
    b.x = 0;
    b.h = 0;
    b.vh = s * Math.sin(loft);
    b.vd = sH * Math.cos(aim);
    b.vx = sH * Math.sin(aim);
    b.inFlight = true;
    b.resting = false;
    b.grounded = false;
    // Reset per-shot readouts.
    this.ballSpeed = s;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = true;
    this.lastResult = null;
    this.trail.length = 0;
    this.power = 0;
    this.events.push({ type: 'launch' });
  }
}
