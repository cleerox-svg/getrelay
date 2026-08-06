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

import { clubById, DEFAULT_CLUB_ID } from './clubs';
import type { Club } from './clubs';
import { FIXED_MS } from './tuning';
import {
  AIR_DRAG,
  BITE_K,
  CHECK_BACK_FRAC,
  CHECK_BACK_KICK,
  CHECK_TOP_FRAC,
  GRAVITY,
  POWER_FLOOR,
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

const TRAIL_MAX = 64;

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

  constructor(hole: CourseHole, clubId = DEFAULT_CLUB_ID) {
    this.hole = hole;
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

  // Launch from a lie with a locked club/power/aim/spin (mirrors rangeSim.swing,
  // but off an arbitrary origin at the ground's elevation there).
  private swing(power: number, aimRad: number, accuracy: number): void {
    const club = this.club();
    const b = this.ball;
    const sPow = POWER_FLOOR + (1 - POWER_FLOOR) * Math.max(0, Math.min(1, power));
    const s = club.baseSpeed * Math.sqrt(sPow);
    const loft = (club.loft * Math.PI) / 180;
    // Accuracy miss folds into side-spin like the range (kept simple here).
    this.launchSpinSide = this.spinSide + accuracy * 0.9;
    const sH = s * Math.cos(loft);
    b.h = this.ground(b.d, b.x);
    b.vh = s * Math.sin(loft);
    b.vd = sH * Math.cos(aimRad);
    b.vx = sH * Math.sin(aimRad);
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
  }

  substep(dt: number): void {
    const b = this.ball;
    if (!b.inFlight) return;

    b.vd += this.windAlong * dt;
    b.vx += this.windCross * dt;

    if (b.grounded) {
      // Gravity down the fall line (this is the break / downhill run / uphill
      // check). slopeAccel = -g·gradient at the ball.
      const { ad, ax } = slopeAccel(this.hole, b.d, b.x, GRAVITY);
      b.vd += ad * dt;
      b.vx += ax * dt;
      const decay = Math.pow(this.rollDecay, dt * 60);
      b.vd *= decay;
      b.vx *= decay;
      b.d += b.vd * dt;
      b.x += b.vx * dt;
      b.h = this.ground(b.d, b.x);
      this.total = this.origin2D(b.d, b.x);
      const surf = this.lieAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'ob') return this.stop('ob');
      const speed = Math.hypot(b.vd, b.vx);
      if (this.holedOut(speed)) return this.stop('holed');
      if (speed <= ROLL_REST) return this.stop(surf);
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
    if (b.h <= ground && b.vh < 0) {
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
    this.swing(opts.power ?? 1, aim, 0);
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
