// The pitching bench. Every table here is PRINTED — read them, do not merely
// watch the assertions go green. A physics change can sit inside every
// tolerance while walking the whole ladder one way, and the ladder is the point.
//
// ⚠ WHAT THIS FILE FOUND, up front, because it is the most important thing
// stage 2 produced: the induced-break gap stage 1 flagged is NOT purely a
// measured-segment convention. One free parameter (the segment) was swept
// against sixteen published constraints and no value fits them all — the
// per-pitch requirement spans 34.0 to 51.1 ft. The reason is structural and is
// asserted below: over a common segment, deflection ≈ ½·K·C_L·L², so |v|
// cancels and the RATIO of any two pitches' break is just the ratio of their
// C_L. The segment sets the scale of all eight together and cannot change their
// relative pattern at all. The published table's break ratios disagree with the
// C_L ratios implied by the same table's spin/efficiency columns by up to 2.1×.
// So: C_D and C_L were NOT touched, no per-pitch correction was added, and the
// five resisting rows are pinned to the MODEL's own numbers with their
// published values recorded beside them as residuals.
//
// ⚠ MUTATIONS WATCHED TO FAIL. Each was applied to the shipping source, the
// whole baseball suite was run, and the source was reverted. A test nobody has
// seen fail is not a test. Measured, in tests (not assertions) killed:
//   1. tilt clock mirrored, θ → −θ in spinVector — 5 tests: the ratio structure,
//      the four-seam target, the goldens, the ordering test, and pitches.test's
//      12:00-is-backspin anchor. Every horizontal break flips sign.
//   2. activeSpin factor dropped (transverse = ω, not activeSpin·ω) — 5 tests,
//      including the pure-gyro test, whose break goes from 1.4 in to 20 in.
//   3. slider's tilt changed 9:30 → 9:00 (i.e. made a sweeper) — 1 test: the
//      goldens. The ordering test does NOT catch it, because a 9:00 slider still
//      breaks to the glove side and still less than the sweeper. This is exactly
//      what a golden pin is for, and why the ordering test is not enough alone.
//   4. gyro component dropped from spinVector — 3 tests: the goldens (the axis
//      renormalises, so break MOVES) plus both decomposition tests in
//      pitches.test.ts.
//   5. plate crossing snapped to the substep boundary instead of interpolated —
//      4 tests, the track/crossing consistency one by 0.16 in of called height.
//   6. stage 1's gyro projection defeated (S from |ω| instead of |ω_eff|) —
//      7 tests, 2 of them stage 1's own. Stage 2 does not weaken stage 1.
//   7. BREAK_SEGMENT_FT moved 50 → 44, the RMS optimum — 4 tests. The adopted
//      convention is pinned; it cannot drift without someone re-reading this
//      file's tables.

import { describe, expect, it } from 'vitest';
import { BALL_RADIUS_FT, liftCoef, vLen } from './airPhysics';
import { PITCHES, pitchById, publishedBreak } from './pitches';
import type { Pitch } from './pitches';
import { BREAK_REF_AIR, GAME_AIR, measureBreak, sampleTrack, simulatePitch } from './pitchSim';
import { BREAK_SEGMENT_FT, FIXED_DT } from './tuning';
import { FT_TO_IN, MPH_TO_FPS, RPM_TO_RADS } from './units';
import { RELEASE_D_FT, ZONE_CENTER } from './zone';

const pad = (s: string | number, n: number) => String(s).padStart(n);
const f = (n: number, w: number, p = 2) => pad(n.toFixed(p), w);

/** Break of a pitch on the pinned convention, RHP, ISA air, default aim. */
const breakOf = (p: Pitch, segmentFt: number = BREAK_SEGMENT_FT) =>
  measureBreak({ pitch: p, hand: 'R', air: BREAK_REF_AIR }, segmentFt);

/** Spin parameter S of a row, from its own published columns. */
const spinParamOf = (p: Pitch) =>
  (BALL_RADIUS_FT * p.spinRpm * p.activeSpin * RPM_TO_RADS) / (p.veloMph * MPH_TO_FPS);

