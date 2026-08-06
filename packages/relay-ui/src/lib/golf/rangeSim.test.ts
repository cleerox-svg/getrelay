// Headless dynamics harness for the driving-range shot model. Drives the REAL
// RangeSim pipeline (arm → fireArmed → fixed-timestep substep loop to rest via
// simulateShot) and MEASURES outcomes, so the shot physics can be tuned and
// regression-tested BEFORE anything ships. No DOM, no canvas, no wind — pure
// deterministic ballistics.
//
// Run: `pnpm --filter @relay/ui test`. The tables below are printed to stdout
// (the numbers we tune against); the expect() assertions fail loudly on a
// regression (broken ladder, dead aim, flipped spin, drifting neutral shot).

import { describe, it, expect } from 'vitest';
import { RangeSim } from './rangeSim';
import type { SimulateShotOptions } from './rangeSim';
import { CLUBS } from './clubs';
import { PINS } from './rangeTargets';

// A fresh sim with NO wind and no challenge target — the deterministic bench.
function bench(): RangeSim {
  return new RangeSim({ pins: PINS, target: null, windAlong: 0, windCross: 0 });
}

function shot(opts: SimulateShotOptions) {
  return bench().simulateShot(opts);
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

describe('range shot dynamics', () => {
  it('full-power neutral-spin straight-aim table (the tuning bench)', () => {
    const rows: string[] = [];
    rows.push('  club     | power | carry | total |  apex | ballSpd | result');
    rows.push('  ---------+-------+-------+-------+-------+---------+-------');
    for (const c of CLUBS) {
      const m = shot({ clubId: c.id, power: 1 });
      rows.push(
        `  ${pad(c.name, 8)} | ${pad('1.00', 5)} | ${pad(m.carry, 5)} | ${pad(
          m.total,
          5,
        )} | ${pad(m.apex, 5)} | ${pad(m.ballSpeed, 6)} | ${m.result}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[FULL-POWER NEUTRAL BAG]\n' + rows.join('\n') + '\n');

    // Monotonic ladder: every club must carry AND total further than the next
    // shorter club (a broken/duplicated baseSpeed shows up here immediately).
    let prevCarry = Infinity;
    let prevTotal = Infinity;
    for (const c of CLUBS) {
      const m = shot({ clubId: c.id, power: 1 });
      expect(m.carry, `${c.name} carry < previous`).toBeLessThan(prevCarry);
      expect(m.total, `${c.name} total < previous`).toBeLessThan(prevTotal);
      prevCarry = m.carry;
      prevTotal = m.total;
    }

    // Distance target: a full-power driver totals ~340-350 yd (carry ~290-300).
    const drv = shot({ clubId: 'driver', power: 1 });
    expect(drv.total).toBeGreaterThanOrEqual(338);
    expect(drv.total).toBeLessThanOrEqual(352);
    expect(drv.carry).toBeGreaterThanOrEqual(285);
    expect(drv.carry).toBeLessThanOrEqual(305);
  });

  it('driver power curve (the forgiving map shape)', () => {
    const rows: string[] = [];
    rows.push('  power | carry | total');
    rows.push('  ------+-------+------');
    const powers = [0.25, 0.5, 0.75, 1.0];
    const carries: number[] = [];
    for (const p of powers) {
      const m = shot({ clubId: 'driver', power: p });
      carries.push(m.carry);
      rows.push(`  ${pad(p.toFixed(2), 5)} | ${pad(m.carry, 5)} | ${pad(m.total, 5)}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n[DRIVER POWER CURVE]\n' + rows.join('\n') + '\n');

    // Monotonic increasing with power, and the floor keeps even a 25% pull real.
    for (let i = 1; i < carries.length; i++) {
      expect(carries[i]!).toBeGreaterThan(carries[i - 1]!);
    }
    expect(carries[0]!).toBeGreaterThan(120); // POWER_FLOOR still bombs a bit
  });

  it('driver aim sweep proves left/right steering', () => {
    const rows: string[] = [];
    rows.push('  aim°  | lateral(ball.x, +right) | total');
    rows.push('  ------+-------------------------+------');
    const aims = [-40, -20, 0, 20, 40];
    const lat: Record<number, number> = {};
    for (const a of aims) {
      const m = shot({ clubId: 'driver', power: 1, aimDeg: a });
      lat[a] = m.lateral;
      rows.push(`  ${pad(a, 4)}° | ${pad(m.lateral.toFixed(1), 23)} | ${pad(m.total, 5)}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n[DRIVER AIM SWEEP]\n' + rows.join('\n') + '\n');

    // +right, -left, ~centered straight — the whole point of the aim control.
    expect(lat[40]!).toBeGreaterThan(60);
    expect(lat[-40]!).toBeLessThan(-60);
    expect(Math.abs(lat[0]!)).toBeLessThan(2);
    // Monotonic across the sweep.
    expect(lat[40]!).toBeGreaterThan(lat[20]!);
    expect(lat[20]!).toBeGreaterThan(lat[0]!);
    expect(lat[0]!).toBeGreaterThan(lat[-20]!);
    expect(lat[-20]!).toBeGreaterThan(lat[-40]!);
  });

  it('spin + accuracy shape the shot correctly', () => {
    const neutral = shot({ clubId: 'driver', power: 1 });
    const draw = shot({ clubId: 'driver', power: 1, spinSide: -1 });
    const fade = shot({ clubId: 'driver', power: 1, spinSide: 1 });
    const back = shot({ clubId: 'driver', power: 1, spinBack: 1 });
    const missL = shot({ clubId: 'driver', power: 1, accuracy: -1 });
    const missR = shot({ clubId: 'driver', power: 1, accuracy: 1 });

    const rows: string[] = [];
    rows.push('  case    | carry | total |  apex | lateral');
    rows.push('  --------+-------+-------+-------+--------');
    const row = (name: string, m: typeof neutral) =>
      rows.push(
        `  ${pad(name, 7)} | ${pad(m.carry, 5)} | ${pad(m.total, 5)} | ${pad(
          m.apex,
          5,
        )} | ${pad(m.lateral.toFixed(1), 7)}`,
      );
    row('neutral', neutral);
    row('draw', draw);
    row('fade', fade);
    row('backspin', back);
    row('miss L', missL);
    row('miss R', missR);
    // eslint-disable-next-line no-console
    console.log('\n[SPIN / ACCURACY]\n' + rows.join('\n') + '\n');

    // Draw curves left (-x), fade curves right (+x).
    expect(draw.lateral).toBeLessThan(-10);
    expect(fade.lateral).toBeGreaterThan(10);
    // Backspin raises apex and adds carry vs neutral, and bites (less roll):
    // total roll (total-carry) is smaller than neutral's.
    expect(back.apex).toBeGreaterThan(neutral.apex);
    expect(back.carry).toBeGreaterThan(neutral.carry);
    expect(back.total - back.carry).toBeLessThan(neutral.total - neutral.carry);
    // Accuracy miss curves the ball the way you pushed it (L=-x, R=+x).
    expect(missL.lateral).toBeLessThan(-10);
    expect(missR.lateral).toBeGreaterThan(10);
  });

  it('neutral shot equals the tuned baseline (no drift)', () => {
    // A dead-center strike with zero spin/aim must land dead straight, so the
    // club ladder the bag is tuned against is never silently moved by the
    // accuracy/spin machinery.
    const a = shot({ clubId: 'driver', power: 1 });
    const b = shot({ clubId: 'driver', power: 1, aimDeg: 0, spinBack: 0, spinSide: 0, accuracy: 0 });
    expect(a.total).toBe(b.total);
    expect(a.carry).toBe(b.carry);
    expect(Math.abs(a.lateral)).toBeLessThan(1);
  });
});
