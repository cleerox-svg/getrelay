// The derby bench.
//
// `derbySim.ts` writes no physics, so this file does not re-assert any. What it
// asserts is the things a game loop can get wrong that a physics bench cannot
// see: that a seed replays, that the score cannot overflow the server's clamp,
// that the two player inputs reach the three geometric axes in the right places
// and with the right signs, and that snapshot/restore is total.
//
// ELEVEN MUTATIONS WERE WATCHED TO FAIL — each applied, the file's 19 tests run,
// then reverted. Observed failure counts, not predicted ones:
//
//   1. `homeRunPoints`'s Math.min cap deleted            → 2 fail
//   2. the reticle disc's residual measured from the
//      CENTRE instead of the rim (k = 1 always)          → 3 fail
//   3. `away` sign flipped (armSideX read un-negated)    → 1 fail
//   4. the contact test's tip bound removed              → 3 fail
//   5. the undercut overlap test removed                 → 1 fail
//   6. `SWING_UNDERCUT_IN` moved to stage 3's 0.75       → 5 fail
//   7. `roundScores` by reference in `snapshot()`        → 1 fail
//   8. `rngState` dropped from the snapshot              → 1 fail
//   9. the serve's weighted draw replaced by `MIX[0]`    → 1 fail
//  10. the per-pitch cap read from the CONSTANT rather
//      than from `cfg.pitchesPerRound`                   → 1 fail
//  11. `roundScores` by reference in `getState()`        → 1 fail
//
// SEVEN MORE WERE WATCHED TO FAIL when the reticle shoulder and the pull/oppo
// intent landed. Same discipline, observed counts, not predicted ones:
//
//  12. `reticleResidual` reverted to the hard 4 in disc  → 1 fail
//  13. the pull/oppo intent forced to zero               → 2 fail
//  14. the overlap test back to `|undercut|` alone,
//      not the resultant with the intent offset          → 1 fail
//  15. `last` by reference from `getState()`             → 1 fail
//  16. divisibility back to `perPitch * perRound`        → 1 fail
//  17. `resolveDerbyConfig` stops validating             → 1 fail
//  18. `tuning.MAX_ROUNDS` drifts from the worker's      → 1 fail, in
//      `tuning.test.ts`, which reads the WORKER's source text
//
// ⚠ THREE OF THOSE SURVIVED THE FIRST PASS, and all three were real gaps:
//   • (7) the dry run in the snapshot test never crossed a ROUND BOUNDARY, so
//     `roundScores` — the only array the snapshot copies — was never written
//     during it. The mutation was unobservable, not merely unobserved.
//   • (11) was found by accident: the mutation script's pattern matched
//     `getState()`'s identical line first, and THAT survived too. `getState`
//     hands the HUD a live reference to sim state under it. Now asserted.
//   • (10) the config-derived per-pitch cap: nothing overrode `pitchesPerRound`,
//     so reading the constant passed everything. Leg (2b) of the clamp test now
//     plays a 20-pitch round at 130 mph of bat speed.

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../golf/wind';
import { LOC_DISTANCE_IN, SWEET_SPOT_M } from './bat';
import { contactGeometry, swingContact } from './batSim';
import {
  BAT_HANDLE_LIMIT_M,
  BAT_TIP_M,
  DERBY_MIX,
  DERBY_ROUNDS,
  DISTANCE_DATUM_FT,
  HR_BASE_POINTS,
  MAX_POINTS_PER_PITCH,
  PITCHES_PER_ROUND,
  PULL_INTENT_MAX_IN,
  RETICLE_FADE_POWER,
  RETICLE_FULL_MISS_IN,
  SERVE_SPREAD,
  SWING_UNDERCUT_IN,
  derbyDraw,
  homeRunPoints,
  pullIntentOffsetIn,
  reticleResidual,
  validateDerbyFormat,
  validateDerbyMix,
} from './derbyRules';
import { DerbySim } from './derbySim';
import type { DerbySim as DerbySimType } from './derbySim';
import type { SwingResult } from './derbyState';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { MAX_POINTS_PER_ROUND, MAX_ROUNDS, isBarrel } from './tuning';

import { ZONE_CENTER, reticleToPlate } from './zone';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Play a whole derby with a scripted controller. Returns every swing. */
function playSession(
  sim: DerbySimType,
  control: (sim: DerbySimType, plateX: number, plateH: number, plateT: number) => void,
): SwingResult[] {
  const out: SwingResult[] = [];
  while (sim.getState().phase !== 'done') {
    const pr = sim.servePitch();
    control(sim, pr.plate.x, pr.plate.h, pr.plate.t);
    out.push(sim.last as SwingResult);
  }
  return out;
}

/** Reticle dead centre, tap exactly on the plate crossing. */
const centred = (s: DerbySimType, _x: number, _h: number, t: number) => {
  s.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
  s.swing(t);
};

/** Reticle exactly on the pitch, tap `offsetS` from the crossing. */
const perfect =
  (offsetS = 0) =>
  (s: DerbySimType, x: number, h: number, t: number) => {
    s.setReticle(x, h);
    s.swing(t + offsetS);
  };

const ownDataProps = (o: object) =>
  Object.keys(o)
    .filter((k) => typeof (o as Record<string, unknown>)[k] !== 'function')
    .sort();

const f = (v: number, w = 7, d = 2) => v.toFixed(d).padStart(w);

/**
 * `batSim.test.ts`'s reference pitch, reproduced exactly: 90 mph descending 8°
 * with 2200 rpm of backspin. Copied rather than exported so that this file
 * cannot quietly change stage 3's bench — if the two drift, the band assertion
 * below is what says so.
 */
const REF_PITCH = {
  v: { x: 90 * 1.466667 * Math.cos(-Math.PI / 22.5), y: 0, z: 90 * 1.466667 * Math.sin(-Math.PI / 22.5) },
  omega: { x: 0, y: -2200 * (Math.PI / 30), z: 0 },
};

// ---------------------------------------------------------------------------

