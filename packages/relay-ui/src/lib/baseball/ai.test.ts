// The AI bench.
//
// `ai.ts` decides two things — what to throw and where, and whether to swing and
// when — and it does both for a difficulty parameter. So there are exactly three
// classes of thing to assert, and a decorative test would miss all of them:
//
//   1. THE STREAM. Every decision comes from the seeded draw and nothing else,
//      and it consumes a FIXED number of draws whatever it decides, so the pitch
//      after a swing does not depend on whether the previous batter swung.
//   2. DIFFICULTY REACHES BEHAVIOUR. The failure mode this file exists for is an
//      AI that accepts a difficulty and plays identically — which typechecks,
//      passes every band, and is not a difficulty setting at all. Every lever is
//      asserted to MOVE and to move in the right DIRECTION.
//   3. THE DECISIONS ARE BASEBALL. Swing at strikes, protect the plate with two,
//      sit on a 3-0, and work backwards when ahead in the count.
//
// The outcome distribution these produce is `duelSim.test.ts`'s bench; this file
// is about the decisions themselves, which is why it needs no trajectories and
// runs in milliseconds.

import { describe, expect, it } from 'vitest';
import {
  AI_AIM_CENTRE,
  AI_AIM_EDGE_STRONG,
  AI_AIM_EDGE_WEAK,
  AI_CHASE_BASE_FT,
  AI_COMMAND_SPREAD_STRONG,
  AI_COMMAND_SPREAD_WEAK,
  AI_DEFENSE_STRONG,
  AI_DEFENSE_WEAK,
  AI_DRAWS_PER_PITCH,
  AI_DRAWS_PER_SWING,
  AI_GUESS_SPREAD_H_FT,
  AI_READ_STRONG,
  AI_READ_WEAK,
  aiDefenseRating,
  aiPitchCommand,
  aiSwingDecision,
  pickPitch,
  putAway,
} from './ai';
import { DUEL_MIX, STRIKES_FOR_K } from './duelRules';
import { simDraw } from './rng';
import { PITCHES } from './pitches';
import { CALL_ZONE, ZONE_CENTER, isStrike, plateToReticle } from './zone';

/** A counting draw over the shared seeded stream. */
function stream(seed: number) {
  let s = seed >>> 0;
  let n = 0;
  return {
    draw: () => {
      n++;
      const d = simDraw(s);
      s = d.next;
      return d.value;
    },
    count: () => n,
  };
}

/** A pitch that has already crossed — the only thing the batter reads. */
const crossing = (x: number, h: number) => ({
  plateX: x,
  plateH: h,
  plateT: 0.41,
  plateSpeedFps: 126,
});

const MEAT = crossing(0, ZONE_CENTER.h);
/** Well outside the CALLED zone on both axes — nobody's strike. */
const WAY_OFF = crossing(CALL_ZONE.right + 1.2, CALL_ZONE.top + 1.2);

// ===========================================================================
describe('ai — the stream', () => {
  it('⚠ the draw count is FIXED per decision, whatever the decision is', () => {
    // A variable draw count couples the next pitch to the last batter's choice.
    const counts = [
      { balls: 0, strikes: 0 },
      { balls: 3, strikes: 0 },
      { balls: 0, strikes: 2 },
      { balls: 3, strikes: 2 },
    ];
    for (const c of counts) {
      for (const d of [0, 0.5, 1]) {
        const st = stream(1234 + c.balls * 7 + c.strikes);
        aiPitchCommand(st.draw, d, c);
        expect(st.count()).toBe(AI_DRAWS_PER_PITCH);
      }
    }
    // …and at the plate, whether it swings or takes.
    let sawSwing = false;
    let sawTake = false;
    for (let seed = 1; seed <= 60; seed++) {
      for (const ctx of [MEAT, WAY_OFF]) {
        const st = stream(seed * 31);
        const dec = aiSwingDecision(st.draw, 0.5, { balls: 0, strikes: 0, ...ctx });
        expect(st.count()).toBe(AI_DRAWS_PER_SWING);
        if (dec.swing) sawSwing = true;
        else sawTake = true;
      }
    }
    // Guard the guard: the loop must actually have exercised both branches.
    expect(sawSwing && sawTake).toBe(true);
  });

  it('the same stream replays the same decisions, and a different one does not', () => {
    const one = aiPitchCommand(stream(99).draw, 0.5, { balls: 1, strikes: 1 });
    expect(aiPitchCommand(stream(99).draw, 0.5, { balls: 1, strikes: 1 })).toEqual(one);
    expect(aiPitchCommand(stream(100).draw, 0.5, { balls: 1, strikes: 1 })).not.toEqual(one);
  });
});

