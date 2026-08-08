// Terrain-aware full-shot simulation for the 9-hole course — headless, pure
// physics, no canvas. It reuses the SAME tuned ballistics and per-lie bounce/
// roll materials as the driving range (constants + TERRAIN imported from
// rangeSim), so a course shot feels identical to a range shot — but the ground
// is the hole's HEIGHTFIELD (lib/golf/terrain.ts): flight lands at heightAt(),
// the grounded roll follows slopeAccel() (downhill runs, uphill checks, sidehill
// pushes), and the lie under the ball (surfaceAt → TERRAIN material) shapes the
// bounce and run. One source of truth (the CourseHole) drives both this and the
// coming terrain mesh, so the look and the play can't disagree.
//
// World space matches the range/terrain: d downrange yд, x lateral yд (+right),
// h ABSOLUTE elevation yд (the range treats ground as h=0; here the ground is
// heightAt(d,x)). The course renderer will drive this on the same fixed step.

import { CLUBS, clubById, DEFAULT_CLUB_ID } from './clubs';
import type { Club } from './clubs';
import { FIXED_MS, MIN_PULL } from './tuning';
import {
  ACCURACY_AIM,
  ACCURACY_CURVE,
  ACCURACY_POWER_FLOOR,
  ACCURACY_SPIN_MAX,
  AIM_DEADZONE_FRAC,
  AIR_DRAG,
  BITE_K,
  CHECK_BACK_FRAC,
  CHECK_BACK_KICK,
  CHECK_TOP_FRAC,
  GRAVITY,
  MAX_AIM_RAD,
  ROLL_FRICTION,
  SPIN_BITE,
  SPIN_LIFT_ACC,
  SPIN_ROLL,
  SPIN_SIDE_ACC,
  TERRAIN,
  type Terrain,
} from './rangeSim';
import { gradientAt, heightAt, slopeAccel, surfaceAt } from './terrain';
import type { CourseHole, Surface } from './terrain';

// Below this ground speed a rolling ball on ~flat ground is snapped to rest. On
// a slope the per-substep slopeAccel keeps feeding it, so it only rests where
// the ground is shallow enough that friction wins — exactly like a real green.
const ROLL_REST = 2.0;
// Grass friction (Coulomb) — the missing piece that stops a slow ball. Below
// LOW_ROLL_SPEED a constant decel of frictionFor(lie) yd/s² opposes motion, so a
// near-stopped ball actually STOPS and HOLDS on a slope up to that decel instead
// of trickling/oscillating downhill for tens of seconds (the real "ball rolls
// backward for 30s" bug). It's per-surface: greens have the LOWEST friction (1.5)
// so a putt still rolls far and breaks as it dies, yet — sitting just above the
// tilt's slope accel (~0.6–1.3 on HOLE_1) — it settles instead of trickling back
// into a hazard; fairway/rough/sand bite harder so approach shots stop in a
// second or two. The same value is the rest slope-threshold, so the ball rests
// exactly where its friction can hold it.
const LOW_ROLL_SPEED = 8;
function frictionFor(surf: Surface): number {
  switch (surf) {
    case 'green':
      // Just above the green's slope accel (~0.6–1.3 on HOLE_1's tilt +
      // undulation) so a putt still BREAKS as it rolls but STOPS when it dies
      // instead of trickling back down into a hazard. Greens are still the
      // lowest-friction surface (putts roll far and true).
      return 1.5;
    case 'fringe':
      return 2.4;
    case 'rough':
      return 6.5; // thick grass grabs
    case 'bunker':
      return 9; // sand kills it
    case 'cartpath':
      return 1.2; // firm — runs a bit
    default:
      return 4.5; // fairway / tee
  }
}
// The course allows genuine FINESSE: a much lower effective power floor than the
// range (0.35), so a soft pitch can fly a few yards instead of a forced ~40. Full
// power (sPow=1) is unchanged, so the club ladder off the tee is untouched.
const COURSE_POWER_FLOOR = 0.06;
// Putt: on the green a stroke ROLLS along the ground (no loft, no floor) instead
// of a lofted swing. Drag power maps to an initial ground speed in this band —
// full power comfortably crosses the green; a touch still trickles.
const PUTT_MIN_SPEED = 2.5;
const PUTT_MAX_SPEED = 18;
// Cup capture: a grounded ball within this radius of the pin and slower than
// CUP_SPEED drops. Faster or wider and it rolls on (lips out).
const CUP_R = 0.6;
const CUP_SPEED = 7;

