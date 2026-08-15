// Headless dynamics bench for the baseball aero core. Every number here is
// either a published reference we must reproduce or a derivation we must not
// silently break. The tables are PRINTED to stdout — read them, don't just
// watch the assertions go green: a change can stay inside every tolerance while
// walking the whole ladder in one direction.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import {
  BALL_AREA_FT2,
  BALL_MASS_SLUG,
  BALL_RADIUS_FT,
  C_D_BASE,
  FIXED_DT,
  RHO_ISA_SEA_LEVEL,
  aeroAccel,
  aeroScale,
  airDensity,
  dragCoef,
  liftCoef,
  spinParameter,
  stepBall,
  crossingFraction,
  lerpBallState,
  vLen,
  vSub,
  vec3,
} from './airPhysics';
import type { BallState } from './airPhysics';
import { FPS_TO_MPH, G_FPS2, MPH_TO_FPS } from './units';

const pad = (s: string | number, n: number) => String(s).padStart(n);

// A four-seam release: horizontal, no spin, sea-level ISA air. The bench for
// the drag calibration.
const K_SEA = aeroScale(RHO_ISA_SEA_LEVEL);

/** Fly a ball to x = `distFt`, returning the state interpolated to that exact x. */
function flyToX(start: BallState, distFt: number, K: number, omega = vec3(0, 0, 0)): BallState {
  let s = start;
  for (let i = 0; i < 20000; i++) {
    const next = stepBall(s, omega, K, FIXED_DT);
    const t = crossingFraction(s.p.x, next.p.x, distFt);
    if (t !== null) return lerpBallState(s, next, t);
    s = next;
  }
  throw new Error('ball never reached target x');
}

