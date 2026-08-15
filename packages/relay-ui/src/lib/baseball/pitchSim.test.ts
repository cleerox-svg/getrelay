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
//
// AND THE SHAPE OF C_L CANNOT RESCUE IT EITHER — the argument that closes that
// loophole is asserted too, and it needs no C_L: the published table contains a
// spin/break INVERSION (the cutter has a higher spin parameter than the changeup
// and half its published break), which no monotone C_L can produce. So: C_D and
// C_L were NOT touched, no per-pitch correction was added, and the SEVEN rows
// that resist are pinned to the MODEL's own numbers with their published values
// recorded beside them as residuals. Exactly one row — the four-seamer — lands
// on its published pair, and only that row is asserted against published.
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
// Added after the stage-2 adversarial review, same discipline (applied to the
// shipping source, whole suite run, reverted):
//   8. the cutter's activeSpin "repaired" 0.75 → 0.2418 — the efficiency its own
//      published break implies — 3 tests: the C_L-free inversion, the ratio
//      structure and the goldens. That the inversion test dies here is the
//      point: it asserts a property of the DATA and must stop passing the moment
//      the data stops having it.
//   9. the slider's tilt 9:30 → 9:00 again, now 2 tests rather than 1 — the
//      goldens AND the break-direction test, which catches it on merit (14.81°
//      of separation collapsing to 0.94°). Note a tiltVsPublishedDeg bound would
//      NOT: the mutation IMPROVES the slider's agreement, −11.4° → +3.6°.
//  10. the changeup's tilt 1:30 → 1:00 — 1 test, its new golden pin. Run again
//      with that one golden row commented out: 49 passed, 0 failed. An unpinned
//      row is an unguarded row, which is exactly why ch is now pinned.
//  11. a per-pitch, per-SEGMENT fudge inside measureBreak (the slider only,
//      0.4 %/ft) — 1 test, and specifically the |ratio(40 ft) − ratio(50 ft)|
//      line, at 0.0213 against a bound of 0.02. The ratio-law residual bound did
//      NOT catch it. That is why both assertions exist and why the second one is
//      the one the "scale, never shape" argument actually rests on.
//  12. PITCH_TEMPO imported by airPhysics.ts — 1 test, the widened tempo guard.
//      The old version of that guard read pitchSim.ts alone and passed this.
//  13. `import { Vector3 } from 'three'` added to zone.ts — 1 test (budget), the
//      leak that would silently pull the renderer into the main entry chunk.
//  14. budget.test.ts's own LIB_CAP dropped 500 → 400 — 1 test, proving the cap
//      is measured against real files rather than a list nobody updates.

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
  measureBreak({ pitch: p, hand: 'R' }, segmentFt, BREAK_REF_AIR);

/** Spin parameter S of a row, from its own published columns. */
const spinParamOf = (p: Pitch) =>
  (BALL_RADIUS_FT * p.spinRpm * p.activeSpin * RPM_TO_RADS) / (p.veloMph * MPH_TO_FPS);

