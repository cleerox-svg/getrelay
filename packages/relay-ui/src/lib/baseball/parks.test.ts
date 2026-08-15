// The park bench: the fence interpolation, the roof mechanic, the altitude
// result and the home-run / in-play resolution.
//
// Same discipline as every stage before it — print the table, read the table,
// assert the numbers, and pin the findings as goldens with the published figure
// beside them so a drift is a diff and not a shrug.

import { describe, expect, it } from 'vitest';
import { aeroAccel, aeroScale, airDensity, crossingFraction, vAdd, vLerp, vScale, vSub, vec3 } from './airPhysics';
import type { Vec3 } from './airPhysics';
import {
  CONTACT_HEIGHT_FT,
  distanceAtHeight,
  launchFromAngles,
  maxCarry,
  simulateBattedBall,
} from './battedBallSim';
import type { BattedFlight } from './battedBallSim';
import {
  ALPINE_HEIGHTS,
  fenceAt,
  FOUL_LINE_DEG,
  HARBOURFRONT,
  parkConditions,
  PARKS,
  parkById,
  resolveFence,
  ROOF_CLOSED_RH,
  ROOF_CLOSED_TEMP_F,
  roofClosed,
  validatePark,
} from './parks';
import type { Park } from './parks';
import { GAME_AIR } from './pitchSim';
import { FIXED_DT } from './tuning';
import { makeWind, mulberry32, windMph } from '../golf/wind';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/** The reference batted ball: game-day air, 2200 rpm — BASEBALL.md's convention. */
const BACKSPIN_RPM = 2200;
const REF_LA = 27;

const fly = (evMph: number, laDeg = REF_LA, sprayDeg = 0, air = GAME_AIR): BattedFlight =>
  simulateBattedBall(launchFromAngles(evMph, laDeg, sprayDeg, BACKSPIN_RPM), air);

