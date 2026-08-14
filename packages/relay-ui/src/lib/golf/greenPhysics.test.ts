// Harness for the shared green-physics helpers (lib/golf/greenPhysics.ts): the
// Stimpmeter friction model, its roll-out calibration and the speed-dependent
// cup capture. These are the principled constants both the Course green and (in
// future) Mini-Golf read, so pin them down independently of any sim.

import { describe, it, expect } from 'vitest';
import {
  CUP_CAPTURE_SPEED,
  cupCaptured,
  frictionCoef,
  greenRollDecel,
  launchSpeedForRoll,
  rollOutDistance,
  POLE_R,
  POLE_RESTITUTION,
  poleDeflect,
  poleSweep,
} from './greenPhysics';

describe('green physics — Stimpmeter friction', () => {
  it('μ ≈ 0.611 / stimp', () => {
    expect(frictionCoef(10)).toBeCloseTo(0.0611, 4);
    expect(frictionCoef(12)).toBeCloseTo(0.0509, 4);
  });

  it('a faster green (higher stimp) has lower friction and a longer roll', () => {
    expect(frictionCoef(12)).toBeLessThan(frictionCoef(9));
    const g = 16; // the sim's tuned gravity
    const fast = rollOutDistance(5, greenRollDecel(g, 12));
    const slow = rollOutDistance(5, greenRollDecel(g, 9));
    expect(fast).toBeGreaterThan(slow);
  });

  it('roll-out and launch-speed are exact inverses (calibration)', () => {
    const a = greenRollDecel(16, 10);
    for (const d of [2, 8, 20, 35]) {
      const v = launchSpeedForRoll(d, a);
      expect(rollOutDistance(v, a)).toBeCloseTo(d, 6);
    }
  });
});

describe('green physics — speed-dependent cup capture', () => {
  const cupR = 0.5;

  it('a dead-slow ball drops from anywhere within the cup radius', () => {
    expect(cupCaptured(0.45, 0.1, cupR)).toBe(true);
    expect(cupCaptured(0.0, 0.1, cupR)).toBe(true);
  });

  it('a ball at or over the capture limit never holes (lips out / rolls over)', () => {
    expect(cupCaptured(0.0, CUP_CAPTURE_SPEED, cupR)).toBe(false);
    expect(cupCaptured(0.0, CUP_CAPTURE_SPEED + 2, cupR)).toBe(false);
  });

  it('the effective capture radius SHRINKS as speed rises', () => {
    // A ball near the rim (0.4 of 0.5) holes when slow but NOT when quick.
    expect(cupCaptured(0.4, 0.2, cupR)).toBe(true);
    expect(cupCaptured(0.4, 1.2, cupR)).toBe(false);
    // A quicker ball can still drop, but only if it is nearly dead-centre.
    expect(cupCaptured(0.05, 1.2, cupR)).toBe(true);
  });

  it('the ELLIPTIC falloff captures mid-pace putts the old LINEAR shrink rejected', () => {
    // This is the headline reliability fix: an on-pace putt on line must drop.
    // The old model shrank the effective radius LINEARLY, r_lin = cupR·(1−s/limit),
    // which pinched the window so tight that on-pace putts skimmed the rim. The
    // new model uses an ELLIPTIC falloff, r_ell = cupR·√(1−(s/limit)²), which stays
    // near the full radius through the slow/normal pace band. Because √(1−r²) ≥
    // (1−r) for 0≤r≤1, there is always a ring where the new model captures and the
    // old one wouldn't — pin a concrete case in that ring so a regression to the
    // linear shrink fails loudly.
    const speed = 0.8; // mid-pace: ratio = 0.5 of the 1.6 capture limit
    const ratio = speed / CUP_CAPTURE_SPEED;
    const rElliptic = cupR * Math.sqrt(1 - ratio * ratio); // ≈ 0.433
    const rLinearOld = cupR * (1 - ratio); // ≈ 0.25
    // A distance strictly BETWEEN the two radii: the elliptic model holes it, the
    // old linear model would have rejected it.
    const dist = (rLinearOld + rElliptic) / 2; // ≈ 0.342
    expect(dist).toBeGreaterThan(rLinearOld);
    expect(dist).toBeLessThan(rElliptic);
    expect(cupCaptured(dist, speed, cupR)).toBe(true); // new: drops
    expect(dist > rLinearOld).toBe(true); // old linear model: would have rejected
  });
});