describe('derby — format and the server clamp', () => {
  it('the format data validates, and one `rounds` unit is one DERBY ROUND', () => {
    expect(validateDerbyMix()).toEqual([]);
    expect(validateDerbyFormat()).toEqual([]);

    // ⚠ THE CLAMP IS `rounds × MAX_POINTS_PER_ROUND`, read from the mirrored
    // constants rather than from a literal, so a worker change that lands in
    // tuning.ts fails HERE instead of on the wire.
    expect(DERBY_ROUNDS).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(MAX_POINTS_PER_PITCH * PITCHES_PER_ROUND).toBe(MAX_POINTS_PER_ROUND);

    console.log(
      `\nFORMAT  ${DERBY_ROUNDS} rounds × ${PITCHES_PER_ROUND} pitches = ` +
        `${DERBY_ROUNDS * PITCHES_PER_ROUND} swings\n` +
        `        per-pitch cap ${MAX_POINTS_PER_PITCH} (= ${MAX_POINTS_PER_ROUND}/${PITCHES_PER_ROUND}, DERIVED)\n` +
        `        round ceiling ${MAX_POINTS_PER_ROUND}, session ceiling ` +
        `${DERBY_ROUNDS * MAX_POINTS_PER_ROUND} against the worker's rounds×2000\n` +
        `        payout = ${HR_BASE_POINTS} + max(0, carry − ${DISTANCE_DATUM_FT}) × 1, HR only`,
    );
  });

  it('⚠ the format validator BITES, and the config path actually calls it', () => {
    // ⚠ THE DIVISIBILITY CHECK COULD NOT FIRE. It was written as
    // `perPitch * perRound !== MAX_POINTS_PER_ROUND`, and (2000/3)*3 is exactly
    // 2000 in IEEE-754 — so 3, 6, 7 and 9 pitches all PASSED while producing a
    // fractional per-pitch cap, which the worker (`Number.isInteger`) would then
    // reject on the wire. Every one of these is now caught.
    for (const per of [3, 6, 7, 9, 11, 12, 13]) {
      expect(Number.isInteger(MAX_POINTS_PER_ROUND / per)).toBe(false);
      expect(validateDerbyFormat(DERBY_ROUNDS, per).length).toBeGreaterThan(0);
      // …and the arithmetic the old check used really does say they are fine:
      expect((MAX_POINTS_PER_ROUND / per) * per).toBe(MAX_POINTS_PER_ROUND);
    }
    for (const per of [1, 2, 4, 5, 8, 10, 16, 20]) {
      expect(validateDerbyFormat(DERBY_ROUNDS, per)).toEqual([]);
    }
    expect(validateDerbyFormat(0)).not.toEqual([]);
    expect(validateDerbyFormat(MAX_ROUNDS + 1)).not.toEqual([]);
    expect(validateDerbyFormat(2.5)).not.toEqual([]);

    // ⚠ AND `resolveDerbyConfig` NOW CALLS IT. It validated nothing, so
    // `new DerbySim({ rounds: -5 })` was accepted and `getState()` reported
    // `maxScore = -10000` — because `clamp(started, 1, -5)` returns the HIGH
    // bound when `lo > hi`. A config is player-adjacent input; it throws.
    for (const cfg of [
      { seed: 1, rounds: -5 },
      { seed: 1, rounds: 0 },
      { seed: 1, rounds: MAX_ROUNDS + 1 },
      { seed: 1, pitchesPerRound: 0 },
      { seed: 1, pitchesPerRound: 3 },
      { seed: 1, batSpeedMph: 0 },
      { seed: Number.NaN },
    ]) {
      expect(() => new DerbySim(cfg), JSON.stringify(cfg)).toThrow();
    }
    // The default and the legitimate overrides still build.
    expect(() => new DerbySim({ seed: 1 })).not.toThrow();
    expect(() => new DerbySim({ seed: 1, rounds: 1, pitchesPerRound: 20 })).not.toThrow();
  });

  it('⚠ no achievable input can put a round over MAX_POINTS_PER_ROUND', () => {
    // Three legs, and all three are needed because the first two are arithmetic
    // and the third is the only one that sees the wiring.
    //
    // (1) One swing can never pay more than the per-pitch cap — including at
    //     inputs no physics can reach.
    for (const carry of [0, 350, 400, 500, 1000, 1e9, Number.MAX_SAFE_INTEGER, Infinity]) {
      expect(homeRunPoints(carry)).toBeLessThanOrEqual(MAX_POINTS_PER_PITCH);
      expect(Number.isInteger(homeRunPoints(carry))).toBe(true);
    }
    // (2) The cap re-derives from the CONFIG, so an overridden pitch count
    //     cannot break the round ceiling either.
    for (const per of [1, 2, 4, 5, 8, 10, 20]) {
      expect(homeRunPoints(1e9, MAX_POINTS_PER_ROUND / per) * per).toBeLessThanOrEqual(
        MAX_POINTS_PER_ROUND,
      );
    }
    // (2b) …and through the SIM, not just the function. Without this leg the
    //      config-derived cap is unobservable: nothing else overrides the pitch
    //      count, so reading the constant instead would pass every other test.
    const wide = new DerbySim({ seed: 9, pitchesPerRound: 20, rounds: 1, batSpeedMph: 130 });
    while (wide.getState().phase !== 'done') {
      const pr = wide.servePitch();
      wide.setReticle(pr.plate.x + 0.45, pr.plate.h);
      wide.swing(pr.plate.t - 0.002);
      expect(wide.getState().roundScore).toBeLessThanOrEqual(MAX_POINTS_PER_ROUND);
    }
    expect(wide.getState().score).toBeLessThanOrEqual(MAX_POINTS_PER_ROUND);

    // (3) Play real sessions at absurd bat speeds — the only reachable dial that
    //     grows carry — and check the invariant after EVERY swing, partial
    //     rounds included, against the clamp the worker actually applies.
    const rows: string[] = [];
    for (const bat of [71.5, 80, 90, 105, 130]) {
      let worstRound = 0;
      let bestHr = 0;
      let hrs = 0;
      for (const seed of [1, 2, 3]) {
        const sim = new DerbySim({ seed, batSpeedMph: bat });
        while (sim.getState().phase !== 'done') {
          const pr = sim.servePitch();
          // Aim for the fences: reticle a shade inside, tap a shade early.
          sim.setReticle(pr.plate.x + 0.45, pr.plate.h);
          const r = sim.swing(pr.plate.t - 0.002);
          const st = sim.getState();
          expect(st.roundScore).toBeLessThanOrEqual(MAX_POINTS_PER_ROUND);
          expect(st.score).toBeLessThanOrEqual(st.roundsPlayed * MAX_POINTS_PER_ROUND);
          worstRound = Math.max(worstRound, st.roundScore, ...st.roundScores);
          if (r.outcome === 'homeRun') {
            hrs++;
            bestHr = Math.max(bestHr, r.distFt);
          }
        }
      }
      rows.push(
        `  bat ${f(bat, 5, 1)} mph | best HR ${f(bestHr, 6, 1)} ft | ${String(hrs).padStart(2)} HR ` +
          `| worst round ${String(worstRound).padStart(4)} / ${MAX_POINTS_PER_ROUND} ` +
          `(${f((100 * (MAX_POINTS_PER_ROUND - worstRound)) / MAX_POINTS_PER_ROUND, 5, 1)} % headroom)`,
      );
    }
    console.log(
      '\nCLAMP HEADROOM — a maximum-effort session at each bat speed\n' + rows.join('\n'),
    );
  });
});