/** Bisect exit velocity until `measure(flight)` hits `target`. */
function evFor(target: number, measure: (f: BattedFlight) => number, spray = 0): number {
  let lo = 70;
  let hi = 125;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    if (measure(fly(m, REF_LA, spray)) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------

describe('the fence, interpolated', () => {
  it('is monotone-cubic-Hermite: smooth, local, and it never overshoots', () => {
    let table = '\n[HARBOURFRONT FENCE — pchip through 5 samples, ft]\n  bearing  dist   height   (linear-in-polar for contrast)\n';
    const lin = (b: number) => {
      // The rejected alternative, computed here so the contrast is measured.
      const f = HARBOURFRONT.fence;
      for (let i = 1; i < f.length; i++) {
        const a = f[i - 1];
        const c = f[i];
        if (!a || !c) continue;
        if (b >= a.bearingDeg && b <= c.bearingDeg) {
          const t = (b - a.bearingDeg) / (c.bearingDeg - a.bearingDeg);
          return a.distFt + (c.distFt - a.distFt) * t;
        }
      }
      return 0;
    };
    for (let b = -45; b <= 45; b += 5) {
      const w = fenceAt(HARBOURFRONT, b);
      table += `  ${String(b).padStart(5)}°  ${w.distFt.toFixed(2).padStart(6)}  ${w.heightFt
        .toFixed(2)
        .padStart(5)}   ${lin(b).toFixed(2).padStart(6)}\n`;
    }
    log(table);

    // NO OVERSHOOT is the property the whole choice rests on: a natural cubic
    // spline through 328/375/400 bulges PAST 400 at centre field, inventing a
    // distance the data does not contain at the one bearing the deepest part of
    // the park is defined by. Fritsch–Carlson cannot.
    for (let b = -45; b <= 45; b += 0.25) {
      const d = fenceAt(HARBOURFRONT, b).distFt;
      expect(d).toBeLessThanOrEqual(400 + 1e-9);
      expect(d).toBeGreaterThanOrEqual(328 - 1e-9);
    }
    // Dead centre is the true maximum, because the extremum slope is set to 0.
    expect(fenceAt(HARBOURFRONT, 0).distFt).toBeCloseTo(400, 9);
    expect(fenceAt(HARBOURFRONT, 1).distFt).toBeLessThan(400);
    expect(fenceAt(HARBOURFRONT, -1).distFt).toBeLessThan(400);

    // A symmetric park interpolates symmetrically — otherwise a pulled ball and
    // an opposite-field ball of the same length disagree.
    for (let b = 0.5; b <= 45; b += 0.5) {
      expect(fenceAt(HARBOURFRONT, -b).distFt).toBeCloseTo(fenceAt(HARBOURFRONT, b).distFt, 9);
    }
    // A constant height column comes back constant — 10 ft to 1e-14, i.e. the
    // Hermite basis summing to 1 and nothing else. A ringing interpolant would
    // put a dip in a uniform wall; this one puts a rounding error in it.
    for (let b = -45; b <= 45; b += 1) {
      expect(Math.abs(fenceAt(HARBOURFRONT, b).heightFt - 10)).toBeLessThan(1e-12);
    }

    // It is NOT secretly linear. If it were, the renderer gets its creases back.
    expect(Math.abs(fenceAt(HARBOURFRONT, -33).distFt - lin(-33))).toBeGreaterThan(0.5);

    // C¹ AT THE KNOTS, which is the property the crease-free wall needs and the
    // one linear interpolation fails. Compare the one-sided slopes across the
    // −22° sample; linear's jump by 0.66 ft/deg, pchip's agree to <0.01.
    const slope = (b: number, h: number) =>
      (fenceAt(HARBOURFRONT, b + h).distFt - fenceAt(HARBOURFRONT, b).distFt) / h;
    const jump = Math.abs(slope(-22, 1e-4) - slope(-22, -1e-4));
    const linJump = Math.abs((lin(-21.9999) - lin(-22)) / 1e-4 - (lin(-22.0001) - lin(-22)) / -1e-4);
    log(`  knot slope jump at −22°: pchip ${jump.toFixed(5)} ft/deg, linear ${linJump.toFixed(5)}\n`);
    expect(jump).toBeLessThan(0.01);
    expect(linJump).toBeGreaterThan(0.3);
  });

  it('handles an asymmetric park with a tall wall without ringing', () => {
    let table = '\n[ALPINE HEIGHTS FENCE — asymmetric, 16 ft wall in LC]\n';
    for (let b = -45; b <= 45; b += 5) {
      const w = fenceAt(ALPINE_HEIGHTS, b);
      table += `  ${String(b).padStart(5)}°  ${w.distFt.toFixed(1).padStart(6)} ft  ${w.heightFt
        .toFixed(2)
        .padStart(5)} ft\n`;
    }
    log(table);
    for (let b = -45; b <= 45; b += 0.25) {
      const w = fenceAt(ALPINE_HEIGHTS, b);
      expect(w.distFt).toBeGreaterThanOrEqual(347 - 1e-9);
      expect(w.distFt).toBeLessThanOrEqual(415 + 1e-9);
      // The height column is 8/16/8/8/8: a spline that rings would dip BELOW 8
      // either side of the notch and put a hole in the wall.
      expect(w.heightFt).toBeGreaterThanOrEqual(8 - 1e-9);
      expect(w.heightFt).toBeLessThanOrEqual(16 + 1e-9);
    }
    // ⚠ THE HEIGHT COLUMN IS INTERPOLATED TOO, and this has to be asserted
    // separately: Harbourfront's wall is a uniform 10 ft, so every test there
    // passes with the height pinned to the first sample. (Watched: pinning it
    // survived the whole suite until this line existed.)
    expect(fenceAt(ALPINE_HEIGHTS, -20).heightFt).toBeCloseTo(16, 9);
    expect(fenceAt(ALPINE_HEIGHTS, 20).heightFt).toBeCloseTo(8, 9);
    expect(fenceAt(ALPINE_HEIGHTS, -30).heightFt).toBeGreaterThan(8.5);
    expect(fenceAt(ALPINE_HEIGHTS, -30).heightFt).toBeLessThan(15.5);
    expect(fenceAt(ALPINE_HEIGHTS, -45).heightFt).toBeCloseTo(8, 9);

    // Outside the sampled span the wall is clamped, not extrapolated to nonsense.
    expect(fenceAt(ALPINE_HEIGHTS, -70).distFt).toBe(347);
    expect(fenceAt(ALPINE_HEIGHTS, 70).distFt).toBe(350);
  });

  it('a tall wall is a real gameplay boundary, not a decal', () => {
    // The same ball at the same bearing under an 8 ft wall and Alpine's 16 ft
    // one. If the height column were not read, these would agree.
    const air = { elevFt: ALPINE_HEIGHTS.elevationFt, tempF: 70, rh: 0.5 };
    // Bisect until the ball is exactly 12 ft up at the 390 ft LC fence — over an
    // 8 ft wall, under a 16 ft one.
    let lo = 80;
    let hi = 120;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      if ((distanceAtHeight(fly(m, REF_LA, -20, air), 12) ?? 0) < 390) lo = m;
      else hi = m;
    }
    const f = fly((lo + hi) / 2, REF_LA, -20, air);
    const tall = resolveFence(f, ALPINE_HEIGHTS, false);
    const short = resolveFence(f, { ...ALPINE_HEIGHTS, fence: ALPINE_HEIGHTS.fence.map((s) => ({ ...s, heightFt: 8 })) }, false);
    log(
      `\n[TALL WALL] the same ball at −20°, ${(tall.heightAtFenceFt ?? 0).toFixed(
        2,
      )} ft up at the ${tall.fenceDistFt.toFixed(1)} ft fence:` +
        ` over a ${tall.fenceHeightFt.toFixed(0)} ft wall → ${tall.outcome}, over 8 ft → ${short.outcome}\n`,
    );
    expect(tall.fenceHeightFt).toBeCloseTo(16, 6);
    expect(tall.outcome).toBe('offWall');
    expect(short.outcome).toBe('homeRun');
  });
});

// ---------------------------------------------------------------------------

describe('parks as data', () => {
  it('every shipped park validates, and the ids are unique', () => {
    for (const p of PARKS) {
      expect(validatePark(p), `${p.id}: ${validatePark(p).join('; ')}`).toEqual([]);
    }
    expect(new Set(PARKS.map((p) => p.id)).size).toBe(PARKS.length);
    expect(parkById('harbourfront')).toBe(HARBOURFRONT);
    expect(parkById('nope')).toBeUndefined();
  });

  it('validatePark actually fires — on a park built to be wrong', () => {
    // A guard nobody has watched fail is not a guard. Every clause below is a
    // separate way a hand-edited data row goes wrong.
    const bad: Park = {
      id: '',
      name: '  ',
      elevationFt: 99999,
      roof: 'none',
      roofPeakFt: 282, // roofless park with a stale ceiling
      fence: [
        { bearingDeg: -40, distFt: 328, heightFt: 10 }, // does not start at −45
        { bearingDeg: -40, distFt: 375, heightFt: 10 }, // not strictly ascending
        { bearingDeg: 0, distFt: 40, heightFt: 10 }, // 40 ft to centre field
        { bearingDeg: 22, distFt: 375, heightFt: -3 }, // negative wall
        { bearingDeg: 44, distFt: 328, heightFt: 10 }, // does not end at +45
      ],
      foulTerritoryFt: 0,
      wind: {
        open: { bearingCentreDeg: Number.NaN, swingDeg: 400, gustScale: -1 },
        closed: {} as never,
      },
    };
    const errs = validatePark(bad);
    log(`\n[validatePark on a deliberately broken park — ${errs.length} problems]\n  ${errs.join('\n  ')}\n`);
    expect(errs.length).toBe(14);
    expect(errs.join('|')).toContain('id is empty');
    expect(errs.join('|')).toContain('name is empty');
    expect(errs.join('|')).toContain('elevationFt');
    expect(errs.join('|')).toContain('foulTerritoryFt');
    expect(errs.join('|')).toContain("roofPeakFt must be 0 when roof is 'none'");
    expect(errs.join('|')).toContain('wind.closed must be null');
    expect(errs.join('|')).toContain('bearingCentreDeg is not finite');
    expect(errs.join('|')).toContain('swingDeg 400');
    expect(errs.join('|')).toContain('gustScale -1');
    expect(errs.join('|')).toContain('must start at the LF line');
    expect(errs.join('|')).toContain('must end at the RF line');
    expect(errs.join('|')).toContain('not strictly after');
    expect(errs.join('|')).toContain('distFt 40');
    expect(errs.join('|')).toContain('heightFt -3');

    // ...and a roofed park with no ceiling is caught from the other direction.
    expect(validatePark({ ...HARBOURFRONT, roofPeakFt: 0 }).join('|')).toContain('roofPeakFt 0');
    expect(validatePark({ ...HARBOURFRONT, roofPeakFt: 282 })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('home-run resolution', () => {
  it('400 ft to centre clears the wall; 395 does not', () => {
    // ⚠ SAY WHAT THE 400 MEASURES. A fence is a plane and a wall has a height,
    // so "a 400 foot home run" only has an answer once you fix which 400. Here it
    // is the ground distance at which the ball descends through the top of the
    // wall — `distanceAtHeight(flight, wallHeight)` — which is exactly the
    // quantity the resolver compares against `fence.distFt`. The CARRY is
    // printed beside it because the two differ by more than a wall's worth.
    const wall = fenceAt(HARBOURFRONT, 0);
    expect(wall.distFt).toBe(400);
    expect(wall.heightFt).toBe(10);

    let table = '\n[HARBOURFRONT · dead centre, 400 ft, 10 ft wall]\n  d@10ft   EV      carry    h at fence   call\n';
    const rows = [400, 395].map((target) => {
      const ev = evFor(target, (f) => distanceAtHeight(f, wall.heightFt) ?? 0);
      const f = fly(ev);
      const r = resolveFence(f, HARBOURFRONT, false);
      table += `  ${target} ft  ${ev.toFixed(2)}  ${f.carryFt.toFixed(2)} ft  ${(r.heightAtFenceFt ?? 0)
        .toFixed(3)
        .padStart(8)} ft   ${r.outcome}\n`;
      return { target, r, f };
    });

    // And the number that is NOT a home run, which is worth printing because it
    // is the one everybody assumes is: a ball whose CARRY is exactly 400 lands at
    // the base of a 400 ft wall.
    const carry400 = fly(evFor(400, (f) => f.carryFt));
    const c400 = resolveFence(carry400, HARBOURFRONT, false);
    table += `\n  a 400 ft CARRY to a 400 ft fence: ${c400.outcome} — it needs ${(
      fly(evFor(400, (f) => distanceAtHeight(f, 10) ?? 0)).carryFt - 400
    ).toFixed(1)} ft more carry to clear the 10 ft wall.\n`;
    log(table);

    expect(rows[0]?.r.outcome).toBe('homeRun');
    expect(rows[0]?.r.heightAtFenceFt ?? 0).toBeCloseTo(10, 2);
    expect(rows[1]?.r.outcome).toBe('offWall');
    expect(rows[1]?.r.heightAtFenceFt ?? 0).toBeLessThan(10);
    // The finding, pinned: carry alone does not clear a wall.
    expect(c400.outcome).not.toBe('homeRun');
    expect(rows[0]?.f.carryFt ?? 0).toBeGreaterThan(405);
  });

  it('the foul line is at 45° and the pole is fair', () => {
    let table = '\n[SPRAY vs THE FOUL LINE — 105 mph, 27°]\n  spray    bearing at fence   call\n';
    const call = (spray: number) => {
      const r = resolveFence(fly(105, REF_LA, spray), HARBOURFRONT, false);
      table += `  ${spray.toFixed(1).padStart(6)}°  ${r.bearingDeg.toFixed(3).padStart(9)}°        ${r.outcome}\n`;
      return r.outcome;
    };
    const at44 = call(44.5);
    const at45 = call(45);
    const at455 = call(45.5);
    const atNeg = call(-45.5);
    const atNegIn = call(-44.5);
    log(table);

    expect(FOUL_LINE_DEG).toBe(45);
    // Two-sided and mirrored: a one-sided check passes an implementation that
    // fouls everything.
    expect(at44).toBe('homeRun');
    expect(at45).toBe('homeRun'); // the pole itself is fair
    expect(at455).toBe('foul');
    expect(atNeg).toBe('foul');
    expect(atNegIn).toBe('homeRun');
  });

  it('a ball short of the wall is in play, and a ball off the wall is not a home run', () => {
    const short = resolveFence(fly(92), HARBOURFRONT, false);
    expect(short.outcome).toBe('inPlay');
    expect(short.heightAtFenceFt).toBeNull();
    expect(short.distFt).toBeLessThan(400);

    // d@10 ft = 396 ⇒ the ball is below the top of the wall by the time it gets
    // to 400, but still carries past the fence line — the wall-ball case.
    const wallBall = resolveFence(fly(evFor(396, (f) => distanceAtHeight(f, 10) ?? 0)), HARBOURFRONT, false);
    expect(wallBall.outcome).toBe('offWall');
    expect(wallBall.fenceDistFt).toBeCloseTo(400, 6);
  });
});

// ---------------------------------------------------------------------------

describe('the roof', () => {
  it('closed ⇒ the wind is EXACTLY zero and the park is deterministic', () => {
    const a = parkConditions(HARBOURFRONT, true, 1);
    const b = parkConditions(HARBOURFRONT, true, 987654321);

    // ⚠ === 0, not toBeCloseTo. A wind of 1e-17 is not determinism, it is a bug
    // that has not been noticed yet — and it would defeat the byte-identity
    // below the moment a trajectory got long enough.
    expect(a.windFps.x).toBe(0);
    expect(a.windFps.y).toBe(0);
    expect(a.windFps.z).toBe(0);
    expect(a.windSpeedMph).toBe(0);
    expect(b.windFps).toEqual(vec3(0, 0, 0));
    expect(a.air).toEqual({ elevFt: 250, tempF: ROOF_CLOSED_TEMP_F, rh: ROOF_CLOSED_RH });
    expect(b.air).toEqual(a.air);

    // BYTE-IDENTICAL trajectories at two unrelated seeds. This is the property
    // ranked play rests on, so it is asserted on the whole sampled track and on
    // the scalars, not on "carry agrees to a foot".
    const fa = simulateBattedBall(launchFromAngles(103, 27, -8, BACKSPIN_RPM), a.air, a.windFps);
    const fb = simulateBattedBall(launchFromAngles(103, 27, -8, BACKSPIN_RPM), b.air, b.windFps);
    expect(fb.track).toEqual(fa.track);
    expect(fb.carryFt).toBe(fa.carryFt);
    expect(fb.hangS).toBe(fa.hangS);
    expect(fb.landing).toEqual(fa.landing);
    log(
      `\n[ROOF CLOSED] wind exactly 0, air ${a.air.tempF} °F / ${a.air.rh} RH @ ${a.air.elevFt} ft` +
        `\n  seeds 1 and 987654321 both carry ${fa.carryFt.toFixed(6)} ft in ${fa.hangS.toFixed(6)} s\n`,
    );
  });

  it('open ⇒ the seed matters, and it moves real feet', () => {
    let table = '\n[ROOF OPEN — the same 103 mph / 27° swing, per seed]\n  seed        wind        bearing   temp    RH     carry\n';
    const carries: number[] = [];
    for (const seed of [1, 7, 12345, 99]) {
      const c = parkConditions(HARBOURFRONT, false, seed);
      const f = simulateBattedBall(launchFromAngles(103, 27, 0, BACKSPIN_RPM), c.air, c.windFps);
      carries.push(f.carryFt);
      table += `  ${String(seed).padStart(5)}   ${c.windSpeedMph.toFixed(2).padStart(5)} mph  ${c.windBearingDeg
        .toFixed(1)
        .padStart(7)}°  ${c.air.tempF.toFixed(1)}°F  ${c.air.rh.toFixed(2)}  ${f.carryFt.toFixed(2)} ft\n`;
    }
    const closed = parkConditions(HARBOURFRONT, true, 1);
    const shut = simulateBattedBall(launchFromAngles(103, 27, 0, BACKSPIN_RPM), closed.air, closed.windFps);
    table += `  closed                                        ${shut.carryFt.toFixed(2)} ft\n`;
    log(table);

    expect(new Set(carries).size).toBe(carries.length);
    // The spread has to be worth something, or the roof is decoration.
    expect(Math.max(...carries) - Math.min(...carries)).toBeGreaterThan(5);
    // ...and the SAME seed still reproduces exactly.
    expect(parkConditions(HARBOURFRONT, false, 7)).toEqual(parkConditions(HARBOURFRONT, false, 7));
  });

  it('the bearing window is UNIFORM, so its centre is not its rarest bearing', () => {
    // ⚠ THE REGRESSION THIS EXISTS FOR. The bearing used to be golf's
    // `windBearing` mapped onto the window, and golf damps `along` to 0.6× so
    // that `cross` dominates — which piled `atan2(cross, along)` up near ±π/2
    // and made the mapped bearing BIMODAL at ±swingDeg/2. Measured then, over
    // these same 4000 seeds: the centre drew 3.1 % and ±30° drew 7.2 % each, so
    // the field then called `prevailingDeg` was the LEAST likely outcome it had.
    //
    // Asserted as a SHAPE, not as a golden: every 5° bucket inside the window
    // gets a fair share and none of them is a spike. A histogram is the only
    // thing that can see this class of bug — no single seed can.
    const N = 4000;
    const swing = HARBOURFRONT.wind.open.swingDeg;
    const centre = HARBOURFRONT.wind.open.bearingCentreDeg;
    const buckets = new Map<number, number>();
    let inWindow = 0;
    for (let seed = 1; seed <= N; seed++) {
      const b = parkConditions(HARBOURFRONT, false, seed).windBearingDeg;
      if (Math.abs(b - centre) <= swing + 1e-9) inWindow++;
      buckets.set(Math.floor(b / 10) * 10, (buckets.get(Math.floor(b / 10) * 10) ?? 0) + 1);
    }
    const keys = [...buckets.keys()].sort((a, b) => a - b);
    const pct = keys.map((k) => (100 * (buckets.get(k) ?? 0)) / N);
    log(
      `\n[WIND BEARING — ${N} seeds, window ${centre}° ± ${swing}°, 10° buckets]\n  ` +
        keys.map((k, i) => `${String(k).padStart(4)}°:${(pct[i] ?? 0).toFixed(1)}`).join('  ') +
        `\n  centre bucket ${(pct[keys.indexOf(0)] ?? 0).toFixed(1)} % vs edge buckets ${(
          pct[0] ?? 0
        ).toFixed(1)} / ${(pct[pct.length - 1] ?? 0).toFixed(1)} % — the old mapping gave 3.1 vs 7.2.\n`,
    );
    expect(inWindow).toBe(N); // never outside the window at all
    expect(keys.length).toBe((2 * swing) / 10); // and it fills the whole window
    // Uniform to within sampling noise: the expected share is 100/12 = 8.33 %.
    const expectedPct = 100 / keys.length;
    for (const p of pct) {
      expect(p).toBeGreaterThan(expectedPct * 0.75);
      expect(p).toBeLessThan(expectedPct * 1.25);
    }
    // The centre is not the rarest bucket — the assertion the old sampler failed.
    const centreShare = pct[keys.indexOf(0)] ?? 0;
    expect(centreShare).toBeGreaterThan(Math.min(...pct) - 1e-9);
    expect(centreShare).toBeGreaterThan(0.7 * Math.max(...pct));
  });

  it('⚠ TRIPWIRE on golf\'s wind sampler — an upstream retune must not land silently', () => {
    // ⚠ THIS ASSERTS NOTHING ABOUT BASEBALL. `parkConditions` reuses golf's
    // `makeWind`/`windMph` rather than forking a second sampler (the charter's
    // flag-not-fork rule), and golf is mid-audit — so a golf retune moves this
    // game's winds. Three separate mutations of `lib/golf/wind.ts` used to pass
    // this whole suite: `windMph`'s ×2.5 → ×1.0, doubling `makeWind`'s
    // magnitude, and deleting the 0.6 along-damping. Flag-not-fork is right;
    // flag-without-a-tripwire is not.
    //
    // If this fails, NOTHING IS WRONG WITH BASEBALL: read the golf diff, decide
    // whether the new wind is one this game wants, and re-golden deliberately.
    expect(windMph(3, 4)).toBeCloseTo(12.5, 12); // hypot × 2.5
    expect(windMph(0, 1)).toBeCloseTo(2.5, 12);
    const w = makeWind(mulberry32(7));
    expect(w.along).toBeCloseTo(0.23571815946921332, 12);
    expect(w.cross).toBeCloseTo(0.9576636792870686, 12);
    // ...and the composite the game actually plays, at one fixed seed.
    const c = parkConditions(HARBOURFRONT, false, 7);
    log(
      `[TRIPWIRE] golf seed 7 ⇒ along ${w.along.toFixed(6)}, cross ${w.cross.toFixed(
        6,
      )}; Harbourfront seed 7 ⇒ ${c.windSpeedMph.toFixed(6)} mph @ ${c.windBearingDeg.toFixed(6)}°\n`,
    );
    expect(c.windSpeedMph).toBeCloseTo(6.394447498974202, 9);
    expect(c.windBearingDeg).toBeCloseTo(2.5734322238713503, 9);
  });

  it('geometry decides whether the roof can be shut at all', () => {
    expect(roofClosed(HARBOURFRONT, true)).toBe(true);
    expect(roofClosed(HARBOURFRONT, false)).toBe(false);
    expect(roofClosed(ALPINE_HEIGHTS, true)).toBe(false); // no roof to close
    expect(roofClosed({ ...HARBOURFRONT, roof: 'fixed' }, false)).toBe(true);
    // A roofless park never pins the weather, whatever the caller asks for.
    expect(parkConditions(ALPINE_HEIGHTS, true, 3).roofClosed).toBe(false);
    expect(parkConditions(ALPINE_HEIGHTS, true, 3).windSpeedMph).toBeGreaterThan(0);
  });

  it('the ceiling is enforced — and here is exactly how much it bites', () => {
    const air = parkConditions(HARBOURFRONT, true, 0).air;
    const pop = (ev: number) => simulateBattedBall(launchFromAngles(ev, 89.5, 0, 0), air);
    let table = '\n[ROOF CEILING — 282 ft, near-vertical pop-up, closed-roof air]\n  EV mph   apex ft   call\n';
    for (const ev of [110, 115, 120, 122, 125]) {
      const f = pop(ev);
      table += `  ${String(ev).padStart(6)}  ${f.apexFt.toFixed(1).padStart(8)}   ${
        resolveFence(f, HARBOURFRONT, true).outcome
      }\n`;
    }
    expect(resolveFence(pop(120), HARBOURFRONT, true).outcome).toBe('inPlay');
    expect(resolveFence(pop(120), HARBOURFRONT, true).hitRoof).toBe(false);
    expect(resolveFence(pop(122), HARBOURFRONT, true).outcome).toBe('roof');
    expect(resolveFence(pop(122), HARBOURFRONT, true).hitRoof).toBe(true);
    // ...and with the roof OPEN the same ball is just a pop-up.
    expect(resolveFence(pop(122), HARBOURFRONT, false).outcome).toBe('inPlay');

    // ⚠ THE HONEST FINDING, and it is a finding rather than a bug: at 282 ft the
    // ceiling can only ever catch a POP-UP off the hardest contact in the sport.
    // The threshold is ~120.2 mph straight up; a ball hit at a home-run launch
    // angle apexes ~200 ft at 125 mph, so the roof NEVER converts a home run.
    const hr = simulateBattedBall(launchFromAngles(125, 40, 0, BACKSPIN_RPM), air);
    table += `\n  a 125 mph / 40° home run apexes ${hr.apexFt.toFixed(
      1,
    )} ft — the roof is 282, so it never converts one.\n`;
    log(table);
    expect(hr.apexFt).toBeLessThan(282);
    expect(resolveFence(hr, HARBOURFRONT, true).outcome).toBe('homeRun');
    expect(resolveFence(hr, HARBOURFRONT, true).hitRoof).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('wind is a Galilean boost, not a second integrator', () => {
  it('agrees with an INDEPENDENT ground-frame integration that carries the wind', () => {
    // ⚠ WHAT THIS TEST USED TO DO, AND WHY IT WAS REPLACED. It compared the
    // boosted flight against `p_air + w·t` recomputed from a BIT-IDENTICAL
    // air-frame integration — i.e. it evaluated the same expression on both
    // sides and reported 0.00e+0 ft over 652 substeps. The number was real and
    // the derivation is correct, but the evidence was CIRCULAR: it could not
    // have printed anything else. It killed a sign flip and a `dt`-for-`t`
    // slip and nothing more.
    //
    // The honest test is an independent integration in the GROUND frame with
    // the wind carried inside the accelerator — `a(v) = aeroAccel(v − w)`,
    // which is the "add a wind term" implementation the boost claims to
    // replace. Same RK4, same coefficients, different arithmetic path, so the
    // agreement is a real measurement with a real (tiny) nonzero residual.
    const K = aeroScale(airDensity(GAME_AIR.elevFt, GAME_AIR.tempF, GAME_AIR.rh));
    let table = '\n[WIND = GALILEAN BOOST — boost vs a ground-frame RK4 carrying the wind]\n';
    for (const w of [vec3(-9, 4, 0), vec3(14.6667, 0, 0), vec3(0, -20, 0)]) {
      const l = launchFromAngles(101, 28, -6, BACKSPIN_RPM);
      const boosted = simulateBattedBall(l, GAME_AIR, w);
      const acc = (v: Vec3) => aeroAccel(vSub(v, w), l.omega, K);
      let s = { p: l.p, v: l.v };
      let t = 0;
      let i = 0;
      let worst = 0;
      const compare = (st: { p: Vec3 }, tt: number, idx: number) => {
        worst = Math.max(
          worst,
          Math.abs(st.p.x - (boosted.track.x[idx] ?? NaN)),
          Math.abs(st.p.y - (boosted.track.y[idx] ?? NaN)),
          Math.abs(st.p.z - (boosted.track.z[idx] ?? NaN)),
          Math.abs(tt - (boosted.track.t[idx] ?? NaN)),
        );
      };
      compare(s, 0, 0);
      for (;;) {
        const a1 = acc(s.v);
        const v2 = vAdd(s.v, vScale(a1, FIXED_DT / 2));
        const a2 = acc(v2);
        const v3 = vAdd(s.v, vScale(a2, FIXED_DT / 2));
        const a3 = acc(v3);
        const v4 = vAdd(s.v, vScale(a3, FIXED_DT));
        const a4 = acc(v4);
        const next = {
          p: vAdd(s.p, vScale(vAdd(vAdd(s.v, vScale(vAdd(v2, v3), 2)), v4), FIXED_DT / 6)),
          v: vAdd(s.v, vScale(vAdd(vAdd(a1, vScale(vAdd(a2, a3), 2)), a4), FIXED_DT / 6)),
        };
        i++;
        const f = crossingFraction(s.p.z, next.p.z, 0);
        if (f !== null) {
          t += f * FIXED_DT;
          compare({ p: vLerp(s.p, next.p, f) }, t, i);
          break;
        }
        s = next;
        t += FIXED_DT;
        compare(s, t, i);
      }
      table += `  w = (${w.x.toFixed(1)}, ${w.y.toFixed(1)}) ft/s: ${i + 1} samples, worst |Δ| ${worst.toExponential(
        2,
      )} ft over the whole flight\n`;
      // A REAL tolerance: the residual is accumulated floating-point difference
      // between two arithmetic paths, ~1e-12 ft on a 400 ft flight. Tight enough
      // that a sign, a dropped term or a `dt`-for-`t` slip is orders out.
      expect(i + 1).toBe(boosted.track.t.length);
      expect(worst).toBeLessThan(1e-9);
      expect(worst).toBeGreaterThan(0); // it is a measurement, not an identity
    }
    log(table);
  });

  it('zero wind is byte-identical to no wind at all, and a real wind is not', () => {
    const l = launchFromAngles(100, 27, 0, BACKSPIN_RPM);
    const none = simulateBattedBall(l, GAME_AIR);
    expect(simulateBattedBall(l, GAME_AIR, vec3(0, 0, 0)).track).toEqual(none.track);
    expect(simulateBattedBall(l, GAME_AIR, vec3(0, 0, 0)).carryFt).toBe(none.carryFt);

    // 10 mph out to centre vs 10 mph in, on the same swing. Direction sign check:
    // bearing 0 is out to CF, which is −x in WORLD, so a tailwind is w.x < 0.
    const tail = simulateBattedBall(l, GAME_AIR, vec3(-10 * 1.466667, 0, 0));
    const head = simulateBattedBall(l, GAME_AIR, vec3(10 * 1.466667, 0, 0));
    log(
      `[WIND · 10 mph] head ${head.carryFt.toFixed(1)} ft · still ${none.carryFt.toFixed(
        1,
      )} ft · tail ${tail.carryFt.toFixed(1)} ft  (span ${(tail.carryFt - head.carryFt).toFixed(1)} ft)\n`,
    );
    expect(tail.carryFt).toBeGreaterThan(none.carryFt);
    expect(head.carryFt).toBeLessThan(none.carryFt);
    expect(tail.carryFt - head.carryFt).toBeGreaterThan(20);

    // ⚠ AN INDEPENDENT CHECK, and the reason the wind is worth modelling as a
    // boost rather than as a HUD arrow: the commonly published figure is that a
    // 10 mph wind straight out is worth roughly 20–25 ft on a 400 ft fly.
    // Nothing here was fitted to that — the wind enters through the air-relative
    // velocity in stage 1's unmodified `aeroAccel` — and the model gives +24.2.
    // (The headwind costs MORE than the tailwind gains, −33.4 ft, which is also
    // the right asymmetry: drag goes as the square of the air-relative speed.)
    const gain = tail.carryFt - none.carryFt;
    expect(gain).toBeGreaterThan(20);
    expect(gain).toBeLessThan(25);
    expect(none.carryFt - head.carryFt).toBeGreaterThan(gain);

    // A pure crosswind pushes the ball sideways and barely touches the carry.
    const cross = simulateBattedBall(l, GAME_AIR, vec3(0, 10 * 1.466667, 0));
    expect(cross.landing.y).toBeGreaterThan(30);
    expect(Math.abs(cross.carryFt - none.carryFt)).toBeLessThan(6);
    // The vertical component is ignored rather than silently integrated.
    expect(simulateBattedBall(l, GAME_AIR, vec3(0, 0, 40)).track).toEqual(none.track);
  });
});

// ---------------------------------------------------------------------------

describe('altitude is DERIVED — measured against the published band', () => {
  it('a 400 ft fly at sea level, re-flown a mile up', () => {
    // ⚠ THE PUBLISHED FIGURE IS QUOTED ON A 400 FT FLY, so the model is measured
    // on one: hold the swing fixed, change ONLY the air, and read the gain. Air
    // reaches the ball through ρ → K and nothing else. There is no park factor
    // in this file and there must never be one.
    const ev = evFor(400, (f) => f.carryFt);
    const airAt = (elevFt: number) => ({ elevFt, tempF: 70, rh: 0.5 });
    let table = '\n[ALTITUDE — the SAME swing, only the air changes]\n  elev ft   carry @27°   Δ ft    carry @LA_opt   Δ ft\n';
    const rows: Array<{ elev: number; d27: number; dOpt: number }> = [];
    const base27 = fly(ev, REF_LA, 0, GAME_AIR).carryFt;
    const baseOpt = maxCarry(ev, BACKSPIN_RPM, GAME_AIR).carryFt;
    for (const elev of [0, 2500, 5200, 5280]) {
      const c27 = fly(ev, REF_LA, 0, airAt(elev)).carryFt;
      const cOpt = maxCarry(ev, BACKSPIN_RPM, airAt(elev)).carryFt;
      rows.push({ elev, d27: c27 - base27, dOpt: cOpt - baseOpt });
      table += `  ${String(elev).padStart(7)}   ${c27.toFixed(1).padStart(9)}  ${(c27 - base27)
        .toFixed(1)
        .padStart(6)}   ${cOpt.toFixed(1).padStart(12)}  ${(cOpt - baseOpt).toFixed(1).padStart(6)}\n`;
    }
    const alpine = rows.find((r) => r.elev === 5200);
    const mile = rows.find((r) => r.elev === 5280);
    table +=
      `\n  Published altitude effect on a 400 ft fly: ~25–30 ft.\n` +
      `  Model at 5200 ft (Alpine Heights): +${(alpine?.d27 ?? 0).toFixed(1)} ft at a fixed 27°,` +
      ` +${(alpine?.dOpt ?? 0).toFixed(1)} ft with each air at its own optimum launch angle.\n` +
      `  ⚠ RECONCILING BASEBALL.md's "+34.7 ft, slightly high": that figure is the\n` +
      `    105 mph MAX-CARRY rung, which is a ${maxCarry(105, BACKSPIN_RPM, GAME_AIR).carryFt.toFixed(
        0,
      )} ft fly, not a 400 ft one — and the\n` +
      `    altitude gain is superlinear in flight length (${((mile?.dOpt ?? 0) / baseOpt * 100).toFixed(
        2,
      )} % of a 400 ft fly against\n` +
      `    ${(
        ((maxCarry(105, BACKSPIN_RPM, airAt(5280)).carryFt - maxCarry(105, BACKSPIN_RPM, GAME_AIR).carryFt) /
          maxCarry(105, BACKSPIN_RPM, GAME_AIR).carryFt) *
        100
      ).toFixed(2)} % of a 432 ft one). Measured the way the published number is\n` +
      `    stated, the model is INSIDE the band — at its top edge, not outside it.\n`;
    log(table);

    // Thin air carries further, monotonically, through K alone.
    expect(rows[0]?.d27).toBeCloseTo(0, 9);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]?.d27 ?? 0).toBeGreaterThan(rows[i - 1]?.d27 ?? 0);
    }
    // THE RESULT, asserted against the published band rather than against itself.
    expect(alpine?.d27 ?? 0).toBeGreaterThan(25);
    expect(alpine?.d27 ?? 0).toBeLessThan(30);
    expect(alpine?.dOpt ?? 0).toBeGreaterThan(25);
    expect(alpine?.dOpt ?? 0).toBeLessThan(31);
    // Goldens, so a drift is a diff.
    expect(alpine?.d27 ?? 0).toBeCloseTo(29.1, 1);
    expect(mile?.d27 ?? 0).toBeCloseTo(29.5, 1);
    // ...and the 105 mph max-carry figure BASEBALL.md quotes is reproduced, so
    // the reconciliation above is arithmetic and not a story.
    const mileMax = maxCarry(105, BACKSPIN_RPM, airAt(5280)).carryFt;
    expect(mileMax - maxCarry(105, BACKSPIN_RPM, GAME_AIR).carryFt).toBeCloseTo(34.7, 1);
  });

  it('the two parks differ by their elevation and by nothing else in the physics', () => {
    // Same swing, same launch, the parks' own air — the ONLY input that differs
    // is elevationFt, and it reaches the ball through ρ → K.
    const l = launchFromAngles(100, 27, 0, BACKSPIN_RPM);
    const shut = parkConditions(HARBOURFRONT, true, 4);
    const thin = { elevFt: ALPINE_HEIGHTS.elevationFt, tempF: ROOF_CLOSED_TEMP_F, rh: ROOF_CLOSED_RH };
    const low = simulateBattedBall(l, shut.air).carryFt;
    const high = simulateBattedBall(l, thin).carryFt;
    log(`[TWO PARKS, same swing, same weather] 250 ft ${low.toFixed(1)} · 5200 ft ${high.toFixed(1)}  (+${(high - low).toFixed(1)})\n`);
    expect(high).toBeGreaterThan(low + 20);
    expect(CONTACT_HEIGHT_FT).toBe(3);
  });
});