// ===========================================================================
describe('ai — the pitcher', () => {
  it('every published pitch stays reachable, and the count TILTS the mix', () => {
    const tally = (difficulty: number, balls: number, strikes: number) => {
      const c: Record<string, number> = {};
      for (let i = 0; i <= 400; i++) {
        const id = pickPitch(i / 400, difficulty, { balls, strikes });
        c[id] = (c[id] ?? 0) + 1;
      }
      return c;
    };
    const even = tally(1, 0, 0);
    const ahead = tally(1, 0, 2);
    const easy = tally(0, 0, 0);
    // eslint-disable-next-line no-console
    console.log(
      '\n[AI ARSENAL — 401 evenly-spaced draws, counts by pitch]\n' +
        `  ${'pitch'.padEnd(6)}${'chase'.padStart(6)}${'0-0 hard'.padStart(10)}` +
        `${'0-2 hard'.padStart(10)}${'0-0 easy'.padStart(10)}\n` +
        DUEL_MIX.map(
          (m) =>
            `  ${m.id.padEnd(6)}${m.chase.toFixed(2).padStart(6)}` +
            `${String(even[m.id] ?? 0).padStart(10)}${String(ahead[m.id] ?? 0).padStart(10)}` +
            `${String(easy[m.id] ?? 0).padStart(10)}`,
        ).join('\n') +
        '\n',
    );
    // Content is DATA: no count and no difficulty may make a published pitch
    // unreachable, which is what keeps `pitches.ts` the one arsenal.
    for (const p of PITCHES) {
      expect(even[p.id], `${p.id} unreachable at 0-0`).toBeGreaterThan(0);
      expect(ahead[p.id], `${p.id} unreachable at 0-2`).toBeGreaterThan(0);
      expect(easy[p.id], `${p.id} unreachable at difficulty 0`).toBeGreaterThan(0);
    }
    // Ahead in the count, the put-away pitches come out; the fastball does not.
    expect(ahead.st!).toBeGreaterThan(even.st!);
    expect(ahead.sl!).toBeGreaterThan(even.sl!);
    expect(ahead.ff!).toBeLessThan(even.ff!);
    // …and a WEAK pitcher leans on the pitch that is easy to hit.
    expect(easy.ff!).toBeGreaterThan(even.ff!);
    expect(easy.st!).toBeLessThan(even.st!);
  });

  it('`putAway` is DERIVED from the count and self-corrects', () => {
    expect(putAway({ balls: 0, strikes: 0 })).toBe(0);
    expect(putAway({ balls: 0, strikes: 1 })).toBe(0.5);
    expect(putAway({ balls: 0, strikes: 2 })).toBe(1);
    // A wasted 0-2 becomes 1-2 and the aim comes back toward the plate.
    expect(putAway({ balls: 1, strikes: 2 })).toBe(0.5);
    expect(putAway({ balls: 2, strikes: 2 })).toBe(0);
    expect(putAway({ balls: 3, strikes: 0 })).toBe(0);
  });

  it('⚠ DIFFICULTY MOVES THE MOUND — aim and command, in the right direction', () => {
    const rows: string[] = [];
    const sample = (difficulty: number, balls: number, strikes: number) => {
      let radius = 0;
      let absErr = 0;
      let inZone = 0;
      const N = 300;
      for (let i = 0; i < N; i++) {
        const c = aiPitchCommand(stream(7000 + i).draw, difficulty, { balls, strikes });
        const u = plateToReticle(c.intentX, c.intentH);
        radius += (Math.abs(u.u) + Math.abs(u.v)) / 2;
        absErr += Math.abs(c.stopError);
        if (isStrike(c.intentX, c.intentH)) inZone++;
      }
      return { radius: radius / N, absErr: absErr / N, zone: inZone / N };
    };
    for (const d of [0, 0.5, 1]) {
      const even = sample(d, 0, 0);
      const ahead = sample(d, 0, 2);
      rows.push(
        `  ${d.toFixed(2)}   0-0 aim r ${even.radius.toFixed(3)}  |stop| ${even.absErr.toFixed(3)}` +
          `   0-2 aim r ${ahead.radius.toFixed(3)}  intent in zone ${(100 * ahead.zone).toFixed(0)} %`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[AI MOUND — 300 streams per cell, reticle units]\n' + rows.join('\n') + '\n');

    // COMMAND: a better pitcher misses less, strictly, at every step.
    const err = [0, 0.5, 1].map((d) => sample(d, 0, 0).absErr);
    expect(err[0]!).toBeGreaterThan(err[1]!);
    expect(err[1]!).toBeGreaterThan(err[2]!);
    expect(err[0]! / err[2]!).toBeCloseTo(AI_COMMAND_SPREAD_WEAK / AI_COMMAND_SPREAD_STRONG, 1);
    // AIM: with two strikes a better pitcher finishes further off the plate…
    const r02 = [0, 1].map((d) => sample(d, 0, 2).radius);
    expect(r02[1]!).toBeGreaterThan(r02[0]!);
    expect(r02[0]!).toBeCloseTo(AI_AIM_EDGE_WEAK, 6);
    expect(r02[1]!).toBeCloseTo(AI_AIM_EDGE_STRONG, 6);
    // …and past the CALLED corner, so a strike is not on offer and only a chase
    // is. Measured on `isStrike`, not on the reticle number, because the called
    // zone runs a ball radius past the painted one — see `AI_AIM_EDGE_STRONG`.
    expect(sample(1, 0, 2).zone).toBeLessThan(0.05);
    expect(sample(0, 0, 2).zone).toBeGreaterThan(0.9);
    // ⚠ …while at an EVEN count the aim does NOT move with difficulty, and that
    // is stated rather than accidental: an even-count pitch is a strike attempt
    // for everybody, and difficulty pays for it through COMMAND alone.
    expect(sample(0, 0, 0).radius).toBeCloseTo(AI_AIM_CENTRE, 6);
    expect(sample(1, 0, 0).radius).toBeCloseTo(AI_AIM_CENTRE, 6);
  });
});

// ===========================================================================
describe('ai — the batter', () => {
  it('it swings at strikes, sits on balls, and protects with two', () => {
    const rate = (difficulty: number, ctx: ReturnType<typeof crossing>, b = 0, s = 0) => {
      let n = 0;
      for (let i = 0; i < 400; i++) {
        if (aiSwingDecision(stream(4400 + i).draw, difficulty, { balls: b, strikes: s, ...ctx }).swing) n++;
      }
      return n / 400;
    };
    // A meatball: swung at almost always, and never taken with two strikes.
    expect(rate(1, MEAT)).toBeGreaterThan(0.6);
    expect(rate(1, MEAT, 0, STRIKES_FOR_K - 1)).toBe(1);
    // A pitch a foot and a half off the plate: a good hitter does not offer.
    expect(rate(1, WAY_OFF)).toBe(0);
    // ⚠ THE COUNT MOVES THE ZONE HE SWINGS AT. Just off the corner, he protects
    // with two strikes and sits on 3-0. Placed a hair outside the CHASE radius
    // that a 0-0 count allows, so only the count can open it.
    const nibble = crossing(CALL_ZONE.right + AI_CHASE_BASE_FT * 0.9, ZONE_CENTER.h);
    expect(rate(0, nibble, 0, 2)).toBeGreaterThan(rate(0, nibble, 3, 0));
  });

  it('⚠ DIFFICULTY MOVES THE PLATE — discipline, the read and the timing', () => {
    const rows: string[] = [];
    const sample = (difficulty: number) => {
      let chase = 0;
      let aimErrFt = 0;
      let maxTiming = 0;
      const N = 400;
      const pitch = crossing(0.35, 2.15);
      // Just outside the CALLED zone — inside the chase radius an even count
      // allows, so discipline is what decides it rather than eyesight.
      const nibble = crossing(CALL_ZONE.right + 0.08, ZONE_CENTER.h);
      for (let i = 0; i < N; i++) {
        const d = aiSwingDecision(stream(5500 + i).draw, difficulty, {
          balls: 0,
          strikes: 0,
          ...nibble,
        });
        if (d.swing) chase++;
        const e = aiSwingDecision(stream(6600 + i).draw, difficulty, {
          balls: 0,
          strikes: 0,
          ...pitch,
        });
        aimErrFt += Math.hypot(e.reticleX - pitch.plateX, e.reticleH - pitch.plateH);
        if (e.tapTimeS !== null) {
          maxTiming = Math.max(maxTiming, Math.abs(e.tapTimeS - pitch.plateT));
        }
      }
      return { chase: chase / N, aimErrIn: (12 * aimErrFt) / N, timingMs: maxTiming * 1000 };
    };
    const s = [0, 0.5, 1].map(sample);
    for (let i = 0; i < 3; i++) {
      rows.push(
        `  ${[0, 0.5, 1][i]!.toFixed(2)}   chase(1 in off the called zone) ${(100 * s[i]!.chase).toFixed(0)} %` +
          `   mean aim error ${s[i]!.aimErrIn.toFixed(2)} in` +
          `   |timing| <= ${s[i]!.timingMs.toFixed(1)} ms`,
      );
    }
    // eslint-disable-next-line no-console
    console.log('\n[AI PLATE — 400 streams per cell]\n' + rows.join('\n') + '\n');

    // THE READ: a better hitter puts his hands nearer the ball, strictly.
    expect(s[0]!.aimErrIn).toBeGreaterThan(s[1]!.aimErrIn);
    expect(s[1]!.aimErrIn).toBeGreaterThan(s[2]!.aimErrIn);
    // …and never to zero. `1 − AI_READ_STRONG` of the guess always survives,
    // which is what stops the strongest AI living inside the reference plateau.
    expect(s[2]!.aimErrIn).toBeGreaterThan(0.5);
    expect(AI_READ_STRONG).toBeGreaterThan(AI_READ_WEAK);
    expect(AI_READ_STRONG).toBeLessThan(1);
    expect(AI_GUESS_SPREAD_H_FT).toBeGreaterThan(0);
    // TIMING: a better hitter's spread is tighter, strictly.
    expect(s[0]!.timingMs).toBeGreaterThan(s[1]!.timingMs);
    expect(s[1]!.timingMs).toBeGreaterThan(s[2]!.timingMs);
    // DISCIPLINE: a better hitter lays off the same pitch off the corner.
    expect(s[0]!.chase).toBeGreaterThan(s[2]!.chase);
  });

  it('⚠ the SAME stream at two difficulties produces DIFFERENT decisions', () => {
    // The blunt version of the whole file: an AI that accepted `difficulty` and
    // ignored it would pass every band above that is stated one difficulty at a
    // time. Here the draws are identical and only the parameter moves.
    let pitchDiffs = 0;
    let swingDiffs = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const a = aiPitchCommand(stream(seed).draw, 0.1, { balls: 0, strikes: 2 });
      const b = aiPitchCommand(stream(seed).draw, 0.9, { balls: 0, strikes: 2 });
      if (JSON.stringify(a) !== JSON.stringify(b)) pitchDiffs++;
      const c = aiSwingDecision(stream(seed).draw, 0.1, { balls: 1, strikes: 1, ...MEAT });
      const d = aiSwingDecision(stream(seed).draw, 0.9, { balls: 1, strikes: 1, ...MEAT });
      if (JSON.stringify(c) !== JSON.stringify(d)) swingDiffs++;
    }
    expect(pitchDiffs).toBe(40);
    expect(swingDiffs).toBe(40);
  });
});

// ===========================================================================
describe('ai — the field', () => {
  it('the defender rating is ONE scalar, monotone, inside fielding.ts’s range', () => {
    expect(aiDefenseRating(0)).toBeCloseTo(AI_DEFENSE_WEAK, 12);
    expect(aiDefenseRating(1)).toBeCloseTo(AI_DEFENSE_STRONG, 12);
    expect(aiDefenseRating(0.5)).toBeCloseTo((AI_DEFENSE_WEAK + AI_DEFENSE_STRONG) / 2, 12);
    let prev = -1;
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const r = aiDefenseRating(d);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
      prev = r;
    }
    // …and it clamps, because `fielding.ts` takes `defense ∈ [0,1]`.
    expect(aiDefenseRating(-5)).toBeCloseTo(AI_DEFENSE_WEAK, 12);
    expect(aiDefenseRating(5)).toBeCloseTo(AI_DEFENSE_STRONG, 12);
  });
});