describe('derby — determinism', () => {
  it('the same seed replays a byte-identical session', () => {
    const a = playSession(new DerbySim({ seed: 4242 }), centred);
    const b = playSession(new DerbySim({ seed: 4242 }), centred);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const sa = new DerbySim({ seed: 4242 });
    const sb = new DerbySim({ seed: 4242 });
    playSession(sa, centred);
    playSession(sb, centred);
    expect(JSON.stringify(sa.getState())).toBe(JSON.stringify(sb.getState()));

    // …and a DIFFERENT seed does not. Without this the test above passes on a
    // sim that ignores its seed entirely.
    const c = playSession(new DerbySim({ seed: 4243 }), centred);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it('⚠ TRIPWIRE: the snapshottable stream is golf `mulberry32`, exactly', () => {
    // derbySim carries the PRNG as a plain number so that snapshot() can be
    // total. That rests on mulberry32's state being `seed + k·STEP`. If golf
    // changes its mixer or its step, this fails here rather than silently
    // re-shaping every derby session.
    const gen = mulberry32(9001);
    let state = 9001;
    for (let i = 0; i < 6; i++) {
      const step = derbyDraw(state);
      expect(step.value).toBe(gen());
      state = step.next;
    }
    // And it is a real generator, not a constant.
    expect(new Set([0, 1, 2, 3, 4].map((s) => derbyDraw(s).value)).size).toBe(5);
  });

  it('snapshot/restore is TOTAL — every own data prop, byte-identical after a dry run', () => {
    const sim = new DerbySim({ seed: 77 });
    sim.servePitch();
    sim.setReticle(0.1, 2.6);
    sim.swing(0.41);

    // ⚠ RULE: the pair must cover every own data property. A field left out is a
    // preview that leaks into the live session.
    expect(Object.keys(sim.snapshot()).sort()).toEqual(ownDataProps(sim));

    // getState() hands out a COPY of the only mutable array it exposes. Found by
    // a mutation that hit this line instead of snapshot()'s identical one and
    // survived all 19 tests: a HUD that sorted `roundScores` would have been
    // editing sim state.
    sim.getState().roundScores.push(1234);
    expect(sim.getState().roundScores).toEqual([]);

    // ⚠ AND `last` IS A COPY TOO. It was a live reference: `resolveSwing` builds
    // a fresh literal each call and never mutates it, so it was benign — but it
    // is a MUTABLE-TYPED field on a public readout handed to a HUD, and
    // `roundScores` above is the proof that "benign today" is not an argument
    // (that mutation survived all 19 tests until this line existed). Now nothing
    // `getState` returns aliases sim state, with no exception to remember.
    const leaked = sim.getState().last as SwingResult;
    expect(leaked).not.toBeNull();
    leaked.evMph = -999;
    leaked.outcome = 'take';
    expect(sim.getState().last?.evMph).not.toBe(-999);
    expect(sim.getState().last).not.toBe(sim.getState().last);
    expect(sim.getState().last).toEqual(sim.snapshot().last);
    // …and the snapshot's copy is independent of the live one as well.
    const snapLeak = sim.snapshot();
    (snapLeak.last as SwingResult).distFt = -1;
    expect(sim.getState().last?.distFt).not.toBe(-1);

    // ⚠ THE DRY RUN MUST CROSS A ROUND BOUNDARY. It did not at first, and the
    // mutation that copies `roundScores` BY REFERENCE survived all 19 tests: the
    // array is only ever written when a round closes, so a shorter dry run never
    // touched it. This is the "two mechanisms, one untested" shape stage 4 hit.
    while (sim.getState().pitchesThrown < PITCHES_PER_ROUND - 1) {
      const pr = sim.servePitch();
      sim.setReticle(pr.plate.x, pr.plate.h);
      sim.swing(pr.plate.t);
    }
    sim.servePitch();
    const before = JSON.stringify(sim);
    const snap = sim.snapshot();

    const dryRun = () => {
      sim.setReticle(-0.6, 1.9);
      sim.swing(0.3); // closes round 1
      for (let i = 0; i < 3; i++) {
        const pr = sim.servePitch();
        sim.setReticle(pr.plate.x, pr.plate.h - 0.2);
        sim.swing(pr.plate.t + 0.004);
      }
      expect(sim.getState().roundScores.length).toBe(1);
    };

    dryRun();
    expect(JSON.stringify(sim)).not.toBe(before);
    sim.restore(snap);
    expect(JSON.stringify(sim)).toBe(before);

    // Twice from the SAME snapshot — which is what the renderer's preview does,
    // and what catches a restore that hands back a live reference.
    dryRun();
    sim.restore(snap);
    expect(JSON.stringify(sim)).toBe(before);

    // Restoring must also restore the STREAM, so the next serve is the one the
    // snapshot was about to see — not merely the same counters.
    const restored = new DerbySim({ seed: 77 });
    restored.restore(snap);
    expect(JSON.stringify(restored.getState())).toBe(JSON.stringify(sim.getState()));
    // …and the stream itself: resolve the pitch that was in flight, then the NEXT
    // serve must be identical. A snapshot that restores counters but not the PRNG
    // passes everything above and diverges here.
    restored.swing(0.42);
    sim.swing(0.42);
    expect(JSON.stringify(restored.servePitch())).toBe(JSON.stringify(sim.servePitch()));
  });

  it('predict() mutates nothing', () => {
    const sim = new DerbySim({ seed: 5 });
    const pr = sim.servePitch();
    sim.setReticle(pr.plate.x, pr.plate.h);
    const before = JSON.stringify(sim);
    for (let dt = -0.04; dt <= 0.04; dt += 0.005) sim.predict(pr.plate.t + dt);
    expect(JSON.stringify(sim)).toBe(before);
    // And predict agrees with the swing it previews, to the last bit.
    const p = sim.predict(pr.plate.t + 0.006);
    expect(JSON.stringify(sim.swing(pr.plate.t + 0.006))).toBe(JSON.stringify(p));
  });
});

describe('derby — the serve', () => {
  it('the AI serves a plausible, seeded mix and locates inside the zone', () => {
    const counts = new Map<PitchId, number>();
    const targets: { x: number; h: number }[] = [];
    let strikes = 0;
    let n = 0;
    for (let seed = 0; seed < 120; seed++) {
      const sim = new DerbySim({ seed });
      while (sim.getState().phase !== 'done') {
        const pr = sim.servePitch();
        const id = sim.getState().pitchId as PitchId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        targets.push({ x: pr.plate.x, h: pr.plate.h });
        if (pr.plate.strike) strikes++;
        n++;
        sim.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
        sim.swing(pr.plate.t);
      }
    }
    const rows = DERBY_MIX.map((m) => {
      const got = (100 * (counts.get(m.id) ?? 0)) / n;
      return `  ${m.id}  served ${f(got, 5, 1)} %  want ${f(m.weight * 100, 5, 1)} %`;
    });
    console.log(`\nSERVE MIX over ${n} pitches (${DERBY_ROUNDS * PITCHES_PER_ROUND} × 120 seeds)`);
    console.log(rows.join('\n'));
    console.log(`  every serve a called strike: ${strikes}/${n}`);

    // Every published row is reachable — the arsenal is not forked.
    for (const p of PITCHES) expect(counts.get(p.id) ?? 0).toBeGreaterThan(0);
    // The mix tracks its weights (2 percentage points over ~2900 draws).
    for (const m of DERBY_MIX) {
      expect(Math.abs((counts.get(m.id) ?? 0) / n - m.weight)).toBeLessThan(0.02);
    }
    // It is NOT the same pitch every time, and it is not uniform either.
    expect(counts.size).toBe(PITCHES.length);
    expect((counts.get('ff') ?? 0) / n).toBeGreaterThan((counts.get('fs') ?? 0) / n);
    // A derby server locates: every serve is a strike.
    expect(strikes).toBe(n);

    // The same seed gives the same sequence of ids and locations.
    const idsOf = (seed: number) => {
      const sim = new DerbySim({ seed });
      const out: string[] = [];
      while (sim.getState().phase !== 'done') {
        const pr = sim.servePitch();
        out.push(`${sim.getState().pitchId}@${pr.plate.x.toFixed(6)},${pr.plate.h.toFixed(6)}`);
        sim.setReticle(0, 2.5);
        sim.swing(pr.plate.t);
      }
      return out.join('|');
    };
    expect(idsOf(31)).toBe(idsOf(31));
    expect(idsOf(31)).not.toBe(idsOf(32));
  });
});

describe('derby — the swing mapping', () => {
  it('the reference swing reproduces bat.ts BOTH published bands', () => {
    // SWING_UNDERCUT_IN is duplicated from bat.ts's calibration, so it is pinned
    // here against the two published bands it was calibrated to rather than
    // copied on trust.
    const c = swingContact(REF_PITCH, {
      hand: 'R',
      timingErrorS: 0,
      undercutIn: SWING_UNDERCUT_IN,
    });
    console.log(
      `\nREFERENCE SWING (undercut ${SWING_UNDERCUT_IN} in, on time, sweet spot)\n` +
        `  LA ${c.laDeg.toFixed(2)}° (band 25.0–25.9)   backspin ${c.backspinRpm.toFixed(0)} rpm ` +
        `(band 2350–2500)   EV ${c.evMph.toFixed(2)} mph`,
    );
    expect(c.laDeg).toBeGreaterThan(25.0);
    expect(c.laDeg).toBeLessThan(25.9);
    expect(c.backspinRpm).toBeGreaterThan(2350);
    expect(c.backspinRpm).toBeLessThan(2500);
  });

  it('the contact window is the BAT, and its timing half is derived from it', () => {
    // Both bounds come out of bat.ts, not out of a knob:
    expect(BAT_TIP_M).toBeCloseTo(0.8382, 6); // a 33 in bat
    expect(BAT_HANDLE_LIMIT_M).toBeCloseTo(2 * SWEET_SPOT_M - BAT_TIP_M, 12);

    // Because R_c = d/cos θ > d for a miss in EITHER direction, a mistimed swing
    // walks contact OUT toward the tip, so "is the ball still over the bat" IS
    // the timing window. Walk it and report where it closes.
    const sim = new DerbySim({ seed: 7 });
    const pr = sim.servePitch();
    sim.setReticle(pr.plate.x, pr.plate.h);
    let lo = 0;
    let hi = 0;
    for (let ms = 0; ms <= 60; ms += 0.1) {
      if (sim.predict(pr.plate.t - ms / 1000).outcome !== 'whiff') lo = ms;
      if (sim.predict(pr.plate.t + ms / 1000).outcome !== 'whiff') hi = ms;
    }
    console.log(
      `\nTIMING WINDOW (derived from the bat's length, no knob)\n` +
        `  contact from ${lo.toFixed(1)} ms early to ${hi.toFixed(1)} ms late; ` +
        `half-width ${((lo + hi) / 2).toFixed(1)} ms, asymmetry ${(hi - lo).toFixed(2)} ms`,
    );
    expect(lo).toBeGreaterThan(20);
    expect(lo).toBeLessThan(35);
    // EXACTLY symmetric — the geometry's cos θ is even in Δt.
    expect(hi).toBeCloseTo(lo, 6);
  });

  it('⚠ early and late stay EXACTLY symmetric where stage 3 proved they are', () => {
    // Stage 3's invariant lives in `contactGeometry`: contact point and bat speed
    // are even functions of Δt. derbySim must not introduce an asymmetry into
    // that, and the honest way to assert it is on the quantities the invariant is
    // actually about — then to MEASURE what is left over and say where it comes
    // from.
    const sim = new DerbySim({ seed: 7 });
    const pr = sim.servePitch();
    // ⚠ THE RETICLE IS CENTRED LATERALLY, NOT PUT ON THE BALL, AND THAT IS THE
    // POINT OF THE CHANGE. Spray now carries a second term — the declared
    // pull/oppo intent — which is deliberately NOT a function of Δt, so the
    // early/late spray mirror is a statement about the TIMING component alone
    // and has to be asked with intent held at zero. Asking it with an intent
    // bias would be asserting that the new channel does not exist.
    sim.setReticle(ZONE_CENTER.x, pr.plate.h);
    const rows: string[] = [];
    for (const ms of [5, 10, 15, 20, 25]) {
      const dt = ms / 1000;
      const early = sim.predict(pr.plate.t - dt);
      const late = sim.predict(pr.plate.t + dt);
      const ga = contactGeometry(140, { hand: 'R', timingErrorS: -dt, undercutIn: SWING_UNDERCUT_IN });
      const gb = contactGeometry(140, { hand: 'R', timingErrorS: dt, undercutIn: SWING_UNDERCUT_IN });
      // The stage-3 invariant, to the last bit.
      expect(gb.contactZM).toBe(ga.contactZM);
      expect(gb.batSpeedFps).toBe(ga.batSpeedFps);
      expect(late.contactZM).toBe(early.contactZM);
      // …and mirrored spray, which is what makes pulling the ball a strategy.
      expect(Math.sign(early.sprayDeg)).toBe(-Math.sign(late.sprayDeg));
      rows.push(
        `  ±${String(ms).padStart(2)} ms  EV ${f(early.evMph)} / ${f(late.evMph)}  Δ ${f(
          late.evMph - early.evMph,
          6,
        )} mph   spray ${f(early.sprayDeg, 7, 1)}° / ${f(late.sprayDeg, 6, 1)}°   zM ${early.contactZM?.toFixed(9)}`,
      );
    }
    console.log(
      '\nEARLY / LATE — contact point and bat speed are EXACTLY even in Δt\n' +
        rows.join('\n') +
        '\n  ⚠ The residual EV gap is the PITCH, not the swing: this served pitch\n' +
        '    arrives with real lateral velocity and spin, and the collision is not\n' +
        '    invariant under azim → −azim when v.y ≠ 0. Against a straight, spinless\n' +
        '    pitch it vanishes — measured below.',
    );

    // The control: v purely along +x, no spin ⇒ the collision IS even in azim.
    for (const ms of [5, 15, 25]) {
      const dt = ms / 1000;
      const one = (t: number) =>
        swingContact(
          REF_PITCH,
          { hand: 'R', timingErrorS: t, undercutIn: SWING_UNDERCUT_IN },
        ).evMph;
      expect(one(dt)).toBeCloseTo(one(-dt), 10);
    }
  });

  it('⚠ the reticle SHOULDER is continuous — dead centre is STRICTLY best', () => {
    // ⚠ WHAT THIS REPLACED, AND WHY IT IS THE SAME TEST WITH TEETH. The reticle
    // was a hard DISC of radius 4 in with `k = 0` identically inside it, so the
    // three rows at 0.0 / 2.4 / 4.0 in below were BYTE-IDENTICAL — 411.0 ft of
    // carry each — and barrel rate then fell 100 % → 8.3 % between 4.0 and
    // 5.4 in. A two-state mechanic dressed as a continuous one. The shoulder
    // fades instead, and the assertions here are the ones that could not be
    // written before: STRICT monotonicity in the residual and in the carry.
    const sim = new DerbySim({ seed: 7 });
    const pr = sim.servePitch();
    const rows: string[] = [];
    const carries: number[] = [];
    const undercuts: number[] = [];
    for (const dh of [-0.6, -0.5, -0.4, -0.33, -0.2, 0, 0.2, 0.33, 0.4, 0.5, 0.6]) {
      sim.setReticle(pr.plate.x, pr.plate.h - dh); // + dh = aiming BELOW the ball
      const r = sim.predict(pr.plate.t);
      if (dh >= 0) {
        carries.push(r.distFt);
        undercuts.push(r.undercutIn);
      }
      rows.push(
        `  aim ${f(dh * 12, 6, 1)} in ${dh < 0 ? 'high' : 'low '}  undercut ${f(r.undercutIn, 6)} in  ` +
          `${r.outcome.padEnd(8)} EV ${f(r.evMph)}  LA ${f(r.laDeg)}°  carry ${f(r.distFt, 6, 1)} ft  ` +
          `barrel ${r.barrel ? 'Y' : '·'}`,
      );
    }
    console.log(
      `\nRETICLE — VERTICAL sweep (fade: (r/${RETICLE_FULL_MISS_IN} in)^${RETICLE_FADE_POWER})\n` +
        rows.join('\n'),
    );

    // Dead centre is EXACTLY the reference swing, and it is the only placement
    // that is: the residual is zero only at zero.
    sim.setReticle(pr.plate.x, pr.plate.h);
    const bull = sim.predict(pr.plate.t);
    expect(bull.undercutIn).toBe(SWING_UNDERCUT_IN);
    expect(reticleResidual(0)).toBe(0);
    // Monotone, strictly, from the first inch outward — the property the disc
    // could not have. `toBeGreaterThan`, not `toBeGreaterThanOrEqual`.
    for (let i = 1; i < undercuts.length; i++) {
      expect(undercuts[i]!).toBeGreaterThan(undercuts[i - 1]!);
      expect(carries[i]!).toBeLessThan(carries[i - 1]!);
    }
    // ⚠ STRICTLY POSITIVE AND STRICTLY INCREASING FROM ZERO — right down to a
    // hundredth of an inch. This is the assertion the old disc could not pass
    // and no flat-centred law can: `k(r) > 0` for every `r > 0`.
    let prev = 0;
    for (let rIn = 0.01; rIn < 8; rIn += 0.01) {
      const k = reticleResidual(rIn / 12);
      expect(k).toBeGreaterThan(prev);
      prev = k;
    }
    expect(reticleResidual(0.01 / 12)).toBeGreaterThan(0);
    // Beyond the fade radius the assist is GONE, not scaled: the WHOLE miss
    // reaches the swing.
    for (const rIn of [8, 9, 12, 40]) expect(reticleResidual(rIn / 12)).toBe(1);

    // Contact fails on the ball/bat overlap, and the two sides are NOT
    // symmetric, because the swing carries a positive reference undercut.
    // Aiming LOW spends that margin, aiming HIGH has to cross it first.
    const boundary = (sign: number) => {
      let last = 0;
      for (let d = 0; d < 1; d += 0.0005) {
        sim.setReticle(pr.plate.x, pr.plate.h + sign * d);
        if (sim.predict(pr.plate.t).outcome !== 'whiff') last = d;
      }
      return last;
    };
    // The prediction, solved from the DERIVED overlap test through the shoulder
    // rather than through a closed form: the miss that reaches the swing is
    // `d·reticleResidual(d)`, and the intent this reticle placement declares
    // spends part of the same 2.70 in budget, so it is in the hypotenuse.
    const offIn = pullIntentOffsetIn(pr.plate.x, 'R');
    const vertLimit = Math.sqrt(LOC_DISTANCE_IN ** 2 - offIn ** 2);
    const solve = (sign: number) => {
      let last = 0;
      for (let d = 0; d < 1; d += 0.0005) {
        const undercut = SWING_UNDERCUT_IN - sign * d * reticleResidual(d) * 12;
        if (Math.abs(undercut) <= vertLimit) last = d;
      }
      return last;
    };
    const lowSide = boundary(-1); // reticle below the ball ⇒ MORE undercut
    const highSide = boundary(+1);
    console.log(
      `  intent at this placement ${offIn.toFixed(4)} in ⇒ vertical budget ` +
        `${vertLimit.toFixed(4)} in of ${LOC_DISTANCE_IN.toFixed(4)}\n` +
        `  contact fails beyond ${lowSide.toFixed(4)} ft of aim BELOW the ball ` +
        `(predicted ${solve(-1).toFixed(4)})\n` +
        `  contact fails beyond ${highSide.toFixed(4)} ft of aim ABOVE the ball ` +
        `(predicted ${solve(+1).toFixed(4)})`,
    );
    expect(lowSide).toBeCloseTo(solve(-1), 3);
    expect(highSide).toBeCloseTo(solve(+1), 3);
    expect(highSide).toBeGreaterThan(lowSide);
  });

  it('a well-placed reticle barrels; a badly-placed one does not', () => {
    const sim = new DerbySim({ seed: 7 });
    const pr = sim.servePitch();
    sim.setReticle(pr.plate.x, pr.plate.h);
    const good = sim.predict(pr.plate.t - 0.004);
    expect(good.barrel).toBe(true);
    expect(isBarrel(good.evMph, good.laDeg)).toBe(true);

    // Six inches of aim error, each way, kills the barrel.
    for (const dh of [-0.5, 0.5]) {
      sim.setReticle(pr.plate.x, pr.plate.h + dh);
      expect(sim.predict(pr.plate.t - 0.004).barrel).toBe(false);
    }

    // Barrel RATE across a grid of aim errors — the skill gradient, printed.
    //
    // ⚠ CARRY IS PRINTED BESIDE IT AND IS THE HONEST COLUMN. A barrel is a
    // PUBLISHED classification with a razor-thin launch-angle window (±5.7° at
    // this exit velocity), and launch angle moves ~33° per inch of undercut, so
    // barrel survives only ~0.17 in of residual miss WHEREVER the law puts that
    // threshold. Barrel rate is therefore always going to look step-ish; it is a
    // property of the yardstick, not of the reticle. Mean carry is the
    // continuous quantity, and it is the one that was BYTE-IDENTICAL across the
    // first three rows under the old disc.
    const rows: string[] = [];
    for (const rad of [0, 0.2, 0.33, 0.45, 0.6]) {
      let barrels = 0;
      let contact = 0;
      let n = 0;
      let carry = 0;
      let hit = 0;
      for (let a = 0; a < 12; a++) {
        const th = (a * Math.PI) / 6;
        sim.setReticle(pr.plate.x + rad * Math.cos(th), pr.plate.h + rad * Math.sin(th));
        for (const ms of [-6, -3, 0, 3, 6]) {
          const r = sim.predict(pr.plate.t + ms / 1000);
          n++;
          if (r.outcome !== 'whiff') {
            contact++;
            carry += r.distFt;
            hit++;
          }
          if (r.barrel) barrels++;
        }
      }
      rows.push(
        `  aim error ${f(rad * 12, 5, 1)} in   contact ${f((100 * contact) / n, 5, 1)} %   ` +
          `barrel ${f((100 * barrels) / n, 5, 1)} %   mean carry ${
            hit ? f(carry / hit, 6, 1) : '   —  '
          } ft`,
      );
    }
    console.log('\nRETICLE — barrel rate against radial aim error (±6 ms of timing)');
    console.log(rows.join('\n'));
  });

  it('⚠ a CENTRED reticle can always reach the worst serve the mix produces', () => {
    // The joint property of SERVE_SPREAD and RETICLE_FULL_MISS_IN, measured rather
    // than asserted — move either knob and this is what tells you.
    const corner = reticleToPlate(SERVE_SPREAD, SERVE_SPREAD);
    const dx = corner.x - ZONE_CENTER.x;
    const dh = corner.h - ZONE_CENTER.h;
    const rad = Math.hypot(dx, dh);
    const k = reticleResidual(rad);
    const worstUndercut = SWING_UNDERCUT_IN + dh * k * 12;
    const margin = LOC_DISTANCE_IN - worstUndercut;
    console.log(
      `\nCENTRED-RETICLE REACH — the property RETICLE_FULL_MISS_IN is CALIBRATED to\n` +
        `  worst serve  Δx ${dx.toFixed(4)} ft  Δh ${dh.toFixed(4)} ft  |Δ| ${rad.toFixed(4)} ft ` +
        `(${(rad * 12).toFixed(3)} in)\n` +
        `  shoulder residual k = ${k.toFixed(4)}  ⇒  undercut ${worstUndercut.toFixed(4)} in ` +
        `vs LOC_DISTANCE_IN ${LOC_DISTANCE_IN.toFixed(4)}\n` +
        `  MARGIN ${margin.toFixed(4)} in   (lateral ${(dx * k * 12).toFixed(4)} in, ` +
        `bat span ±${((BAT_TIP_M - SWEET_SPOT_M) / 0.3048) * 12} in)\n` +
        `  ⚠ the superseded 4 in disc gave k = ${((rad - 1 / 3) / rad).toFixed(4)} here, i.e. the ` +
        `fade is calibrated to preserve this margin, not to tighten it.`,
    );
    expect(margin).toBeGreaterThan(0.2);
    // …and that is what RETICLE_FULL_MISS_IN is calibrated ON: within 0.01 of
    // what the superseded disc produced at this exact corner.
    expect(k).toBeCloseTo((rad - 1 / 3) / rad, 2);
    // A CENTRED reticle declares no intent, so its whole budget is vertical —
    // and it is a POSITIVE zero, which `-1 × 0` is not (see pullIntentOffsetIn).
    expect(pullIntentOffsetIn(ZONE_CENTER.x, 'R')).toBe(0);
    expect(Object.is(pullIntentOffsetIn(ZONE_CENTER.x, 'R'), -0)).toBe(false);

    // And empirically: over 60 seeds, a centred reticle on time never whiffs.
    let whiffs = 0;
    for (let seed = 200; seed < 260; seed++) {
      for (const r of playSession(new DerbySim({ seed }), centred)) {
        if (r.outcome === 'whiff') whiffs++;
      }
    }
    expect(whiffs).toBe(0);
  });

  it('the lateral axis is the BAT, and its sign mirrors for a lefty', () => {
    // A pitch further from the batter than his reticle ⇒ contact further out the
    // barrel ⇒ M_eff collapses ⇒ less exit velocity. That is the whole content of
    // the lateral mapping, and its sign is `zone.armSideX`'s, read once.
    const away = 0.45; // ft, toward the far side of the plate
    const rhb = new DerbySim({ seed: 11, batterHand: 'R' });
    const pr = rhb.servePitch();
    rhb.setReticle(pr.plate.x - away, pr.plate.h);
    const outR = rhb.predict(pr.plate.t);
    rhb.setReticle(pr.plate.x + away, pr.plate.h);
    const inR = rhb.predict(pr.plate.t);

    const lhb = new DerbySim({ seed: 11, batterHand: 'L' });
    const prL = lhb.servePitch();
    lhb.setReticle(prL.plate.x + away, prL.plate.h); // the LHB's outside is +x
    const outL = lhb.predict(prL.plate.t);

    console.log(
      `\nLATERAL AXIS (aim error ${(away * 12).toFixed(1)} in)\n` +
        `  RHB, pitch OUTSIDE the reticle: lateral ${f(outR.lateralIn, 6)} in  zM ${outR.contactZM?.toFixed(4)}  EV ${f(outR.evMph)}\n` +
        `  RHB, pitch INSIDE  the reticle: lateral ${f(inR.lateralIn, 6)} in  zM ${inR.contactZM?.toFixed(4)}  EV ${f(inR.evMph)}\n` +
        `  LHB, pitch OUTSIDE the reticle: lateral ${f(outL.lateralIn, 6)} in  zM ${outL.contactZM?.toFixed(4)}  EV ${f(outL.evMph)}\n` +
        `  ⚠ INSIDE IS STRONGER BY ${f(inR.evMph - outR.evMph, 5)} mph. THE MODEL HAS NO JAMMING\n` +
        `    (BASEBALL.md § "The collision"): with a constant e, eA keeps rising\n` +
        `    toward the balance point, so contact nearer the hands is rewarded out\n` +
        `    to ~6 in. Inherited, printed, NOT patched with a knob here.`,
    );

    expect(outR.lateralIn).toBeGreaterThan(0);
    expect(outR.contactZM ?? 0).toBeGreaterThan(SWEET_SPOT_M);
    expect(inR.lateralIn).toBeLessThan(0);
    expect(inR.contactZM ?? 0).toBeLessThan(SWEET_SPOT_M);
    // The mirror: the same aim error for a lefty lands in the same place on the
    // bat, by the same amount. `away = −armSideX` is the only mirror involved.
    expect(outL.lateralIn).toBeCloseTo(outR.lateralIn, 9);
    expect(outL.contactZM ?? 0).toBeCloseTo(outR.contactZM ?? 0, 9);
    // ⚠ EXIT VELOCITY NO LONGER MIRRORS IN THIS PAIR, AND THE REASON IS THE
    // FINDING. These two sims mirror the BATTER and the aim error but leave the
    // pitch on the same side of the plate, which stopped being a mirrored
    // situation the moment the reticle's ABSOLUTE placement became a pull/oppo
    // intent: an inside pitch to a RHB is an outside pitch to a LHB. Measured
    // gap 0.75 mph, all of it intent. The mapping's own mirror is exact, and it
    // is asserted where it lives — on the function that carries it, against a
    // properly mirrored PITCH LOCATION.
    for (const x of [-0.8, -0.45, -0.1, 0, 0.1, 0.45, 0.8, 1.4]) {
      expect(pullIntentOffsetIn(x, 'R')).toBeCloseTo(pullIntentOffsetIn(-x, 'L'), 12);
    }
    // …and it is a real channel, not a constant: full intent is the plate edge.
    expect(pullIntentOffsetIn(-10, 'R')).toBeCloseTo(PULL_INTENT_MAX_IN, 12);
    expect(pullIntentOffsetIn(10, 'R')).toBeCloseTo(-PULL_INTENT_MAX_IN, 12);
    // Out toward the tip really does cost exit velocity.
    expect(outR.evMph).toBeLessThan(inR.evMph);
  });
});

describe('derby — outcomes', () => {
  it('a perfect swing on a meatball fastball is a home run; a mistimed one is not', () => {
    // The meatball: a four-seamer served dead centre, reticle on it, tap on the
    // true physical plate-crossing instant.
    const sim = new DerbySim({ seed: 12345 });
    let pr = sim.servePitch();
    while (sim.getState().pitchId !== 'ff') {
      sim.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
      sim.swing(pr.plate.t);
      pr = sim.servePitch();
    }
    sim.setReticle(pr.plate.x, pr.plate.h);
    const hit = sim.predict(pr.plate.t);
    expect(hit.outcome).toBe('homeRun');
    expect(hit.points).toBeGreaterThan(HR_BASE_POINTS);
    expect(hit.barrel).toBe(true);

    // Mistimed by 40 ms: the ball is past the end of the bat. Not a home run.
    for (const ms of [-40, 40]) {
      const miss = sim.predict(pr.plate.t + ms / 1000);
      expect(miss.outcome).toBe('whiff');
      expect(miss.points).toBe(0);
    }
    // Mistimed by 22 ms: contact, but pulled or pushed foul.
    expect(sim.predict(pr.plate.t - 0.022).outcome).not.toBe('homeRun');

    console.log(
      `\nMEATBALL  ff at (${pr.plate.x.toFixed(2)}, ${pr.plate.h.toFixed(2)}), ` +
        `${pr.plate.speedMph.toFixed(1)} mph, flight ${pr.plate.t.toFixed(4)} s\n` +
        `  on time  EV ${hit.evMph.toFixed(2)}  LA ${hit.laDeg.toFixed(2)}°  spray ${hit.sprayDeg.toFixed(
          2,
        )}°  carry ${hit.distFt.toFixed(1)} ft  ⇒ ${hit.outcome}, ${hit.points} pts`,
    );
  });

  it('⚠ every pitch in the mix CAN be hit out — but not always on time', () => {
    // The "which 400" finding, live in gameplay. A perfectly-timed, perfectly
    // aimed swing sprays near dead centre, which is the DEEPEST part of the park
    // (400 ft + a 10 ft wall ⇒ ~409 ft of carry needed). The slower pitches carry
    // 397–404 ft on time and die at the wall; pulling them clears a 375 ft gap.
    const rows: string[] = [];
    for (const p of PITCHES) {
      const sim = new DerbySim({ seed: 1 });
      let pr = sim.servePitch();
      let guard = 0;
      while (sim.getState().pitchId !== p.id && guard++ < 2000) {
        sim.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
        if (sim.getState().phase === 'done') break;
        sim.swing(pr.plate.t);
        if (sim.getState().phase === 'done') {
          const fresh = new DerbySim({ seed: 1 + guard });
          Object.assign(sim, fresh);
        }
        pr = sim.servePitch();
      }
      sim.setReticle(pr.plate.x, pr.plate.h);
      const onTime = sim.predict(pr.plate.t);
      let bestOut: SwingResult | null = null;
      for (let ms = -20; ms <= 20; ms += 0.5) {
        const r = sim.predict(pr.plate.t + ms / 1000);
        if (r.outcome === 'homeRun' && (!bestOut || r.points > bestOut.points)) bestOut = r;
      }
      rows.push(
        `  ${p.id}  on time: ${onTime.outcome.padEnd(8)} EV ${f(onTime.evMph)} LA ${f(onTime.laDeg)}° ` +
          `carry ${f(onTime.distFt, 6, 1)} ft  |  best in ±20 ms: ` +
          (bestOut
            ? `${f(bestOut.distFt, 6, 1)} ft @ spray ${f(bestOut.sprayDeg, 6, 1)}°, ${String(
                bestOut.points,
              ).padStart(3)} pts`
            : 'none'),
      );
      expect(bestOut, `${p.id} can never be hit out`).not.toBeNull();
    }
    console.log('\nPER-PITCH — a perfect swing, and the best swing inside ±20 ms');
    console.log(rows.join('\n'));
  });

  it('⚠ the timing sweep has NO home-run trough at perfect timing', () => {
    // ⚠ THE DEFECT THIS TEST NOW PINS. Before the pull/oppo channel existed,
    // spray was a function of TIMING ALONE — and timing also set exit velocity,
    // so the two could not be traded. Perfect timing sprayed at dead centre,
    // which at Harbourfront is 400 ft plus a 10 ft wall, while a 10–15 ms miss
    // sprayed into a 375 ft alley. Measured, on exactly this sweep:
    //
    //     BEFORE       -15 ms  -10 ms   -5 ms    0 ms   +5 ms  +10 ms  +15 ms
    //     HR %          100.0   100.0    75.4    54.2    83.9   100.0   100.0
    //     carry ft      387.0   400.7   406.1   406.7   404.1   398.0   387.5
    //     barrel %       57.2   100.0   100.0   100.0   100.0    95.2    54.2
    //
    // i.e. the row with the best contact by every physical measure had the WORST
    // outcome, and a HUD would have printed "PERFECT" over it. Now the reticle
    // carries an intent, so tracking the pitch sprays an inside serve toward the
    // 375 ft alley and an outside one the other way, and 0 ms is no longer
    // punished for being centred. The assertion is the SHAPE, not a number: the
    // perfect row must not be beaten by any mistimed row.
    const sweep = (label: string, control: typeof perfect) => {
      const rows: string[] = [];
      const hrByMs = new Map<number, number>();
      for (let ms = -35; ms <= 35; ms += 5) {
        const tally = new Map<string, number>();
        let ev = 0;
        let dist = 0;
        let n = 0;
        let barrels = 0;
        for (let seed = 300; seed < 340; seed++) {
          const sim = new DerbySim({ seed });
          for (const r of playSession(sim, control(ms / 1000))) {
            tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1);
            if (r.outcome !== 'whiff' && r.outcome !== 'take') {
              ev += r.evMph;
              dist += r.distFt;
              n++;
            }
            if (r.barrel) barrels++;
          }
        }
        const tot = [...tally.values()].reduce((a, b) => a + b, 0);
        const pct = (k: string) => f((100 * (tally.get(k) ?? 0)) / tot, 5, 1);
        hrByMs.set(ms, (tally.get('homeRun') ?? 0) / tot);
        rows.push(
          `  ${String(ms).padStart(4)} ms   HR ${pct('homeRun')} %  out ${pct('inPlay')} %  ` +
            `foul ${pct('foul')} %  whiff ${pct('whiff')} %   ` +
            `EV ${n ? f(ev / n) : '   —  '}  carry ${n ? f(dist / n, 6, 1) : '  —  '} ft  ` +
            `barrel ${f((100 * barrels) / tot, 5, 1)} %`,
        );
        if (ms === 0) expect(tally.get('whiff') ?? 0).toBe(0);
        if (Math.abs(ms) >= 35) expect((tally.get('whiff') ?? 0) / tot).toBe(1);
      }
      console.log(`\nTIMING SWEEP — ${label}; 40 seeds × 24 swings per row`);
      console.log(rows.join('\n'));
      return hrByMs;
    };

    const tracked = sweep('reticle ON the ball (intent tracks the serve)', perfect);
    // NO ROW BEATS PERFECT TIMING. This is the whole content of the fix, and it
    // is asserted as an inequality over the sweep rather than as a threshold on
    // one cell, so a change that flattens 0 ms by breaking ±10 ms fails too.
    const best = Math.max(...tracked.values());
    expect(tracked.get(0)!).toBe(best);
    for (const [ms, hr] of tracked) {
      if (ms !== 0) expect(hr).toBeLessThanOrEqual(tracked.get(0)!);
    }

    // The CONTROL: the same sweep with the intent channel held at zero (reticle
    // centred laterally, on the ball vertically). Without it the assertion above
    // could pass for some unrelated reason; with it the trough is visible in the
    // same run as its absence, which is what makes this evidence.
    const flat = sweep('intent NEUTRALISED (reticle laterally centred)', (offsetS = 0) => (s, _x, h, t) => {
      s.setReticle(ZONE_CENTER.x, h);
      s.swing(t + offsetS);
    });
    expect(flat.get(0)!).toBeLessThan(Math.max(...flat.values()));
    console.log(
      `\n  perfect-timing HR rate: ${(100 * tracked.get(0)!).toFixed(1)} % with intent, ` +
        `${(100 * flat.get(0)!).toFixed(1)} % without — and without it, ` +
        `${(100 * Math.max(...flat.values())).toFixed(1)} % is available to a MISTIMED swing.`,
    );
  });

  it('the session bookkeeping closes', () => {
    const sim = new DerbySim({ seed: 8888 });
    const swings = playSession(sim, perfect(-0.004));
    const st = sim.getState();
    expect(swings.length).toBe(DERBY_ROUNDS * PITCHES_PER_ROUND);
    expect(st.phase).toBe('done');
    expect(st.homeRuns + st.outs + st.strikes).toBe(swings.length);
    expect(st.roundScores.length).toBe(DERBY_ROUNDS);
    expect(st.roundScores.reduce((a, b) => a + b, 0)).toBe(st.score);
    expect(st.score).toBe(swings.reduce((a, r) => a + r.points, 0));
    expect(st.homeRuns).toBe(swings.filter((r) => r.outcome === 'homeRun').length);
    expect(st.bestFt).toBe(Math.max(...swings.filter((r) => r.points > 0).map((r) => r.distFt)));
    expect(st.roundsPlayed).toBe(DERBY_ROUNDS);
    expect(() => sim.servePitch()).toThrow();

    // A take costs the pitch, scores a strike and is never an out.
    const t = new DerbySim({ seed: 4 });
    t.servePitch();
    const took = t.take();
    expect(took.outcome).toBe('take');
    expect(t.getState().strikes).toBe(1);
    expect(t.getState().outs).toBe(0);

    console.log(
      `\nSESSION seed 8888 (reticle on the ball, tap 4 ms early)\n` +
        `  ${st.homeRuns} HR · ${st.outs} outs · ${st.strikes} strikes · ${st.barrels} barrels\n` +
        `  rounds ${JSON.stringify(st.roundScores)} = ${st.score} pts, longest ${st.bestFt.toFixed(1)} ft\n` +
        `  spin check: reference contact backspin ${swingContact(REF_PITCH, {
          hand: 'R',
          timingErrorS: 0,
          undercutIn: SWING_UNDERCUT_IN,
        }).backspinRpm.toFixed(0)} rpm`,
    );
  });

  it('⚠ FINDING, not fixed here: contact is taken at the PLATE state', () => {
    // A late swing meets the ball 1.46 ft deeper, where gravity has taken it
    // lower — worth real undercut. Sampling that would break the early/late
    // symmetry stage 3 asserts, so it is NOT done; the counterfactual is measured
    // so the decision stays visible and costed.
    const sim = new DerbySim({ seed: 7 });
    const pr = sim.servePitch();
    sim.setReticle(pr.plate.x, pr.plate.h);
    const rows: string[] = [];
    for (const ms of [-20, -10, 0, 10, 20]) {
      const dt = ms / 1000;
      const geom = contactGeometry(
        Math.hypot(pr.plate.v.x, pr.plate.v.y, pr.plate.v.z),
        { hand: 'R', timingErrorS: dt, undercutIn: SWING_UNDERCUT_IN },
      );
      const depthFt = -pr.plate.v.x * geom.contactDelayS;
      const dropIn = pr.plate.v.z * geom.contactDelayS * 12;
      rows.push(
        `  ${String(ms).padStart(4)} ms  contact ${f(depthFt, 6, 2)} ft deeper  ` +
          `ball ${f(-dropIn, 6, 2)} in lower  ⇒ undercut would move ${f(dropIn, 6, 2)} in`,
      );
    }
    console.log(
      '\nCOUNTERFACTUAL — sampling the ball at the true contact instant\n' + rows.join('\n'),
    );
    expect(sim.predict(pr.plate.t).undercutIn).toBe(SWING_UNDERCUT_IN);
  });
});