// The four-seamer is the normaliser for every ratio below: it is the row the
// segment was fitted against and the only one that lands on its published pair.
const FF = pitchById('ff');
/** C_L implied by a row's own spin columns, relative to the four-seamer's. */
const clRatioOf = (p: Pitch) => liftCoef(spinParamOf(p)) / liftCoef(spinParamOf(FF));
/** PUBLISHED break magnitude of a row, relative to the four-seamer's. */
const pubRatioOf = (p: Pitch) => Math.hypot(p.ivbIn, p.hbIn) / Math.hypot(FF.ivbIn, FF.hbIn);

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

    // ⚠ THE EVIDENCE FOR 50 ft IS ONE ROW, NOT THREE. The four-seamer — the
    // best-measured pitch in baseball, and the only row whose tilt and break
    // columns agree to better than 5° (1.1°) — independently requires 49.8 ft,
    // against a plane nominated from outside this data set. That, plus the
    // external nomination, is the whole case.
    const ffRequired = required.find((r) => r.id === 'ff');
    expect(Math.abs((ffRequired?.L ?? 0) - BREAK_SEGMENT_FT)).toBeLessThan(1.5);

    // The sinker (51.1) and changeup (50.8) land there too, and that is worth
    // asserting as a CONSISTENCY check — but it is NOT further evidence, and an
    // earlier draft of this file claimed it was. Two reasons it is not:
    //   • The bisection above matches break MAGNITUDE only; it never looks at
    //     direction. So "requires ~50 ft" and "published ÷ C_L ≈ 1" are the same
    //     statement, and that ratio is defined RELATIVE TO the four-seamer. They
    //     restate the ff constraint rather than adding to it.
    //   • The changeup is not a self-consistent row at all: 22.5° between its
    //     tilt and its published break, the second worst in the table after the
    //     splitter's 40°. pitches.test.ts names it as such, and this file used to
    //     name it as an example of the opposite.
    const consistentWithFF = required.filter((r) => ['si', 'ch'].includes(r.id));
    for (const r of consistentWithFF) expect(Math.abs(r.L - BREAK_SEGMENT_FT)).toBeLessThan(1.5);
  });

  it('⚠ STRUCTURE: the segment sets the SCALE only — break ratios are C_L ratios', () => {
    // This is why no segment can fix the table, and it is the assertion that
    // makes a per-pitch fudge factor a test failure: over a common segment,
    //   Δ ≈ ½·a·t² = ½·(K·C_L·|v|²)·(L/|v|)² = ½·K·C_L·L²
    // so |v| cancels and Δ_i/Δ_j = C_L(S_i)/C_L(S_j) for ANY L. Add a per-pitch
    // multiplier anywhere and this comparison breaks by exactly that multiplier.
    const ff = FF;
    const mag = (b: { ivbIn: number; hbIn: number }) => Math.hypot(b.ivbIn, b.hbIn);
    /** Model break magnitude relative to the four-seamer's, at segment L. */
    const modelRatioAt = (p: Pitch, L: number) => mag(breakOf(p, L)) / mag(breakOf(ff, L));

    const rows: string[] = [];
    for (const L of [40, 50]) {
      for (const p of PITCHES) {
        rows.push(
          `  L=${L}  ${pad(p.id, 3)}  S=${f(spinParamOf(p), 6, 3)}  C_L=${f(
            liftCoef(spinParamOf(p)),
            6,
            3,
          )}  model/ff=${f(modelRatioAt(p, L), 6, 3)}  C_L/C_L(ff)=${f(
            clRatioOf(p),
            6,
            3,
          )}  published/ff=${f(pubRatioOf(p), 6, 3)}  published÷C_L=${f(
            pubRatioOf(p) / clRatioOf(p),
            6,
            2,
          )}`,
        );
      }
      rows.push('');
    }

    // ⚠ HOW WELL THE MODEL OBEYS THE LAW, AND HOW THAT VARIES WITH L. An earlier
    // draft claimed "~2 %, and INDEPENDENT of L" on the strength of a loop that
    // only ever ran L ∈ {40, 50}. Both halves were wrong. Measured worst-case
    // |model/ff ÷ C_L/C_L(ff) − 1| (always the slider, the most gyro-heavy row):
    //   L=20 → 7.1 %,  L=30 → 5.7 %,  L=40 → 4.3 %,  L=50 → 2.9 %,  L=54 → 2.4 %.
    // It is monotone in L, and for a reason: the prediction evaluates C_L at the
    // RELEASE spin parameter, while the real S climbs through the flight as |v|
    // decays. A SHORT segment measures only the last, slowest feet — where the
    // true C_L has drifted furthest from the release value — so the shorter the
    // segment the worse the agreement, and the effect is largest on the pitch
    // whose C_L is furthest down the fit (the slider). 8 % bounds the sweep with
    // room; it is a statement about the approximation, not a tolerance on the
    // physics, which is why the assertion that follows is the load-bearing one.
    const lawRows: string[] = [];
    for (const L of [20, 30, 40, 50, 54]) {
      let worst = { id: '', dev: 0 };
      for (const p of PITCHES) {
        if (p.id === 'ff') continue;
        const dev = Math.abs(modelRatioAt(p, L) / clRatioOf(p) - 1);
        if (dev > worst.dev) worst = { id: p.id, dev };
        expect(dev, `ratio law broke at L=${L} on ${p.id}`).toBeLessThan(0.08);
      }
      lawRows.push(`  L=${pad(L, 2)}  worst |model/C_L − 1| = ${f(worst.dev * 100, 5, 2)} %  (${worst.id})`);
    }

    // And the claim the ARGUMENT actually needs is not the size of that residual
    // but the L-independence of the RATIO itself — that is what makes "the
    // segment sets scale, never shape" true. Assert it directly rather than
    // inferring it from two similar residuals: no pitch's break ratio moves by
    // more than 0.011 between a 40 ft and a 50 ft segment (worst: the sweeper).
    const drift: string[] = [];
    for (const p of PITCHES) {
      if (p.id === 'ff') continue;
      const d = Math.abs(modelRatioAt(p, 40) - modelRatioAt(p, 50));
      drift.push(`${p.id} ${d.toFixed(4)}`);
      expect(d, `${p.id}'s break ratio moved with the segment`).toBeLessThan(0.02);
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n[RATIO STRUCTURE — break ratios vs C_L ratios, normalised to the four-seamer]\n' +
        rows.join('\n') +
        '  published÷C_L is the residual the segment CANNOT touch: 1.00 means the row\n' +
        '  is consistent with the rest of the table, 0.47 (cutter) means its published\n' +
        '  break is less than half what its own spin columns demand.\n\n' +
        '  How closely the model tracks ½·K·C_L·L², swept — NOT independent of L:\n' +
        lawRows.join('\n') +
        '\n  |ratio(40 ft) − ratio(50 ft)| per pitch — THIS is what "scale, not shape" means:\n    ' +
        drift.join('   ') +
        '\n',
    );

    // The cutter is the extreme case, and it is a DATA problem rather than a
    // physics one. Note what is and is NOT true of it: at 2400 rpm × 75 %
    // efficiency it carries 1800 rpm of effective spin against the four-seamer's
    // 2300 × 93 % = 2139 — COMPARABLE, and slightly LOWER, which is also what its
    // spin parameter (0.175 vs 0.197) and its C_L (0.94× the ff's) say. It is
    // thrown slower, so it flies longer. And its published break is 44 % of the
    // four-seamer's. A 0.94× coefficient cannot produce a 0.44× break: that is
    // 2.1× out, and no C_L, no segment and no air closes it. Either its real
    // efficiency is ~0.24 (bisecting the model to its own published magnitude
    // gives 0.2418) or seam-shifted wake — absent from any spin-only model — is
    // cancelling most of its Magnus break.
    const fc = pitchById('fc');
    expect(fc.spinRpm * fc.activeSpin).toBeLessThan(ff.spinRpm * ff.activeSpin);
    expect(clRatioOf(fc)).toBeGreaterThan(0.9);
    expect(clRatioOf(fc)).toBeLessThan(1.0);
    expect(pubRatioOf(fc)).toBeLessThan(0.5);
  });

  it('⚠ C_L-FREE: the published table contains a spin/break INVERSION', () => {
    // The test that closes the loophole the ratio law above leaves open. Break
    // ratios ARE C_L ratios, so C_L(S)'s functional FORM is exactly the lever
    // that could change the pattern — and C_L's citation is flagged unverified,
    // so "the error is not in a coefficient" cannot be asserted by fiat. A merely
    // proportional C_L ∝ S, for instance, would move the slider's published÷C_L
    // from 0.61 to 0.81 and the splitter's from 0.74 to 1.05. The loophole is
    // real.
    //
    // What closes it uses no C_L at all — only that C_L is MONOTONE in S, which
    // airPhysics.test.ts asserts over 501 samples, and which is a physical
    // requirement rather than a fitting choice (a non-monotone C_L makes a
    // higher-spin pitch break less). Over a common segment Δ ∝ C_L, so monotone
    // C_L ⇒ a row with the higher S must break AT LEAST AS MUCH as one with a
    // lower S. The published table says otherwise, twice.
    const rows: string[] = [];
    const cmp = (hi: string, lo: string) => {
      const a = pitchById(hi as Pitch['id']);
      const b = pitchById(lo as Pitch['id']);
      rows.push(
        `  ${pad(a.id, 3)} S=${f(spinParamOf(a), 6, 4)} pub/ff=${f(pubRatioOf(a), 6, 3)}   vs   ` +
          `${pad(b.id, 3)} S=${f(spinParamOf(b), 6, 4)} pub/ff=${f(pubRatioOf(b), 6, 3)}   ` +
          `→ higher S, ${f((pubRatioOf(a) / pubRatioOf(b)) * 100, 5, 1)} % of the break`,
      );
      // Higher spin parameter…
      expect(spinParamOf(a), `${hi} should out-spin ${lo}`).toBeGreaterThan(spinParamOf(b));
      // …and yet LESS published break. Monotone C_L forbids the pair outright,
      // whatever the segment and whatever the fit.
      expect(pubRatioOf(a), `${hi} vs ${lo}: the inversion is gone`).toBeLessThan(pubRatioOf(b));
    };
    // The strong instance: the cutter out-spins the changeup and breaks half as
    // much. Factor 2.0 — an order of magnitude past the ratio law's own 2.9 %
    // residual at the adopted segment, so it cannot be a modelling artefact.
    cmp('fc', 'ch');
    // The milder second instance, on rows that share neither speed nor shape.
    cmp('cu', 'ff');
    // eslint-disable-next-line no-console
    console.log(
      '\n[SPIN/BREAK INVERSION — the C_L-free argument]\n' +
        rows.join('\n') +
        '\n  A monotone C_L(S) — asserted in airPhysics.test.ts — cannot give a HIGHER-S\n' +
        '  pitch LESS break over a common segment. So the residual is not in C_L’s shape,\n' +
        '  not in the segment, and not in the air: it is in the table’s own spin columns\n' +
        '  or in physics this model does not have.\n',
    );
    // The cutter's factor is the load-bearing one; state the size, not just the
    // sign, so "repairing" the data by halving the gap still fails here.
    expect(pubRatioOf(pitchById('fc')) / pubRatioOf(pitchById('ch'))).toBeLessThan(0.6);
  });
});

