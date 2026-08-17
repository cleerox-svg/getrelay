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
// THREE MORE WERE WATCHED TO FAIL in the M2c review pass, when the streak moved
// into the sim and the contact window stopped being a hand-copied number:
//
//  19. `curStreak = 0` dropped from `commit()`'s non-HR
//      branch (the streak never breaks)                  → 1 fail
//  20. `bestStreak` dropped from `derbySnapshot`          → 1 fail
//  21. `contactWindowS` hand-set to the 0.0264 s that
//      `shared/TimingBar.tsx` used to carry as a const    → 1 fail
//  22. `copySwing` flattened back to `{ ...r }` — the
//      shallow spread that left `flight` aliased          → 1 fail
//  23. `contactWindowS` stops FORWARDING `batSpeedMph`
//      into `contactGeometry` (the parameter accepted and
//      ignored) — a follow-up pass; the file survived it  → 1 fail
//
// TEN MORE WERE WATCHED TO FAIL in the M2 FEEL pass, when the payout stopped
// being home-run-only and `derbyRules.ts` was split three ways at the cap. Same
// discipline, observed counts against the whole 182-test baseball suite:
//
//  24. `swingPoints`'s `Math.min(cap, …)` deleted           → 36 fail
//  25. a WHIFF drops out of the no-contact guard and
//      scores `contactCredit`                               → 36 fail
//  26. `CONTACT_DATUM_FT` unpinned from the grass line
//      (155.5 → 100)                                        → 1 fail
//  27. `FOUL_CREDIT_FRACTION` not applied — a foul pays
//      exactly what the same ball in play pays              → 1 fail
//  28. `BARREL_BONUS_POINTS` zeroed                          → 1 fail
//  29. `CONTACT_POINTS_PER_FT` 0.35 → 2, so a caught fly
//      out-pays the home run it just missed                  → 2 fail
//  30. `validatePayoutCap` dropped from `validateDerbyFormat`
//      (the payout stops being checked on the LIVE path)     → 1 fail
//  31. `derbySim` scores home runs only again (M2's ternary)  → 1 fail
//  32. the per-pitch cap read from the CONSTANT rather than
//      from `perPitchCap(cfg.pitchesPerRound)`               → 1 fail
//  33. `PITCH_TEMPO` reverted 0.45 → 0.55                    → 1 fail
//
// ⚠ (24) AND (25) FAIL 36 TESTS BECAUSE `resolveDerbyConfig` THROWS. The payout
// cap is checked on the live config path, so an uncapped payout is not a wrong
// score — it is a `new DerbySim()` that refuses to build. That is the intended
// blast radius: the alternative is a session that plays fine and then 400s on
// submit with the client swallowing the error.
//
// ⚠ (30) SURVIVED ITS FIRST ASSERTION, and the reason is recorded in the test.
// `expect(validateDerbyFormat(3, 7).join(' | ')).toContain('cap')` passed with
// the payout check deleted, because the DIVISIBILITY clause next door already
// prints "(per-pitch cap 285.71…)". Superset-against-`validatePayoutCap`'s own
// messages is what separates "mentions a cap" from "ran the payout validator".
//
// ⚠ (33) IS THE ONE MUTATION THAT IS SUPPOSED TO BE SURVIVABLE AND IS NOT, and
// the exception is deliberate. Every other assertion in this game is stated in
// TRUE physical time, so the tempo is free; the cliff/slope test is stated in
// the player's WALL ms, because that is the axis his thumb is on. Reverting the
// knob puts the ±60 ms row back to a hard zero, which is the measured
// justification for moving it.
//
// ⚠ (22) IS A GAP THIS FILE HAD, not one it caught. The independence assertions
// in the snapshot test mutated only SCALARS, so `getState().last.flight` — and
// its four sample arrays — could alias sim state through every one of them. It
// is the same "benign today" shape as (7) and (11) and it is now asserted the
// same way.
//
// ⚠ THREE OF THE EARLIER ONES SURVIVED THE FIRST PASS, and all three were real gaps:
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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../golf/wind';
import { vLen } from './airPhysics';
import { BAT_SPEED_MPH, LOC_DISTANCE_IN, SWEET_SPOT_M } from './bat';
import { contactGeometry, swingContact } from './batSim';
import { BAT_HANDLE_LIMIT_M, BAT_TIP_M, contactWindowS } from './contactWindow';
import {
  DERBY_MIX,
  DERBY_ROUNDS,
  MAX_POINTS_PER_PITCH,
  PITCHES_PER_ROUND,
  PULL_INTENT_MAX_IN,
  RETICLE_FADE_POWER,
  RETICLE_FULL_MISS_IN,
  SERVE_SPREAD,
  SWING_UNDERCUT_IN,
  derbyDraw,
  perPitchCap,
  pullIntentOffsetIn,
  reticleResidual,
  validateDerbyFormat,
  validateDerbyMix,
} from './derbyRules';
import { CHAIN_MULT_MAX, CHAIN_START, chainMultiplier } from './derbyChain';
import {
  BARREL_BONUS_POINTS,
  CONTACT_DATUM_FT,
  CONTACT_POINTS_PER_FT,
  DERBY_OUTCOMES,
  DISTANCE_DATUM_FT,
  FOUL_CREDIT_FRACTION,
  HR_BASE_POINTS,
  POINTS_PER_FT,
  swingPoints,
  validateDerbyPayout,
  validatePayoutCap,
} from './derbyScoring';
import { infieldDepthFt } from './fielding';
import { DerbySim } from './derbySim';
import type { DerbySim as DerbySimType } from './derbySim';
import type { SwingResult } from './derbyState';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { DERBY_POINTS_PER_ROUND, MAX_ROUNDS, PITCH_TEMPO, isBarrel } from './tuning';

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
 * Standard normal draws off ONE seeded `mulberry32` stream — Marsaglia polar.
 *
 * ⚠ SEEDED, because `determinism.test.ts` bans `Math.random` from the sim and a
 * bench that drives it with an unseeded RNG cannot be re-run to check a number
 * somebody disputes. The stream is the same generator the sim's own serve uses,
 * fed a different seed, so no shared state leaks between the player model and
 * the pitches he is facing.
 */
function gaussian(seed: number): () => number {
  const r = mulberry32(seed >>> 0);
  let spare: number | null = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = r() * 2 - 1;
      v = r() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
}

/** Median of a sample. Even lengths average the two middles. */
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const h = s.length >> 1;
  return s.length % 2 ? s[h]! : (s[h - 1]! + s[h]!) / 2;
}

