// The batted-ball bench, and THE CENTRAL EXPERIMENT of stage 3.
//
// ⚠ THE RESULT, up front. `C_D` = 0.300 and `C_L(S)` were fixed entirely by the
// PITCH regime — 0.4 s of flight, 86–94 mph, S ≈ 0.2, spin held constant. A fly
// ball is a different regime in every one of those variables: 5 s of flight, a
// continuous decay from 100 mph to ~50, and therefore an S that CLIMBS through
// the flight. The published max-carry ladder is consequently an INDEPENDENT test
// of the same two coefficients at a regime nothing fitted them to.
//
// IT DOES NOT CORROBORATE. At the stated reference conditions the model carries
// 52–65 ft too far at every rung — 12–20 %, uniformly positive, and worst at the
// low end:
//
//   EV mph   published   model   residual
//      90       330      395.0     +65.0
//      95       360      424.7     +64.7
//     100       400      453.9     +53.9
//     105       430      482.5     +52.5
//     110       455      510.6     +55.6
//     115       480      538.1     +58.1
//
// AND NO CONSTANT C_D REPAIRS IT — checked, and the check is the interesting
// part. Refitting a single constant `C_D` against the six rows (a one-off
// diagnostic, not shipped, because it needs a second integrator) lands at 0.385
// with an RMS residual of 13.2 ft and a residual SPREAD of 35 ft: +21.5 at
// 90 mph falling monotonically to −13.2 at 115. The published ladder rises at
// 6.0 ft/mph and the model at 5.6 ft/mph with C_D = 0.300 and only 4.6 ft/mph
// at C_D = 0.385, so the level and the slope pull the fit in opposite
// directions. Worse, C_D = 0.385 puts the four-seamer at the plate at 84.1 mph
// against the published 86.3 — a 2.2 mph error where stage 1 calibrated to
// ±0.4. A single Reynolds-independent `C_D` cannot serve both regimes.
//
// ⚠ NOTHING WAS CHANGED TO ABSORB THIS. `C_D` and `C_L` did not move, and there
// is no carry factor, no per-regime coefficient and no launch-angle correction —
// those are the fifth category the physics rule forbids. The model's own ladder
// is pinned as goldens with the published values beside it as residuals, exactly
// as stage 2 pinned the seven resisting pitch rows. The honest reading is that
// the aero core needs a spin- and Reynolds-dependent `C_D` (whose signature
// `airPhysics.dragCoef(speedFps, S)` already anticipates), and that this is a
// stage-4 calibration against BOTH regimes at once, not a stage-3 patch.
//
// ⚠ AND THE AIR IS PART OF THE NUMBER, which stage 2 learned the hard way. Every
// carry figure here is quoted at GAME-DAY SEA LEVEL — 0 ft, 70 °F, 50 % RH,
// ρ = 0.0023168 — because that is the air the game is played in and the air a
// contemporary published carry table is quoted in. ISA sea level (59 °F, dry,
// ρ = 0.0023770) is 2.6 % denser and carries 2.6–5.0 ft SHORTER; both columns
// are printed. The reference BACKSPIN is 2200 rpm, the midpoint of the published
// 1900–2500 rpm band `batSim`'s `e_T` is calibrated against and within 200 rpm
// of what the reference swing actually produces (2220). Carry moves ~4 ft per
// 100 rpm, so a ladder without its spin is meaningless too.

import { describe, expect, it } from 'vitest';
import { airDensity, vec3 } from './airPhysics';
import { SWEET_SPOT_M } from './bat';
import { swingContact } from './batSim';
import type { Swing } from './batSim';
import {
  CONTACT_HEIGHT_FT,
  distanceAtHeight,
  launchFromAngles,
  maxCarry,
  simulateBattedBall,
} from './battedBallSim';
import { decomposeSpin } from './batSim';
import { BREAK_REF_AIR, GAME_AIR } from './pitchSim';
import type { AirConditions } from './pitchSim';
import { FIXED_DT } from './tuning';
import { MPH_TO_FPS, RPM_TO_RADS } from './units';

const pad = (s: string | number, n: number) => String(s).padStart(n);
const f = (n: number, w: number, p = 2) => pad(n.toFixed(p), w);

/** The published max-carry ladder, sea level, no wind. TEST TARGET ONLY. */
const PUBLISHED_CARRY: Record<number, number> = {
  90: 330,
  95: 360,
  100: 400,
  105: 430,
  110: 455,
  115: 480,
};
const EVS = [90, 95, 100, 105, 110, 115];