describe('ball & air constants (derivations)', () => {
  it('ball spec derives mass, radius and area', () => {
    const rows = [
      `  mass   = ${BALL_MASS_SLUG.toFixed(7)} slug   (5.125 oz / 16 / g)`,
      `  radius = ${BALL_RADIUS_FT.toFixed(6)} ft     (9.125 in circumference / 2π)`,
      `  area   = ${BALL_AREA_FT2.toFixed(7)} ft²    (π r²)`,
    ];
    // eslint-disable-next-line no-console
    console.log('\n[BALL — MLB Rule 3.01 midpoints]\n' + rows.join('\n') + '\n');

    expect(BALL_MASS_SLUG).toBeCloseTo(0.0099556, 6);
    expect(BALL_RADIUS_FT).toBeCloseTo(0.1210237, 6);
    expect(BALL_AREA_FT2).toBeCloseTo(0.0460144, 6);
  });

  it('air density: ISA sea level, park elevations, and the derived K', () => {
    const rows: string[] = [];
    rows.push('  park               | elev ft |  °F |  RH  |    ρ slug/ft³ |     K ft⁻¹ |  vs SL');
    rows.push('  -------------------+---------+-----+------+---------------+------------+-------');
    const cases: Array<[string, number, number, number]> = [
      ['ISA reference', 0, 59, 0],
      ['sea level', 0, 70, 0.5],
      ['sea level, humid', 0, 90, 0.9],
      ['lakeside (~250)', 250, 70, 0.5],
      ['inland (~1000)', 1000, 70, 0.5],
      ['high plains (3500)', 3500, 70, 0.5],
      ['mile high (5200)', 5200, 70, 0.5],
    ];
    const rhoSea = airDensity(0, 70, 0.5);
    for (const [name, elev, t, rh] of cases) {
      const rho = airDensity(elev, t, rh);
      rows.push(
        `  ${pad(name, 18)} | ${pad(elev, 7)} | ${pad(t, 3)} | ${pad(
          rh.toFixed(2),
          4,
        )} | ${pad(rho.toFixed(9), 13)} | ${pad(aeroScale(rho).toFixed(8), 10)} | ${pad(
          (((rho - rhoSea) / rhoSea) * 100).toFixed(1) + '%',
          6,
        )}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[AIR DENSITY → K]\n' + rows.join('\n') + '\n');

    // The published textbook figure 0.002378 slug/ft³ is quoted at ISA sea
    // level: 59 °F, DRY. That is the number this model must reproduce, and it
    // does to 0.04 %.
    expect(RHO_ISA_SEA_LEVEL).toBeGreaterThan(0.002378 * 0.995);
    expect(RHO_ISA_SEA_LEVEL).toBeLessThan(0.002378 * 1.005);
    expect(airDensity(0, 59, 0)).toBeCloseTo(RHO_ISA_SEA_LEVEL, 9);

    // ⚠ airDensity(0, 70, 0.5) is NOT 0.002378. A game-day 70 °F / 50 % RH sea
    // level is 11 °F warmer than the ISA reference AND carries vapour, both of
    // which THIN the air: 0.0023169, i.e. 2.5 % below the textbook figure.
    // Asserting 0.002378 here would have required breaking the ideal gas law,
    // so the assertion follows the physics instead. This ~2.5 % is real and it
    // shows up as roughly 1.5 ft of extra fly-ball carry.
    expect(rhoSea).toBeGreaterThan(0.0023169 * 0.995);
    expect(rhoSea).toBeLessThan(0.0023169 * 1.005);
    expect(rhoSea).toBeLessThan(RHO_ISA_SEA_LEVEL);

    // K is DERIVED, never hand-set. Published-value check: ρ = 0.002378 must
    // give K = 0.005498 ft⁻¹ (we land 0.0054951, 0.05 % under).
    expect(aeroScale(0.002378)).toBeGreaterThan(0.005498 * 0.995);
    expect(aeroScale(0.002378)).toBeLessThan(0.005498 * 1.005);
    expect(aeroScale(0)).toBe(0); // vacuum ⇒ no aero at all
    expect(aeroScale(2 * 0.002378)).toBeCloseTo(2 * aeroScale(0.002378), 9); // linear in ρ

    // A mile high is ~17 % thinner air — the single biggest park effect in the
    // sport, and the reason parks.ts carries an elevation and physics reads it.
    const rhoMile = airDensity(5200, 70, 0.5);
    const dropPct = ((rhoSea - rhoMile) / rhoSea) * 100;
    expect(dropPct).toBeGreaterThan(15);
    expect(dropPct).toBeLessThan(19);

    // Monotone: higher, warmer, wetter air is always thinner.
    expect(airDensity(1000, 70, 0.5)).toBeLessThan(airDensity(0, 70, 0.5));
    expect(airDensity(0, 95, 0.5)).toBeLessThan(airDensity(0, 55, 0.5));
    expect(airDensity(0, 90, 0.9)).toBeLessThan(airDensity(0, 90, 0.1));
  });
});

describe('aero coefficients', () => {
  it('C_L(S) is monotone non-decreasing and capped', () => {
    const rows: string[] = [];
    rows.push('     S   |  C_L  | example');
    rows.push('  -------+-------+---------------------------------');
    const notes: Record<string, string> = {
      '0.00': 'knuckleball (no useful spin)',
      '0.10': 'piecewise knee (both branches = 0.15)',
      '0.20': 'gyro-heavy slider, effective spin only',
      '0.25': 'four-seam ~2400 rpm at 94 mph',
      '0.45': 'cap reached (C_L = 0.35)',
    };
    for (let i = 0; i <= 10; i++) {
      const S = i * 0.05;
      const key = S.toFixed(2);
      rows.push(
        `  ${pad(S.toFixed(3), 6)} | ${pad(liftCoef(S).toFixed(3), 5)} | ${notes[key] ?? ''}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[LIFT COEFFICIENT C_L(S)]\n' + rows.join('\n') + '\n');

    let prev = -Infinity;
    for (let i = 0; i <= 500; i++) {
      const S = (i / 500) * 0.5;
      const cl = liftCoef(S);
      expect(cl, `C_L dipped at S=${S.toFixed(3)}`).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cl;
    }
    expect(liftCoef(0)).toBe(0); // no spin, no Magnus
    expect(liftCoef(0.1)).toBeCloseTo(0.15, 12); // piecewise branches agree
    expect(liftCoef(5)).toBe(0.35); // cap holds far past the useful range

    // Spin parameter sanity: 2400 rpm (251.3 rad/s) at 94 mph (137.9 ft/s).
    const S = spinParameter(94 * MPH_TO_FPS, 2400 * (Math.PI / 30));
    expect(S).toBeGreaterThan(0.2);
    expect(S).toBeLessThan(0.24);
  });
});

describe('aeroAccel', () => {
  it('spinless flight is exactly gravity + drag', () => {
    const v = vec3(130, 4, -6);
    const a = aeroAccel(v, vec3(0, 0, 0), K_SEA);
    const speed = vLen(v);
    const kd = K_SEA * dragCoef(speed, 0) * speed;
    const expected = vec3(-kd * v.x, -kd * v.y, -G_FPS2 - kd * v.z);
    expect(vLen(vSub(a, expected))).toBeLessThan(1e-9);
  });

  it('⚠ GYRO: spin parallel to velocity produces ZERO Magnus force', () => {
    // A pure gyro-spun ball (the "rifle bullet" slider taken to its limit):
    // the spin axis points exactly along travel, so ω̂_eff × v vanishes and the
    // only forces left are gravity and drag. If the perpendicular projection in
    // aeroAccel were missing or wrong, this residual would be enormous.
    const rows: string[] = [];
    rows.push('  case                       | |a| ft/s² | Magnus residual ft/s²');
    rows.push('  ---------------------------+-----------+----------------------');

    const dirs = [vec3(137.9, 0, 0), vec3(100, -30, -12), vec3(-60, 5, 88)];
    const spins = [1200, 2400, 3600];
    let worst = 0;
    for (const v of dirs) {
      const speed = vLen(v);
      for (const rpm of spins) {
        const w = (rpm * Math.PI) / 30;
        // omega exactly parallel to v (and the antiparallel case).
        for (const sign of [1, -1]) {
          const omega = vec3((v.x / speed) * w * sign, (v.y / speed) * w * sign, (v.z / speed) * w * sign);
          const a = aeroAccel(v, omega, K_SEA);
          const kd = K_SEA * dragCoef(speed, 0) * speed;
          const gravDrag = vec3(-kd * v.x, -kd * v.y, -G_FPS2 - kd * v.z);
          const residual = vLen(vSub(a, gravDrag));
          worst = Math.max(worst, residual);
          expect(residual).toBeLessThan(1e-9);
        }
        rows.push(
          `  ${pad(`v=(${v.x},${v.y},${v.z}) ${rpm}rpm`, 26)} | ${pad(
            vLen(aeroAccel(v, vec3((v.x / speed) * w, (v.y / speed) * w, (v.z / speed) * w), K_SEA)).toFixed(3),
            9,
          )} | ${pad(worst.toExponential(2), 21)}`,
        );
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n[GYRO PROJECTION — pure gyro spin must be inert]\n' + rows.join('\n') + '\n');
    expect(worst).toBeLessThan(1e-9);

    // The complement: the SAME spin rate turned perpendicular to v is anything
    // but inert — this is what makes the projection load-bearing rather than
    // cosmetic. 2400 rpm across a 137.9 ft/s fastball is over half a g.
    const v = vec3(137.9, 0, 0);
    const perp = aeroAccel(v, vec3(0, (2400 * Math.PI) / 30, 0), K_SEA);
    const magnus = vLen(vSub(perp, vec3(-K_SEA * dragCoef(137.9, 0) * 137.9 * 137.9, 0, -G_FPS2)));
    expect(magnus).toBeGreaterThan(0.5 * G_FPS2);
  });
});

describe('drag calibration — the published 94 mph release', () => {
  it('a 94 mph spinless pitch arrives at the plate at 86–88 mph', () => {
    // Statcast: an average four-seamer leaves the hand near 94.0 mph and
    // crosses the plate near 86.3 — an ~8 % loss over the ~55 ft of actual
    // flight (60.5 ft mound-to-plate less ~5.5 ft of release extension). That
    // single published pair is what pins C_D; nothing else in this module is
    // free to absorb it.
    const v0 = 94 * MPH_TO_FPS;
    const start: BallState = { p: vec3(0, 0, 6), v: vec3(v0, 0, 0) };

    const rows: string[] = [];
    rows.push('  x ft | speed mph | drop ft');
    rows.push('  -----+-----------+--------');
    for (const x of [0, 11, 22, 33, 44, 55]) {
      const s = x === 0 ? start : flyToX(start, x, K_SEA);
      rows.push(
        `  ${pad(x, 4)} | ${pad((vLen(s.v) * FPS_TO_MPH).toFixed(2), 9)} | ${pad(
          (6 - s.p.z).toFixed(3),
          7,
        )}`,
      );
    }
    const end = flyToX(start, 55, K_SEA);
    const endMph = vLen(end.v) * FPS_TO_MPH;
    rows.push(`  C_D = ${C_D_BASE}   K = ${K_SEA.toFixed(8)} ft⁻¹   plate = ${endMph.toFixed(2)} mph`);
    // eslint-disable-next-line no-console
    console.log('\n[DRAG CALIBRATION — 94.0 mph release, spinless, 55 ft]\n' + rows.join('\n') + '\n');

    expect(endMph).toBeGreaterThanOrEqual(86);
    expect(endMph).toBeLessThanOrEqual(88);

    // Thinner air must carry more speed to the plate (the derived-K chain,
    // end to end: elevation → ρ → K → arrival speed).
    const mile = flyToX(start, 55, aeroScale(airDensity(5200, 70, 0.5)));
    expect(vLen(mile.v)).toBeGreaterThan(vLen(end.v));
  });

  it('the integrator matches the closed-form horizontal decay', () => {
    // With no gravity term to couple in, v(x) = v0·exp(−K·C_D·x) exactly.
    // Integrating a horizontal, spinless ball and comparing to that analytic
    // solution is a check on RK4 itself, so integration error can never be
    // mistaken for aerodynamics later.
    const v0 = 137.9;
    let s: BallState = { p: vec3(0, 0, 0), v: vec3(v0, 0, 0) };
    // gravity-free variant: integrate drag alone via the same stepper by
    // cancelling g out of the comparison is not possible, so instead compare
    // the HORIZONTAL component, which gravity only perturbs through |v|.
    for (let i = 0; i < 10000 && s.p.x < 55; i++) s = stepBall(s, vec3(0, 0, 0), K_SEA, FIXED_DT);
    const analytic = v0 * Math.exp(-K_SEA * C_D_BASE * s.p.x);
    expect(s.v.x).toBeGreaterThan(analytic * 0.995);
    expect(s.v.x).toBeLessThan(analytic * 1.005);
  });
});

describe('fixed-timestep integrator', () => {
  it('FIXED_DT is 1/120 s and free flight matches the ballistic closed form', () => {
    expect(FIXED_DT).toBeCloseTo(1 / 120, 12);
    // In a vacuum (K = 0) RK4 must reproduce z = z0 + v0 t − ½gt² to machine
    // precision — RK4 is exact for a constant acceleration.
    let s: BallState = { p: vec3(0, 0, 0), v: vec3(0, 0, 100) };
    const n = 120;
    for (let i = 0; i < n; i++) s = stepBall(s, vec3(0, 0, 0), 0, FIXED_DT);
    const t = n * FIXED_DT;
    expect(s.p.z).toBeCloseTo(100 * t - 0.5 * G_FPS2 * t * t, 8);
    expect(s.v.z).toBeCloseTo(100 - G_FPS2 * t, 9);
  });

  it('crossingFraction + lerpBallState resolve an event exactly, not to a substep', () => {
    // 95 mph covers 1.16 ft per substep against a 1.9 ft strike zone: snapping
    // to a substep boundary would quantise the plate crossing by more than half
    // a zone height. The analytic crossing must land on the plate to <1e-9 ft.
    const start: BallState = { p: vec3(0, 0, 6), v: vec3(95 * MPH_TO_FPS, 0, -3) };
    const perStep = 95 * MPH_TO_FPS * FIXED_DT;
    expect(perStep).toBeGreaterThan(1.1);
    const at = flyToX(start, 55, K_SEA);
    expect(Math.abs(at.p.x - 55)).toBeLessThan(1e-9);
    expect(crossingFraction(0, 10, 2.5)).toBeCloseTo(0.25, 12);
    expect(crossingFraction(0, 10, 12)).toBeNull();
    expect(crossingFraction(5, 5, 5)).toBeNull();
  });

  it('stepBall never mutates its input state', () => {
    const s: BallState = { p: vec3(1, 2, 3), v: vec3(10, 0, 20) };
    stepBall(s, vec3(0, 100, 0), K_SEA, FIXED_DT);
    expect(s.p).toEqual(vec3(1, 2, 3));
    expect(s.v).toEqual(vec3(10, 0, 20));
  });
});