/** The worker's own source — read as TEXT, never imported. See `tuning.test.ts`. */
const WORKER_GAMES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'relay-worker',
  'src',
  'games.ts',
);

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

    // ⚠ THE CLAMP IS `rounds × DERBY_POINTS_PER_ROUND`, read from the mirrored
    // constants rather than from a literal, so a worker change that lands in
    // tuning.ts fails HERE instead of on the wire.
    expect(DERBY_ROUNDS).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(MAX_POINTS_PER_PITCH * PITCHES_PER_ROUND).toBe(DERBY_POINTS_PER_ROUND);

    console.log(
      `\nFORMAT  ${DERBY_ROUNDS} rounds × ${PITCHES_PER_ROUND} pitches = ` +
        `${DERBY_ROUNDS * PITCHES_PER_ROUND} swings\n` +
        `        per-pitch cap ${MAX_POINTS_PER_PITCH} (= ${DERBY_POINTS_PER_ROUND}/${PITCHES_PER_ROUND}, DERIVED)\n` +
        `        round ceiling ${DERBY_POINTS_PER_ROUND}, session ceiling ` +
        `${DERBY_ROUNDS * DERBY_POINTS_PER_ROUND} against the worker's rounds×${DERBY_POINTS_PER_ROUND}\n` +
        `        homeRun = ${HR_BASE_POINTS} + max(0, carry − ${DISTANCE_DATUM_FT}) × 1\n` +
        `        inPlay  = max(0, carry − ${CONTACT_DATUM_FT}) × ${CONTACT_POINTS_PER_FT}\n` +
        `        foul    = ${FOUL_CREDIT_FRACTION} × the same ball in play\n` +
        `        barrel  = +${BARREL_BONUS_POINTS} on any of the three, before the foul scale`,
    );
  });

  it('⚠ SCORING IS NOT HOME-RUN-ONLY, and the payout ladder is printed', () => {
    // ⚠ THE DEFECT THIS CLOSES, MEASURED BEFORE THE FIX. Across every skill
    // level modelled, 20–48 % of swings were `inPlay` — real contact, often
    // 350+ ft — and every one scored 0, byte-identical to a whiff. The owner
    // played the shipped derby and scored 122 points with 1 home run over 24
    // pitches, and said "it's tough to hit". It was not them.
    expect(validateDerbyPayout(MAX_POINTS_PER_PITCH)).toEqual([]);

    // Exactly two outcomes pay nothing, and they are the two with no contact.
    for (const o of DERBY_OUTCOMES) {
      const paid = swingPoints(o, 400, false, MAX_POINTS_PER_PITCH, 1);
      expect(paid > 0, `${o} @ 400 ft`).toBe(o !== 'whiff' && o !== 'take');
    }

    // ⚠ THE CONTACT DATUM IS NOMINATED FROM THE FIELD, and the nomination is
    // asserted rather than left in a comment: it is the grass line at dead
    // centre, the 95 ft skinned-infield arc struck from the rubber. Move the
    // arc and this fails, which is the point — a ball that never reaches the
    // outfield grass is not solid contact.
    expect(CONTACT_DATUM_FT).toBeCloseTo(infieldDepthFt(0), 9);

    // ⚠ A BARREL IS WORTH SOMETHING, on every outcome that made contact. Without
    // this `BARREL_BONUS_POINTS = 0` passes the whole suite — `validateDerbyPayout`
    // only bounds the bonus from ABOVE, because its job is the worker's clamp.
    expect(BARREL_BONUS_POINTS).toBeGreaterThan(0);
    for (const o of ['homeRun', 'inPlay', 'foul'] as const) {
      const cap = MAX_POINTS_PER_PITCH;
      expect(swingPoints(o, 400, true, cap, 1), o).toBeGreaterThan(
        swingPoints(o, 400, false, cap, 1),
      );
    }

    // ⚠ AND `validateDerbyFormat` ACTUALLY SURFACES THE PAYOUT'S COMPLAINTS. The
    // format validator is what `resolveDerbyConfig` runs on the LIVE path, so
    // the wiring is load-bearing and is otherwise invisible: every payout
    // property here is also asserted by calling `validateDerbyPayout` directly,
    // which keeps passing with the call deleted from the format validator.
    //
    // ⚠ THE FIRST VERSION OF THIS ASSERTION WAS `…join(' | ')).toContain('cap')`
    // AND IT SURVIVED THAT MUTATION — the divisibility clause next door already
    // prints "(per-pitch cap 285.71…)", so the substring was there either way.
    // Asserting SUPERSET against the payout validator's own messages is what
    // separates "the format validator mentions a cap" from "the format
    // validator ran the payout validator".
    const payoutBad = validatePayoutCap(perPitchCap(7));
    expect(payoutBad.length, 'guard the guard: 7 must produce payout complaints').toBeGreaterThan(0);
    for (const msg of payoutBad) expect(validateDerbyFormat(DERBY_ROUNDS, 7)).toContain(msg);

    // A foul is the SAME ball, scaled. Asserted as the identity the constant's
    // comment claims, at every carry — not spot-checked.
    for (let c = 0; c <= 500; c += 25) {
      const fairRaw = Math.max(0, c - CONTACT_DATUM_FT) * CONTACT_POINTS_PER_FT;
      expect(swingPoints('foul', c, false, MAX_POINTS_PER_PITCH, 0)).toBe(
        Math.round(fairRaw * FOUL_CREDIT_FRACTION),
      );
    }

    const rows: string[] = [];
    for (const c of [120, 155.5, 200, 250, 300, 340, 380, 400, 420, 440]) {
      const cap = MAX_POINTS_PER_PITCH;
      rows.push(
        `  ${f(c, 6, 1)} ft | HR ${String(swingPoints('homeRun', c, false, cap, 1)).padStart(3)}` +
          ` (barrel ${String(swingPoints('homeRun', c, true, cap, 1)).padStart(3)})` +
          ` (chained ${String(swingPoints('homeRun', c, true, cap, 99)).padStart(3)})` +
          ` | inPlay ${String(swingPoints('inPlay', c, false, cap, 0)).padStart(3)}` +
          ` (barrel ${String(swingPoints('inPlay', c, true, cap, 0)).padStart(3)})` +
          ` | foul ${String(swingPoints('foul', c, false, cap, 0)).padStart(3)}` +
          ` | whiff ${swingPoints('whiff', c, true, cap, 99)}`,
      );
    }
    console.log('\nPAYOUT LADDER — every outcome, by projected carry\n' + rows.join('\n'));
  });

  it('⚠ the format validator BITES, and the config path actually calls it', () => {
    // ⚠ THE DIVISIBILITY CHECK COULD NOT FIRE. It was written as
    // `perPitch * perRound !== DERBY_POINTS_PER_ROUND`, and (4000/3)*3 is exactly
    // 2000 in IEEE-754 — so 3, 6, 7 and 9 pitches all PASSED while producing a
    // fractional per-pitch cap, which the worker (`Number.isInteger`) would then
    // reject on the wire. Every one of these is now caught.
    for (const per of [3, 6, 7, 9, 11, 12, 13]) {
      expect(Number.isInteger(DERBY_POINTS_PER_ROUND / per)).toBe(false);
      expect(validateDerbyFormat(DERBY_ROUNDS, per).length).toBeGreaterThan(0);
      // …and the arithmetic the old check used really does say they are fine:
      expect((DERBY_POINTS_PER_ROUND / per) * per).toBe(DERBY_POINTS_PER_ROUND);
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

  it('⚠ no achievable input can put a round over DERBY_POINTS_PER_ROUND', () => {
    // Three legs, and all three are needed because the first two are arithmetic
    // and the third is the only one that sees the wiring.
    //
    // (1) NO swing can pay more than the per-pitch cap — for EVERY outcome, not
    //     just for a home run, and at inputs no physics can reach. This is the
    //     leg that had to change when the payout stopped being home-run-only:
    //     the worker rejects on the SUBMITTED TOTAL, so the property has to be
    //     universally quantified over the outcome enum.
    for (const o of DERBY_OUTCOMES) {
      for (const carry of [0, 350, 400, 500, 1000, 1e9, Number.MAX_SAFE_INTEGER, Infinity]) {
        for (const b of [false, true]) {
          const p = swingPoints(o, carry, b, MAX_POINTS_PER_PITCH, 99);
          expect(p, `${o} @ ${carry} barrel=${b}`).toBeLessThanOrEqual(MAX_POINTS_PER_PITCH);
          expect(Number.isInteger(p), `${o} @ ${carry} barrel=${b}`).toBe(true);
        }
      }
    }
    // (2) The cap re-derives from the CONFIG, so an overridden pitch count
    //     cannot break the round ceiling either — again over every outcome.
    for (const per of [1, 2, 4, 5, 8, 10, 20]) {
      for (const o of DERBY_OUTCOMES) {
        expect(swingPoints(o, 1e9, true, perPitchCap(per), 1e9) * per).toBeLessThanOrEqual(
          DERBY_POINTS_PER_ROUND,
        );
      }
    }
    // (2b) …and through the SIM, not just the function. Without this leg the
    //      config-derived cap is unobservable: nothing else overrides the pitch
    //      count, so reading the constant instead would pass every other test.
    const wide = new DerbySim({ seed: 9, pitchesPerRound: 20, rounds: 1, batSpeedMph: 130 });
    while (wide.getState().phase !== 'done') {
      const pr = wide.servePitch();
      wide.setReticle(pr.plate.x + 0.45, pr.plate.h);
      wide.swing(pr.plate.t - 0.002);
      expect(wide.getState().roundScore).toBeLessThanOrEqual(DERBY_POINTS_PER_ROUND);
    }
    expect(wide.getState().score).toBeLessThanOrEqual(DERBY_POINTS_PER_ROUND);

    // (3) Play real sessions at absurd bat speeds — the only reachable dial that
    //     grows carry — and check the invariant after EVERY swing, partial
    //     rounds included, against the clamp the worker actually applies.
    const rows: string[] = [];
    let shipWorstRound = 0;
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
          expect(st.roundScore).toBeLessThanOrEqual(DERBY_POINTS_PER_ROUND);
          expect(st.score).toBeLessThanOrEqual(st.roundsPlayed * DERBY_POINTS_PER_ROUND);
          worstRound = Math.max(worstRound, st.roundScore, ...st.roundScores);
          if (r.outcome === 'homeRun') {
            hrs++;
            bestHr = Math.max(bestHr, r.distFt);
          }
        }
      }
      rows.push(
        `  bat ${f(bat, 5, 1)} mph | best HR ${f(bestHr, 6, 1)} ft | ${String(hrs).padStart(2)} HR ` +
          `| worst round ${String(worstRound).padStart(5)} / ${DERBY_POINTS_PER_ROUND} ` +
          `(${f((100 * (DERBY_POINTS_PER_ROUND - worstRound)) / DERBY_POINTS_PER_ROUND, 5, 1)} % headroom)`,
      );
      if (bat === BAT_SPEED_MPH) shipWorstRound = worstRound;
    }
    console.log(
      '\nCLAMP HEADROOM — a maximum-effort session at each bat speed\n' +
        rows.join('\n') +
        `\n  ⚠ THE SHIPPING ROW IS THE ONE WITH A BOUND ON IT. The absurd-bat rows are\n` +
        `  proof the cap holds AT saturation; the 71.5 row is the CARD BUDGET — the\n` +
        `  room a future bat-speed modulator has before the clamp starts eating it.`,
    );
    // ⚠ THE CARD BUDGET, ASSERTED. `baseball-progression`'s card stats are
    // modulators on physics constants (bat speed raises exit velocity raises
    // carry raises points), so a payout that already saturates the round ceiling
    // at the SHIPPING bat speed makes every future card worth nothing. The
    // shipping build before the chain multiplier kept 32.3 % of headroom here;
    // this bound is deliberately looser than that (25 %) so the knobs have room
    // to move, and deliberately tighter than "under the cap" so they cannot move
    // all the way to saturation without failing. `CHAIN_STEP = 0.5` fails it.
    expect(shipWorstRound, 'the shipping row measured nothing').toBeGreaterThan(0);
    expect(shipWorstRound).toBeLessThan(0.75 * DERBY_POINTS_PER_ROUND);
  });

  it('⚠ a MAXIMAL session survives the worker’s OWN acceptance predicate', () => {
    // ⚠ THIS IS THE LEG THE M2c BUG GOT THROUGH. The three legs above check the
    // sim's own counters against its own mirrored constants — which is exactly
    // what was green when `bestStreak` shipped over the worker's bound and every
    // over-cap submission vanished with no UI signal, because
    // `DerbyGame.bank()` swallows the 400 with `.catch(() => undefined)`.
    //
    // So this one evaluates the worker's predicate on the body `bank()` actually
    // posts. It is the only assertion in the file that can see a payout change
    // breaking submission.
    //
    // ⚠ EXACTLY HOW MUCH OF IT COMES FROM THE WORKER, stated precisely — an
    // earlier draft of this comment said the predicate was "reconstructed from
    // the worker's source text", which is generous. THREE INTEGERS are read out
    // of `games.ts` (the same read `tuning.test.ts` uses, for the same reason:
    // the two packages deploy independently and must not share a module); the
    // SHAPE of `workerAccepts` below is a HAND TRANSCRIPTION of
    // `roundsAndStreakValid` plus the score clamp, faithful as of this pass and
    // able to drift silently if the worker's logic changes.
    //
    // The source read is not decoration and was mutation-checked: reformatting
    // the worker to `export const MAX_ROUNDS: number = 8;` fails 2 tests loudly
    // (the `readConst` guard), and changing the worker's 2000 to 200 fails 1.
    // What it CANNOT see is the worker TIGHTENING its logic — `rounds *
    // (DERBY_POINTS_PER_ROUND / 2)` fails 0 tests here. That half is covered on the
    // worker side by `games.test.ts`, which is where a transcription belongs to
    // be checked; this is the client half of a pincer, not the whole of it.
    const workerSrc = readFileSync(WORKER_GAMES, 'utf8');
    const readConst = (name: string): number => {
      const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`).exec(workerSrc);
      // Guard the guard: a rename on the worker side must fail HERE, loudly.
      expect(m, `${name} not found in the worker source — regex stale?`).not.toBeNull();
      return Number(m![1]);
    };
    const wMaxRounds = readConst('MAX_ROUNDS');
    const wPerRound = readConst('DERBY_POINTS_PER_ROUND');
    const wArcadePerRound = readConst('MAX_POINTS_PER_ROUND');
    const wPitches = readConst('DERBY_PITCHES_PER_ROUND');
    // The client's format must be the one the worker's streak bound assumes.
    expect(wPitches).toBe(PITCHES_PER_ROUND);
    // ⚠ AND THE DERBY'S POINTS CEILING MUST BE THE DERBY'S OWN. Reading
    // MAX_POINTS_PER_ROUND here as well is what makes "the worker branches"
    // observable from this side: if somebody collapses the branch and raises the
    // shared constant instead, the two reads become equal and this fails.
    expect(wArcadePerRound).toBeLessThan(wPerRound);
    expect(wPerRound).toBe(DERBY_POINTS_PER_ROUND);
    expect(workerSrc).toContain(
      "game === 'bbderby' ? DERBY_POINTS_PER_ROUND : MAX_POINTS_PER_ROUND",
    );

    /**
     * `games.ts`'s `roundsAndStreakValid` + its score clamp, HAND-TRANSCRIBED —
     * only `wMaxRounds`, `wPerRound` and `wPitches` come from the worker source.
     */
    const workerAccepts = (b: { score: number; rounds: number; bestStreak: number }): boolean =>
      Number.isInteger(b.rounds) &&
      Number.isInteger(b.bestStreak) &&
      b.rounds >= 1 &&
      b.rounds <= wMaxRounds &&
      b.bestStreak >= 0 &&
      b.bestStreak <= b.rounds * wPitches &&
      Number.isInteger(b.score) &&
      b.score >= 0 &&
      b.score <= b.rounds * wPerRound;
    // Prove the predicate can REFUSE, or "it accepted" means nothing.
    expect(workerAccepts({ score: 1, rounds: 1, bestStreak: 0 })).toBe(true);
    expect(workerAccepts({ score: wPerRound + 1, rounds: 1, bestStreak: 0 })).toBe(false);
    expect(workerAccepts({ score: 1, rounds: 1, bestStreak: wPitches + 1 })).toBe(false);
    expect(workerAccepts({ score: 1.5, rounds: 1, bestStreak: 0 })).toBe(false);

    // Drive the score as high as this game can go: absurd bat speed, reticle
    // shaded to the pull side, tapped a shade early — the corner the sweeps
    // below say is the maximum — and submit after EVERY swing, partial rounds
    // included, because that is what the abandon net does.
    const rows: string[] = [];
    let shipPeak = 0;
    let worstPeak = 0;
    for (const bat of [undefined, 90, 105, 130, 200]) {
      let peak = 0;
      let bestStreak = 0;
      for (const seed of [1, 2, 3, 4, 5]) {
        const sim = new DerbySim({ seed, ...(bat === undefined ? {} : { batSpeedMph: bat }) });
        while (sim.getState().phase !== 'done') {
          const pr = sim.servePitch();
          sim.setReticle(pr.plate.x + 0.3, pr.plate.h);
          sim.swing(pr.plate.t - 0.002);
          const st = sim.getState();
          const body = { score: st.score, rounds: st.roundsPlayed, bestStreak: st.bestStreak };
          expect(workerAccepts(body), `bat ${bat} seed ${seed}: ${JSON.stringify(body)}`).toBe(true);
          peak = Math.max(peak, st.score / (st.roundsPlayed * wPerRound));
          bestStreak = Math.max(bestStreak, st.bestStreak);
        }
      }
      if (bat === undefined) shipPeak = peak;
      worstPeak = Math.max(worstPeak, peak);
      rows.push(
        `  bat ${(bat === undefined ? `${BAT_SPEED_MPH} (shipping)` : String(bat)).padStart(16)} mph` +
          ` | peak ${f(100 * peak, 6, 1)} % of rounds × ${wPerRound}` +
          ` | headroom ${f(100 * (1 - peak), 5, 1)} %` +
          ` | longest chain ${String(bestStreak).padStart(2)}`,
      );
    }
    console.log(
      `\nWORKER CLAMP — a maximal session against the worker's OWN predicate\n` +
        rows.join('\n') +
        `\n  Every submission above was ACCEPTED, and no row exceeded 100 %: that is the\n` +
        `  STRUCTURAL cap (pitchesPerRound × perPitchCap ≡ DERBY_POINTS_PER_ROUND) doing\n` +
        `  its job — the worker's bound is ≤, so exactly full is fine and one point more\n` +
        `  is a silent 400. The chain multiplier is INSIDE that clamp, so it cannot\n` +
        `  break it however long the run gets.\n` +
        `  ⚠ THE 200 mph ROW IS NOT THE HARDEST CASE and stopped being it here: at that\n` +
        `  bat speed the ball apexes past the 282 ft roof, is ruled 'roof' rather than a\n` +
        `  home run, and so earns the CONTACT curve and NO chain at all. 105–130 mph is\n` +
        `  where the payout actually peaks.`,
    );
    // The shipping config keeps real headroom — the absurd-bat rows are proof
    // the cap holds at saturation, this is proof the game is nowhere near it.
    expect(shipPeak).toBeLessThan(1);
    // ⚠ AND NOTHING, AT ANY REACHABLE BAT SPEED, GOES OVER. `workerAccepts`
    // above already refuses `score > rounds × wPerRound`, so this is the same
    // property said as a number the printed table can be read against.
    expect(worstPeak).toBeLessThanOrEqual(1);
  });
});

