// Headless dynamics bench for the baseball aero core. Every number here is
// either a published reference we must reproduce or a derivation we must not
// silently break. The tables are PRINTED to stdout — read them, don't just
// watch the assertions go green: a change can stay inside every tolerance while
// walking the whole ladder in one direction.
//
// ⚠ EVERY TEST IN THIS FILE HAS BEEN SEEN TO FAIL. A guard that has only ever
// been observed passing guards nothing: the original gyro test fed ω exactly
// parallel to v, where ω̂ × v vanishes whether or not the projection exists, so
// deleting the projection outright kept all ten tests green. The fix is
// SUPERPOSITION — adding pure gyro spin to an OBLIQUE axis must change the
// acceleration by nothing at all. Any new invariant here must be written the
// same way: pick inputs where a wrong implementation gives a different answer.
//
// Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import {
  BALL_AREA_FT2,
  BALL_MASS_SLUG,
  BALL_RADIUS_FT,
  C_D_BASE,
  C_L_MAX,
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
  vAdd,
  vLen,
  vScale,
  vSub,
  vec3,
} from './airPhysics';
import type { BallState, Vec3 } from './airPhysics';
import { FPS_TO_MPH, FT_TO_IN, G_FPS2, MPH_TO_FPS, RPM_TO_RADS } from './units';

const pad = (s: string | number, n: number) => String(s).padStart(n);

// A four-seam release: horizontal, no spin, sea-level ISA air. The bench for
// the drag calibration.
const K_SEA = aeroScale(RHO_ISA_SEA_LEVEL);

/**
 * Fly a ball to x = `distFt`, returning the state interpolated to that exact x
 * AND the elapsed flight time (needed for the vacuum break reference, which has
 * to be evaluated at the real ball's clock, not at its own).
 */
function flyToXTimed(
  start: BallState,
  distFt: number,
  K: number,
  omega = vec3(0, 0, 0),
  dt = FIXED_DT,
): { s: BallState; t: number } {
  let s = start;
  let elapsed = 0;
  for (let i = 0; i < 400000; i++) {
    const next = stepBall(s, omega, K, dt);
    const f = crossingFraction(s.p.x, next.p.x, distFt);
    if (f !== null) return { s: lerpBallState(s, next, f), t: elapsed + f * dt };
    s = next;
    elapsed += dt;
  }
  throw new Error('ball never reached target x');
}

/** Fly a ball to x = `distFt`, returning the state interpolated to that exact x. */
const flyToX = (
  start: BallState,
  distFt: number,
  K: number,
  omega = vec3(0, 0, 0),
  dt = FIXED_DT,
): BallState => flyToXTimed(start, distFt, K, omega, dt).s;

/** Integrate for exactly `T` seconds in `n` equal substeps. */
function flyForTime(start: BallState, T: number, K: number, omega: Vec3, n: number): BallState {
  const dt = T / n;
  let s = start;
  for (let i = 0; i < n; i++) s = stepBall(s, omega, K, dt);
  return s;
}

/**
 * The Magnus term alone: total acceleration minus the SAME state's spinless
 * acceleration. Gravity and drag are identical between the two calls, so what
 * is left is exactly K·C_L·|v|·(ω̂_eff × v). (If `dragCoef` ever becomes
 * spin-dependent this decomposition needs revisiting — it is a difference of
 * two aeroAccel calls precisely so that stays visible.)
 */
const magnusOf = (v: Vec3, omega: Vec3, K: number): Vec3 =>
  vSub(aeroAccel(v, omega, K), aeroAccel(v, vec3(0, 0, 0), K));