/** The stated reference backspin — see this file's header. */
const REF_SPIN_RPM = 2200;

/** Denver, for the altitude check. */
const MILE_HIGH: AirConditions = { elevFt: 5280, tempF: 70, rh: 0.5 };

// ---------------------------------------------------------------------------
// THE CENTRAL EXPERIMENT
// ---------------------------------------------------------------------------

describe('the carry ladder — an independent test of C_D and C_L', () => {
  it('⚠ LADDER: prints the residual table in both airs', () => {
    console.log(
      `\nMAX CARRY vs PUBLISHED — backspin ${REF_SPIN_RPM} rpm, argmax over launch angle`,
    );
    console.log(
      `  game-day sea level ρ = ${airDensity(0, 70, 0.5).toFixed(7)} | ISA sea level ρ = ${airDensity(0, 59, 0).toFixed(7)}`,
    );
    console.log(' EV   pub |   game  LA_opt  resid  hang  apex |    ISA  LA_opt  resid');
    for (const ev of EVS) {
      const g = maxCarry(ev, REF_SPIN_RPM, GAME_AIR);
      const i = maxCarry(ev, REF_SPIN_RPM, BREAK_REF_AIR);
      console.log(
        `${f(ev, 3, 0)} ${f(PUBLISHED_CARRY[ev]!, 5, 0)} | ${f(g.carryFt, 6, 1)} ${f(g.laDeg, 7, 2)} ${f(g.carryFt - PUBLISHED_CARRY[ev]!, 6, 1)} ${f(g.hangS, 5, 2)} ${f(g.apexFt, 5, 0)} | ${f(i.carryFt, 6, 1)} ${f(i.laDeg, 7, 2)} ${f(i.carryFt - PUBLISHED_CARRY[ev]!, 6, 1)}`,
      );
    }
    console.log('\n  sensitivity to the assumed backspin (game air, residual ft):');
    for (const spin of [1500, 1800, 2000, 2200, 2500]) {
      let line = `   ${pad(spin, 4)} rpm: `;
      for (const ev of EVS) {
        line += `${f(maxCarry(ev, spin, GAME_AIR).carryFt - PUBLISHED_CARRY[ev]!, 6, 1)} `;
      }
      console.log(line);
    }
  });

  it('⚠ GOLDEN: the model\'s own ladder, with the published values as residuals', () => {
    // Pinned to the MODEL, not to the published table, because the model does
    // not reach the published table and pretending otherwise with a wide band
    // would be the fifth category by another route. Stage 2's precedent.
    const golden: Record<number, [number, number]> = {
      90: [395.0, 31.0],
      95: [424.7, 30.0],
      100: [453.9, 29.25],
      105: [482.5, 28.5],
      110: [510.6, 27.75],
      115: [538.1, 27.25],
    };
    for (const ev of EVS) {
      const m = maxCarry(ev, REF_SPIN_RPM, GAME_AIR);
      const [carry, la] = golden[ev]!;
      expect(m.carryFt).toBeCloseTo(carry, 1);
      expect(m.laDeg).toBeCloseTo(la, 2);
    }
  });

  it('⚠ THE RESIDUAL IS UNIFORMLY POSITIVE AND LARGE — the finding, asserted', () => {
    // If someone quietly slips in a carry correction, this test starts failing,
    // which is the point: the finding is pinned as firmly as the numbers are.
    const resid = EVS.map((ev) => maxCarry(ev, REF_SPIN_RPM, GAME_AIR).carryFt - PUBLISHED_CARRY[ev]!);
    for (const r of resid) {
      expect(r).toBeGreaterThan(45);
      expect(r).toBeLessThan(70);
    }
    const mean = resid.reduce((a, b) => a + b, 0) / resid.length;
    expect(mean).toBeGreaterThan(15); // ≫ the ±15 ft corroboration bar
    expect(mean).toBeCloseTo(58.3, 1);
  });

  it('the published ladder rises FASTER in EV than the model does', () => {
    // The second half of "no constant C_D repairs it": raising drag lowers the
    // level and flattens the slope, but the published slope is already steeper
    // than ours, so the two constraints pull opposite ways.
    const lo = maxCarry(90, REF_SPIN_RPM, GAME_AIR).carryFt;
    const hi = maxCarry(115, REF_SPIN_RPM, GAME_AIR).carryFt;
    const modelSlope = (hi - lo) / 25;
    const pubSlope = (PUBLISHED_CARRY[115]! - PUBLISHED_CARRY[90]!) / 25;
    console.log(`\n  slope: model ${modelSlope.toFixed(2)} ft/mph vs published ${pubSlope.toFixed(2)} ft/mph`);
    expect(pubSlope).toBeCloseTo(6.0, 6);
    expect(modelSlope).toBeLessThan(pubSlope);
    expect(modelSlope).toBeCloseTo(5.72, 2);
  });
});