// ---------------------------------------------------------------------------
// The dynamics table
// ---------------------------------------------------------------------------

describe('the arsenal in flight', () => {
  it('prints the dynamics table and holds the published plate-speed loss', () => {
    const rows: string[] = [];
    const hbResiduals: number[] = [];
    for (const p of PITCHES) {
      const r = simulatePitch({ pitch: p, hand: 'R' });
      const b = breakOf(p);
      const pub = publishedBreak(p, 'R');
      hbResiduals.push(b.hbArmSideIn - p.hbIn);
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
        '\n  HB is on the PUBLISHED convention (+ = arm side). Δ = model − published.\n' +
        // ⚠ READ THIS LINE, it is the point of printing the table. Every one of
        // the eight ΔHB residuals is NEGATIVE — a systematic arm-side deficit
        // across the whole arsenal, mean −2.7 in, not a per-pitch story. An
        // earlier draft cited these signs as corroboration of seam-shifted wake;
        // they are not, because sl/st/fs share the sign with no SSW story to
        // tell. A uniform sign points at a MODEL or tilt-column bias, and that
        // is a more interesting open question than the one it replaced.
        `  ⚠ ALL EIGHT ΔHB are arm-side NEGATIVE (mean ${(
          hbResiduals.reduce((a, b) => a + b, 0) / hbResiduals.length
        ).toFixed(2)} in, range ${Math.min(...hbResiduals).toFixed(2)} … ${Math.max(
          ...hbResiduals,
        ).toFixed(2)}): a systematic deficit,\n  not a per-pitch one — unexplained, and NOT evidence about any single pitch.\n`,
    );
  });

  it('the four-seamer — the ONE row — reaches its published break with nothing fitted to it', () => {
    // The most-measured pitch in baseball, and the one with the least
    // seam-shifted wake, on a segment nominated from outside this data set.
    // Nothing in the model was tuned to this row. It is also the ONLY row
    // asserted against published values anywhere in this file; every other row
    // is golden-pinned below, with its published pair recorded as a residual.
    const b = breakOf(FF);
    expect(b.ivbIn).toBeCloseTo(16.0, 0); // published 16.0
    expect(Math.abs(b.ivbIn - 16.0)).toBeLessThan(1.0); // measured +0.31
    expect(Math.abs(b.hbArmSideIn - 7.0)).toBeLessThan(1.0); // measured −0.37
  });

  it('⚠ GOLDEN: the seven resisting rows are pinned to the MODEL, not to the table', () => {
    // These are NOT published values. They are what this physics produces —
    // pinned with toBeCloseTo(_, 2), i.e. to ±0.005 in, which is far tighter than
    // the "0.1 in" an earlier comment here advertised. The strict bound is
    // deliberate and stays: a golden pin's whole job is to fail on drift nobody
    // meant, and there is no measurement noise in a deterministic integrator to
    // leave room for. The published number and the residual sit right beside
    // each value as a standing reminder of what is not yet explained. Closing
    // these gaps means better spin/efficiency DATA or a seam-shifted-wake model,
    // never a coefficient nudge.
    //
    // ⚠ WHY THE SINKER IS HERE AND NOT IN THE PUBLISHED TEST ABOVE. It used to be
    // asserted against published at ±2.0 in with residuals of 1.64 and 1.94 —
    // a fifth of an inch of margin, which would read as a physics regression the
    // first time anything moved, when what it really encodes is "close-ish". The
    // sinker is a resisting row: 19 % out on IVB and 13 % on HB. Pinning it to
    // the model says that honestly AND catches more drift than a 3 % margin did.
    //
    // ⚠ AND WHY THE CHANGEUP IS HERE. It was in neither list — constrained only
    // by the sweep's |L − 50| < 1.5 magnitude line, despite a +4.87 in IVB
    // residual and the second-worst tilt/break disagreement in the table (22.5°).
    // An unpinned row is an unguarded row: moving its tilt 1:30 → 1:00 failed
    // nothing at all before this line existed.
    //              model IVB  model HB(arm)   published (IVB, HB)   why it resists
    const golden: Array<[string, number, number, string]> = [
      ['si', 10.143, 13.056, 'pub (8.5, 15.0): Δ +1.64 / −1.94; magnitude needs 51.1 ft'],
      ['fc', 15.249, -6.523, 'pub (7.5, −2.0): break 0.44× the ff, its own C_L 0.94× — 2.1× out'],
      ['sl', 3.675, -13.168, 'pub (0.5, −8.0): gyro-heavy, 0.46× vs C_L 0.76× — 1.6× out'],
      ['st', 0.284, -20.767, 'pub (−1.5, −17.0): the closest of the seven, 0.98× vs C_L 1.16×'],
      ['cu', -19.584, -6.094, 'pub (−12.0, −6.0): 0.77× vs C_L 1.16× — 1.5× out, direction right'],
      ['ch', 10.867, 10.594, 'pub (6.0, 14.5): Δ +4.87 / −3.91; tilt vs break 22.5° apart'],
      ['fs', 10.034, 7.325, 'pub (2.0, 9.0): its tilt and break columns disagree by 40° — SSW'],
    ];
    expect(golden).toHaveLength(PITCHES.length - 1); // every row but the ff
    for (const [id, ivb, hb] of golden) {
      const b = breakOf(pitchById(id as Pitch['id']));
      expect(b.ivbIn, `${id} IVB`).toBeCloseTo(ivb, 2);
      expect(b.hbArmSideIn, `${id} HB`).toBeCloseTo(hb, 2);
    }
  });

  it('⚠ the slider and the sweeper are different pitches, by break DIRECTION', () => {
    // A merit-based catch for the mutation that previously only the golden pins
    // saw: the slider's tilt shifted 9:30 → 9:00, i.e. made into a sweeper. The
    // ordering test misses it (a 9:00 slider still breaks glove-side, still less
    // than the sweeper), and — importantly — a bound on tiltVsPublishedDeg would
    // MISS it too, because the mutation IMPROVES the slider's agreement with its
    // own published columns (−11.4° → +3.6°). What separates them is the ANGLE of
    // the break vector, which is what the tilt clock actually sets: measured
    // sl −74.4°, st −89.2°, 14.8° apart. Under the mutation both land at −89°
    // and the separation collapses to 0.9°.
    const angleOf = (id: string) => {
      const b = breakOf(pitchById(id as Pitch['id']));
      return (Math.atan2(b.hbArmSideIn, b.ivbIn) * 180) / Math.PI;
    };
    const sep = Math.abs(angleOf('sl') - angleOf('st'));
    // eslint-disable-next-line no-console
    console.log(
      `\n[BREAK DIRECTION] sl ${angleOf('sl').toFixed(2)}°, st ${angleOf('st').toFixed(2)}° ` +
        `— ${sep.toFixed(2)}° apart (0° = straight up, −90° = pure glove side).\n`,
    );
    expect(sep).toBeGreaterThan(8);
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
    const denver = measureBreak({ pitch: ff, hand: 'R' }, BREAK_SEGMENT_FT, {
      elevFt: 5280,
      tempF: 59,
      rh: 0,
    });
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
    const bR = measureBreak({ pitch: pitchById('sl'), hand: 'R' }, BREAK_SEGMENT_FT, BREAK_REF_AIR);
    const bL = measureBreak({ pitch: pitchById('sl'), hand: 'L' }, BREAK_SEGMENT_FT, BREAK_REF_AIR);
    expect(bL.ivbIn).toBeCloseTo(bR.ivbIn, 6);
    expect(bL.hbIn).toBeCloseTo(-bR.hbIn, 6);
    expect(bL.hbArmSideIn).toBeCloseTo(bR.hbArmSideIn, 6);
  });

  it('⚠ PITCH_TEMPO cannot reach the physics — no sim source may mention it', async () => {
    // The architectural guard, enforced the only way that survives a refactor:
    // by reading the sources. Slow motion belongs to the render layer; if it ever
    // reaches dt, gravity (linear in dt) and the aero terms (quadratic in |v|)
    // are re-weighted against each other and every break number above drifts
    // silently. A HUD that wants slow motion scales the CLOCK it feeds
    // sampleTrack, which is why sampleTrack takes a time and not a frame index.
    //
    // ⚠ IT GLOBS THE DIRECTORY, and it did not always. Reading pitchSim.ts alone
    // was right when pitchSim.ts was the only file that integrated anything —
    // but airPhysics.ts now imports tuning.ts for the substep, so THE integrator
    // itself was outside the guard. determinism.test.ts globs for exactly this
    // reason; this one matches it rather than inventing a second scope.
    // (Math.random / Date.now / performance are NOT re-checked here —
    // determinism.test.ts owns that ban over the same directory AND the tests,
    // and "one implementation per concept" applies to guards too.)
    const { readdirSync, readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const dir = dirname(fileURLToPath(import.meta.url));
    const names = readdirSync(dir).filter(
      // tuning.ts DECLARES the knob, so it is the one exemption; tests may name
      // it in prose, and are covered by their own eyes rather than by this.
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts') && n !== 'tuning.ts',
    );
    // Guard the guard: a glob that stops matching must not pass over zero files.
    expect(names).toContain('pitchSim.ts');
    expect(names).toContain('airPhysics.ts');
    for (const name of names) {
      // Comments are allowed to NAME it — that is how the rule stays visible.
      // Code is not, so strip comment lines and block-comment bodies first.
      const code = readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join('\n');
      expect(code, `${name} reads PITCH_TEMPO`).not.toMatch(/PITCH_TEMPO/);
    }
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
