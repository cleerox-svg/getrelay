// The ROLL bench — the ball on the ground, with no defence in it.
//
// Split out of `groundBall.test.ts` when `roll.ts` was extracted at the 500-line
// cap, and split along the same seam: everything here is a statement about where
// the ball is and when, and nothing here knows a fielder exists. The race, the
// throw and the runner are next door.

import { describe, expect, it } from 'vitest';
import { launchFromAngles, simulateBattedBall } from './battedBallSim';
import { infieldDepthFt } from './fielders';
import { GAME_AIR } from './pitchSim';
import {
  MAX_ROLL_FT,
  ROLL_DECEL_DIRT_FPS2,
  ROLL_DECEL_TURF_FPS2,
  ROLL_GRASS_RATIO,
  ROLL_SAMPLE_S,
  rollDistFt,
  rollPath,
  rollTimeS,
} from './roll';
import { MPH_TO_FPS } from './units';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

describe('the roll', () => {
  it('is the closed-form solution of constant deceleration, on each surface', () => {
    // ⚠ THE DEFINING PROPERTY, NOT A TABLE. `v² = v₀² − 2as` on each surface and
    // the crossing between them is exact — the same standard every other event
    // in this game is held to. Asserted by re-deriving the speed at a sampled
    // point from the TIME the model reports, which is the inverse of what the
    // model computes and so cannot pass on a mis-stated formula.
    for (const bearing of [0, -20, 38, -44]) {
      const edge = infieldDepthFt(bearing);
      for (const [d0, v0] of [[10, 60], [10, 140], [90, 120], [edge - 1, 100], [edge + 20, 90]]) {
        const p = rollPath(d0!, bearing, v0!);
        expect(rollTimeS(p, 0)).toBe(0);
        expect(rollTimeS(p, p.rollFt)).toBeCloseTo(p.stopS, 6);
        expect(p.stopDistFt).toBeCloseTo(d0! + p.rollFt, 12);
        // Monotone in distance, and never past the stop.
        let prev = -1;
        for (let s = 0; s <= p.rollFt + 5; s += 0.5) {
          const t = rollTimeS(p, s);
          expect(t).toBeGreaterThanOrEqual(prev);
          prev = t;
        }
        // Speed at a mid-dirt sample, two ways.
        if (p.dirtFt > 4) {
          const s = p.dirtFt / 2;
          const v = Math.sqrt(v0! ** 2 - 2 * ROLL_DECEL_DIRT_FPS2 * s);
          expect(rollTimeS(p, s)).toBeCloseTo((v0! - v) / ROLL_DECEL_DIRT_FPS2, 9);
        }
      }
    }
    // A ball with no ground speed left does not roll, and never NaNs.
    const dead = rollPath(40, 12, 0);
    expect(dead.rollFt).toBe(0);
    expect(dead.stopS).toBe(0);
    expect(rollTimeS(dead, 50)).toBe(0);
    expect(rollPath(40, 12, -30).rollFt).toBe(0);
    // The bound bites instead of scanning forever.
    expect(rollPath(1, 0, 400).rollFt).toBe(MAX_ROLL_FT);
    // ⚠ `rollDistFt` IS THE EXACT INVERSE OF `rollTimeS`, on both surfaces, and
    // the search depends on it: it iterates the ball's clock and asks where the
    // ball is, while every assertion about interception asks when the ball was
    // somewhere. A drift between the two would be a fielder racing a ball that
    // is not where the model says.
    for (const bearing of [0, -30, 44]) {
      for (const [d0, v0] of [[8, 60], [8, 145], [100, 110]]) {
        const p = rollPath(d0!, bearing, v0!);
        for (let t = 0; t <= p.stopS + 0.2; t += 0.01) {
          const at = rollDistFt(p, t);
          expect(rollTimeS(p, at)).toBeCloseTo(Math.min(t, p.stopS), 7);
        }
        for (let sFt = 0; sFt <= p.rollFt; sFt += 0.5) {
          expect(rollDistFt(p, rollTimeS(p, sFt))).toBeCloseTo(sFt, 6);
        }
      }
    }
  });

  it('⚠ the search samples the ball\'s CLOCK, and that is the bound it needs', () => {
    // ⚠ THE BOUND THIS ASSERTS IS THE ONE THE VERDICT USES. `groundOut` decides
    // one thing — a time against a 4.30 s runner — and the closest rows of the
    // ladder sit ~0.10 s from it, so the sampling error has to be small in
    // SECONDS. Sampling the clock makes it exactly `ROLL_SAMPLE_S` at every ball
    // speed. Sampling the PATH, which this used to do at 1 ft, does not: the
    // table below is the same sweep measured both ways, and the distance
    // sampler's worst case is where the ball is SLOWEST — which is also where
    // the plays are closest. The old assertion bounded `1 ft / v₀` using the
    // FASTEST ball, so it bounded the best case and called it the worst.
    let worstTimeGapS = 0;
    let worstFtPerSample = 0;
    let worstSecPerFoot = 0;
    for (const bearing of [0, -25, 44]) {
      for (const v0 of [45, 90, 145]) {
        const p = rollPath(6, bearing, v0);
        const steps = Math.max(1, Math.ceil(p.stopS / ROLL_SAMPLE_S));
        let prevT = 0;
        let prevS = 0;
        for (let i = 1; i <= steps; i++) {
          const t = i === steps ? p.stopS : i * ROLL_SAMPLE_S;
          const at = rollDistFt(p, t);
          worstTimeGapS = Math.max(worstTimeGapS, t - prevT);
          worstFtPerSample = Math.max(worstFtPerSample, at - prevS);
          prevT = t;
          prevS = at;
        }
        // The distance sampler's worst case: one foot at the speed the ball is
        // doing one foot from rest.
        // Time to traverse the LAST foot: it enters it at √(2a·1) and leaves at
        // rest, so it takes `v/a` = √(2/a) seconds, not `1/v`.
        worstSecPerFoot = Math.max(worstSecPerFoot, Math.sqrt(2 / ROLL_DECEL_DIRT_FPS2));
      }
    }
    log(
      `\n[SAMPLING] clock sampler: worst gap ${worstTimeGapS.toFixed(
        4,
      )} s (bound ${ROLL_SAMPLE_S} s), ${worstFtPerSample.toFixed(
        2,
      )} ft at the fastest.\n` +
        `  path sampler at 1 ft: ${(1 / 145).toFixed(4)} s at the FASTEST ball but ` +
        `${worstSecPerFoot.toFixed(3)} s over the LAST foot —\n  larger than the ~0.10 s margins the ladder decides on. Hence the clock.\n`,
    );
    expect(worstTimeGapS).toBeLessThanOrEqual(ROLL_SAMPLE_S + 1e-12);
    // …and the bound is an order of magnitude inside the margin it resolves.
    expect(ROLL_SAMPLE_S * 10).toBeLessThan(0.1);
    // The old distance bound, shown failing the same test it used to pass.
    expect(worstSecPerFoot).toBeGreaterThan(0.1);
  });

  it('⚠ crosses the grass line and slows THERE, not at the landing point', () => {
    // ⚠ THE TEST IS THE SAME BALL AT TWO BEARINGS, because the grass line is a
    // FUNCTION of bearing (`fielders.infieldDepthFt`) and a model that used one
    // radius would roll both the same distance. Down the line the ball reaches
    // grass 27.9 ft sooner than it does to centre, so it stops sooner.
    // Fast enough to CROSS the line at both bearings — a ball that stops on the
    // dirt never sees the second surface and would pass this test vacuously.
    const centre = rollPath(20, 0, 150);
    const line = rollPath(20, 45, 150);
    expect(ROLL_DECEL_TURF_FPS2).toBeCloseTo(ROLL_GRASS_RATIO * ROLL_DECEL_DIRT_FPS2, 12);
    expect(ROLL_GRASS_RATIO).toBeGreaterThan(1);
    expect(centre.dirtFt).toBeCloseTo(infieldDepthFt(0) - 20, 9);
    expect(line.dirtFt).toBeCloseTo(infieldDepthFt(45) - 20, 9);
    expect(centre.rollFt).toBeGreaterThan(centre.dirtFt);
    expect(line.rollFt).toBeGreaterThan(line.dirtFt);
    expect(line.rollFt).toBeLessThan(centre.rollFt);
    // …and it really is the SURFACE doing it, not the shorter dirt run: with one
    // deceleration everywhere the same ball would roll `v²/2a` from wherever it
    // landed, identically at both bearings.
    expect(centre.rollFt).toBeLessThan((150 * 150) / (2 * ROLL_DECEL_DIRT_FPS2));
    let table =
      '\n[ROLL — a 150 ft/s ground ball from 20 ft out, by bearing]\n' +
      '  bearing   grass line   dirt run   total roll   stops at   time to rest\n';
    for (const b of [0, 20, 38, 45]) {
      const p = rollPath(20, b, 150);
      table += `  ${String(b).padStart(5)}°   ${infieldDepthFt(b).toFixed(1).padStart(10)}   ${p.dirtFt
        .toFixed(1)
        .padStart(8)}   ${p.rollFt.toFixed(1).padStart(10)}   ${p.stopDistFt
        .toFixed(1)
        .padStart(8)}   ${p.stopS.toFixed(2).padStart(12)}\n`;
    }
    table +=
      `\n  ⚠ The tail is over-decelerated and the constant's own comment says so: a\n` +
      `  91 mph ground ball comes to rest ${rollPath(26, 0, 133).stopDistFt.toFixed(
        0,
      )} ft out, where a real one is still moving\n  when the outfielder picks it up. Not observable in this milestone's outcome\n  set — every ball that gets through the infield is a single either way.\n`;
    log(table);
  });

  it('⚠ the roll starts at the GROUND speed, which is where the angle lives', () => {
    // A topped chopper and a grazing screamer can land at the same SPEED and
    // roll at wildly different ones, because one of them is spending most of its
    // velocity going down. That is the whole angle dependence of the model and it
    // arrives free, out of the integrator, with no bounce-retention knob.
    const fps = (mph: number) => mph * MPH_TO_FPS;
    let table =
      '\n[GROUND SPEED — what the bounce keeps, by launch angle]\n' +
      '  LA    lands at   speed ft/s   GROUND ft/s   kept    roll ft (from 20 ft out)\n';
    for (const la of [-45, -30, -15, -5, 2, 10]) {
      const f = simulateBattedBall(launchFromAngles(95, la, 0, 1500), GAME_AIR);
      const v = fps(f.landingSpeedMph);
      table += `  ${String(la).padStart(3)}°  ${f.carryFt.toFixed(0).padStart(8)}   ${v
        .toFixed(0)
        .padStart(10)}   ${f.landingGroundFps.toFixed(0).padStart(11)}   ${(
        (100 * f.landingGroundFps) / v
      )
        .toFixed(0)
        .padStart(3)} %   ${rollPath(20, 0, f.landingGroundFps).rollFt.toFixed(0).padStart(6)}\n`;
    }
    log(table);
    // The steeper the ball comes in, the smaller the fraction the ground keeps —
    // and the ROLL is the thing that shrinks with it. ⚠ It is NOT the same claim
    // as "a chopper lands slower than a screamer": a topped ball lands almost at
    // once and barely decelerates in the air, so it can land FASTER and still
    // roll less. The decomposition, not the speed, is the mechanism.
    const steep = simulateBattedBall(launchFromAngles(95, -45, 0, 1500), GAME_AIR);
    const graze = simulateBattedBall(launchFromAngles(95, -2, 0, 1500), GAME_AIR);
    expect(steep.landingGroundFps / fps(steep.landingSpeedMph)).toBeLessThan(0.8);
    expect(graze.landingGroundFps / fps(graze.landingSpeedMph)).toBeGreaterThan(0.99);
    expect(rollPath(20, 0, steep.landingGroundFps).rollFt).toBeLessThan(
      rollPath(20, 0, graze.landingGroundFps).rollFt,
    );
  });
});
