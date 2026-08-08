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
});