// ---------------------------------------------------------------------------
// Structure the model DOES get right
// ---------------------------------------------------------------------------

describe('lift structure', () => {
  it('⚠ carry peaks near 27–31°, not 45°, and the optimum FALLS as EV rises', () => {
    // Backspin generating lift is the entire reason a fly ball's optimum is far
    // below the drag-free 45°, and the reason the optimum falls with EV: a
    // faster ball spends proportionally less of its flight at the low speeds
    // where lift is cheap relative to gravity. Both are asserted, and the
    // monotone fall is the one a spot check would miss.
    let prev = Infinity;
    for (const ev of EVS) {
      const m = maxCarry(ev, REF_SPIN_RPM, GAME_AIR);
      expect(m.laDeg).toBeGreaterThan(25);
      expect(m.laDeg).toBeLessThan(32);
      expect(m.laDeg).toBeLessThanOrEqual(prev);
      prev = m.laDeg;
    }
  });

  it('⚠ with the spin removed the optimum collapses toward the ballistic angle', () => {
    // The complement of the test above, and the one that bites if the Magnus
    // term is deleted: a spinless fly ball's optimum jumps to the high 30s / low
    // 40s and it carries far less. A model that only checked "optimum ≈ 29°"
    // would pass with the lift term present but wrong; this pins the CONTRAST.
    const spun = maxCarry(100, REF_SPIN_RPM, GAME_AIR);
    const bare = maxCarry(100, 0, GAME_AIR);
    console.log(
      `\n  100 mph: ${REF_SPIN_RPM} rpm ⇒ ${spun.carryFt.toFixed(1)} ft @ ${spun.laDeg}° | 0 rpm ⇒ ${bare.carryFt.toFixed(1)} ft @ ${bare.laDeg}°`,
    );
    expect(bare.laDeg).toBeGreaterThan(spun.laDeg + 6);
    expect(bare.carryFt).toBeLessThan(spun.carryFt - 50);
  });

  it('backspin is worth 30–50 ft at 100 mph / 27°', () => {
    const lo = simulateBattedBall(launchFromAngles(100, 27, 0, 1000), GAME_AIR);
    const hi = simulateBattedBall(launchFromAngles(100, 27, 0, 2500), GAME_AIR);
    const gain = hi.carryFt - lo.carryFt;
    console.log(`  1000 rpm ${lo.carryFt.toFixed(1)} ft | 2500 rpm ${hi.carryFt.toFixed(1)} ft | +${gain.toFixed(1)} ft`);
    expect(gain).toBeGreaterThan(30);
    expect(gain).toBeLessThan(50);
    expect(gain).toBeCloseTo(41.6, 1);
  });

  it('a 400 ft fly near its optimum hangs 5.0–5.5 s', () => {
    console.log('\n  400 ft flies:');
    for (const la of [26, 28, 30, 31]) {
      let found = 0;
      let hang = 0;
      for (let ev = 85; ev <= 105; ev += 0.05) {
        const r = simulateBattedBall(launchFromAngles(ev, la, 0, REF_SPIN_RPM), GAME_AIR);
        if (r.carryFt >= 400) {
          found = ev;
          hang = r.hangS;
          break;
        }
      }
      console.log(`    LA ${la}°: EV ${found.toFixed(2)} mph, hang ${hang.toFixed(3)} s`);
      expect(hang).toBeGreaterThan(5.0);
      expect(hang).toBeLessThan(5.5);
    }
  });
});

// ---------------------------------------------------------------------------
// The integrator contract
// ---------------------------------------------------------------------------