const unit = (a: Vec3): Vec3 => vScale(a, 1 / vLen(a));

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
    // which THIN the air: 0.0023168, i.e. 2.6 % below the textbook figure.
    // Asserting 0.002378 here would have required breaking the ideal gas law,
    // so the assertion follows the physics instead. This ~2.6 % is real and it
    // shows up as roughly 1.5 ft of extra fly-ball carry.
    expect(rhoSea).toBeGreaterThan(0.0023168 * 0.995);
    expect(rhoSea).toBeLessThan(0.0023168 * 1.005);
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
  it('C_L(S) reproduces the published fit, is monotone, and is capped', () => {
    const rows: string[] = [];
    rows.push('     S   |  C_L  | example');
    rows.push('  -------+-------+---------------------------------------------');
    const notes: Record<string, string> = {
      '0.00': 'knuckleball (no useful spin)',
      '0.05': 'gyro slider: 2400 rpm @ 85 mph, 30 % eff → S = 0.073',
      '0.10': 'piecewise knee (both branches = 0.15)',
      '0.20': 'four-seam 2400 rpm @ 94 mph, 100 % eff → S = 0.221',
      '0.45': 'past the clamp (C_L flat at 0.35 from S = 0.4333)',
    };
    for (let i = 0; i <= 10; i++) {
      const S = i * 0.05;
      const key = S.toFixed(2);
      rows.push(
        `  ${pad(S.toFixed(3), 6)} | ${pad(liftCoef(S).toFixed(3), 5)} | ${notes[key] ?? ''}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[LIFT COEFFICIENT C_L(S) — published fit]\n' + rows.join('\n') + '\n');

    // ⚠ PUBLISHED-FIT ANCHORS. C_L is published data, not a calibrated dial, so
    // pin both branches at fixed S. Without these, changing the slope 0.6 → 0.9
    // (a 30 % break error at four-seam S) passes the whole suite.
    expect(liftCoef(0.04)).toBeCloseTo(0.06, 12); // 1.5·S branch
    expect(liftCoef(0.08)).toBeCloseTo(0.12, 12);
    expect(liftCoef(0.1)).toBeCloseTo(0.15, 12); // knee: branches agree
    expect(liftCoef(0.15)).toBeCloseTo(0.18, 12); // 0.09 + 0.6·S branch
    expect(liftCoef(0.2)).toBeCloseTo(0.21, 12);
    expect(liftCoef(0.3)).toBeCloseTo(0.27, 12);
    expect(liftCoef(0)).toBe(0); // no spin, no Magnus

    // The clamp is a labelled feel knob, not part of the fit. It bites at
    // (0.35 − 0.09)/0.6 = 0.4333, double a four-seamer's S, so it never binds
    // in the pitch table.
    const knee = (C_L_MAX - 0.09) / 0.6;
    expect(knee).toBeCloseTo(0.4333, 4);
    expect(liftCoef(knee - 1e-6)).toBeLessThan(C_L_MAX);
    expect(liftCoef(5)).toBe(C_L_MAX); // cap holds far past the useful range

    let prev = -Infinity;
    for (let i = 0; i <= 500; i++) {
      const S = (i / 500) * 0.5;
      const cl = liftCoef(S);
      expect(cl, `C_L dipped at S=${S.toFixed(3)}`).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = cl;
    }

    // Spin parameter sanity: 2400 rpm (251.3 rad/s) at 94 mph (137.9 ft/s)
    // gives S = 0.2206 — the reference four-seamer, and the row labelled 0.20
    // in the table above.
    const S = spinParameter(94 * MPH_TO_FPS, 2400 * RPM_TO_RADS);
    expect(S).toBeCloseTo(0.2206, 4);
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

  it('⚠ GYRO: adding velocity-parallel spin to an OBLIQUE axis changes nothing', () => {
    // THE test stage 1 rests on. Superposition: aeroAccel(v, ω) must equal
    // aeroAccel(v, ω + c·v̂) exactly, for oblique ω and any c. Gyro spin is
    // inert, so pouring more of it in must not move the acceleration by so much
    // as a rounding error.
    //
    // ⚠ Why not "ω parallel to v gives zero Magnus"? Because ω̂ × v vanishes for
    // parallel vectors WHETHER OR NOT the projection exists — that test passes
    // an implementation with the projection deleted. Verified by mutation:
    // removing `omegaEff = ω − (ω·v̂)v̂` leaves the parallel test green and
    // fails these rows by up to ~1.6 ft/s².
    const rows: string[] = [];
    rows.push('  v ft/s            | ω rad/s          |  base Magnus |     c |   |Δa| ft/s²');
    rows.push('  ------------------+------------------+--------------+-------+-------------');

    const cases: Array<[Vec3, Vec3]> = [
      [vec3(137.9, 0, 0), vec3(60, -180, 90)], // fastball, tilted axis
      [vec3(120, -8, -5), vec3(-40, -250, 30)], // running two-seam
      [vec3(-60, 5, 88), vec3(10, 120, -200)], // a fly ball on the way up
    ];
    const cs = [-2000, -400, -50, 25, 300, 2000];
    let worst = 0;
    for (const [v, omega] of cases) {
      const vHat = unit(v);
      const base = aeroAccel(v, omega, K_SEA);
      const baseMagnus = vLen(magnusOf(v, omega, K_SEA));
      // Non-degeneracy: this case must actually FEEL a Magnus force, otherwise
      // "unchanged" is vacuous.
      expect(baseMagnus).toBeGreaterThan(1);
      for (const c of cs) {
        const spun = vAdd(omega, vScale(vHat, c));
        const delta = vLen(vSub(aeroAccel(v, spun, K_SEA), base));
        worst = Math.max(worst, delta);
        rows.push(
          `  ${pad(`(${v.x},${v.y},${v.z})`, 17)} | ${pad(
            `(${omega.x},${omega.y},${omega.z})`,
            16,
          )} | ${pad(baseMagnus.toFixed(4), 12)} | ${pad(c, 5)} | ${pad(
            delta.toExponential(2),
            12,
          )}`,
        );
        expect(delta, `gyro spin c=${c} moved the acceleration`).toBeLessThan(1e-9);
      }
    }
    // eslint-disable-next-line no-console
    console.log('\n[GYRO SUPERPOSITION — pure gyro spin must be inert]\n' + rows.join('\n') + '\n');
    expect(worst).toBeLessThan(1e-9);

    // The degenerate case is kept as a cheap corollary, NOT as the guard:
    // spin exactly along (and against) v produces no Magnus at all.
    for (const sign of [1, -1]) {
      const v = vec3(100, -30, -12);
      const omega = vScale(unit(v), sign * 2400 * RPM_TO_RADS);
      expect(vLen(magnusOf(v, omega, K_SEA))).toBeLessThan(1e-9);
    }
  });

  it('⚠ SIGN: backspin LIFTS, topspin sinks, +z spin runs toward third base', () => {
    // The declared frame (airPhysics.ts header) is load-bearing: swapping the
    // cross-product operands to vCross(v, axis) makes a four-seamer SINK 22.8 in
    // instead of rising 22.6 in, and passes a suite that only checks magnitudes.
    const v = vec3(94 * MPH_TO_FPS, 0, 0);
    const w = 2400 * RPM_TO_RADS;

    const back = aeroAccel(v, vec3(0, -w, 0), K_SEA); // backspin, axis −y
    const top = aeroAccel(v, vec3(0, w, 0), K_SEA); // topspin, axis +y
    const side = aeroAccel(v, vec3(0, 0, w), K_SEA); // sidespin, axis +z

    const rows = [
      `  spin axis −y (backspin) : a = (${back.x.toFixed(3)}, ${back.y.toFixed(
        3,
      )}, ${back.z.toFixed(3)})  ⇒ lift ${(back.z + G_FPS2).toFixed(3)} ft/s² UP`,
      `  spin axis +y (topspin)  : a = (${top.x.toFixed(3)}, ${top.y.toFixed(3)}, ${top.z.toFixed(
        3,
      )})  ⇒ lift ${(top.z + G_FPS2).toFixed(3)} ft/s²`,
      `  spin axis +z (sidespin) : a = (${side.x.toFixed(3)}, ${side.y.toFixed(
        3,
      )}, ${side.z.toFixed(3)})  ⇒ side ${side.y.toFixed(3)} ft/s² to +y (3B)`,
      `  gravity alone would be z = ${(-G_FPS2).toFixed(3)}`,
    ];
    // eslint-disable-next-line no-console
    console.log('\n[MAGNUS SIGN — 2400 rpm on a 94 mph ball travelling +x]\n' + rows.join('\n') + '\n');

    // Backspin about −y on a +x ball: ω̂ × v = (−ŷ) × x̂ = +ẑ. UP.
    expect(back.z).toBeGreaterThan(-G_FPS2);
    expect(back.z).toBeCloseTo(-8.96, 1); // 23.22 ft/s² of lift against 32.174
    expect(Math.abs(back.y)).toBeLessThan(1e-9); // no side force from a pure −y axis
    // Topspin is the exact mirror: it must SINK, by the same amount.
    expect(top.z).toBeLessThan(-G_FPS2);
    expect(back.z + top.z).toBeCloseTo(-2 * G_FPS2, 9);
    // Sidespin about +z: ẑ × x̂ = +ŷ, toward third base, with no vertical part.
    expect(side.y).toBeGreaterThan(1);
    expect(side.z).toBeCloseTo(-G_FPS2, 9);
    expect(side.y).toBeCloseTo(back.z + G_FPS2, 9); // same magnitude, rotated 90°
  });

  it('⚠ MAGNITUDE: the reference four-seamer sits in the published 0.5–0.9 g band', () => {
    // A fully-efficient 2400 rpm four-seamer at 94 mph. Alan Nathan's published
    // range for the Magnus acceleration of a spinning baseball is roughly
    // 0.5–0.9 g (exact reference unverified — confirm before publication); this
    // model lands 0.72 g. Without this the C_L slope can be changed by 50 % and
    // the suite stays green.
    const v = vec3(94 * MPH_TO_FPS, 0, 0);
    const w = 2400 * RPM_TO_RADS;
    const speed = vLen(v);
    const S = spinParameter(speed, w);
    const magnus = vLen(magnusOf(v, vec3(0, -w, 0), K_SEA));

    // eslint-disable-next-line no-console
    console.log(
      `\n[MAGNUS MAGNITUDE — 2400 rpm, 94 mph, ISA]\n  S = ${S.toFixed(4)}   C_L = ${liftCoef(
        S,
      ).toFixed(4)}   |a_M| = ${magnus.toFixed(3)} ft/s² = ${(magnus / G_FPS2).toFixed(3)} g\n`,
    );

    // Closed form: |ω̂_eff × v| = |v| for a perpendicular axis, so the Magnus
    // magnitude is exactly K·C_L·|v|².
    expect(magnus).toBeCloseTo(K_SEA * liftCoef(S) * speed * speed, 9);
    expect(magnus / G_FPS2).toBeGreaterThan(0.5);
    expect(magnus / G_FPS2).toBeLessThan(0.9);
  });

  it('⚠ PROJECTION: S (and so C_L) comes from |ω_eff|, not |ω|', () => {
    // A gyro-heavy slider: 2400 rpm at 85 mph with 30 % spin efficiency. Only
    // the perpendicular 30 % may reach C_L. Feeding the full |ω| to the spin
    // parameter — a mutation the old suite could not see — gives 2.15× the
    // Magnus force, which is the whole slider/fastball distinction gone.
    const speed = 85 * MPH_TO_FPS;
    const w = 2400 * RPM_TO_RADS;
    const eff = 0.3;
    const v = vec3(speed, 0, 0);
    // |ω| = w, with an eff fraction perpendicular (about +z) and the rest gyro.
    const omega = vec3(w * Math.sqrt(1 - eff * eff), 0, w * eff);

    const magnus = vLen(magnusOf(v, omega, K_SEA));
    const projected = K_SEA * liftCoef(spinParameter(speed, w * eff)) * speed * speed;
    const unprojected = K_SEA * liftCoef(spinParameter(speed, w)) * speed * speed;

    // eslint-disable-next-line no-console
    console.log(
      `\n[SPIN PARAMETER FROM ω_eff — 2400 rpm @ 85 mph, 30 % efficient]\n` +
        `  S(ω_eff) = ${spinParameter(speed, w * eff).toFixed(4)}  C_L = ${liftCoef(
          spinParameter(speed, w * eff),
        ).toFixed(4)}  ⇒ ${projected.toFixed(3)} ft/s²\n` +
        `  S(|ω|)   = ${spinParameter(speed, w).toFixed(4)}  C_L = ${liftCoef(
          spinParameter(speed, w),
        ).toFixed(4)}  ⇒ ${unprojected.toFixed(3)} ft/s²  (${(unprojected / projected).toFixed(
          2,
        )}× — the bug)\n`,
    );

    expect(magnus).toBeCloseTo(projected, 9);
    expect(unprojected / projected).toBeGreaterThan(2); // the mutation is not subtle
    expect(magnus).toBeLessThan(unprojected * 0.6);
  });
});

describe('drag calibration — the published 94 mph release', () => {
  it('a 94.0 mph spinless pitch arrives at 86.3 mph over 55 ft of ISA air', () => {
    // Statcast: an average four-seamer leaves the hand near 94.0 mph and
    // crosses the plate near 86.3 — an ~8 % loss over the ~55 ft of actual
    // flight (60.5 ft mound-to-plate less ~5.5 ft of release extension). That
    // single published pair is what pins C_D; nothing else in this module is
    // free to absorb it.
    //
    // ⚠ CONDITIONS, because a calibration without them is a coincidence:
    // ISA air (59 °F, DRY — not the 70 °F/50 % game-day air, which is thinner
    // and gives 86.49 mph with the SAME C_D), 55 ft of flight, spinless, and
    // 86.3 is the VECTOR MAGNITUDE |v|, which is what a radar plate speed is.
    // The gravity-free closed form v_x = v0·exp(−K·C_D·x) inverts to 0.2829 —
    // but that answers a question about v_x, not |v|.
    const v0 = 94 * MPH_TO_FPS;
    const start: BallState = { p: vec3(0, 0, 6), v: vec3(v0, 0, 0) };

    const rows: string[] = [];
    rows.push('  x ft | |v| mph | v_x mph | drop ft');
    rows.push('  -----+---------+---------+--------');
    for (const x of [0, 11, 22, 33, 44, 55]) {
      const s = x === 0 ? start : flyToX(start, x, K_SEA);
      rows.push(
        `  ${pad(x, 4)} | ${pad((vLen(s.v) * FPS_TO_MPH).toFixed(2), 7)} | ${pad(
          (s.v.x * FPS_TO_MPH).toFixed(2),
          7,
        )} | ${pad((6 - s.p.z).toFixed(3), 7)}`,
      );
    }
    const end = flyToX(start, 55, K_SEA);
    const endMph = vLen(end.v) * FPS_TO_MPH;
    const cdFromVx = Math.log(v0 / end.v.x) / (K_SEA * 55);
    rows.push(`  C_D = ${C_D_BASE}   K = ${K_SEA.toFixed(8)} ft⁻¹   plate |v| = ${endMph.toFixed(2)} mph`);
    rows.push(
      `  closed-form C_D for v_x = 86.3: ${(Math.log(94 / 86.3) / (K_SEA * 55)).toFixed(4)}` +
        `   effective C_D of the integrated v_x: ${cdFromVx.toFixed(4)}`,
    );
    rows.push(
      `  same C_D in game-day 70 °F/50 % air: ${(
        vLen(flyToX(start, 55, aeroScale(airDensity(0, 70, 0.5))).v) * FPS_TO_MPH
      ).toFixed(2)} mph  (thinner air, the honest slop)`,
    );
    // eslint-disable-next-line no-console
    console.log('\n[DRAG CALIBRATION — 94.0 mph release, spinless, 55 ft, ISA]\n' + rows.join('\n') + '\n');

    // ⚠ TIGHT ON PURPOSE. The old 86–88 band admitted C_D ∈ [0.231, 0.312] — a
    // ±13 % dial that any mis-tuning could hide inside. ±0.4 mph pins C_D to
    // about ±0.016 (±5 %), which is the same order as the reference-condition
    // slop documented on C_D_BASE, so tightening further would assert the
    // conventions rather than the physics.
    expect(endMph).toBeGreaterThan(86.3 - 0.4);
    expect(endMph).toBeLessThan(86.3 + 0.4);

    // The closed form is a statement about v_x and it is accurate to 0.2 % —
    // which is exactly why it disagrees with C_D: it answers a different
    // question from the published one.
    expect(cdFromVx).toBeCloseTo(C_D_BASE, 2);

    // Thinner air must carry more speed to the plate (the derived-K chain,
    // end to end: elevation → ρ → K → arrival speed).
    const mile = flyToX(start, 55, aeroScale(airDensity(5200, 70, 0.5)));
    expect(vLen(mile.v)).toBeGreaterThan(vLen(end.v));
  });
});

describe('induced break — the reporting convention', () => {
  it('measures IVB against a spinless-WITH-drag reference, release → 55 ft', () => {
    // ⚠ CONVENTION, fixed here so stage 2 cannot "recalibrate" a published
    // coefficient to close what is really a reporting-convention gap. See
    // BASEBALL.md § induced break. Reference = same release state, same drag,
    // spin set to ZERO; measured at the plate crossing; displacement is Δz.
    //
    // The reference four-seamer produces 22.59 in on this convention while
    // Statcast-style IVB for such a pitch is usually quoted around 15–18 in.
    // The Magnus force is NOT the discrepancy — it is 0.72 g, inside the
    // published band (see the magnitude test). Deflection grows as the SQUARE
    // of the measured length, so the gap is the measured segment, as the table
    // below shows directly. No coefficient moves to close it.
    const w = 2400 * RPM_TO_RADS;
    const spin = vec3(0, -w, 0);
    const rel: BallState = { p: vec3(0, 0, 6), v: vec3(94 * MPH_TO_FPS, 0, 0) };

    const rows: string[] = [];
    rows.push('  measured over        | Δz vs spinless+drag | Δz vs vacuum gravity-only');
    rows.push('  ---------------------+---------------------+--------------------------');
    const byLength = new Map<number, number>();
    const breakOver = (L: number): number => byLength.get(L) ?? NaN;
    for (const L of [55, 50, 45, 40]) {
      const xs = 55 - L;
      const from = xs === 0 ? rel : flyToX(rel, xs, K_SEA, spin);
      const spun = flyToXTimed(from, 55, K_SEA, spin);
      const plain = flyToX(from, 55, K_SEA);
      // Vacuum reference: gravity only, evaluated on the SPUN ball's clock.
      const zVac = from.p.z + from.v.z * spun.t - 0.5 * G_FPS2 * spun.t * spun.t;
      byLength.set(L, (spun.s.p.z - plain.p.z) * FT_TO_IN);
      rows.push(
        `  last ${pad(L, 2)} ft to plate  | ${pad(breakOver(L).toFixed(2) + ' in', 19)} | ${pad(
          ((spun.s.p.z - zVac) * FT_TO_IN).toFixed(2) + ' in',
          25,
        )}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n[INDUCED BREAK CONVENTION — 2400 rpm, 94 mph, ISA, backspin about −y]\n' +
        rows.join('\n') +
        '\n  THE convention: spinless-with-drag reference, release → 55 ft (the top row).\n',
    );

    // The convention itself: positive (a four-seamer RISES relative to spinless)
    // and 22.59 in for the reference pitch.
    expect(breakOver(55)).toBeGreaterThan(0);
    expect(breakOver(55)).toBeCloseTo(22.59, 1);

    // Quadratic-ish growth with measured length is what makes the 15–18 in
    // quotes and this 22.6 in reconcilable without touching C_L: shorten the
    // segment and the number falls into that range on its own.
    expect(breakOver(45)).toBeGreaterThan(15);
    expect(breakOver(45)).toBeLessThan(18);
    const ratio = breakOver(55) / breakOver(40);
    expect(ratio).toBeGreaterThan((55 / 40) ** 2 * 0.9);
    expect(ratio).toBeLessThan((55 / 40) ** 2 * 1.1);
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

  it('RK4 converges at 4th order, so integration error is never mistaken for aero', () => {
    // ⚠ This replaces a test that compared a gravity-COUPLED v_x against a
    // gravity-FREE analytic solution at 0.5 % tolerance — three orders of
    // magnitude looser than the integrator's real error, and confounded besides
    // (its own comment admitted it). dt-refinement has no such confound: halving
    // dt must cut the error by 2⁴ = 16, and nothing but the integrator can
    // produce that number.
    const start: BallState = { p: vec3(0, 0, 6), v: vec3(137.9, -3, 4) };
    const omega = vec3(40, -220, 60); // oblique, so the gyro projection is live
    const T = 0.4; // a full pitch flight
    const ref = flyForTime(start, T, K_SEA, omega, 120 * 64);

    const rows: string[] = [];
    rows.push('    rate |         dt s |     |Δz| ft | ratio vs previous');
    rows.push('  -------+--------------+--------------+------------------');
    let prevErr = 0;
    const ratios: number[] = [];
    for (const hz of [15, 30, 60, 120]) {
      const s = flyForTime(start, T, K_SEA, omega, Math.round(hz * T));
      const err = Math.abs(s.p.z - ref.p.z);
      if (prevErr > 0) ratios.push(prevErr / err);
      rows.push(
        `  ${pad(hz + ' Hz', 6)} | ${pad((1 / hz).toExponential(4), 12)} | ${pad(
          err.toExponential(4),
          12,
        )} | ${pad(prevErr > 0 ? (prevErr / err).toFixed(2) : '—', 17)}`,
      );
      prevErr = err;
    }
    // eslint-disable-next-line no-console
    console.log('\n[RK4 CONVERGENCE — 0.4 s pitch flight vs a 7680 Hz reference]\n' + rows.join('\n') + '\n');

    // 4th order: every halving must cut the error by close to 16.
    for (const r of ratios) {
      expect(r).toBeGreaterThan(14);
      expect(r).toBeLessThan(18);
    }
    // And the absolute error at the shipped rate is negligible: <1e-9 ft, i.e.
    // under a millionth of an inch over a whole pitch.
    expect(prevErr).toBeLessThan(1e-9);
  });

  it('crossingFraction + lerpBallState resolve the plate crossing to <0.01 in', () => {
    // 95 mph covers 1.16 ft per substep against a 1.9 ft strike zone: snapping
    // to a substep boundary would quantise the plate crossing by more than half
    // a zone height.
    //
    // ⚠ Asserting |p.x − 55| < 1e-9 would be a TAUTOLOGY: t is solved from the
    // linear interpolation of x and p.x is then rebuilt with that same t, so it
    // is 55 by construction. The real question is whether the OTHER components
    // are right, so compare the whole crossing state against a 512× finer
    // integration of the same flight.
    const perStep = 95 * MPH_TO_FPS * FIXED_DT;
    expect(perStep).toBeGreaterThan(1.1);

    const start: BallState = { p: vec3(0, 0, 6), v: vec3(95 * MPH_TO_FPS, 0.5, -3) };
    const spin = vec3(0, -2400 * RPM_TO_RADS, 0);
    const coarse = flyToX(start, 55, K_SEA, spin, FIXED_DT);
    const fine = flyToX(start, 55, K_SEA, spin, FIXED_DT / 512);

    const rows = [
      `  z    coarse ${coarse.p.z.toFixed(9)} ft  fine ${fine.p.z.toFixed(9)} ft  Δ ${(
        Math.abs(coarse.p.z - fine.p.z) * FT_TO_IN
      ).toExponential(3)} in`,
      `  y    coarse ${coarse.p.y.toFixed(9)} ft  fine ${fine.p.y.toFixed(9)} ft  Δ ${(
        Math.abs(coarse.p.y - fine.p.y) * FT_TO_IN
      ).toExponential(3)} in`,
      `  |v|  coarse ${(vLen(coarse.v) * FPS_TO_MPH).toFixed(6)} mph  fine ${(
        vLen(fine.v) * FPS_TO_MPH
      ).toFixed(6)} mph`,
      `  one substep at 95 mph = ${perStep.toFixed(3)} ft — this is what the interpolation buys`,
    ];
    // eslint-disable-next-line no-console
    console.log('\n[PLATE-CROSSING RESOLUTION — 120 Hz + interpolation vs 61440 Hz]\n' + rows.join('\n') + '\n');

    expect(Math.abs(coarse.p.z - fine.p.z) * FT_TO_IN).toBeLessThan(0.01);
    expect(Math.abs(coarse.p.y - fine.p.y) * FT_TO_IN).toBeLessThan(0.01);
    expect(Math.abs(vLen(coarse.v) - vLen(fine.v)) * FPS_TO_MPH).toBeLessThan(0.001);
  });

  it('crossingFraction is half-open: (0, 1]', () => {
    expect(crossingFraction(0, 10, 2.5)).toBeCloseTo(0.25, 12);
    expect(crossingFraction(10, 0, 2.5)).toBeCloseTo(0.75, 12); // descending too
    expect(crossingFraction(0, 10, 10)).toBe(1); // end of step INCLUDED
    expect(crossingFraction(0, 10, 12)).toBeNull();
    expect(crossingFraction(5, 5, 5)).toBeNull(); // no motion, no crossing
    // ⚠ Start of step EXCLUDED. A batted ball launched from exactly z = 0 must
    // not register ground contact on its first substep and be caught at the tee.
    expect(crossingFraction(0, 10, 0)).toBeNull();
    expect(crossingFraction(0, -10, 0)).toBeNull();
  });

  it('stepBall never mutates its input state', () => {
    const s: BallState = { p: vec3(1, 2, 3), v: vec3(10, 0, 20) };
    stepBall(s, vec3(0, 100, 0), K_SEA, FIXED_DT);
    expect(s.p).toEqual(vec3(1, 2, 3));
    expect(s.v).toEqual(vec3(10, 0, 20));
  });
});
