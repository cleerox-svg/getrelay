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
import { PINS, pinsFor, surfaceAt } from './rangeTargets';
import type { RangeLayout } from './rangeTargets';

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

    // Distance target: a full-power driver CARRIES ~290 and, on the firm
    // fairway lie, RUNS OUT to ~375 (the golf-like bounce+run pass gave the
    // fairway much more release — see TERRAIN.fairway in rangeSim.ts).
    const drv = shot({ clubId: 'driver', power: 1 });
    expect(drv.total).toBeGreaterThanOrEqual(365);
    expect(drv.total).toBeLessThanOrEqual(390);
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

  it('slingshot pull steers aim opposite the drag; power tracks magnitude', () => {
    const sim = bench();
    sim.setMaxPull(200);
    // Drag the finger DOWN and to the RIGHT (start 100,100 → 160,260): the shot
    // flings the other way → aims LEFT (aimRad < 0).
    sim.onPointerDown({ x: 100, y: 100 });
    sim.onPointerMove({ x: 160, y: 260 });
    expect(sim.aimRad, 'drag right → aim left').toBeLessThan(-0.05);
    expect(sim.power, 'power tracks pull magnitude').toBeGreaterThan(0.5);
    // DOWN and to the LEFT → aims RIGHT (aimRad > 0).
    sim.onPointerDown({ x: 100, y: 100 });
    sim.onPointerMove({ x: 40, y: 260 });
    expect(sim.aimRad, 'drag left → aim right').toBeGreaterThan(0.05);
    // Straight DOWN → dead straight.
    sim.onPointerDown({ x: 100, y: 100 });
    sim.onPointerMove({ x: 100, y: 280 });
    expect(Math.abs(sim.aimRad), 'straight pull → straight').toBeLessThan(0.02);
    // A tiny pull inside the deadzone doesn't steer (stays straight).
    sim.onPointerDown({ x: 100, y: 100 });
    sim.onPointerMove({ x: 118, y: 108 });
    expect(sim.aimRad, 'deadzone: short pull stays straight').toBe(0);
    // arm() locks the steered aim from the final pull vector.
    sim.onPointerDown({ x: 100, y: 100 });
    sim.onPointerMove({ x: 150, y: 250 });
    sim.arm({ x: 150, y: 250 });
    expect(sim.armed).toBe(true);
    expect(sim.aimRad).toBeLessThan(-0.05);
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

// --- Shot prediction: the aim aid must match the real shot -------------------
// predict() runs the CURRENT inputs through the SAME pipeline as the live shot
// (snapshot/restore), so the on-turf arc + landing reticle can be trusted. These
// tests pin that guarantee: the predicted landing/rest match simulateShot() to
// the yard, predict() never mutates the sim, and wind shifts the prediction the
// expected way. If prediction ever forks from the real integrator, this fails.

// Build a sim with fixed inputs (no wind unless asked), matching simulateShot's
// setup, so predict() and simulateShot() see identical state.
function primed(opts: SimulateShotOptions & { windAlong?: number; windCross?: number }): RangeSim {
  const sim = new RangeSim({
    pins: PINS,
    target: null,
    windAlong: opts.windAlong ?? 0,
    windCross: opts.windCross ?? 0,
    layout: opts.layout,
    isChallenge: opts.isChallenge,
  });
  sim.teeUp();
  if (opts.layout) sim.layout = opts.layout;
  if (opts.isChallenge != null) sim.isChallenge = opts.isChallenge;
  if (opts.clubId) sim.selectClub(opts.clubId);
  sim.setSpin(opts.spinBack ?? 0, opts.spinSide ?? 0);
  sim.setAim(((opts.aimDeg ?? 0) * Math.PI) / 180);
  sim.power = Math.max(0, Math.min(1, opts.power ?? 1));
  return sim;
}

describe('shot prediction (aim aid)', () => {
  it('predicted landing/rest match the real shot to the yard, every club', () => {
    const rows: string[] = [];
    rows.push('  club     | pred carry/total | real carry/total');
    rows.push('  ---------+------------------+-----------------');
    for (const c of CLUBS) {
      const sim = primed({ clubId: c.id, power: 1 });
      const pred = sim.predict({ accuracy: 0, includeWind: true });
      const real = shot({ clubId: c.id, power: 1 });
      const predCarry = Math.round(pred.landing?.d ?? pred.rest.d);
      const predTotal = Math.round(pred.rest.d);
      rows.push(
        `  ${pad(c.name, 8)} | ${pad(predCarry, 7)}/${pad(predTotal, 8)} | ${pad(
          real.carry,
          7,
        )}/${pad(real.total, 8)}`,
      );
      // Same integrator → within a yard (rounding only).
      expect(Math.abs(predTotal - real.total), `${c.name} total`).toBeLessThanOrEqual(1);
      expect(Math.abs(predCarry - real.carry), `${c.name} carry`).toBeLessThanOrEqual(1);
      expect(Math.round(pred.apex), `${c.name} apex`).toBe(real.apex);
      expect(pred.result, `${c.name} result`).toBe(real.result);
    }
    // eslint-disable-next-line no-console
    console.log('\n[PREDICTION vs REAL]\n' + rows.join('\n') + '\n');
  });

  it('prediction tracks aim and spin like the real shot (lateral to the yard)', () => {
    const cases: SimulateShotOptions[] = [
      { clubId: 'driver', power: 1, aimDeg: 30 },
      { clubId: 'driver', power: 1, aimDeg: -30 },
      { clubId: 'driver', power: 1, spinSide: -1 },
      { clubId: '7iron', power: 0.7, spinSide: 1 },
      { clubId: 'pw', power: 0.5, spinBack: 1 },
    ];
    for (const opts of cases) {
      const pred = primed(opts).predict({ accuracy: 0, includeWind: true });
      const real = shot(opts);
      const label = JSON.stringify(opts);
      expect(Math.abs(pred.rest.x - real.lateral), `${label} lateral`).toBeLessThanOrEqual(1);
      expect(Math.abs(Math.round(pred.rest.d) - real.total), `${label} total`).toBeLessThanOrEqual(1);
    }
  });

  it('a tap-timing miss bends the prediction the way it bends the shot', () => {
    const missL = primed({ clubId: 'driver', power: 1 }).predict({ accuracy: -1 });
    const missR = primed({ clubId: 'driver', power: 1 }).predict({ accuracy: 1 });
    const realL = shot({ clubId: 'driver', power: 1, accuracy: -1 });
    const realR = shot({ clubId: 'driver', power: 1, accuracy: 1 });
    // Left miss hooks (-x), right miss slices (+x) — matching the real shot.
    expect(missL.rest.x).toBeLessThan(-10);
    expect(missR.rest.x).toBeGreaterThan(10);
    expect(Math.abs(missL.rest.x - realL.lateral)).toBeLessThanOrEqual(1);
    expect(Math.abs(missR.rest.x - realR.lateral)).toBeLessThanOrEqual(1);
    // The dispersion the cone spans is real (edges are far apart).
    expect(missR.rest.x - missL.rest.x).toBeGreaterThan(20);
  });

  it('predict() never mutates the sim (read-only probe)', () => {
    const sim = primed({ clubId: '5iron', power: 0.8, aimDeg: 12, spinSide: -0.5, spinBack: 0.3 });
    const before = JSON.stringify(sim.getState());
    const ballBefore = JSON.stringify(sim.ball);
    // Several probes, as the renderer does per input change.
    sim.predict({ accuracy: 0, includeWind: true });
    sim.predict({ accuracy: 0, includeWind: false });
    sim.predict({ accuracy: -1 });
    sim.predict({ accuracy: 1 });
    expect(JSON.stringify(sim.getState())).toBe(before);
    expect(JSON.stringify(sim.ball)).toBe(ballBefore);
    expect(sim.ball.inFlight).toBe(false);
    // A live shot after probing still produces the tuned number (nothing drifted).
    const real = sim.simulateShot({ clubId: '5iron', power: 0.8, aimDeg: 12, spinSide: -0.5, spinBack: 0.3 });
    const pred = primed({ clubId: '5iron', power: 0.8, aimDeg: 12, spinSide: -0.5, spinBack: 0.3 }).predict();
    expect(Math.abs(Math.round(pred.rest.d) - real.total)).toBeLessThanOrEqual(1);
  });

  it('wind bends the prediction; includeWind:false is the pre-wind line', () => {
    // A stiff left-to-right crosswind pushes the ball right (+x).
    const sim = primed({ clubId: 'driver', power: 1, windCross: 3 });
    const withWind = sim.predict({ accuracy: 0, includeWind: true });
    const preWind = sim.predict({ accuracy: 0, includeWind: false });
    // Wind visibly shifts the landing to the right of the pre-wind line.
    expect(withWind.rest.x - preWind.rest.x).toBeGreaterThan(5);
    // The pre-wind line matches a genuine no-wind shot (isolates the wind term).
    const noWind = shot({ clubId: 'driver', power: 1 });
    expect(Math.abs(Math.round(preWind.rest.d) - noWind.total)).toBeLessThanOrEqual(1);
    expect(Math.abs(preWind.rest.x - noWind.lateral)).toBeLessThanOrEqual(1);
  });
});

// --- Layout system: validate all three landing-area designs -----------------
// Each layout (+ practice/challenge where it matters) is driven through the
// REAL sim; we print the per-layout full-power straight bag with the landing
// `result` per club, then assert each layout's contract. The neutral distance
// ladder is layout-independent (surface only decides grass/island/water/fence),
// so the driver still totals ~348 wherever it finishes on turf.

// A full-power straight shot's landing on a given layout+mode.
function landing(layout: RangeLayout, isChallenge: boolean, clubId: string, aimDeg = 0) {
  const sim = new RangeSim({ pins: pinsFor(layout), target: null, layout, isChallenge });
  return sim.simulateShot({ clubId, power: 1, aimDeg, layout, isChallenge });
}

function bagTable(layout: RangeLayout, isChallenge: boolean): string {
  const rows: string[] = [];
  rows.push('  club     | carry | total | result');
  rows.push('  ---------+-------+-------+-------');
  for (const c of CLUBS) {
    const m = landing(layout, isChallenge, c.id);
    rows.push(`  ${pad(c.name, 8)} | ${pad(m.carry, 5)} | ${pad(m.total, 5)} | ${m.result}`);
  }
  return rows.join('\n');
}

function grassCount(layout: RangeLayout, isChallenge: boolean): number {
  let n = 0;
  for (const c of CLUBS) if (landing(layout, isChallenge, c.id).result === 'grass') n++;
  return n;
}

describe('range layouts', () => {
  it('prints the per-layout full-power straight bag tables', () => {
    const modes: { layout: RangeLayout; isChallenge: boolean; label: string }[] = [
      { layout: 'lane', isChallenge: false, label: 'lane · practice' },
      { layout: 'lane', isChallenge: true, label: 'lane · challenge' },
      { layout: 'practiceLane', isChallenge: false, label: 'practiceLane · practice' },
      { layout: 'practiceLane', isChallenge: true, label: 'practiceLane · challenge' },
      { layout: 'fairway', isChallenge: false, label: 'fairway · practice' },
      { layout: 'fairway', isChallenge: true, label: 'fairway · challenge' },
    ];
    for (const m of modes) {
      // eslint-disable-next-line no-console
      console.log(
        `\n[LAYOUT: ${m.label}]  (grass ${grassCount(m.layout, m.isChallenge)}/8)\n` +
          bagTable(m.layout, m.isChallenge) +
          '\n',
      );
    }
  });

  it('lane: causeway catches the driver in both modes (~375 grass)', () => {
    for (const isChallenge of [false, true]) {
      const drv = landing('lane', isChallenge, 'driver');
      expect(drv.result, `lane driver result (challenge=${isChallenge})`).toBe('grass');
      expect(drv.total).toBeGreaterThanOrEqual(365);
      expect(drv.total).toBeLessThanOrEqual(390);
    }
  });

  it('practiceLane: causeway in practice, full water in the challenge', () => {
    // Practice → identical to lane: straight driver lands & rolls on the lane.
    const prac = landing('practiceLane', false, 'driver');
    expect(prac.result).toBe('grass');
    expect(prac.total).toBeGreaterThanOrEqual(365);
    expect(prac.total).toBeLessThanOrEqual(390);
    // Challenge → causeway gone: a straight driver splashes; you must aim islands.
    const chal = landing('practiceLane', true, 'driver');
    expect(chal.result).toBe('water');
    // The centre pins ARE islands the challenge can spawn (aim finds turf).
    expect(surfaceAt(165, -14, 'practiceLane', true)).toBe('island');
  });

  it('fairway: driver carries to the far fairway, ≥5/8 land on grass', () => {
    // Driver clears the crossing hazard and rolls out on the far fairway.
    const drv = landing('fairway', true, 'driver');
    expect(drv.result).toBe('grass');
    expect(drv.total).toBeGreaterThanOrEqual(365);
    expect(drv.total).toBeLessThanOrEqual(390);
    // Most clubs land on grass straight (near or far fairway) — same in both modes.
    expect(grassCount('fairway', false)).toBeGreaterThanOrEqual(5);
    expect(grassCount('fairway', true)).toBeGreaterThanOrEqual(5);
    // An island green is still surrounded by water: a small off-aim miss splashes.
    expect(surfaceAt(256, -20, 'fairway', true)).toBe('island'); // on the green
    expect(surfaceAt(256, -8, 'fairway', true)).toBe('water'); // ~12yd off-aim
    // The middle of the crossing stays water — no centred stepping-stone.
    expect(surfaceAt(265, 0, 'fairway', true)).toBe('water');
    // The hazard is real: at least one club splashes straight (can't trivially
    // bomb every club onto turf).
    expect(grassCount('fairway', true)).toBeLessThan(8);
  });
});