describe('green physics — flagstick pole deflection', () => {
  it('POLE_R is a small positive radius, smaller than the cup', () => {
    expect(POLE_R).toBeGreaterThan(0);
    expect(POLE_R).toBeLessThan(0.5); // < CUP_R — the pole is a sliver at the centre
  });

  it('a head-on strike reverses the normal component and damps it by the restitution', () => {
    // Ball moving in −d straight into a pin that is dead ahead: normal points
    // pin→ball = +d (1,0), velocity is (−v,0). The normal component reverses and
    // is scaled by POLE_RESTITUTION; the (zero) tangential is preserved.
    const v = 10;
    const r = poleDeflect(-v, 0, 1, 0);
    expect(r.v1).toBeCloseTo(POLE_RESTITUTION * v, 9); // bounced back, pace killed
    expect(r.v2).toBe(0);
    expect(Math.abs(r.v1)).toBeLessThan(v); // energy lost to the pole
  });

  it('preserves the tangential glide, reversing only the inbound normal', () => {
    // Normal +x (1,0); velocity has an inbound −x part and a +y glide. Only the
    // x (normal) part reverses+damps; the y (tangential) part is untouched.
    const r = poleDeflect(-6, 4, 1, 0);
    expect(r.v1).toBeCloseTo(POLE_RESTITUTION * 6, 9);
    expect(r.v2).toBe(4); // tangential glide unchanged
  });

  it('a custom restitution scales the rebound (a livelier or deader pole)', () => {
    expect(poleDeflect(-10, 0, 1, 0, 0.2).v1).toBeCloseTo(2, 9);
    expect(poleDeflect(-10, 0, 1, 0, 0.8).v1).toBeCloseTo(8, 9);
  });
});

describe('green physics — swept pin collision (poleSweep)', () => {
  it('a segment that steps OVER the pin still registers (no tunneling)', () => {
    // prev and cur BOTH sit outside R on opposite sides of the pin, but the
    // segment passes through the centre — a single-endpoint point test would miss
    // it entirely; the swept closest-approach catches it (minDist ≈ 0).
    const R = 0.28;
    const sw = poleSweep(-1, 0, 1, 0, 0, 0, R);
    expect(Math.hypot(-1, 0)).toBeGreaterThan(R); // prev outside the zone
    expect(Math.hypot(1, 0)).toBeGreaterThan(R); // cur outside the zone
    expect(sw.minDist).toBeCloseTo(0, 9); // …yet the sweep found the pin
    expect(sw.approaching).toBe(true);
    // The contact normal is the ENTRY side (−x), a real inbound normal for a
    // meaningful bounce (not the near-tangent normal at closest approach).
    expect(sw.n1).toBeCloseTo(-1, 6);
    expect(sw.n2).toBeCloseTo(0, 6);
  });

  it('reports the true closest approach for a glancing pass', () => {
    const R = 0.5;
    const sw = poleSweep(-2, 0.3, 2, 0.3, 0, 0, R); // passes 0.3 above the pin
    expect(sw.minDist).toBeCloseTo(0.3, 6);
    expect(sw.approaching).toBe(true);
  });

  it('a miss (closest approach beyond R) reports minDist > R', () => {
    const R = 0.28;
    const sw = poleSweep(-2, 1, 2, 1, 0, 0, R); // passes 1 unit clear
    expect(sw.minDist).toBeGreaterThan(R);
  });

  it('a segment moving AWAY from the pin is not approaching', () => {
    const R = 0.5;
    const sw = poleSweep(0, 0, 1, 0, 0, 0, R); // starts at the centre, moves out
    expect(sw.approaching).toBe(false);
  });
});
