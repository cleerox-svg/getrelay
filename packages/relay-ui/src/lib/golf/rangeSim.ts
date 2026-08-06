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
import { RANGE_YD, islandAt, islandSurfaceR, surfaceAt } from './rangeTargets';
import type { Pin } from './rangeTargets';
import { FIXED_MS, MIN_PULL } from './tuning';

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
// Max lateral aim swing. Aim is now a DEDICATED HUD control (RangeGame's
// nudge buttons), fully DECOUPLED from the power pull, so the range can be
// wide without the drag ever feeling twitchy: ~0.70 rad ≈ 40° each way makes
// "choosing direction" feel real. setAim()/nudgeAim() clamp to this.
const MAX_AIM_RAD = 0.7;

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
// First-bounce spin "check": at full backspin the ball loses this fraction of
// its landing ground speed plus a fixed reverse kick (so a spinny wedge zips
// BACK a little); at full topspin it keeps an extra fraction forward. Only the
// player's spin drives this, so neutral-spin carries/ladders are untouched.
const CHECK_BACK_FRAC = 0.7;
const CHECK_BACK_KICK = 6;
const CHECK_TOP_FRAC = 0.4;
// --- Accuracy (Golf-Clash-style tap-timing) → hook/slice --------------------
// After aim+power are locked (armed), the player taps to stop a sweeping marker.
// The stop error e ∈ [-1..1] (0 = dead center = pure shot) is turned into ADDED
// SIDE-SPIN so the ball curves in flight and the tracer visibly bends.
// Convention: stopping the marker RIGHT of center (e>0) adds fade/slice spin
// (curves right, +x); LEFT (e<0) adds draw/hook spin (curves left) — the
// intuitive "you pushed it that way" read. The added spin scales with |e| AND
// with power, so a full-power drive punishes a mishit far more than a soft
// wedge. At a full miss (|e|=1) at full power it adds ACCURACY_CURVE of side
// spin on top of the player's intentional spin; the net is clamped to
// ±ACCURACY_SPIN_MAX so a total whiff is a strong-but-legible banana and a
// dead-center stop stays pristine (leaving the tuned club ladder untouched).
const ACCURACY_CURVE = 0.9;
const ACCURACY_SPIN_MAX = 1.4;
// Power weighting of the miss: at zero power a mishit still curves this fraction
// of ACCURACY_CURVE; at full power the whole of it applies.
const ACCURACY_POWER_FLOOR = 0.45;
// A mishit also starts a hair offline (a small straight push), radians at a full
// miss at full power. Kept tiny — the curve is the main effect.
const ACCURACY_AIM = 0.05;
// Island containment: a soft rim. Beyond this fraction of the green radius the
// outward roll is damped; at the rim the outward component is reflected so a
// ball that landed on the green settles on it instead of trickling into water.
const RIM_SOFT = 0.72;
const RIM_DAMP = 0.82;
const RIM_BOUNCE = 0.35;
// Recent-positions tracer length (world-space samples).
const TRAIL_MAX = 48;
// Default drag distance (CSS px) for full power; RangeGL overrides this with a
// value relative to the canvas so a natural drag reaches 100%.
const DEFAULT_MAX_PULL = 220;

export type ShotResult = 'grass' | 'island' | 'water' | 'fence';

// One-shot headless measurement, returned by simulateShot(). Mirrors exactly
// what the game measures at rest — carry is the first-landing downrange, total
// is the ball's final resting downrange (carry + roll), so a harness reading
// matches the on-screen CARRY/TOTAL readouts. `lateral` is the resting ball.x
// (+right), for verifying aim/spin direction.
export interface ShotMeasurement {
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  lateral: number;
  result: ShotResult;
}

// Options for simulateShot(). All optional; omitted fields use neutral values
// (straight aim, no spin, dead-center strike).
export interface SimulateShotOptions {
  clubId?: string;
  power?: number; // 0..1
  aimDeg?: number; // + = right
  spinBack?: number; // -1..1 (back>0 lifts, top<0 presses)
  spinSide?: number; // -1..1 (fade>0 curves right, draw<0 curves left)
  accuracy?: number; // tap-timing error -1..1 (0 = pure strike)
}