// ---------------------------------------------------------------------------
// THE SEGMENT SWEEP — the headline experiment
// ---------------------------------------------------------------------------

describe('the measurement-segment experiment', () => {
  it('⚠ SWEEP: one free parameter against sixteen published targets', () => {
    const lengths: number[] = [];
    for (let L = 30; L <= 54; L += 2) lengths.push(L);
    for (const L of [49, 50, 51]) if (!lengths.includes(L)) lengths.push(L);
    lengths.sort((a, b) => a - b);

    let best = { L: 0, rms: Infinity };
    const rows = lengths.map((L) => {
      let sum = 0;
      const cells = PITCHES.map((p) => {
        const m = breakOf(p, L);
        const pub = publishedBreak(p, 'R');
        const dv = m.ivbIn - pub.ivbIn;
        const dh = m.hbIn - pub.hbIn;
        sum += dv * dv + dh * dh;
        return `${f(dv, 6, 1)}${f(dh, 5, 1)}`;
      });
      const rms = Math.sqrt(sum / (PITCHES.length * 2));
      if (rms < best.rms) best = { L, rms };
      const mark = L === BREAK_SEGMENT_FT ? ' ←' : '';
      return `  L=${pad(L, 2)}  rms=${f(rms, 5, 2)} ` + cells.join('') + mark;
    });

    // The length each pitch would need, on its own, to hit its own published
    // break magnitude. Bisection — deterministic, no random search.
    const required = PITCHES.map((p) => {
      const pubMag = Math.hypot(p.ivbIn, p.hbIn);
      let lo = 5;
      let hi = RELEASE_D_FT;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const m = breakOf(p, mid);
        if (Math.hypot(m.ivbIn, m.hbIn) < pubMag) lo = mid;
        else hi = mid;
      }
      return { id: p.id, L: (lo + hi) / 2 };
    });

    // eslint-disable-next-line no-console
    console.log(
      '\n[SEGMENT SWEEP — residual (model − published), inches, RHP, ISA air]\n' +
        '  each pitch shows  ΔIVB ΔHB   (HB in the REPORT frame, + toward first base)\n' +
        '        rms  ' +
        PITCHES.map((p) => pad(p.id, 11)).join('') +
        '\n' +
        rows.join('\n') +
        `\n\n  RMS optimum: L = ${best.L} ft at ${best.rms.toFixed(2)} in. ADOPTED: L = ${BREAK_SEGMENT_FT} ft.\n` +
        '  Length each pitch needs ON ITS OWN to hit its own published break magnitude:\n    ' +
        required.map((r) => `${r.id} ${r.L.toFixed(1)}`).join('   ') +
        '\n  → a 17 ft spread. NO single segment reconciles the eight; see the ratio test.\n',
    );

    // The finding itself, asserted so it cannot rot into a silent assumption.
    const spread = Math.max(...required.map((r) => r.L)) - Math.min(...required.map((r) => r.L));
    expect(spread).toBeGreaterThan(10);
    // The three rows whose own tilt and break columns agree with each other
    // (ff, si, ch — see pitches.test.ts's tilt−pub column) independently land on
    // the adopted segment. That agreement is the evidence for 50 ft, and it is
    // the thing that would break first if the aero core drifted.
    const near50 = required.filter((r) => ['ff', 'si', 'ch'].includes(r.id));
    for (const r of near50) expect(Math.abs(r.L - BREAK_SEGMENT_FT)).toBeLessThan(1.5);
  });

  it('⚠ STRUCTURE: the segment sets the SCALE only — break ratios are C_L ratios', () => {
    // This is why no segment can fix the table, and it is the assertion that
    // makes a per-pitch fudge factor a test failure: over a common segment,
    //   Δ ≈ ½·a·t² = ½·(K·C_L·|v|²)·(L/|v|)² = ½·K·C_L·L²
    // so |v| cancels and Δ_i/Δ_j = C_L(S_i)/C_L(S_j) for ANY L. Add a per-pitch
    // multiplier anywhere and this comparison breaks by exactly that multiplier.
    const ff = pitchById('ff');
    const clFF = liftCoef(spinParamOf(ff));
    const rows: string[] = [];
    for (const L of [40, 50]) {
      const mFF = Math.hypot(...(Object.values(breakOf(ff, L)).slice(0, 2) as [number, number]));
      for (const p of PITCHES) {
        const m = breakOf(p, L);
        const modelRatio = Math.hypot(m.ivbIn, m.hbIn) / mFF;
        const clRatio = liftCoef(spinParamOf(p)) / clFF;
        const pubRatio = Math.hypot(p.ivbIn, p.hbIn) / Math.hypot(ff.ivbIn, ff.hbIn);
        rows.push(
          `  L=${L}  ${pad(p.id, 3)}  S=${f(spinParamOf(p), 6, 3)}  C_L=${f(
            liftCoef(spinParamOf(p)),
            6,
            3,
          )}  model/ff=${f(modelRatio, 6, 3)}  C_L/C_L(ff)=${f(clRatio, 6, 3)}  published/ff=${f(
            pubRatio,
            6,
            3,
          )}  published÷C_L=${f(pubRatio / clRatio, 6, 2)}`,
        );
        if (p.id !== 'ff') {
          // The model obeys the ½·K·C_L·L² law to ~2 % at both lengths, and the
          // agreement is INDEPENDENT of L — that independence is the proof that
          // the segment cannot change the relative pattern.
          expect(Math.abs(modelRatio / clRatio - 1)).toBeLessThan(0.05);
        }
      }
      rows.push('');
    }
    // eslint-disable-next-line no-console
    console.log(
      '\n[RATIO STRUCTURE — break ratios vs C_L ratios, normalised to the four-seamer]\n' +
        rows.join('\n') +
        '  published÷C_L is the residual the segment CANNOT touch: 1.00 means the row\n' +
        '  is consistent with the rest of the table, 0.47 (cutter) means its published\n' +
        '  break is less than half what its own spin columns demand.\n',
    );

    // The cutter is the extreme case and it is a DATA problem, not a physics
    // one: 2400 rpm at 75 % efficiency is MORE effective spin than the
    // four-seamer's 2300 at 93 %, at a lower speed (so more flight time), yet
    // its published break is 44 % of the four-seamer's. No C_L, no segment and
    // no air can produce that; only a lower spin efficiency (~0.24) or
    // unmodelled seam-shifted wake can.
    const fc = pitchById('fc');
    const clRatioFC = liftCoef(spinParamOf(fc)) / clFF;
    const pubRatioFC = Math.hypot(fc.ivbIn, fc.hbIn) / Math.hypot(ff.ivbIn, ff.hbIn);
    expect(clRatioFC).toBeGreaterThan(0.9);
    expect(pubRatioFC).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// The dynamics table
// ---------------------------------------------------------------------------

describe('the arsenal in flight', () => {
  it('prints the dynamics table and holds the published plate-speed loss', () => {
    const rows: string[] = [];
    for (const p of PITCHES) {
      const r = simulatePitch({ pitch: p, hand: 'R' });
      const b = breakOf(p);
      const pub = publishedBreak(p, 'R');
      rows.push(
        [
          pad(p.id, 4),
          f(r.releaseSpeedMph, 8, 1),
          f(r.plate.speedMph, 8, 1),
          f(r.plate.speedMph / r.releaseSpeedMph, 8, 3),
          f(r.flightTimeS, 8, 3),
          f(r.plate.x, 8, 3),
          f(r.plate.h, 8, 3),
          f(b.ivbIn, 9, 1),
          f(pub.ivbIn, 6, 1),
          f(b.ivbIn - pub.ivbIn, 7, 1),
          f(b.hbArmSideIn, 9, 1),
          f(p.hbIn, 6, 1),
          f(b.hbArmSideIn - p.hbIn, 7, 1),
        ].join(''),
      );

      // Published: a pitch arrives at 91–93 % of its release speed. This is the
      // drag calibration re-measured through the whole pitch pipeline rather
      // than on stage 1's bare bench — if C_D or K ever drifts, it lands here.
      const ratio = r.plate.speedMph / r.releaseSpeedMph;
      expect(ratio).toBeGreaterThan(0.91);
      expect(ratio).toBeLessThan(0.93);
      // A pitch is between 0.38 and 0.50 s of flight — the reaction-time budget
      // the whole timing game is built on.
      expect(r.flightTimeS).toBeGreaterThan(0.38);
      expect(r.flightTimeS).toBeLessThan(0.5);
      // The aim solve lands on the target, not near it.
      expect(r.aimResidualFt).toBeLessThan(1e-6);
      expect(r.plate.x).toBeCloseTo(ZONE_CENTER.x, 6);
      expect(r.plate.h).toBeCloseTo(ZONE_CENTER.h, 6);
      expect(r.plate.strike).toBe(true);
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[DYNAMICS — RHP, aimed at the middle of the zone, ${GAME_AIR.tempF} °F/${(
        GAME_AIR.rh * 100
      ).toFixed(0)} % RH; break measured in ISA air over ${BREAK_SEGMENT_FT} ft]\n` +
        '  id  release   plate   ratio  flight   plate_x plate_h      IVB   pub      Δ       HB   pub      Δ\n' +
        rows.join('\n') +
        '\n  HB is on the PUBLISHED convention (+ = arm side). Δ = model − published.\n',
    );
  });

  it('the four-seamer reaches its published break with nothing fitted to it', () => {
    // The most-measured pitch in baseball, and the one with the least
    // seam-shifted wake, on a segment nominated from outside this data set.
    // Nothing in the model was tuned to this row.
    const b = breakOf(pitchById('ff'));
    expect(b.ivbIn).toBeCloseTo(16.0, 0); // published 16.0
    expect(Math.abs(b.ivbIn - 16.0)).toBeLessThan(1.0);
    expect(Math.abs(b.hbArmSideIn - 7.0)).toBeLessThan(1.0);
    // The sinker, the other row whose columns are self-consistent, inside 2 in.
    const si = breakOf(pitchById('si'));
    expect(Math.abs(si.ivbIn - 8.5)).toBeLessThan(2.0);
    expect(Math.abs(si.hbArmSideIn - 15.0)).toBeLessThan(2.0);
  });

  it('⚠ GOLDEN: the five resisting rows are pinned to the MODEL, not to the table', () => {
    // These are NOT published values. They are what this physics produces, to
    // 0.1 in, so that any future drift fails loudly — while the published
    // number and the residual sit right beside them as a standing reminder of
    // what is not yet explained. Closing these gaps means better spin/efficiency
    // DATA or a seam-shifted-wake model, never a coefficient nudge.
    //              model IVB  model HB(arm)   published (IVB, HB)   why it resists
    const golden: Array<[string, number, number, string]> = [
      ['fc', 15.249, -6.523, 'pub (7.5, −2.0): break 0.44× the ff, its own C_L 0.94× — 2.1× out'],
      ['sl', 3.675, -13.168, 'pub (0.5, −8.0): gyro-heavy, 0.46× vs C_L 0.76× — 1.6× out'],
      ['st', 0.284, -20.767, 'pub (−1.5, −17.0): the closest of the five, 0.98× vs C_L 1.16×'],
      ['cu', -19.584, -6.094, 'pub (−12.0, −6.0): 0.77× vs C_L 1.16× — 1.5× out, direction right'],
      ['fs', 10.034, 7.325, 'pub (2.0, 9.0): its tilt and break columns disagree by 40° — SSW'],
    ];
    for (const [id, ivb, hb] of golden) {
      const b = breakOf(pitchById(id as Pitch['id']));
      expect(b.ivbIn).toBeCloseTo(ivb, 2);
      expect(b.hbArmSideIn).toBeCloseTo(hb, 2);
    }
  });

  it('ordering: the fastball rises, the curve sinks, the sweeper out-sweeps the slider', () => {
    const ivb = (id: string) => breakOf(pitchById(id as Pitch['id'])).ivbIn;
    const hb = (id: string) => breakOf(pitchById(id as Pitch['id'])).hbArmSideIn;
    // The shape of the arsenal — true in the model AND in the published table,
    // so these hold whatever the segment or the residuals do.
    expect(ivb('cu')).toBeLessThan(0);
    expect(0).toBeLessThan(ivb('ff'));
    expect(ivb('ff')).toBeGreaterThan(ivb('si')); // four-seam carries, sinker does not
    expect(hb('si')).toBeGreaterThan(hb('ff')); // the sinker runs
    expect(hb('st')).toBeLessThan(hb('sl')); // the sweeper sweeps past the slider
    expect(hb('sl')).toBeLessThan(0); // both break to the glove side
    expect(hb('fc')).toBeLessThan(hb('ff')); // the cutter cuts against the arm side
  });

  it('⚠ a pure gyro pitch barely breaks, and what is left is honest', () => {
    // activeSpin 0 puts the whole 2400 rpm along the direction of travel at
    // RELEASE, where ω̂ × v vanishes. The axis is then fixed in space while v is
    // not: gravity rotates the velocity ~6° down over the flight, so by the
    // plate the axis is no longer parallel and a genuinely perpendicular sliver
    // of spin has appeared. That sliver is real physics — real gyro sliders do
    // drift slightly to the glove side — and it grows with the measured segment
    // exactly as it should: 0.14 in over the last 10 ft, 1.44 in over 50 ft.
    //
    // ⚠ SO THIS IS 1.44 in, NOT THE < 1 in THE BRIEF EXPECTED. The difference is
    // the 50 ft segment, not a leak in the gyro projection — stage 1's
    // superposition test already pins that to 5e-15 ft/s², and the 10 ft figure
    // below is what a leak would inflate. Widening the bound and saying why beats
    // shortening the segment to make a round number.
    const gyro = { ...pitchById('sl'), activeSpin: 0, spinRpm: 2400 };
    const b = breakOf(gyro);
    const near = breakOf(gyro, 10);
    // eslint-disable-next-line no-console
    console.log(
      `\n[PURE GYRO — 2400 rpm entirely along v̂ at release]\n` +
        `  over ${BREAK_SEGMENT_FT} ft: IVB ${b.ivbIn.toFixed(4)} in, HB ${b.hbIn.toFixed(
          4,
        )} in (toward the glove side)\n` +
        `  over 10 ft: IVB ${near.ivbIn.toFixed(4)} in, HB ${near.hbIn.toFixed(4)} in\n`,
    );
    expect(Math.abs(b.ivbIn) + Math.abs(b.hbIn)).toBeLessThan(2);
    expect(Math.abs(near.ivbIn) + Math.abs(near.hbIn)).toBeLessThan(0.25);
    // And it is not trivially zero because nothing is moving: the same row at
    // full efficiency breaks fifteen times as much.
    const spun = breakOf({ ...gyro, activeSpin: 1 });
    expect(Math.hypot(spun.ivbIn, spun.hbIn)).toBeGreaterThan(20);
    expect(Math.hypot(spun.ivbIn, spun.hbIn)).toBeGreaterThan(
      13 * Math.hypot(b.ivbIn, b.hbIn),
    );
  });

  it('break scales with the spin rate and with the air, and both through K', () => {
    const ff = pitchById('ff');
    const half = breakOf({ ...ff, spinRpm: ff.spinRpm / 2 });
    const full = breakOf(ff);
    // Not exactly half: C_L = 0.09 + 0.6·S is affine, so halving S more than
    // halves nothing — it lands at (0.09 + 0.3S)/(0.09 + 0.6S) of the lift.
    expect(half.ivbIn / full.ivbIn).toBeGreaterThan(0.4);
    expect(half.ivbIn / full.ivbIn).toBeLessThan(0.75);
    // A mile of altitude thins the air by ~17.5 % and takes the break with it —
    // the ONLY channel is K, so this is also a guard on nobody hand-setting K.
    const denver = measureBreak({ pitch: ff, hand: 'R', air: { elevFt: 5280, tempF: 59, rh: 0 } });
    expect(denver.ivbIn).toBeLessThan(full.ivbIn * 0.87);
    expect(denver.ivbIn).toBeGreaterThan(full.ivbIn * 0.78);
  });
});

// ---------------------------------------------------------------------------
// Determinism, the track, and the tempo quarantine
// ---------------------------------------------------------------------------

describe('the track', () => {
  it('is sampled at exactly FIXED_DT and ends on the analytic plate crossing', () => {
    const r = simulatePitch({ pitch: pitchById('ff'), hand: 'R' });
    const { track } = r;
    const n = track.t.length;

    // Parallel arrays only mean anything if they stay parallel.
    expect(track.d).toHaveLength(n);
    expect(track.x).toHaveLength(n);
    expect(track.h).toHaveLength(n);
    const at = (i: number) => ({
      t: track.t[i] ?? Number.NaN,
      d: track.d[i] ?? Number.NaN,
      x: track.x[i] ?? Number.NaN,
      h: track.h[i] ?? Number.NaN,
    });

    // Every whole substep is exactly FIXED_DT apart; only the last sample — the
    // interpolated crossing — is a partial step. Snapping the crossing to a
    // substep boundary instead would show up here AND in the miss below.
    for (let i = 1; i < n - 1; i++) expect(at(i).t - at(i - 1).t).toBeCloseTo(FIXED_DT, 12);
    const lastGap = at(n - 1).t - at(n - 2).t;
    expect(lastGap).toBeGreaterThan(0);
    expect(lastGap).toBeLessThanOrEqual(FIXED_DT + 1e-12);

    // The track starts at the release point and ends EXACTLY on the plate.
    expect(at(0).d).toBeCloseTo(RELEASE_D_FT, 12);
    expect(at(n - 1).d).toBeCloseTo(0, 12);
    expect(at(n - 1).t).toBeCloseTo(r.plate.t, 12);
    expect(at(n - 1).x).toBeCloseTo(r.plate.x, 12);
    expect(at(n - 1).h).toBeCloseTo(r.plate.h, 12);

    // The substep the ball crossed IN would have snapped the call by this much:
    const snapMissIn = Math.abs(at(n - 2).h - r.plate.h) * FT_TO_IN;
    // eslint-disable-next-line no-console
    console.log(
      `\n[TRACK] ${n} samples, ${(at(n - 1).t * 1000).toFixed(1)} ms of flight, ` +
        `${(1.0 / FIXED_DT).toFixed(0)} Hz. Snapping to the last whole substep instead of ` +
        `interpolating would move the called height by ${snapMissIn.toFixed(2)} in.\n`,
    );
    expect(snapMissIn).toBeGreaterThan(0.01); // interpolation is doing real work

    // sampleTrack agrees with the analytic crossing at the crossing instant,
    // and with the raw array at every sample.
    const crossing = sampleTrack(track, r.plate.t);
    expect(crossing.x).toBeCloseTo(r.plate.x, 12);
    expect(crossing.h).toBeCloseTo(r.plate.h, 12);
    for (let i = 0; i < n; i++) {
      const s = sampleTrack(track, at(i).t);
      expect(s.h).toBeCloseTo(at(i).h, 9);
      expect(s.d).toBeCloseTo(at(i).d, 9);
    }
    // Clamped outside the flight, never extrapolated into fantasy.
    expect(sampleTrack(track, -5).d).toBeCloseTo(RELEASE_D_FT, 12);
    expect(sampleTrack(track, 99).d).toBeCloseTo(0, 12);
  });

  it('is deterministic: the same pitch twice is byte-identical', () => {
    for (const p of PITCHES) {
      const a = simulatePitch({ pitch: p, hand: 'R', target: { x: -0.4, h: 2.1 } });
      const b = simulatePitch({ pitch: p, hand: 'R', target: { x: -0.4, h: 2.1 } });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
    // And a LHP's pitch is the exact lateral mirror of a RHP's — same physics,
    // no second code path.
    const rhp = simulatePitch({ pitch: pitchById('sl'), hand: 'R', target: { x: 0.3, h: 2.5 } });
    const lhp = simulatePitch({ pitch: pitchById('sl'), hand: 'L', target: { x: -0.3, h: 2.5 } });
    expect(lhp.plate.h).toBeCloseTo(rhp.plate.h, 9);
    expect(lhp.plate.x).toBeCloseTo(-rhp.plate.x, 9);
    // ⚠ ω is AXIAL, so the mirror is not "negate y". Reflecting the lateral axis
    // leaves the component ALONG that axis alone (the backspin that makes IVB)
    // and flips the two perpendicular to it (the sidespin that makes HB, and the
    // gyro sense — a mirrored right-handed screw is a left-handed one). Writing
    // this test as a naive negation is how a LHP ends up with a fastball that
    // rises for the wrong reason.
    expect(lhp.omega.y).toBeCloseTo(rhp.omega.y, 9);
    expect(lhp.omega.z).toBeCloseTo(-rhp.omega.z, 9);
    expect(lhp.omega.x).toBeCloseTo(-rhp.omega.x, 9);
    expect(vLen(lhp.omega)).toBeCloseTo(vLen(rhp.omega), 9);
    // The break mirrors with it: same IVB, opposite HB in the world frame, and
    // IDENTICAL on the published arm-side convention, which is what that
    // convention exists for.
    const bR = measureBreak({ pitch: pitchById('sl'), hand: 'R', air: BREAK_REF_AIR });
    const bL = measureBreak({ pitch: pitchById('sl'), hand: 'L', air: BREAK_REF_AIR });
    expect(bL.ivbIn).toBeCloseTo(bR.ivbIn, 6);
    expect(bL.hbIn).toBeCloseTo(-bR.hbIn, 6);
    expect(bL.hbArmSideIn).toBeCloseTo(bR.hbArmSideIn, 6);
  });

  it('⚠ PITCH_TEMPO cannot reach the physics — the source may not mention it', async () => {
    // The architectural guard, enforced the only way that survives a refactor:
    // by reading the file. Slow motion belongs to the render layer; if it ever
    // reaches dt, gravity (linear in dt) and the aero terms (quadratic in |v|)
    // are re-weighted against each other and every break number above drifts
    // silently. A HUD that wants slow motion scales the CLOCK it feeds
    // sampleTrack, which is why sampleTrack takes a time and not a frame index.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./pitchSim.ts', import.meta.url), 'utf8');
    // Comments are allowed to NAME it — that is how the rule stays visible. Code
    // is not, so strip comment lines and block-comment bodies before looking.
    const code = src
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/PITCH_TEMPO/);
    expect(code).not.toMatch(/Math\.random|Date\.now|performance\./);
  });

  it('a pitch aimed at a corner is a strike; a pitch off the plate is not', () => {
    const corner = simulatePitch({ pitch: pitchById('sl'), hand: 'R', target: { x: 0.68, h: 1.75 } });
    expect(corner.plate.strike).toBe(true);
    const ballFour = simulatePitch({ pitch: pitchById('sl'), hand: 'R', target: { x: 1.2, h: 1.75 } });
    expect(ballFour.plate.strike).toBe(false);
    // The aim solve holds at the corners too — it is the same solve.
    expect(corner.aimResidualFt).toBeLessThan(1e-6);
    expect(ballFour.aimResidualFt).toBeLessThan(1e-6);
  });
});