describe('derby — the chain multiplier', () => {
  it('⚠ the ramp is a RUN of home runs, and an isolated one pays what it always did', () => {
    // (1) THE RAMP, SPELLED OUT AS LITERALS. Not `1 + CHAIN_STEP * (k - 2)` —
    //     that is the implementation, and a test that recomputes it passes for
    //     every value of every constant in it, which is this suite's named
    //     failure mode. These are the numbers a player experiences.
    expect(chainMultiplier(1)).toBe(1);
    expect(chainMultiplier(2)).toBe(1);
    expect(chainMultiplier(3)).toBe(1.25);
    expect(chainMultiplier(4)).toBe(1.5);
    expect(chainMultiplier(5)).toBe(1.75);
    expect(chainMultiplier(6)).toBe(2);
    expect(chainMultiplier(24)).toBe(2);
    expect(CHAIN_MULT_MAX).toBe(2);
    expect(CHAIN_START).toBe(3);

    // (2) A NON-HOME-RUN NEVER READS IT — the structural half of "skill, not
    //     volume". A player who puts 24 balls in play earns no multiplier, and
    //     that is not a rule written anywhere, it is `swingPoints` not passing
    //     the index into the contact curve.
    const cap = MAX_POINTS_PER_PITCH;
    for (const o of ['inPlay', 'foul', 'whiff', 'take'] as const) {
      for (const k of [0, 1, 3, 6, 24]) {
        expect(swingPoints(o, 420, true, cap, k), `${o} @ chain ${k}`).toBe(
          swingPoints(o, 420, true, cap, 0),
        );
      }
    }
    // …and prove the probe can see a difference at all, or the loop above is
    // satisfied by a scorer that ignores the chain entirely.
    expect(swingPoints('homeRun', 420, true, cap, 6)).toBeGreaterThan(
      swingPoints('homeRun', 420, true, cap, 1),
    );

    // (3) THE GOLDEN THE BOTTOM OF THE CURVE RESTS ON. An isolated home run pays
    //     EXACTLY the pre-chain payout — `HR_BASE_POINTS + (carry − datum) +
    //     barrel` — so "the novice and casual rows do not move" is a property of
    //     the code and not of a session average. A base cut to fund the
    //     multiplier (the alternative this design rejected) fails right here.
    for (const c of [350, 380, 400, 415, 440]) {
      for (const b of [false, true]) {
        const expected = Math.round(
          HR_BASE_POINTS + (c - DISTANCE_DATUM_FT) * 1 + (b ? BARREL_BONUS_POINTS : 0),
        );
        expect(swingPoints('homeRun', c, b, cap, 1), `${c} ft barrel=${b}`).toBe(expected);
        expect(swingPoints('homeRun', c, b, cap, 2), `${c} ft barrel=${b}`).toBe(expected);
      }
    }
    expect(POINTS_PER_FT).toBe(1);

    // (4) THE CHAIN IS THE SIM'S OWN COUNTER, READ ONE AHEAD — and `predict()`
    //     must not move it. This is the wiring `swingPoints` cannot see.
    const sim = new DerbySim({ seed: 5150 });
    sim.curStreak = 5;
    const before = sim.curStreak;
    sim.servePitch();
    sim.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
    const p = sim.predict(sim.served!.result.plate.t);
    expect(sim.curStreak, 'predict() moved the streak').toBe(before);
    expect(p.chainIndex).toBe(p.outcome === 'homeRun' ? before + 1 : 0);

    const rows: string[] = [];
    for (let k = 1; k <= 7; k++) {
      rows.push(
        `  HR #${k} of a run  ×${chainMultiplier(k).toFixed(2)}  ` +
          `⇒ a barrelled 415 ft ball pays ${swingPoints('homeRun', 415, true, cap, k)} / ${cap}`,
      );
    }
    console.log('\nCHAIN — the multiplier on consecutive home runs\n' + rows.join('\n'));
  });

  it('⚠ THE SKILL CURVE — the chain is worth nothing at the bottom and everything at the top', () => {
    // ⚠ THE MEASUREMENT THIS WHOLE PASS EXISTS FOR. A gaussian player: timing
    // error drawn in the player's WALL milliseconds (`PITCH_TEMPO` converts it
    // to the true physical seconds the sim takes — the thumb lives in wall time
    // and that is the axis a difficulty is stated on), aim error drawn in feet
    // on both reticle axes, 40 sessions per skill, MEDIAN session score.
    //
    // ⚠ THE AIM/TIMING TIE IS A MODEL AND IS STATED HERE RATHER THAN HIDDEN:
    // aim σ = 0.010 ft per ms of timing σ, i.e. a player 45 ms loose on the tap
    // is also 5.4 in loose with the reticle. It is a reconstruction of the model
    // the M2 review reported against, not that script — it reproduces the six
    // reported post-M2 figures (744/1606/2979/3531/3678/3742) to 5.3 % RMS,
    // which is close enough to compare curves and not close enough to quote
    // absolute numbers from somebody else's harness.
    //
    // Both columns are scored from the SAME 240 sessions: `chain` is what the
    // sim paid, `flat` re-scores every swing at chain position 1. So the two
    // differ by the mechanic and by nothing else — not by a different seed, a
    // different draw or a different physics.
    const cap = MAX_POINTS_PER_PITCH;
    const SKILLS = [
      { name: 'novice ', ms: 45 },
      { name: 'casual ', ms: 30 },
      { name: 'decent ', ms: 18 },
      { name: 'good   ', ms: 10 },
      { name: 'expert ', ms: 5 },
      { name: 'perfect', ms: 0 },
    ];
    const chainMed: Record<string, number> = {};
    const flatMed: Record<string, number> = {};
    const rows: string[] = [];
    for (const sk of SKILLS) {
      const aimFt = sk.ms * 0.01;
      const chain: number[] = [];
      const flat: number[] = [];
      let neverWorse = true;
      let clipped = 0;
      let swings = 0;
      for (let i = 0; i < 40; i++) {
        const g = gaussian((1000 + i) * 7919 + 13);
        const sim = new DerbySim({ seed: 1000 + i });
        let cs = 0;
        let fs = 0;
        while (sim.getState().phase !== 'done') {
          const pr = sim.servePitch();
          sim.setReticle(pr.plate.x + g() * aimFt, pr.plate.h + g() * aimFt);
          const r = sim.swing(pr.plate.t + ((g() * sk.ms) / 1000) * PITCH_TEMPO);
          cs += r.points;
          fs += swingPoints(r.outcome, r.distFt, r.barrel, cap, 1);
          swings++;
          // ⚠ DID THE CLAMP BIND? Asked by scoring the SAME swing against an
          // unreachable cap and comparing, so nothing here re-implements the
          // payout — the difference is the clamp and only the clamp.
          if (swingPoints(r.outcome, r.distFt, r.barrel, 1e9, r.chainIndex) !== r.points) clipped++;
        }
        if (cs < fs) neverWorse = false;
        chain.push(cs);
        flat.push(fs);
      }
      // ⚠ THE MULTIPLIER IS NEVER A PENALTY, per SESSION, not on average.
      expect(neverWorse, `${sk.name}: a session scored less WITH the chain`).toBe(true);
      // ⚠ AND THE PER-PITCH CLAMP MUST NOT BIND IN REAL PLAY, AT ANY SKILL.
      // This is the assertion that makes the chain knobs sweepable: raise
      // `CHAIN_STEP` to 0.5 or `CHAIN_MAX_STEPS` to 8 and the clamp starts
      // clipping 2–7 % of home runs, at which point the top of the curve is
      // being set by the submission ceiling rather than by the payout — the
      // mechanic goes flat again and nothing says so. `swings` is asserted
      // non-zero first so "0 clipped" cannot mean "0 measured".
      expect(swings, `${sk.name}: nothing was measured`).toBe(40 * 24);
      expect(clipped, `${sk.name}: the per-pitch clamp bound ${clipped}/${swings} times`).toBe(0);
      chainMed[sk.name.trim()] = median(chain);
      flatMed[sk.name.trim()] = median(flat);
      const c = median(chain);
      const fl = median(flat);
      rows.push(
        `  ${sk.name}  σt ${String(sk.ms).padStart(2)} ms  aim ${aimFt.toFixed(2)} ft |` +
          ` flat ${String(fl).padStart(6)} | chain ${String(c).padStart(6)} |` +
          ` chain is ${f((100 * (c - fl)) / c, 5, 1)} % of it`,
      );
    }
    const ratio = (a: Record<string, number>, hi: string, lo: string) => a[hi]! / a[lo]!;
    console.log(
      '\nSKILL CURVE — median of 40 sessions per row, same sessions scored both ways\n' +
        rows.join('\n') +
        `\n  good → perfect   flat ${ratio(flatMed, 'perfect', 'good').toFixed(3)}×` +
        `   chain ${ratio(chainMed, 'perfect', 'good').toFixed(3)}×` +
        `\n  decent → good    flat ${ratio(flatMed, 'good', 'decent').toFixed(3)}×` +
        `   chain ${ratio(chainMed, 'good', 'decent').toFixed(3)}×` +
        `\n  novice → perfect flat ${ratio(flatMed, 'perfect', 'novice').toFixed(2)}×` +
        `   chain ${ratio(chainMed, 'perfect', 'novice').toFixed(2)}×`,
    );

    // ⚠ THE DEFECT, ASSERTED. Without the chain an expert and a perfect player
    // are the same player: the flat column's good→perfect is under 1.06. If this
    // ever stops being true the mechanic's justification has gone with it, and
    // that is worth failing over rather than quietly keeping a multiplier
    // nothing needs.
    expect(ratio(flatMed, 'perfect', 'good')).toBeLessThan(1.06);
    // …and with it, there is something at the top to chase.
    expect(ratio(chainMed, 'perfect', 'good')).toBeGreaterThan(1.1);
    // The rung below moved too — this is a ladder, not one raised step.
    expect(ratio(chainMed, 'good', 'decent')).toBeGreaterThan(1.3);

    // ⚠ THE BOTTOM DID NOT PAY FOR IT. The novice row is BYTE-IDENTICAL to the
    // flat payout — a novice reaches a third consecutive home run 0.05 times a
    // session — and the casual row (the owner's measured skill: 7 HR, best
    // streak 3) gains a little and loses nothing. A design that funded the
    // multiplier by cutting the base payout fails both of these.
    expect(chainMed.novice).toBe(flatMed.novice);
    expect(chainMed.casual).toBeGreaterThanOrEqual(flatMed.casual!);
    expect((chainMed.casual! - flatMed.casual!) / chainMed.casual!).toBeLessThan(0.05);
    // …while at the top it is a quarter of the money.
    expect((chainMed.perfect! - flatMed.perfect!) / chainMed.perfect!).toBeGreaterThan(0.2);
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

    // ⚠ AND THE COPY GOES ALL THE WAY DOWN, WHICH THE SPREAD DID NOT. `last`
    // was copied with `{ ...s.last }` — SHALLOW — so `flight`, its `landing`
    // and its four sample arrays stayed ALIASED across the live sim,
    // `getState()` and `snapshot()`. The assertions above could not see it
    // because every one of them mutates a SCALAR, which is exactly the shape
    // that let `roundScores` rot. `derbyState.copySwing` closes it; these two
    // lines are what fail if anyone re-flattens it.
    const flightSim = new DerbySim({ seed: 20260816 });
    while (flightSim.last?.flight == null && flightSim.phase !== 'done') {
      const pr = flightSim.servePitch();
      flightSim.setReticle(pr.plate.x, pr.plate.h);
      flightSim.swing(pr.plate.t);
    }
    // Guard the guard: no batted flight means every line below is vacuous.
    expect(flightSim.last?.flight, 'no batted flight was produced').toBeTruthy();
    const trueCarry = flightSim.last!.flight!.carryFt;
    const trueX0 = flightSim.last!.flight!.track.x[0]!;
    const leakedFlight = flightSim.getState().last!.flight!;
    leakedFlight.carryFt = -1;
    leakedFlight.track.x[0] = -1;
    leakedFlight.landing.x = -1;
    expect(flightSim.last!.flight!.carryFt).toBe(trueCarry);
    expect(flightSim.last!.flight!.track.x[0]).toBe(trueX0);
    expect(flightSim.last!.flight!.landing.x).not.toBe(-1);
    // …and the snapshot's copy is independent of the live flight too.
    const snapFlight = flightSim.snapshot().last!.flight!;
    snapFlight.track.y[0] = -1;
    expect(flightSim.last!.flight!.track.y[0]).not.toBe(-1);

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
    // ⚠ AND THE NUMBER IS NOW EXPORTED, BECAUSE IT IS DRAWN. `TimingBar` paints
    // the contact band, and it painted `const CONTACT_MS = 26.4` — a figure that
    // existed in `lib/baseball` only as this `console.log`'s output. Nothing
    // connected the two, so a change to `contactGeometry` or to the bat's length
    // would move the real window and leave the drawn band lying about it.
    // `contactWindowS` inverts `contactGeometry` instead; this is the assertion
    // that says the inversion and the live `predict()` path agree.
    const derivedMs = contactWindowS(vLen(pr.plate.v)) * 1000;
    console.log(
      `\nTIMING WINDOW (derived from the bat's length, no knob)\n` +
        `  contact from ${lo.toFixed(1)} ms early to ${hi.toFixed(1)} ms late; ` +
        `half-width ${((lo + hi) / 2).toFixed(1)} ms, asymmetry ${(hi - lo).toFixed(2)} ms\n` +
        `  contactWindowS(${vLen(pr.plate.v).toFixed(2)} ft/s) = ${derivedMs.toFixed(4)} ms ` +
        `— what shared/TimingBar.tsx draws`,
    );
    // The sweep steps 0.1 ms and reports the last value INSIDE the window, so
    // the true edge is in [lo, lo + 0.1). One sweep step is the whole tolerance.
    expect(derivedMs).toBeGreaterThanOrEqual(lo);
    expect(derivedMs).toBeLessThan(lo + 0.1);
    expect(derivedMs).toBeGreaterThanOrEqual(hi);
    expect(derivedMs).toBeLessThan(hi + 0.1);

    // ⚠ AND IT MOVES WITH THE PITCH — the other half of why it cannot be a
    // constant, and the direction is the opposite of the plausible guess. From
    // `contactGeometry`, θ_c = ω·Δt·v_p/(ω·d + v_p), which is INCREASING in
    // v_p: a faster ball reaches the bat sooner after the mistimed swing
    // started, so the bat is further off square when they meet, so contact is
    // further out the barrel. A fast pitch therefore has a NARROWER window, not
    // a wider one — mistiming a fastball costs more than mistiming a curveball,
    // which is the right answer for the right reason. (This assertion was
    // written the other way round first and failed; the arithmetic is the
    // authority, not the intuition.) A hand-copied 26.4 ms was one pitch's
    // answer standing in for all eight.
    const slow = contactWindowS(72 * 1.4666667) * 1000;
    const fast = contactWindowS(96 * 1.4666667) * 1000;
    expect(fast).toBeLessThan(slow);
    console.log(
      `  and it is a function of the pitch — FASTER is NARROWER: ` +
        `${slow.toFixed(2)} ms at 72 mph (a curveball at the plate), ` +
        `${fast.toFixed(2)} ms at 96 mph`,
    );

    // ⚠ AND OF THE BAT, which is the argument `DerbyGame` threads from
    // `DerbySim.cfg.batSpeedMph` — the hook every card/fatigue modulator will
    // reach for. It was a parameter nothing exercised: no shipping config sets
    // the field, so both the HUD and its test took the default and agreed by
    // accident. Drive it here instead, where the default is not in the way.
    //
    // Same mechanism as the pitch-speed leg, same direction, and the same
    // counter-intuitive answer: θ_c = ω·Δt·v_p/(ω·d + v_p) is INCREASING in ω
    // (∂/∂ω = v_p/(ω·d + v_p)² > 0), so a faster bat is further off square when
    // it meets the ball and contact sits further out the barrel. Swinging harder
    // narrows the window it can be swung in. The band the HUD draws must shrink
    // with it; drawing the published swing's band for a 130 mph bat would be the
    // widget lying by 6.5 ms.
    const v = vLen(pr.plate.v);
    const light = contactWindowS(v, 55) * 1000;
    const heavy = contactWindowS(v, 130) * 1000;
    expect(heavy).toBeLessThan(derivedMs);
    expect(derivedMs).toBeLessThan(light);
    // …and `undefined` means THE PUBLISHED SWING, not "some default" — the two
    // are the same call, so a config that leaves the field unset is not a
    // different physics from one that sets it to 71.5.
    expect(contactWindowS(v, BAT_SPEED_MPH)).toBe(contactWindowS(v));
    console.log(
      `  and of the BAT — HARDER is NARROWER too: ` +
        `${light.toFixed(2)} ms at 55 mph, ${derivedMs.toFixed(2)} at the published ` +
        `${BAT_SPEED_MPH}, ${heavy.toFixed(2)} at 130`,
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

  it('⚠ the timing CLIFF is a SLOPE — measured in WALL ms, in POINTS', () => {
    // ⚠ THE SWEEP ABOVE COULD NOT SEE THIS DEFECT AND THIS ONE IS ITS COMPLEMENT.
    // It measures HOME-RUN RATE at TRUE physical offsets with the reticle ON the
    // ball. The owner does not live in either of those: he lives in WALL ms
    // (the tempo divides the window his thumb has) and he is scored in POINTS,
    // and M2's payout paid nothing for anything but a home run. Measured on the
    // shipped build — reticle at zone centre, tap biased by a constant WALL
    // offset, 40 sessions per row:
    //
    //     bias  -45 ms | HR  0 % foul 92 % | score      0
    //     bias  -30 ms | HR 69 % inPlay 29 | score  84440
    //     bias    0 ms | HR 30 % inPlay 70 | score  45775   ← the trough
    //     bias  +30 ms | HR 75 % inPlay 18 | score  93698
    //     bias  +45 ms | HR  0 % foul 95 % | score      0
    //
    // 75 % home runs to a hard zero in 15 ms of wall clock, with 95 % of the
    // dead rows STILL MAKING CONTACT. That is a payout problem, not a physics
    // one, and it is fixed in the payout.
    const rows: string[] = [];
    const byBias = new Map<number, number>();
    const SEEDS = 12;
    for (let wallMs = -75; wallMs <= 75; wallMs += 15) {
      let pts = 0;
      let contact = 0;
      let n = 0;
      for (let seed = 300; seed < 300 + SEEDS; seed++) {
        const sim = new DerbySim({ seed });
        while (sim.getState().phase !== 'done') {
          const pr = sim.servePitch();
          sim.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
          // ⚠ THE TEST IS THE ONE PLACE THE TEMPO MAY BE READ, because the thing
          // being measured is the PLAYER's window and the player taps a wall
          // clock. `trueS = wallS × PITCH_TEMPO` — the same MULTIPLY
          // `DerbyGame.trueTimeOf` performs, written once more here rather than
          // hidden inside a helper, because getting it backwards is the bug the
          // whole architecture exists to prevent.
          const r = sim.swing(pr.plate.t + (wallMs / 1000) * PITCH_TEMPO);
          pts += r.points;
          if (r.outcome !== 'whiff' && r.outcome !== 'take') contact++;
          n++;
        }
      }
      byBias.set(wallMs, pts / n);
      rows.push(
        `  ${String(wallMs).padStart(4)} ms wall (${f((wallMs * PITCH_TEMPO) / 1000, 7, 4)} s true)` +
          ` | contact ${f((100 * contact) / n, 5, 1)} % | ${f(pts / n, 6, 1)} pts/swing`,
      );
    }
    const peak = Math.max(...byBias.values());
    console.log(
      `\nTIMING CLIFF → SLOPE — constant WALL bias, reticle at ZONE CENTRE, ` +
        `${SEEDS} seeds × 24 swings/row, PITCH_TEMPO ${PITCH_TEMPO}\n` +
        rows.join('\n') +
        `\n  peak ${peak.toFixed(1)} pts/swing. The worst of ±45 ms pays ` +
        `${((100 * Math.min(byBias.get(-45)!, byBias.get(45)!)) / peak).toFixed(1)} % of it ` +
        `(was 0 %), ±60 pays ` +
        `${((100 * Math.min(byBias.get(-60)!, byBias.get(60)!)) / peak).toFixed(1)} %, ` +
        `and the dead-centre trough at 0 ms pays ` +
        `${((100 * byBias.get(0)!) / peak).toFixed(1)} % (was 48.9 %).`,
    );

    // ⚠ THIS TEST IS TEMPO-DEPENDENT, ON PURPOSE, AND IT IS THE ONLY ONE THAT
    // IS. Every other assertion in the game is stated in TRUE physical time, so
    // `PITCH_TEMPO` is free to turn and a source guard proves the sim cannot
    // read it. This one is stated in the player's WALL ms, because the claim is
    // about the window his thumb actually gets — and that window is
    // `contactWindowS / PITCH_TEMPO`. Reverting the knob to M2's 0.55 fails leg
    // (1) below at ±60 ms with "expected 0 to be greater than 0", which is the
    // measured justification for the 0.45 the feel pass shipped: 22 % more wall
    // clock, and the ±60 row goes from a hard zero to 4–5 % of peak.
    //
    // (1) THE SLOPE. A swing 60 wall-ms off still makes contact on most pitches,
    //     so it must still pay — this is the assertion the shipped build failed
    //     at exactly 0 from ±45 outward.
    for (const ms of [-60, -45, -30, -15, 0, 15, 30, 45, 60]) {
      expect(byBias.get(ms)!, `${ms} ms wall pays nothing`).toBeGreaterThan(0);
    }
    // (2) THE SLOPE HAS AN END, AND IT IS THE BAT, NOT THE PAYOUT. ±75 wall ms
    //     is ±33.8 ms of TRUE time against a ~26 ms contact window, so there is
    //     no contact at all and nothing to pay for. If this ever pays, something
    //     is scoring a whiff — which is the one thing `swingPoints` must never
    //     do, and the reason `validateDerbyPayout` sweeps whiff/take separately.
    for (const ms of [-75, 75]) expect(byBias.get(ms)!).toBe(0);
    // (3) IT IS STILL A SLOPE, NOT A PLATEAU. Being 60 ms out must cost most of
    //     the payout, or timing has stopped being the game.
    expect(Math.max(byBias.get(-60)!, byBias.get(60)!)).toBeLessThan(0.35 * peak);
    // (4) AND THE TROUGH AT DEAD CENTRE IS SOFTENED, NOT INVERTED. Perfect
    //     timing with a dead-centre reticle is still beaten (that is FINDING 3,
    //     the park's deepest wall, and it is real baseball) — but no longer by
    //     the 2.2× the home-run-only payout gave it.
    //
    //     ⚠ THE CHAIN MULTIPLIER GAVE SOME OF THIS BACK, MEASURED: 76.5 % of
    //     peak before it, 70.7 % after (peak/trough 1.31× → 1.41×, against the
    //     home-run-only payout's 2.2×). That is not a bug in the chain, it is
    //     the chain doing exactly what it is for — it is SUPERLINEAR in home-run
    //     rate, so it re-amplifies every home-run-rate gap it finds, and this
    //     row's gap is a real one (FINDING 3: a dead-centre reticle at perfect
    //     timing sprays at the park's 400 ft + 10 ft wall and clears it 54.9 %
    //     of the time, against 96 % from a reticle 0.2 ft to the pull side). The
    //     honest statement is that the mechanic cannot tell a home-run-rate gap
    //     that comes from skill from one that comes from the park's geometry,
    //     and the fix for the second is the aim sweep next door, not the payout.
    //     The bound is loosened to 0.65 and NOT removed, so a collapse back
    //     toward the pre-M2 trough still fails here.
    expect(byBias.get(0)!).toBeLessThan(peak);
    expect(byBias.get(0)!).toBeGreaterThan(0.65 * peak);
  });

  it('⚠ FINDING 3: dead centre is the WORST viable aim, and the sweep is ASYMMETRIC', () => {
    // The reticle-X sweep at perfect timing, aiming at the pitch's own height.
    // This is the measurement `shared/swingCopy.coachSwing` quotes and the reason
    // the HUD teaches at all: the natural instinct — "aim at the middle, swing
    // on time" — is the worst placement that still makes contact, because dead
    // centre is the deepest wall in the park and nothing on screen said so.
    const rows: string[] = [];
    const hrByX = new Map<number, number>();
    const carryByX = new Map<number, number>();
    const SEEDS = 12;
    for (const rx of [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4]) {
      let hr = 0;
      let n = 0;
      let carry = 0;
      let carryN = 0;
      let spray = 0;
      for (let seed = 300; seed < 300 + SEEDS; seed++) {
        const sim = new DerbySim({ seed });
        while (sim.getState().phase !== 'done') {
          const pr = sim.servePitch();
          sim.setReticle(rx, pr.plate.h);
          const r = sim.swing(pr.plate.t);
          n++;
          if (r.outcome === 'homeRun') hr++;
          if (r.outcome === 'homeRun' || r.outcome === 'inPlay') {
            carry += r.distFt;
            spray += r.sprayDeg;
            carryN++;
          }
        }
      }
      hrByX.set(rx, hr / n);
      carryByX.set(rx, carryN ? carry / carryN : 0);
      rows.push(
        `  reticleX ${f(rx, 5, 2)} ft | HR ${f((100 * hr) / n, 5, 1)} % | ` +
          `carry ${carryN ? f(carry / carryN, 6, 1) : '   —  '} ft | ` +
          `spray ${carryN ? f(spray / carryN, 6, 1) : '   —  '}°`,
      );
    }
    console.log(
      `\nFINDING 3 — reticle X at PERFECT timing, aimed at the pitch's height ` +
        `(${SEEDS} seeds × 24)\n` +
        rows.join('\n'),
    );

    // (1) THE TRAP IS REAL. Dead centre is beaten by a shade in EITHER
    //     direction, which is park geometry (400 ft to centre, 375 to the gaps)
    //     and not a modelling accident — so the HUD's coaching line has
    //     something true to say.
    expect(hrByX.get(0)!).toBeLessThan(hrByX.get(0.2)!);
    expect(hrByX.get(0)!).toBeLessThan(hrByX.get(-0.3)!);

    // (2) ⚠ AND THE SWEEP IS ASYMMETRIC AT A SYMMETRIC PARK, which is a MODEL
    //     DEFECT and not a lesson. Harbourfront's ±22° samples are both 375 ft,
    //     so a symmetric mechanic would give symmetric rows; the + side wins,
    //     and it wins on CARRY. That is `eA` climbing toward the handle in a
    //     rigid bat with no `e(z)` — BASEBALL.md § "The collision", "the model
    //     has no jamming at all". Asserted so it cannot be quietly closed with a
    //     knob, and so the coaching copy keeps saying "off the middle" rather
    //     than "to the opposite field".
    expect(carryByX.get(0.2)!).toBeGreaterThan(carryByX.get(-0.2)!);
    console.log(
      `\n  ⚠ ASYMMETRY, and it is the missing e(z): ±0.2 ft at a park whose ±22° ` +
        `samples\n    are both 375 ft gives HR ${(100 * hrByX.get(-0.2)!).toFixed(1)} % / ` +
        `${(100 * hrByX.get(0.2)!).toFixed(1)} % and carry ` +
        `${carryByX.get(-0.2)!.toFixed(1)} / ${carryByX.get(0.2)!.toFixed(1)} ft.\n` +
        `    The + side aims AWAY from a RHB, which walks contact toward the HANDLE,\n` +
        `    where this model's eA rises instead of collapsing. The HUD teaches the\n` +
        `    symmetric half of this only.`,
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
    // ⚠ `bestFt` IS THE LONGEST HOME RUN, not the longest carry, and this filter
    // used to read `r.points > 0` — which was the same set only while home runs
    // were the only thing that scored. It is `outcome === 'homeRun'` now, which
    // is what `commit()` actually books and what the leaderboard column means.
    expect(st.bestFt).toBe(
      Math.max(...swings.filter((r) => r.outcome === 'homeRun').map((r) => r.distFt)),
    );
    expect(st.roundsPlayed).toBe(DERBY_ROUNDS);
    expect(() => sim.servePitch()).toThrow();

    // ⚠ `maxScore` IS THE DERBY'S CEILING, NOT THE ARCADE ONE, and this
    // assertion exists because it was a SURVIVING MUTATION: reverting
    // `derbyState.ts` to `roundsPlayed * 2000` failed 0 of 203 tests. It is the
    // number a HUD would print beside the score and the number a "you are at
    // 90 % of the cap" warning would ever be derived from, so a stale 2000 is a
    // readout that says a full session is 6000 when the worker will take 12000.
    // Written out (3 × 4000 = 12000) rather than computed from the constant, so
    // it cannot pass for every value of it — and the identity against the
    // per-pitch cap is asserted beside it, because THAT is the structural one.
    expect(st.maxScore).toBe(12000);
    expect(st.maxScore).toBe(st.roundsPlayed * PITCHES_PER_ROUND * MAX_POINTS_PER_PITCH);
    expect(st.score).toBeLessThanOrEqual(st.maxScore);
    // …and it tracks PARTIAL sessions, which is what `bank()` submits on abandon.
    const partial = new DerbySim({ seed: 8888 });
    partial.servePitch();
    partial.take();
    expect(partial.getState().maxScore).toBe(4000);

    // ⚠ THE HOME-RUN STREAK IS BOOKED HERE TOO, and it used to be the one
    // exception. `bestStreak` is submitted to the leaderboard beside `score`,
    // `homeRuns` and `bestFt`, but it lived in a `useRef` inside `DerbyGame` —
    // so it was outside `derbySnapshot`, outside the guard above, and
    // `restore()` could not round-trip it. Re-derived here from the swings, the
    // way the other four counters are.
    const longestRun = swings.reduce(
      (acc, r) => {
        const cur = r.outcome === 'homeRun' ? acc.cur + 1 : 0;
        return { cur, best: Math.max(acc.best, cur) };
      },
      { cur: 0, best: 0 },
    );
    expect(longestRun.best).toBeGreaterThan(0); // guard the guard
    expect(st.bestStreak).toBe(longestRun.best);
    expect(st.curStreak).toBe(longestRun.cur);

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