// Where a shot ended up. The solid lies double as the resting-lie readout; the
// terminal ones end the shot.
export type CourseResult = Surface | 'holed';

// Map a course lie onto its bounce/roll material. water/ob never reach here (the
// settle path ends the shot on them first); every solid lie has a TERRAIN entry.
function terrainFor(surf: Surface): Terrain {
  switch (surf) {
    case 'green':
      return 'green';
    case 'fringe':
      return 'fringe';
    case 'rough':
      return 'rough';
    case 'bunker':
      return 'bunker';
    case 'cartpath':
      return 'cartpath';
    case 'tee':
      return 'tee';
    default:
      return 'fairway';
  }
}

export interface CourseBall {
  d: number;
  x: number;
  h: number;
  vd: number;
  vx: number;
  vh: number;
  inFlight: boolean;
  grounded: boolean;
  resting: boolean;
}

export interface CourseTrailPt {
  d: number;
  x: number;
  h: number;
}

export interface CourseShot {
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  restD: number;
  restX: number;
  distToPin: number;
  result: CourseResult;
}

export interface CourseShotOptions {
  clubId?: string;
  power?: number; // 0..1
  aimDeg?: number; // + = right, absolute bearing off the tee→pin... here off +d
  spinBack?: number; // -1..1
  spinSide?: number; // -1..1
  // Start the shot from an arbitrary lie (approach/putt) instead of the tee.
  from?: { d: number; x: number };
  windAlong?: number;
  windCross?: number;
}

// Non-committing prediction returned by predict(): the sampled flight+roll
// `path` (world space), the first-ground-contact `landing` (carry point, null
// only for a shot that never touches down), and the resting point.
export interface CoursePrediction {
  path: CourseTrailPt[];
  landing: { d: number; x: number; h: number } | null;
  rest: { d: number; x: number; h: number };
  result: CourseResult;
}

// Live readouts the HUD polls each frame.
export interface CourseState {
  clubId: string;
  clubName: string;
  par: number;
  strokes: number;
  power: number;
  aiming: boolean;
  armed: boolean;
  inFlight: boolean;
  resting: boolean;
  holed: boolean;
  aimDeg: number;
  distToPin: number;
  lie: Surface;
  lastResult: CourseResult;
  spinBack: number;
  spinSide: number;
  penaltyPending: boolean;
  // On the green → the next stroke is a putt (ground roll), so the HUD can label
  // the club "Putter" and read the power meter as putt strength.
  putting: boolean;
}

const TRAIL_MAX = 64;

// A complete capture of every MUTABLE field of a CourseSim — the one source of
// truth for predict()'s snapshot/restore (see CourseSim.snapshot). Kept as a
// plain data struct with no reference to any render object, so it clones cheaply
// and a dry-run prediction can never touch the scene. If you add mutable state
// to CourseSim, add it here too; the round-trip test enforces completeness.
interface CourseSnapshot {
  ball: CourseBall;
  trail: CourseTrailPt[];
  clubId: string;
  spinBack: number;
  spinSide: number;
  launchSpinSide: number;
  windAlong: number;
  windCross: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  firstLanding: boolean;
  rollDecay: number;
  result: CourseResult;
  originD: number;
  originX: number;
  aiming: boolean;
  power: number;
  aimRad: number;
  armed: boolean;
  strokes: number;
  holed: boolean;
  dragStart: { x: number; y: number };
  maxPull: number;
  shotOriginD: number;
  shotOriginX: number;
  penaltyPending: boolean;
  stepGuard: number;
}

export class CourseSim {
  readonly hole: CourseHole;
  readonly ball: CourseBall;
  readonly trail: CourseTrailPt[] = [];

  private clubId: string;
  private spinBack = 0;
  private spinSide = 0;
  private launchSpinSide = 0;
  private windAlong: number;
  private windCross: number;

  private teeGround: number;
  private originD: number;
  private originX: number;

  private carry = 0;
  private total = 0;
  private apex = 0;
  private ballSpeed = 0;
  private firstLanding = true;
  private rollDecay = ROLL_FRICTION;
  private result: CourseResult = 'tee';