describe('the flight uses stage 1\'s integrator, honestly', () => {
  it('⚠ the ground crossing is ANALYTIC, not snapped to a substep', () => {
    const r = simulateBattedBall(launchFromAngles(100, 28, 0, REF_SPIN_RPM), GAME_AIR);
    expect(Math.abs(r.landing.z)).toBeLessThan(1e-9);
    // The last step is a PARTIAL one, so the hang time must not be an integer
    // multiple of the substep. Snapping would make it exactly one.
    const steps = r.hangS / FIXED_DT;
    expect(Math.abs(steps - Math.round(steps))).toBeGreaterThan(1e-6);
    // …and the track's last sample IS that interpolated point.
    const n = r.track.t.length;
    expect(r.track.z[n - 1]).toBeCloseTo(0, 9);
    expect(r.track.t[n - 1]).toBeCloseTo(r.hangS, 12);
  });

  it('⚠ air reaches the ball ONLY through K: thinner air carries further', () => {
    const sea = maxCarry(105, REF_SPIN_RPM, GAME_AIR).carryFt;
    const isa = maxCarry(105, REF_SPIN_RPM, BREAK_REF_AIR).carryFt;
    const mile = maxCarry(105, REF_SPIN_RPM, MILE_HIGH).carryFt;
    console.log(`\n  105 mph carry: ISA ${isa.toFixed(1)} | game SL ${sea.toFixed(1)} | mile high ${mile.toFixed(1)}`);
    expect(isa).toBeLessThan(sea); // ISA is COLDER and DRIER, so denser
    expect(mile).toBeGreaterThan(sea + 25);
    expect(sea - isa).toBeCloseTo(3.98, 2);
    expect(mile - sea).toBeCloseTo(29.44, 2);
  });

  it('launchFromAngles and decomposeSpin are inverses', () => {
    for (const [la, spray, back, side] of [
      [28, 0, 2200, 0],
      [12, -35, 1500, 900],
      [45, 22, 900, -1400],
      [-8, 5, -2000, 300],
    ] as const) {
      const l = launchFromAngles(103, la, spray, back, side);
      const d = decomposeSpin(l.v, l.omega);
      expect(d.backspinRpm).toBeCloseTo(back, 6);
      expect(d.sidespinRpm).toBeCloseTo(side, 6);
      expect(d.gyrospinRpm).toBeCloseTo(0, 9);
      const r = simulateBattedBall(l, GAME_AIR);
      expect(r.evMph).toBeCloseTo(103, 9);
      expect(r.laDeg).toBeCloseTo(la, 9);
      expect(r.sprayDeg).toBeCloseTo(spray, 9);
    }
  });

  it('⚠ sidespin curves the ball in flight — toward third base for +side', () => {
    // The Magnus sign again, on the batted-ball side. +sidespin is about the up
    // axis; on a ball travelling −x that is ẑ × (−x̂) = −ŷ, i.e. toward third.
    const straight = simulateBattedBall(launchFromAngles(100, 25, 0, 2000, 0), GAME_AIR);
    const hooked = simulateBattedBall(launchFromAngles(100, 25, 0, 2000, 2000), GAME_AIR);
    const sliced = simulateBattedBall(launchFromAngles(100, 25, 0, 2000, -2000), GAME_AIR);
    console.log(
      `\n  lateral landing y: −2000 rpm ${sliced.landing.y.toFixed(1)} | 0 ${straight.landing.y.toFixed(1)} | +2000 ${hooked.landing.y.toFixed(1)} ft`,
    );
    expect(Math.abs(straight.landing.y)).toBeLessThan(1e-9);
    expect(hooked.landing.y).toBeLessThan(-20);
    expect(sliced.landing.y).toBeCloseTo(-hooked.landing.y, 6);
  });

  it('distanceAtHeight finds the fence crossing on the way down', () => {
    const r = simulateBattedBall(launchFromAngles(103, 28, 0, REF_SPIN_RPM), GAME_AIR);
    const at8 = distanceAtHeight(r, 8);
    const at20 = distanceAtHeight(r, 20);
    expect(at8).not.toBeNull();
    expect(at20).not.toBeNull();
    expect(at8!).toBeLessThan(r.carryFt);
    expect(at20!).toBeLessThan(at8!); // a higher wall is cleared earlier
    expect(r.carryFt - at8!).toBeCloseTo(8.21, 2);
    // A wall taller than the apex is never reached.
    expect(distanceAtHeight(r, r.apexFt + 10)).toBeNull();
  });

  it('is deterministic — same launch twice, byte-identical', () => {
    const l = launchFromAngles(101.5, 27.5, -12, 2350, 400);
    expect(JSON.stringify(simulateBattedBall(l, GAME_AIR))).toBe(
      JSON.stringify(simulateBattedBall(l, GAME_AIR)),
    );
  });
});