export type RangeEventType = 'launch' | 'land' | 'splash' | 'fence' | 'rest' | 'arm';
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
  armed: boolean;
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

  // Aim state, surfaced for the renderer's ground aim/power indicator. aimRad
  // is set ONLY by the dedicated aim control (setAim/nudgeAim), never by the
  // power pull, and PERSISTS across shots (teeUp does not clear it).
  aiming = false;
  power = 0;
  aimRad = 0;

  // Two-step (slingshot + release-timing) fire state. After a drag is released
  // (arm()), aim + power are LOCKED and `armed` flips true — the shot does NOT
  // launch yet; the HUD runs the accuracy bar and calls fireArmed() to launch.
  armed = false;
  // Net side-spin actually used in flight = clamp(player spinSide + accuracy
  // miss). Public so the renderer's ball-yaw visual reflects the real curve.
  // Set at launch; 0 at the tee.
  launchSpinSide = 0;
  // Accuracy miss for the pending shot, consumed (and cleared) by swing():
  // pendingCurve = added side-spin, pendingAim = added straight push (rad).
  private pendingCurve = 0;
  private pendingAim = 0;

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
  // When the ball settles into a roll ON an island green, the pin whose green
  // it must be kept on (soft rim containment). Null on grass/lip.
  private containPin: Pin | null = null;

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

  // --- Aim (dedicated control, decoupled from the power pull) -------------
  // The HUD's aim buttons/slider drive these; the power pull no longer touches
  // aimRad. Both clamp to ±MAX_AIM_RAD and take effect immediately (the on-turf
  // aim arrow reads aimRad every frame). Aim persists across shots.

  // Set the aim absolutely, in radians (+ = right). Ignored once a shot is in
  // flight or locked (armed), so the accuracy phase can't have its line moved.
  setAim(rad: number): void {
    if (this.ball.inFlight || this.armed) return;
    this.aimRad = Math.max(-MAX_AIM_RAD, Math.min(MAX_AIM_RAD, rad));
  }

  // Nudge the aim by a delta (radians); used by the hold-to-repeat ◀ ▶ buttons.
  nudgeAim(delta: number): void {
    this.setAim(this.aimRad + delta);
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
    this.armed = false;
    this.power = 0;
    // aimRad is intentionally NOT reset here: aim is owned by the dedicated
    // control and persists across shots / re-tees / cancels.
    this.launchSpinSide = 0;
    this.pendingCurve = 0;
    this.pendingAim = 0;
    this.containPin = null;
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
      armed: this.armed,
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
      // Island containment: keep a ball that settled on a green ON the green.
      if (this.containPin) this.containOnIsland();
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
    // launchSpinSide = player's intentional side-spin + the accuracy miss curve.
    b.vx += this.launchSpinSide * SPIN_SIDE_ACC * dt;
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
      const wasFirst = this.firstLanding;
      if (this.firstLanding) {
        this.carry = b.d;
        this.firstLanding = false;
        this.events.push({ type: 'land', d: b.d, x: b.x });
      }
      const surf = surfaceAt(b.d, b.x);
      if (surf === 'fence' || b.d >= RANGE_YD) return this.stop('fence');
      if (surf === 'water') return this.stop('water');
      // First ground contact: the player's spin "checks" the ball. Strong
      // backspin scrubs forward speed and adds a reverse kick (zips back);
      // strong topspin releases forward. Neutral spin leaves vd untouched, so
      // the tuned carry ladder is preserved.
      if (wasFirst) {
        const hs = Math.abs(b.vd);
        const back = Math.max(0, this.spinBack);
        const top = Math.max(0, -this.spinBack);
        b.vd -= back * (CHECK_BACK_FRAC * hs + CHECK_BACK_KICK);
        b.vd += top * CHECK_TOP_FRAC * hs;
      }
      // Grass / island: bounce, or settle into a roll if the hop is spent.
      const club = this.club();
      const up = -b.vh * BOUNCE_RESTITUTION;
      if (up < BOUNCE_MIN) {
        b.grounded = true;
        b.vh = 0;
        // If it settled onto an island green, remember it for rim containment.
        this.containPin = surf === 'island' ? islandAt(b.d, b.x) : null;
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

  // Soft rim: keep a green-bound ball on its island. Near the edge the outward
  // roll is damped; past the rim the ball is clamped back and its outward speed
  // is reflected (a gentle "bounces off the bank" feel) so it stays on the green.
  private containOnIsland(): void {
    const p = this.containPin;
    if (!p) return;
    const b = this.ball;
    const dd = b.d - p.d;
    const dx = b.x - p.x;
    const dist = Math.hypot(dd, dx);
    const rim = islandSurfaceR(p);
    if (dist < rim * RIM_SOFT || dist < 1e-4) return;
    const rd = dd / dist;
    const rx = dx / dist;
    // Extra friction on the outer band of the green.
    b.vd *= RIM_DAMP;
    b.vx *= RIM_DAMP;
    if (dist > rim) {
      // Clamp back onto the edge and reflect the outward velocity component.
      b.d = p.d + rd * rim;
      b.x = p.x + rx * rim;
      const vOut = b.vd * rd + b.vx * rx;
      if (vOut > 0) {
        const j = (1 + RIM_BOUNCE) * vOut;
        b.vd -= j * rd;
        b.vx -= j * rx;
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

  // --- Input (drag back for POWER ONLY, in CSS pixels) -------------------
  // The pull-back gesture is now power-only: power = clamp(|drag| / maxPull)
  // using the drag MAGNITUDE regardless of direction, so the player can yank
  // back to any comfortable spot without steering. Aim is a separate control
  // (setAim/nudgeAim) and is never touched here.

  onPointerDown(p: Vec2): void {
    if (this.ball.inFlight) return;
    // Re-tee for the next shot the moment the player starts a new drag, so the
    // ball always launches from the tee. Aim persists (teeUp keeps aimRad).
    this.teeUp();
    this.aiming = true;
    this.dragStart = { x: p.x, y: p.y };
    this.power = 0;
  }

  onPointerMove(p: Vec2): void {
    if (!this.aiming) return;
    // Direction-independent: power tracks the drag magnitude only.
    const rawX = this.dragStart.x - p.x;
    const rawY = this.dragStart.y - p.y;
    this.power = Math.min(Math.hypot(rawX, rawY), this.maxPull) / this.maxPull;
  }

  // Step 1 → Step 2 (release): LOCK the pulled power (aim is already set on the
  // dedicated control) and enter the accuracy phase. Does NOT launch — the HUD
  // now runs the accuracy bar and calls fireArmed() to release. A sub-min pull
  // cancels back to the tee.
  arm(p: Vec2): void {
    if (!this.aiming) return;
    this.aiming = false;
    const pullX = this.dragStart.x - p.x;
    const pullY = this.dragStart.y - p.y;
    const len = Math.hypot(pullX, pullY);
    if (len < MIN_PULL) {
      this.cancelArm();
      return;
    }
    this.power = Math.min(len, this.maxPull) / this.maxPull;
    this.armed = true;
    // Signal the HUD to raise the accuracy bar immediately, rather than on the
    // next ~100ms poll tick (a timing mechanic can't afford a dead window).
    this.events.push({ type: 'arm' });
  }

  // Abandon a locked (armed) shot and return to the tee. Safe when not armed;
  // guarantees the armed flag can never strand (used by sub-min pulls and any
  // HUD-side bail-out).
  cancelArm(): void {
    this.teeUp();
  }

  // Step 2 → fire: the player tapped to stop the accuracy marker. `accuracyError`
  // ∈ [-1..1] (0 = dead center = pure shot). Turns the miss into a small straight
  // push + (mainly) a side-spin curve, then launches with the locked aim/power
  // via the shared swing() internals.
  fireArmed(accuracyError: number): void {
    if (!this.armed) return;
    this.armed = false;
    const e = Math.max(-1, Math.min(1, accuracyError));
    // Power weight: a mishit hurts more the harder you swung.
    const powerW = ACCURACY_POWER_FLOOR + (1 - ACCURACY_POWER_FLOOR) * this.power;
    this.pendingCurve = e * ACCURACY_CURVE * powerW;
    this.pendingAim = e * ACCURACY_AIM * powerW;
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
    // Fold in the accuracy miss (0 for a dead-center stop / practice): a small
    // straight push on the initial line, plus (mainly) added side-spin that
    // curves the flight. Net side-spin = clamp(player spinSide + miss curve);
    // neutral inputs leave it at spinSide, preserving the tuned club ladder.
    const aim = this.aimRad + this.pendingAim;
    this.launchSpinSide = Math.max(
      -ACCURACY_SPIN_MAX,
      Math.min(ACCURACY_SPIN_MAX, this.spinSide + this.pendingCurve),
    );
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
    this.containPin = null;
    this.trail.length = 0;
    this.power = 0;
    // The accuracy miss has been consumed into launchSpinSide/aim above.
    this.pendingCurve = 0;
    this.pendingAim = 0;
    this.events.push({ type: 'launch' });
  }

  // --- Headless measurement hook (tests / tuning) ------------------------
  // Drive a single shot end-to-end through the REAL launch pipeline: set the
  // club/spin/aim/power, arm, fire (baking in any accuracy miss), then run the
  // same fixed-timestep substep loop RangeGL uses until the ball comes to rest.
  // Returns the exact carry/total/apex/ballSpeed the game would show, plus the
  // resting lateral offset. Deterministic — the caller controls wind (default
  // 0 in the harness). Not called by the app runtime; kept tiny and allocation-
  // free beyond the single result object.
  simulateShot(opts: SimulateShotOptions = {}): ShotMeasurement {
    const fixedS = FIXED_MS / 1000;
    this.teeUp();
    if (opts.clubId) this.selectClub(opts.clubId);
    this.setSpin(opts.spinBack ?? 0, opts.spinSide ?? 0);
    this.setAim(((opts.aimDeg ?? 0) * Math.PI) / 180);
    // Lock a power directly (the drag gesture only exists to set this.power).
    this.power = Math.max(0, Math.min(1, opts.power ?? 1));
    this.armed = true;
    // fireArmed() consumes the accuracy miss and calls the real swing().
    this.fireArmed(opts.accuracy ?? 0);
    // Integrate to rest. The cap (~600s of flight) can never be reached by a
    // legal shot, but guards against a physics regression spinning forever.
    let guard = 0;
    while (this.ball.inFlight && guard < 72000) {
      this.substep(fixedS);
      guard++;
    }
    const st = this.getState();
    return {
      carry: st.carry,
      total: st.total,
      apex: st.apex,
      ballSpeed: st.ballSpeed,
      lateral: this.ball.x,
      result: st.lastResult ?? 'grass',
    };
  }
}