  // --- Interactive play (drag-to-aim slingshot, reused from the range) ------
  // aimRad STEERS off the bearing-to-pin (so "straight" points at the flag even
  // on a dogleg); the pull magnitude sets power. arm() locks them and raises the
  // accuracy bar; fireArmed() launches. The ball plays shot-by-shot from wherever
  // it lies until it's holed.
  private readonly par: number;
  aiming = false;
  power = 0;
  aimRad = 0;
  armed = false;
  strokes = 0;
  holed = false;
  private dragStart = { x: 0, y: 0 };
  private maxPull = 220;
  private shotOriginD = 0;
  private shotOriginX = 0;
  private penaltyPending = false;
  private stepGuard = 0;

  constructor(hole: CourseHole, clubId = DEFAULT_CLUB_ID) {
    this.hole = hole;
    this.par = hole.par;
    this.clubId = clubId;
    this.windAlong = hole.wind.along;
    this.windCross = hole.wind.cross;
    this.teeGround = heightAt(hole, hole.tee.d, hole.tee.x);
    this.originD = hole.tee.d;
    this.originX = hole.tee.x;
    this.ball = {
      d: hole.tee.d,
      x: hole.tee.x,
      h: this.teeGround,
      vd: 0,
      vx: 0,
      vh: 0,
      inFlight: false,
      grounded: false,
      resting: true,
    };
    // Auto-club the opening tee shot for the hole length (long par 5 → driver).
    this.clubId = this.recommendedClub();
  }

  private club(): Club {
    return clubById(this.clubId);
  }

  private ground(d: number, x: number): number {
    return heightAt(this.hole, d, x);
  }
  private lieAt(d: number, x: number): Surface {
    return surfaceAt(this.hole, d, x);
  }

  // Launch from a lie with a locked club/power and an ABSOLUTE direction (dirRad,
  // angle off the +d axis) plus a precomputed net side-spin. Off an arbitrary
  // origin at the ground's elevation there. Mirrors rangeSim.swing.
  private swing(power: number, dirRad: number, launchSpinSide: number): void {
    const club = this.club();
    const b = this.ball;
    const sPow = COURSE_POWER_FLOOR + (1 - COURSE_POWER_FLOOR) * Math.max(0, Math.min(1, power));
    const s = club.baseSpeed * Math.sqrt(sPow);
    const loft = (club.loft * Math.PI) / 180;
    this.launchSpinSide = launchSpinSide;
    const sH = s * Math.cos(loft);
    b.h = this.ground(b.d, b.x);
    b.vh = s * Math.sin(loft);
    b.vd = sH * Math.cos(dirRad);
    b.vx = sH * Math.sin(dirRad);
    b.inFlight = true;
    b.grounded = false;
    b.resting = false;
    this.ballSpeed = s;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = true;
    this.result = 'tee';
    this.trail.length = 0;
    this.stepGuard = 0;
  }