// ---------------------------------------------------------------------------
// End to end: one swing, one flight
// ---------------------------------------------------------------------------

describe('collision → flight, end to end', () => {
  const pitch = {
    v: vec3(
      90 * MPH_TO_FPS * Math.cos((-8 * Math.PI) / 180),
      0,
      90 * MPH_TO_FPS * Math.sin((-8 * Math.PI) / 180),
    ),
    omega: vec3(0, -2200 * RPM_TO_RADS, 0),
  };
  const sw = (o: Partial<Swing> = {}): Swing => ({
    hand: 'R',
    timingErrorS: 0,
    undercutIn: 0.75,
    ...o,
  });
  const flyIt = (s: Swing) => {
    const c = swingContact(pitch, s);
    const r = simulateBattedBall(
      { p: vec3(0, 0, CONTACT_HEIGHT_FT), v: c.v, omega: c.omega },
      GAME_AIR,
    );
    return { c, r };
  };

  it('⚠ END TO END: prints undercut → carry, and the model\'s own best swing', () => {
    console.log('\nUNDERCUT SWEEP — one swing model, one collision, one flight (game air)');
    console.log(' under(in)     EV     LA   back(rpm)   carry   hang');
    let best = { u: 0, carry: -1 };
    for (let u = -0.25; u <= 1.5001; u += 0.125) {
      const { c, r } = flyIt(sw({ undercutIn: u }));
      if (r.carryFt > best.carry) best = { u, carry: r.carryFt };
      console.log(
        `${f(u, 10, 3)} ${f(c.evMph, 6, 1)} ${f(c.laDeg, 6, 1)} ${f(c.backspinRpm, 11, 0)} ${f(r.carryFt, 7, 1)} ${f(r.hangS, 6, 2)}`,
      );
    }
    console.log(`  best undercut ${best.u.toFixed(3)} in ⇒ ${best.carry.toFixed(1)} ft`);
    // The model's best hit off a LEAGUE-AVERAGE 71.5 mph swing carries 450+ ft,
    // which real baseball reserves for the hardest swings in the sport. Same
    // over-carry as the ladder above, reached from the other end.
    expect(best.carry).toBeGreaterThan(445);
    expect(best.u).toBeGreaterThan(0.4);
    expect(best.u).toBeLessThan(1.0);
  });

  it('mistiming costs distance, both ways', () => {
    const on = flyIt(sw()).r.carryFt;
    const early = flyIt(sw({ timingErrorS: -0.02 })).r.carryFt;
    const late = flyIt(sw({ timingErrorS: 0.02 })).r.carryFt;
    console.log(`\n  carry: 20 ms early ${early.toFixed(1)} | on time ${on.toFixed(1)} | 20 ms late ${late.toFixed(1)}`);
    expect(early).toBeLessThan(on - 20);
    expect(late).toBeLessThan(on - 20);
    expect(early).toBeCloseTo(late, 6);
  });

  it('a topped ball goes nowhere', () => {
    const { c, r } = flyIt(sw({ undercutIn: -0.6 }));
    expect(c.laDeg).toBeLessThan(0);
    expect(c.backspinRpm).toBeLessThan(0);
    expect(r.hangS).toBeLessThan(1.0);
    expect(r.carryFt).toBeLessThan(120);
  });

  it('the contact point is the published 3.0 ft', () => {
    expect(CONTACT_HEIGHT_FT).toBe(3.0);
    expect(SWEET_SPOT_M).toBe(0.72);
  });
});

// ---------------------------------------------------------------------------
// ⚠ MUTATIONS WATCHED TO FAIL, same discipline as batSim.test.ts — applied to
// the shipping source, the whole 93-test suite run, reverted. Tests killed:
//
//   1. the batted ball's spin zeroed at launch (Magnus removed from the flight)
//      — 11 tests. The optimum-angle contrast, the ladder, the hook and the
//      end-to-end sweep all die, which is the point: a carry test that only
//      checked one launch angle would survive this.
//   2. the ground contact snapped to the substep boundary instead of
//      interpolated — 6 tests, the analytic-crossing one by a landing height of
//      0.4 ft and a fence distance of 0.7 ft.
//   3. ⚠ A 0.87 CARRY FUDGE FACTOR — the exact fifth-category patch that would
//      make this file's published residuals vanish — 8 tests, including the
//      "residual is uniformly positive" assertion that exists to pin the
//      finding. The finding is guarded as firmly as the numbers are.
// ---------------------------------------------------------------------------