  // Roll a PUTT from the current lie: no launch angle, no power floor — the drag
  // power maps to an initial GROUND speed and the ball rolls (and breaks on the
  // green's tilt via the grounded substep). Reuses the same roll integrator as a
  // settled shot, so a well-judged putt trickles into the cup.
  private puttLaunch(power: number, dirRad: number): void {
    const b = this.ball;
    const speed = PUTT_MIN_SPEED + Math.max(0, Math.min(1, power)) * (PUTT_MAX_SPEED - PUTT_MIN_SPEED);
    b.h = this.ground(b.d, b.x);
    b.vh = 0;
    b.vd = speed * Math.cos(dirRad);
    b.vx = speed * Math.sin(dirRad);
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    this.launchSpinSide = 0;
    this.ballSpeed = speed;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = false;
    this.result = 'green';
    this.trail.length = 0;
    this.stepGuard = 0;
    // Smooth green roll — the green lie's own run, no club bite.
    const mat = TERRAIN.green;
    this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - 0.985) / mat.runMul));
  }

  private pushTrail(): void {
    const b = this.ball;
    this.trail.push({ d: b.d, x: b.x, h: b.h });
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  private origin2D(d: number, x: number): number {
    return Math.hypot(d - this.originD, x - this.originX);
  }

  private stop(result: CourseResult): void {
    const b = this.ball;
    b.inFlight = false;
    b.grounded = false;
    b.resting = true;
    b.vd = b.vx = b.vh = 0;
    b.h = this.ground(b.d, b.x);
    this.total = this.origin2D(b.d, b.x);
    this.result = result;
    if (result === 'holed') this.holed = true;
    // Water / OB → the next address replays from the previous spot for a penalty.
    if (result === 'water' || result === 'ob') this.penaltyPending = true;
    // Auto-club the next shot for the new lie/distance (the player can still
    // cycle). A driver-for-a-bunker-chip default is exactly what this avoids.
    else this.clubId = this.recommendedClub();
  }

  // --- Interactive control surface (CourseGL drives this; CourseGame reads it) --

  // The sensible club for the CURRENT lie + distance-to-pin: the shortest club
  // whose full-power total still reaches (so full power gets there and the
  // player dials back), and a wedge out of sand regardless. Green → putter
  // (putt mode handles the stroke). Used to auto-set the club each new shot.
  recommendedClub(): string {
    const b = this.ball;
    const p = this.hole.pin;
    const R = Math.hypot(b.d - p.d, b.x - p.x);
    const lie = this.lieAt(b.d, b.x);
    if (lie === 'green') return 'pw'; // cosmetic; putt mode ignores the club
    if (lie === 'bunker') return R > 110 ? 'pw' : 'sw'; // loft to escape sand
    if (R > 343) return 'driver';
    if (R > 301) return '3wood';
    if (R > 255) return 'hybrid';
    if (R > 224) return '5iron';
    if (R > 195) return '7iron';
    if (R > 157) return '9iron';
    if (R > 128) return 'pw';
    return 'sw';
  }

  selectClub(id: string): void {
    if (this.ball.inFlight) return;
    if (CLUBS.some((c) => c.id === id)) this.clubId = id;
  }
  cycleClub(dir: 1 | -1): void {
    if (this.ball.inFlight) return;
    const i = CLUBS.findIndex((c) => c.id === this.clubId);
    this.clubId = CLUBS[(i + dir + CLUBS.length) % CLUBS.length]!.id;
  }
  setSpin(back: number, side: number): void {
    this.spinBack = Math.max(-1, Math.min(1, back));
    this.spinSide = Math.max(-1, Math.min(1, side));
  }
  setMaxPull(px: number): void {
    this.maxPull = Math.max(40, px);
  }

  // Bearing (rad off +d) from the ball to the pin, so "straight" aims at the flag
  // even on a dogleg; the slingshot steer is added on top of this.
  private bearingToPin(): number {
    const b = this.ball;
    const p = this.hole.pin;
    // TRUE signed bearing — no clamp on the forward component — so a ball BEHIND
    // the pin (the whole back half of the green) can still aim back at the cup
    // (bearing points backward, |angle| > 90°). Clamping the denominator used to
    // snap it sideways/away, making the hole unputtable from long.
    return Math.atan2(p.x - b.x, p.d - b.d);
  }

  // Is the ball on the green? Then a stroke is a PUTT (ground roll), not a swing.
  private putting(): boolean {
    return this.lieAt(this.ball.d, this.ball.x) === 'green';
  }

  // Slingshot steer from a pull-back vector (start − finger, CSS px): the shot
  // flings OPPOSITE the pull. Identical mapping/deadzone to the range.
  private pullAim(rawX: number, rawY: number): number {
    const back = -rawY;
    if (back < this.maxPull * AIM_DEADZONE_FRAC) return 0;
    return Math.max(-MAX_AIM_RAD, Math.min(MAX_AIM_RAD, Math.atan2(rawX, back)));
  }

  onPointerDown(p: { x: number; y: number }): void {
    if (this.ball.inFlight || this.holed) return;
    if (this.penaltyPending) this.applyPenalty();
    this.aiming = true;
    this.armed = false;
    this.dragStart = { x: p.x, y: p.y };
    this.power = 0;
    this.aimRad = 0;
  }
  onPointerMove(p: { x: number; y: number }): void {
    if (!this.aiming) return;
    const rawX = this.dragStart.x - p.x;
    const rawY = this.dragStart.y - p.y;
    this.power = Math.min(Math.hypot(rawX, rawY), this.maxPull) / this.maxPull;
    this.aimRad = this.pullAim(rawX, rawY);
  }
  // Release: lock power + steer and raise the accuracy bar (no launch yet). A
  // sub-min pull cancels back to address.
  arm(p: { x: number; y: number }): boolean {
    if (!this.aiming) return false;
    this.aiming = false;
    const pullX = this.dragStart.x - p.x;
    const pullY = this.dragStart.y - p.y;
    if (Math.hypot(pullX, pullY) < MIN_PULL) {
      this.armed = false;
      this.power = 0;
      return false;
    }
    this.power = Math.min(Math.hypot(pullX, pullY), this.maxPull) / this.maxPull;
    this.aimRad = this.pullAim(pullX, pullY);
    this.armed = true;
    return true;
  }
  cancelArm(): void {
    this.armed = false;
    this.aiming = false;
    this.power = 0;
  }

  // Fire the armed shot with the tap-timing error e∈[-1..1] (0 = pure). Turns the
  // miss into a straight push + side-spin curve (same model as the range), aims
  // at bearing-to-pin + steer, launches, counts the stroke.
  fireArmed(accuracyError: number): void {
    if (!this.armed) return;
    this.armed = false;
    const e = Math.max(-1, Math.min(1, accuracyError));
    const powerW = ACCURACY_POWER_FLOOR + (1 - ACCURACY_POWER_FLOOR) * this.power;
    const curve = e * ACCURACY_CURVE * powerW;
    const pushAim = e * ACCURACY_AIM * powerW;
    const lss = Math.max(-ACCURACY_SPIN_MAX, Math.min(ACCURACY_SPIN_MAX, this.spinSide + curve));
    const b = this.ball;
    this.originD = this.shotOriginD = b.d;
    this.originX = this.shotOriginX = b.x;
    const dir = this.bearingToPin() + this.aimRad + pushAim;
    // On the green the stroke is a PUTT (ground roll); everywhere else a lofted
    // swing. Both aim at bearing-to-pin + the steer, and both count a stroke.
    if (this.putting()) this.puttLaunch(this.power, dir);
    else this.swing(this.power, dir, lss);
    this.strokes += 1;
    this.power = 0;
  }

  // Replay from the previous shot's origin after water/OB, adding a penalty.
  private applyPenalty(): void {
    const b = this.ball;
    b.d = this.shotOriginD;
    b.x = this.shotOriginX;
    b.h = this.ground(b.d, b.x);
    b.vd = b.vx = b.vh = 0;
    this.strokes += 1;
    this.penaltyPending = false;
    this.result = this.lieAt(b.d, b.x);
    this.clubId = this.recommendedClub(); // re-club for the replay lie/distance
  }

  getState(): CourseState {
    const b = this.ball;
    const pin = this.hole.pin;
    return {
      clubId: this.clubId,
      clubName: this.club().name,
      par: this.par,
      strokes: this.strokes,
      power: this.power,
      aiming: this.aiming,
      armed: this.armed,
      inFlight: b.inFlight,
      resting: b.resting,
      holed: this.holed,
      aimDeg: (this.aimRad * 180) / Math.PI,
      distToPin: Math.round(Math.hypot(b.d - pin.d, b.x - pin.x)),
      lie: this.lieAt(b.d, b.x),
      lastResult: this.result,
      spinBack: this.spinBack,
      spinSide: this.spinSide,
      penaltyPending: this.penaltyPending,
      putting: this.putting(),
    };
  }

  substep(dt: number): void {
    const b = this.ball;
    if (!b.inFlight) return;

    // Safety: guarantee a shot always terminates (~833s of sim time) even if a
    // future physics change breaks convergence, so the live loop can never
    // strand the player waiting on a ball that won't rest.
    if (++this.stepGuard > 100000) return this.stop(this.lieAt(b.d, b.x));

    // Wind only pushes an AIRBORNE ball; a grounded/near-resting ball isn't
    // shoved around by wind (that used to nudge settled balls on a windy hole).
    if (!b.grounded) {
      b.vd += this.windAlong * dt;
      b.vx += this.windCross * dt;
    }

    if (b.grounded) {
      // Gravity down the fall line (this is the break / downhill run / uphill
      // check). slopeAccel = -g·gradient at the ball.
      const { ad, ax } = slopeAccel(this.hole, b.d, b.x, GRAVITY);
      b.vd += ad * dt;
      b.vx += ax * dt;
      const decay = Math.pow(this.rollDecay, dt * 60);
      b.vd *= decay;
      b.vx *= decay;
      // Grass Coulomb friction at low speed: bleed a fixed decel off the velocity
      // (capped so it never reverses the ball). This is what finally STOPS a slow
      // ball on a slope instead of leaving it to creep. Only below LOW_ROLL_SPEED,
      // so the fast roll-out that sets total distance is untouched. Sampled at the
      // pre-move lie (the surface the ball is rolling ON this substep); the rest
      // test below re-samples post-move — at sub-ROLL_REST speed the ball travels
      // <0.02 yd/substep, so any surface-boundary mismatch is immaterial.
      const fric = frictionFor(this.lieAt(b.d, b.x));
      const sp0 = Math.hypot(b.vd, b.vx);
      if (sp0 > 1e-5 && sp0 < LOW_ROLL_SPEED) {
        const k = Math.max(0, (sp0 - fric * dt) / sp0);
        b.vd *= k;
        b.vx *= k;
      }
      b.d += b.vd * dt;
      b.x += b.vx * dt;
      b.h = this.ground(b.d, b.x);
      this.total = this.origin2D(b.d, b.x);
      const surf = this.lieAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'ob') return this.stop('ob');
      const speed = Math.hypot(b.vd, b.vx);
      if (this.holedOut(speed)) return this.stop('holed');
      // Rest once slow AND the slope is within what this surface's friction can
      // hold — so the ball settles where it physically would, not creep on.
      if (speed <= ROLL_REST && Math.hypot(ad, ax) <= frictionFor(surf)) return this.stop(surf);
      this.pushTrail();
      return;
    }

    // Airborne: gravity + spin + drag, integrate.
    b.vh -= GRAVITY * dt;
    b.vh += this.spinBack * SPIN_LIFT_ACC * dt;
    b.vx += this.launchSpinSide * SPIN_SIDE_ACC * dt;
    const drag = Math.pow(AIR_DRAG, dt * 60);
    b.vd *= drag;
    b.vx *= drag;
    b.vh *= drag;
    b.d += b.vd * dt;
    b.x += b.vx * dt;
    b.h += b.vh * dt;
    const above = b.h - this.teeGround;
    if (above > this.apex) this.apex = above;
    this.pushTrail();

    const ground = this.ground(b.d, b.x);
    // Land on descent (h dropping to the surface), OR when a still-climbing liner
    // has clearly PENETRATED rising terrain — the latter catches a low shot that
    // would otherwise tunnel through an upslope. The penetration MARGIN keeps a
    // just-launched skim (h ≈ ground) from false-settling at the tee.
    if ((b.h <= ground && b.vh < 0) || b.h < ground - 0.5) {
      b.h = ground;
      const wasFirst = this.firstLanding;
      if (this.firstLanding) {
        this.carry = this.origin2D(b.d, b.x);
        this.firstLanding = false;
      }
      const surf = this.lieAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'ob') return this.stop('ob');
      // First-contact spin check (identical model to the range).
      if (wasFirst) {
        const hs = Math.abs(b.vd);
        const back = Math.max(0, this.spinBack);
        const top = Math.max(0, -this.spinBack);
        b.vd -= back * (CHECK_BACK_FRAC * hs + CHECK_BACK_KICK);
        b.vd += top * CHECK_TOP_FRAC * hs;
      }
      // Bounce or settle, per the LIE material — same core as rangeSim.
      const club = this.club();
      const mat = TERRAIN[terrainFor(surf)];
      const up = -b.vh * mat.restitution;
      if (up < mat.bounceMin) {
        b.grounded = true;
        b.vh = 0;
        const top = Math.max(0, -this.spinBack);
        const rollF = Math.min(0.98, club.rollFactor * mat.rollMul * (1 + top * SPIN_ROLL));
        b.vd *= rollF;
        b.vx *= rollF;
        const biteExtra = Math.max(0, this.spinBack) * SPIN_BITE;
        const base = ROLL_FRICTION - club.backspin * BITE_K * mat.biteMul - biteExtra;
        this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - base) / mat.runMul));
      } else {
        b.vh = up;
        const keep = Math.min(0.92, mat.bounceKeep + 0.2 * club.rollFactor);
        b.vd *= keep;
        b.vx *= keep;
      }
    }
  }

  private holedOut(speed: number): boolean {
    const b = this.ball;
    const p = this.hole.pin;
    return speed <= CUP_SPEED && Math.hypot(b.d - p.d, b.x - p.x) <= CUP_R;
  }

  // Capture / restore the FULL mutable simulation state in ONE place. predict()
  // dry-runs the REAL swing/substep/roll pipeline on live state, then rewinds to
  // byte-identical with restore() — so there is no parallel "prediction physics"
  // to hand-sync, and no per-field snapshot list to silently drift out of date
  // (the old predict() hand-copied only 13 fields, which is exactly the class of
  // bug this closes). snapshot() takes EVERY mutable field; adding new sim state
  // means adding it here, next to the fields. The round-trip test in
  // courseSim.test.ts dumps ALL own data props of the sim INDEPENDENTLY of
  // snapshot() (so it can see fields snapshot() omits) and fails loudly if
  // predict() mutates something snapshot()/restore() forgot. The physics itself
  // is shared BY CONSTRUCTION: predict, fireArmed and simulateShot all call the
  // same swing()/puttLaunch()/substep().
  private snapshot(): CourseSnapshot {
    return {
      ball: { ...this.ball },
      trail: this.trail.slice(),
      clubId: this.clubId,
      spinBack: this.spinBack,
      spinSide: this.spinSide,
      launchSpinSide: this.launchSpinSide,
      windAlong: this.windAlong,
      windCross: this.windCross,
      carry: this.carry,
      total: this.total,
      apex: this.apex,
      ballSpeed: this.ballSpeed,
      firstLanding: this.firstLanding,
      rollDecay: this.rollDecay,
      result: this.result,
      originD: this.originD,
      originX: this.originX,
      aiming: this.aiming,
      power: this.power,
      aimRad: this.aimRad,
      armed: this.armed,
      strokes: this.strokes,
      holed: this.holed,
      dragStart: { ...this.dragStart },
      maxPull: this.maxPull,
      shotOriginD: this.shotOriginD,
      shotOriginX: this.shotOriginX,
      penaltyPending: this.penaltyPending,
      stepGuard: this.stepGuard,
    };
  }

  private restore(s: CourseSnapshot): void {
    Object.assign(this.ball, s.ball);
    this.trail.length = 0;
    for (const p of s.trail) this.trail.push(p);
    this.clubId = s.clubId;
    this.spinBack = s.spinBack;
    this.spinSide = s.spinSide;
    this.launchSpinSide = s.launchSpinSide;
    this.windAlong = s.windAlong;
    this.windCross = s.windCross;
    this.carry = s.carry;
    this.total = s.total;
    this.apex = s.apex;
    this.ballSpeed = s.ballSpeed;
    this.firstLanding = s.firstLanding;
    this.rollDecay = s.rollDecay;
    this.result = s.result;
    this.originD = s.originD;
    this.originX = s.originX;
    this.aiming = s.aiming;
    this.power = s.power;
    this.aimRad = s.aimRad;
    this.armed = s.armed;
    this.strokes = s.strokes;
    this.holed = s.holed;
    this.dragStart = { ...s.dragStart };
    this.maxPull = s.maxPull;
    this.shotOriginD = s.shotOriginD;
    this.shotOriginX = s.shotOriginX;
    this.penaltyPending = s.penaltyPending;
    this.stepGuard = s.stepGuard;
  }

  // Non-committing trajectory PREDICTION for the aim aid — runs the CURRENT
  // address inputs (club/power/steer/spin) through the SAME launch+flight+roll
  // pipeline the live shot uses and captures the path, WITHOUT disturbing any
  // live state (snapshot() before, restore() after — see above). Because it
  // reuses the real integrator ON THE TERRAIN, the drawn arc, landing reticle
  // and roll-out marker are true to the yard. `accuracy` bakes in a tap-timing
  // miss so the dispersion edges can be drawn. Read-only — the renderer calls it
  // several times per address (centre + both edges).
  predict(accuracy = 0): CoursePrediction {
    const fixedS = FIXED_MS / 1000;
    const stride = 2;
    const b = this.ball;
    const snap = this.snapshot();

    const e = Math.max(-1, Math.min(1, accuracy));
    const powerW = ACCURACY_POWER_FLOOR + (1 - ACCURACY_POWER_FLOOR) * this.power;
    const lss = Math.max(
      -ACCURACY_SPIN_MAX,
      Math.min(ACCURACY_SPIN_MAX, this.spinSide + e * ACCURACY_CURVE * powerW),
    );
    this.originD = b.d;
    this.originX = b.x;
    const dir = this.bearingToPin() + this.aimRad + e * ACCURACY_AIM * powerW;
    // Predict the SAME stroke the live fire will make — a putt roll on the green,
    // a lofted swing elsewhere — so the on-turf aim line never lies about it.
    if (this.putting()) this.puttLaunch(this.power, dir);
    else this.swing(this.power, dir, lss);

    const path: CourseTrailPt[] = [{ d: b.d, x: b.x, h: b.h }];
    let landing: { d: number; x: number; h: number } | null = null;
    let i = 0;
    let guard = 0;
    while (b.inFlight && guard < 100000) {
      const wasFirst = this.firstLanding;
      this.substep(fixedS);
      if (wasFirst && !this.firstLanding && landing == null) {
        landing = { d: b.d, x: b.x, h: b.h };
      }
      if (i % stride === 0) path.push({ d: b.d, x: b.x, h: b.h });
      i++;
      guard++;
    }
    path.push({ d: b.d, x: b.x, h: b.h });
    const out: CoursePrediction = {
      path,
      landing,
      rest: { d: b.d, x: b.x, h: b.h },
      result: this.result,
    };

    this.restore(snap);
    return out;
  }

  // Drive a single shot end to end and MEASURE it (tests / tuning / AI). Sets
  // club/spin/aim/power off the given origin, launches, integrates to rest.
  simulateShot(opts: CourseShotOptions = {}): CourseShot {
    const fixedS = FIXED_MS / 1000;
    const b = this.ball;
    if (opts.from) {
      b.d = opts.from.d;
      b.x = opts.from.x;
    } else {
      b.d = this.hole.tee.d;
      b.x = this.hole.tee.x;
    }
    this.originD = b.d;
    this.originX = b.x;
    if (opts.clubId) this.clubId = opts.clubId;
    this.spinBack = Math.max(-1, Math.min(1, opts.spinBack ?? 0));
    this.spinSide = Math.max(-1, Math.min(1, opts.spinSide ?? 0));
    if (opts.windAlong != null) this.windAlong = opts.windAlong;
    if (opts.windCross != null) this.windCross = opts.windCross;
    const aim = ((opts.aimDeg ?? 0) * Math.PI) / 180;
    this.swing(opts.power ?? 1, aim, this.spinSide);
    let guard = 0;
    while (this.ball.inFlight && guard < 100000) {
      this.substep(fixedS);
      guard++;
    }
    const p = this.hole.pin;
    return {
      carry: Math.round(this.carry),
      total: Math.round(this.total),
      apex: Math.round(this.apex),
      ballSpeed: Math.round(this.ballSpeed),
      restD: b.d,
      restX: b.x,
      distToPin: Math.round(Math.hypot(b.d - p.d, b.x - p.x)),
      result: this.result,
    };
  }

  // A putt/roll from a lie with an initial ground speed + bearing (no launch
  // angle). Used to prove greens break and for the putting phase on the course.
  simulatePutt(from: { d: number; x: number }, speed: number, bearingDeg: number): CourseShot {
    const fixedS = FIXED_MS / 1000;
    const b = this.ball;
    b.d = from.d;
    b.x = from.x;
    b.h = this.ground(b.d, b.x);
    this.originD = b.d;
    this.originX = b.x;
    const a = (bearingDeg * Math.PI) / 180;
    b.vd = speed * Math.cos(a);
    b.vx = speed * Math.sin(a);
    b.vh = 0;
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    this.carry = 0;
    this.apex = 0;
    this.firstLanding = false;
    // Putting surface friction: use the lie's own material run, no club bite.
    const mat = TERRAIN[terrainFor(this.lieAt(b.d, b.x))];
    this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - 0.985) / mat.runMul));
    let guard = 0;
    while (this.ball.inFlight && guard < 100000) {
      this.substep(fixedS);
      guard++;
    }
    const p = this.hole.pin;
    return {
      carry: 0,
      total: Math.round(this.origin2D(b.d, b.x)),
      apex: 0,
      ballSpeed: Math.round(speed),
      restD: b.d,
      restX: b.x,
      distToPin: Math.round(Math.hypot(b.d - p.d, b.x - p.x)),
      result: this.result,
    };
  }

  // Slope of the ground under a point, for a putt-read aid later (the UI can draw
  // the break arrow from this). Thin wrapper so the UI needn't import terrain.
  slopeUnder(d: number, x: number): { gd: number; gx: number } {
    return gradientAt(this.hole, d, x);
  }
}
