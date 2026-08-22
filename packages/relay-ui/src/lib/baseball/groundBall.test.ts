// The ROLLING PHASE bench.
//
// ⚠ THE AGGREGATE IS NOT THE TEST. `ROLL_DECEL_DIRT_FPS2` is fitted to MLB's
// ~72 % ground-ball out rate, and a model can hit one scalar by making every
// grounder a coin flip. So the rate is asserted next door in `duelSim.test.ts`,
// where the population lives, and what is asserted HERE is the STRUCTURE the
// rate cannot see: the out has to depend on where the ball goes and how hard it
// was hit. The two halves together are the claim; either one alone is not.
//
// SIXTEEN MUTATIONS WERE WATCHED — each applied to the source, the fielders,
// roll, groundBall, fielding, duel, budget and determinism suites run, then reverted
// with the pristine text byte-compared back and a green baseline re-established
// first. OBSERVED failure counts, not predicted ones, in `derbySim.test.ts`'s
// convention.
//
//   1. `groundOut` never runs — `fielding` returns SINGLE on every dirt ball
//      (i.e. the pre-rolling-phase model, restored)                    → 5 fail
//   2. `duelSim` passes the LANDING SPEED instead of the ground speed   → 1 fail
//   3. `rollPath` ignores the grass line (dirt deceleration everywhere) → 2 fail
//   4. the interception feasibility test is dropped, so a fielder may
//      pick the ball up at a point he reached after it went past       → 6 fail
//   5. the "ball at rest" case loses its `max`, so a stopped ball is
//      credited to a fielder who has not got there yet                 → 4 fail
//   6. the search minimises the PICKUP time instead of the play time   → 0 fail
//   7. the throw is measured from the PLATE, not the pickup point      → 3 fail
//   8. first base is put on the third-base line (sign of FOUL_LINE_DEG) → 4 fail
//   9. the runner is timed from the pickup rather than from contact
//      (i.e. `playS` drops `fieldedS`)                                 → 7 fail
//  10. `timeToCoverS` uses the AIR reaction on the ground              → 2 fail
//  11. the defence rating stops reaching the ground race               → 1 fail
//  12. the pitcher is deleted from `ALIGNMENT`                         → 4 fail
//  13. `rollTimeS` returns the dirt-only time past the grass line      → 1 fail
//  14. `ROLL_DECEL_DIRT_FPS2` set to 35 (half)                         → 4 fail
//  15. the search minimises the THROW DISTANCE                         → 3 fail
//  16. the path search skips the stopping point                        → 1 fail
//
// ⚠ ONE SURVIVED, AND IT IS UNOBSERVABLE RATHER THAN UNTESTED — the same
// category `fielding.ts` records for its infield cap, and it is the most
// informative row in the table.
//   • (6) SURVIVED. Minimising the PICKUP time and minimising the PLAY time
//     return the same play on every one of 7,068 balls swept over the dirt, to
//     within 1e-9 s, and 0 calls differ. That is a small theorem, not luck:
//     taking the ball a foot deeper costs `1/v_ball` and saves at most
//     `1/v_throw`, so a charge can only pay while the ball still outruns the
//     117 ft/s throw — and a ball a fielder has caught up with is slower than
//     that. First an attempt was made to kill it with a named "the defence
//     charges" row, which passed the mutant, and then with a full OPTIMALITY
//     sweep (no legal fielder/pickup pair beats the reported play), which also
//     passed it. So it is recorded and MEASURED instead: `⚠ the objective is the
//     PLAY` runs the counterfactual every run, and the day a knob opens the
//     margin it fails. The optimality sweep is not wasted — it is what kills
//     (15), the shortest-throw objective, which nothing else caught.
//
// ⚠ AND ONE THAT NEARLY DID. (11) is killed by exactly one assertion, the
// ground-side monotonicity sweep, and by nothing in the air suite:
// `DEFENSE_SPAN`'s existing test exercises `sprintFt`, and the ground race
// reaches the rating through a different call, so the air coverage looks like
// coverage and is not.

import { describe, expect, it } from 'vitest';
import { launchFromAngles, simulateBattedBall } from './battedBallSim';
import {
  ALIGNMENT,
  FIELDER_GROUND_REACTION_S,
  infieldDepthFt,
  polarGapFt,
  reachMultiplier,
  timeToCoverS,
} from './fielders';
import {
  BASE_PATH_FT,
  FIRST_BASE,
  RUNNER_HOME_TO_FIRST_S,
  THROW_RELEASE_S,
  THROW_SPEED_FPS,
  THROW_SPEED_MPH,
  groundOut,
} from './groundBall';
import { ROLL_SAMPLE_S, rollDistFt, rollPath, rollTimeS } from './roll';
import { FOUL_LINE_DEG, HARBOURFRONT, resolveFence } from './parks';
import { GAME_AIR } from './pitchSim';
import { MPH_TO_FPS } from './units';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/** One real batted ball, all the way through: launch → flight → fence → ground. */
function hit(evMph: number, laDeg: number, sprayDeg: number, defense = 0.5) {
  const flight = simulateBattedBall(launchFromAngles(evMph, laDeg, sprayDeg, 1500), GAME_AIR);
  const fence = resolveFence(flight, HARBOURFRONT, true);
  return {
    flight,
    fence,
    play: groundOut(
      fence.distFt,
      fence.bearingDeg,
      fence.hangS,
      flight.landingGroundFps,
      defense,
    ),
  };
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

describe('the race, the throw and the runner', () => {
  it('⚠ GROUND BALL LADDER — the structure the aggregate cannot see', () => {
    // ⚠ GOLDEN, AND THE ROWS ARE THE POINT. Nothing outside this repo publishes
    // "a 55 mph roller at −44° is a base hit", so every call here is frozen model
    // output and a row that moves is a decision to make. What the ladder encodes
    // is that the model reads the way baseball reads: hard balls AT somebody are
    // outs, hard balls BETWEEN people are hits, slow rollers are decided by how
    // far the throw is, and the pitcher fields comebackers.
    //
    // ⚠ AND THE MIRRORED PAIRS ARE THE SHARPEST ROWS IN IT. Rows 1/2, 4/5 and
    // 7/8 are the same batted ball at ±the same bearing, and they are called
    // DIFFERENTLY — because first base is on one side of the diamond and the
    // throw from the left side is 80–100 ft longer. A model that decided
    // grounders on speed alone would call every pair the same way.
    //
    // ⚠ THE ASYMMETRY IS REAL BASEBALL; ITS SIZE ON THE RIGHT SIDE IS NOT, AND A
    // READER FORMS THEIR IMPRESSION OF IT HERE, SO IT IS SAID HERE. The bearing
    // sweep below finds a 13-step contiguous out band from +10° to +34° against
    // 5 steps around the shortstop, and the wide half is over-stated: the 3-4
    // hole row is an out because the second baseman intercepts a MOVING ball
    // 31 ft behind his post at 176 ft and still throws in time, which real
    // second basemen essentially never convert. It is the same unbounded-fielding-
    // radius simplification `ROLL_DECEL_DIRT_FPS2` absorbs, but the error is not
    // symmetric — it lands almost entirely on the RIGHT side of the diamond,
    // where the throw is short enough for a late pickup to survive.
    const cases: Array<[string, number, number, number, string]> = [
      ['sharp two-hopper right at the SS', 95, -6, -19, 'OUT'],
      ['…the mirror of it, at the 2B', 95, -6, 19, 'OUT'],
      ['routine two-hopper to short', 88, -4, -22, 'OUT'],
      ['through the 5-6 hole', 102, -3, -28, 'SAFE'],
      ['…the mirror of it, the 3-4 hole', 102, -3, 28, 'OUT'],
      ['hard grounder past the SS', 105, -2, -24, 'SAFE'],
      ['slow roller down the 3B line', 55, -5, -44, 'SAFE'],
      ['…the mirror of it, the 1B line', 55, -5, 44, 'OUT'],
      ['comebacker to the mound', 95, -8, 0, 'OUT'],
      ['chopper over the mound', 80, 2, 2, 'SAFE'],
      ['topped dribbler in front of the plate', 60, -35, -10, 'OUT'],
      ['scorched one-hopper down the 3B line', 108, -2, -43, 'SAFE'],
      ['soft grounder to first', 70, -8, 36, 'OUT'],
      ['high chopper to third', 85, -25, -36, 'OUT'],
    ];
    let table =
      '\n[GROUND BALL LADDER — defence 0.5. ⚠ GOLDEN: every call is model output]\n' +
      '  batted ball                            EV    LA  spray   lands  hang  ft/s   who  gloved  fielded  throw   play   vs 4.30\n';
    // ⚠ EVERY ROW IS EVALUATED AND THE TABLE PRINTED BEFORE ANYTHING IS
    // ASSERTED — `fielding.test.ts` learned this the hard way: an `expect`
    // inside the loop reports one bad row at a time and a change that moves two
    // gets "fixed" twice.
    const wrong: string[] = [];
    for (const [name, ev, la, spray, want] of cases) {
      const { fence, flight, play } = hit(ev, la, spray);
      const got = play.out ? 'OUT' : 'SAFE';
      // ⚠ EVERY ROW HAS TO BE A BALL `fieldBattedBall` WOULD ACTUALLY ROUTE
      // HERE. This ladder calls `groundOut` directly, so a row that landed past
      // the grass line would agree with the model by luck and read as coverage
      // it is not — one row did, at 134.4 ft against a 129.8 ft arc down the
      // third-base line. Asserted rather than eyeballed, for all fourteen.
      if (fence.distFt >= infieldDepthFt(fence.bearingDeg)) {
        wrong.push(
          `${name}: lands at ${fence.distFt.toFixed(1)} ft, PAST the ${infieldDepthFt(
            fence.bearingDeg,
          ).toFixed(1)} ft arc — the roll would never see it`,
        );
      }
      table +=
        `  ${name.padEnd(38)}${String(ev).padStart(4)}${String(la).padStart(6)}${String(spray).padStart(7)}` +
        `${fence.distFt.toFixed(0).padStart(8)}${fence.hangS.toFixed(2).padStart(6)}` +
        `${flight.landingGroundFps.toFixed(0).padStart(6)}   ${play.fielder.padEnd(3)}` +
        `${play.fieldedAtFt.toFixed(0).padStart(7)}${play.fieldedS.toFixed(2).padStart(9)}` +
        `${play.throwFt.toFixed(0).padStart(7)}${play.playS.toFixed(2).padStart(7)}   ${got}` +
        `${got === want ? '' : `   ⚠ pinned ${want}`}\n`;
      if (got !== want) wrong.push(`${name} (${ev}/${la}°/${spray}°): ${want} → ${got}`);
    }
    table +=
      `\n  The runner is ${RUNNER_HOME_TO_FIRST_S} s from contact to the bag. Everything left of that is an out.\n`;
    log(table);
    expect(wrong).toEqual([]);
  });

  it('⚠ WHERE the ball goes decides it — a bearing sweep, not two examples', () => {
    // ⚠ THE PROPERTY BEHIND THE LADDER'S MIRRORED ROWS. At one exit velocity and
    // one launch angle, sweeping the bearing across the infield must produce
    // OUTS at the fielders' bearings and SAFES between them. That is the claim
    // "the out depends on where the ball goes", and unlike a pair of named rows
    // it cannot be satisfied by luck.
    const ev = 100;
    const la = -3;
    let line = '';
    const safeAt: number[] = [];
    const outAt: number[] = [];
    for (let b = -44; b <= 44; b += 2) {
      const { play } = hit(ev, la, b);
      line += play.out ? 'O' : '.';
      (play.out ? outAt : safeAt).push(b);
    }
    log(
      `\n[BEARING SWEEP — ${ev} mph at ${la}°, −44° to +44° in 2° steps]\n  ${line}\n` +
        `  O = out, . = base hit. ${outAt.length} outs, ${safeAt.length} hits.\n` +
        `  Fielders sit at −38, −19, 0, 19, 38.\n`,
    );
    // Both kinds exist — a sweep that is all one letter is a coin with one face.
    expect(outAt.length).toBeGreaterThan(10);
    expect(safeAt.length).toBeGreaterThan(10);
    // Right at a fielder is an out; the middle of a gap is not. Asserted at the
    // two infield gaps that are not the middle of the diamond.
    expect(hit(ev, la, -19).play.out, 'at the SS').toBe(true);
    expect(hit(ev, la, 19).play.out, 'at the 2B').toBe(true);
    expect(hit(ev, la, -28).play.out, 'the 5-6 hole').toBe(false);
    expect(hit(ev, la, -30).play.out, 'the 5-6 hole, wider').toBe(false);
  });

  it('⚠ HOW HARD decides it too — the same bearing, swept on exit velocity', () => {
    // In a gap, a soft ball dies where an infielder can walk to it and a hard one
    // is past him before he moves. So along one bearing the call has to flip
    // exactly once, from OUT to SAFE, as exit velocity rises — and it is a real
    // threshold rather than noise.
    const b = -28;
    let table = `\n[EXIT VELOCITY SWEEP — bearing ${b}°, LA −3°]\n  EV   ground ft/s   gloved at   fielded   throw   play   call\n`;
    const calls: boolean[] = [];
    for (let ev = 50; ev <= 110; ev += 5) {
      const { flight, play } = hit(ev, -3, b);
      calls.push(play.out);
      table += `  ${String(ev).padStart(3)}   ${flight.landingGroundFps.toFixed(0).padStart(11)}   ${play.fieldedAtFt
        .toFixed(0)
        .padStart(9)}   ${play.fieldedS.toFixed(2).padStart(7)}   ${play.throwFt
        .toFixed(0)
        .padStart(5)}   ${play.playS.toFixed(2).padStart(4)}   ${play.out ? 'OUT' : 'SAFE'}\n`;
    }
    log(table);
    expect(calls[0], 'a 50 mph roller into the 5-6 hole').toBe(true);
    expect(calls[calls.length - 1], 'a 110 mph one-hopper into the 5-6 hole').toBe(false);
    // Exactly one crossing: a model whose call rattled up and down with speed
    // would be reading noise, not a mechanism.
    const flips = calls.slice(1).filter((c, i) => c !== calls[i]).length;
    expect(flips, `calls: ${calls.map((c) => (c ? 'O' : '.')).join('')}`).toBe(1);
  });

  it('⚠ the throw is measured from the PICKUP POINT to first base', () => {
    // ⚠ THE ASYMMETRY IS THE TEST, because it is the one thing a "distance from
    // the plate" throw model cannot reproduce. First base is on the +45° line, so
    // a ball fielded on the LEFT side is a much longer throw than the mirror of
    // it on the right — and that difference, not the ball, is why the ladder's
    // mirrored pairs are called differently.
    expect(FIRST_BASE).toEqual({ bearingDeg: FOUL_LINE_DEG, distFt: BASE_PATH_FT });
    expect(THROW_SPEED_FPS).toBeCloseTo(THROW_SPEED_MPH * MPH_TO_FPS, 12);
    let table = '\n[THROW — pickup point → first base]\n  pickup            left side   right side   difference\n';
    for (const [d, b] of [[80, 30], [110, 20], [145, 19], [180, 28], [120, 40]]) {
      const l = polarGapFt(-b!, d!, FIRST_BASE.bearingDeg, FIRST_BASE.distFt);
      const r = polarGapFt(b!, d!, FIRST_BASE.bearingDeg, FIRST_BASE.distFt);
      table += `  ${String(d).padStart(4)} ft at ±${String(b).padStart(2)}°   ${l
        .toFixed(1)
        .padStart(9)}   ${r.toFixed(1).padStart(10)}   ${(l - r).toFixed(1).padStart(10)}\n`;
      expect(l).toBeGreaterThan(r);
    }
    log(table);
    // A first baseman standing on the ball IS the throw, 21.66 ft of it, and that
    // is why "he steps on the bag himself" needs no branch anywhere.
    const at1B = polarGapFt(38, 108, FIRST_BASE.bearingDeg, FIRST_BASE.distFt);
    expect(at1B).toBeCloseTo(21.65, 2);
    expect(at1B / THROW_SPEED_FPS).toBeLessThan(0.2);
  });

  it('⚠ a fielder may not pick up a ball that has already gone past him', () => {
    // ⚠ THE CONSTRAINT, ASSERTED AS A CONSTRAINT. The feasible pickup points are
    // those a fielder reaches NO LATER than the ball; everywhere else the ball
    // is not there any more. The one exception is the stopping point, where the
    // ball waits. So: the fielder credited with the play must either have been
    // able to be at that point in time, or the ball must be at rest there.
    for (const [ev, la, sp] of [[100, -3, -28], [70, -5, -40], [95, -6, -19], [60, -35, -10]]) {
      const { fence, flight, play } = hit(ev!, la!, sp!);
      const path = rollPath(fence.distFt, fence.bearingDeg, flight.landingGroundFps);
      const s = play.fieldedAtFt - fence.distFt;
      const tBall = fence.hangS + rollTimeS(path, s);
      const atRest = Math.abs(s - path.rollFt) < 1e-9;
      expect(atRest || Math.abs(play.fieldedS - tBall) < 1e-9, `${ev}/${la}/${sp}`).toBe(true);
      expect(play.fieldedS).toBeGreaterThanOrEqual(tBall - 1e-9);
      // The whole play is the pickup plus the release plus the flight, and the
      // verdict is that against the runner. No fourth term.
      expect(play.playS).toBeCloseTo(
        play.fieldedS + THROW_RELEASE_S + play.throwFt / THROW_SPEED_FPS,
        9,
      );
      expect(play.out).toBe(play.playS <= RUNNER_HOME_TO_FIRST_S);
    }
  });

  it('⚠ the reported play is the best available, to within the sampling bound', () => {
    // ⚠ TWO CLAIMS IN ONE SWEEP, AND THE SECOND IS WHY IT IS A REFINEMENT RATHER
    // THAN A REPLAY. (a) The OBJECTIVE: no legal (fielder, pickup) pair beats
    // the reported play — which is what kills a shortest-throw or nearest-
    // fielder objective. (b) The RESOLUTION: the enumeration below runs on a
    // grid four times finer than `ROLL_SAMPLE_S`, so the shortfall it finds IS
    // the model's discretisation error, measured rather than argued.
    //
    // The analytic bound on that error: between two samples the play time moves
    // by at most `dt·(1 + v_ball/v_throw)`, so with `dt = 0.005` and a ball
    // never above ~150 ft/s it is 0.011 s — a tenth of the ~0.10 s margins the
    // ladder decides on. The sweep has to come in under it.
    const FINE = ROLL_SAMPLE_S / 4;
    const bound = ROLL_SAMPLE_S * (1 + 150 / THROW_SPEED_FPS);
    let checked = 0;
    let worstShortfallS = 0;
    let at = '';
    for (let b = -44; b <= 44; b += 7) {
      for (const d0 of [5, 40, 90, 130]) {
        for (const v0 of [50, 80, 120, 150]) {
          for (const hang of [0.05, 0.6, 1.4]) {
            const got = groundOut(d0, b, hang, v0, 0.5);
            const path = rollPath(d0, b, v0);
            const mul = reachMultiplier(0.5);
            const steps = Math.max(1, Math.ceil(path.stopS / FINE));
            for (const f of ALIGNMENT) {
              for (let i = 0; i <= steps; i++) {
                const tRoll = i === steps ? path.stopS : i * FINE;
                const p = d0 + rollDistFt(path, tRoll);
                const tBall = hang + tRoll;
                const tCover = timeToCoverS(
                  polarGapFt(b, p, f.bearingDeg, f.distFt) / mul,
                  FIELDER_GROUND_REACTION_S,
                );
                const stopped = i === steps;
                if (!stopped && tCover > tBall) continue; // the ball has gone past
                const fieldedS = stopped ? Math.max(tBall, tCover) : tBall;
                const alt =
                  fieldedS +
                  THROW_RELEASE_S +
                  polarGapFt(b, p, FIRST_BASE.bearingDeg, FIRST_BASE.distFt) / THROW_SPEED_FPS;
                checked++;
                if (got.playS - alt > worstShortfallS) {
                  worstShortfallS = got.playS - alt;
                  at = `${d0} ft / ${b}° / ${v0} fps / hang ${hang}`;
                }
              }
            }
          }
        }
      }
    }
    log(
      `\n[OPTIMAL] ${checked} legal (fielder, pickup) pairs on a ${FINE} s grid — ` +
        `${(FINE / ROLL_SAMPLE_S).toFixed(2)}× the shipped resolution.\n` +
        `  Worst the model is beaten by: ${worstShortfallS.toFixed(
          5,
        )} s (analytic bound ${bound.toFixed(4)} s)${at ? ` at ${at}` : ''}.\n` +
        '  (Only FEASIBLE pairs are counted — a fielder who arrives after the ball has\n' +
        '   gone past is not an alternative, he is a fielder who has missed it.)\n',
    );
    expect(checked).toBeGreaterThan(2000);
    expect(worstShortfallS).toBeLessThan(bound);
  });

  it('⚠ the objective is the PLAY — and the counterfactual says it cannot be TOLD', () => {
    // ⚠ AN UNOBSERVABLE MUTATION, MEASURED RATHER THAN IGNORED — the same
    // category `fielding.ts` records for its infield cap. `groundOut` minimises
    // the whole play time to the bag rather than the pickup time, because a
    // fielder charging a slow roller is trading a later pickup for a shorter
    // throw. Swapping the objective to the PICKUP time fails NOTHING, and the
    // reason is not a missing assertion: swept over the grid below, the two
    // objectives return the SAME PLAY every time.
    //
    // ⚠ AND THE REASON IS TWO THINGS, NOT ONE — the correction that makes this
    // worth recording. The play time along the path moves as
    // `d(play)/ds = 1/v_ball + (d·throw/ds)/v_throw`. A charge pays only when the
    // second term is negative enough to beat the first, which needs BOTH a ball
    // slower than the 117.3 ft/s throw AND a throw that is actually shortening.
    // Neither clause carries it alone: a 150 ft/s grounder straight at the
    // shortstop is first feasible at ≈122.8 ft/s, FASTER than the throw — what
    // saves it there is that `d·throw/ds ≈ −1` only where the ball rolls toward
    // first base inside first's radial projection (~90 ft), and no fielder in
    // `ALIGNMENT` stands inside 90 ft on the right side except the pitcher. So
    // this is a joint consequence of a speed bound and the ALIGNMENT, and an
    // alignment change could break it with the speed argument untouched. The
    // charge is real physics that this game's numbers happen to price at zero;
    // the day an arm gets weaker, a surface gets faster or a fielder moves in,
    // the margin closes — and this test is what says so.
    //
    // The objective STAYS the play time, because it is the correct statement of
    // what a defence is doing and because the equivalence is an artefact of
    // today's constants rather than a theorem about baseball.
    let cases = 0;
    let differ = 0;
    let worstGapS = 0;
    for (let b = -45; b <= 45; b += 3) {
      for (let d0 = 2; d0 < 150; d0 += 8) {
        for (const v0 of [40, 70, 100, 130]) {
          for (const hang of [0.05, 0.5, 1.2]) {
            const path = rollPath(d0, b, v0);
            const mul = reachMultiplier(0.5);
            let byPlay = Infinity;
            let earliestPickup = Infinity;
            let playAtEarliest = Infinity;
            const steps = Math.max(1, Math.ceil(path.rollFt));
            for (const f of ALIGNMENT) {
              for (let i = 0; i <= steps; i++) {
                const sAt = i === steps ? path.rollFt : i;
                const at = d0 + sAt;
                const tBall = hang + rollTimeS(path, sAt);
                const tCover = timeToCoverS(
                  polarGapFt(b, at, f.bearingDeg, f.distFt) / mul,
                  FIELDER_GROUND_REACTION_S,
                );
                const stopped = i === steps;
                if (!stopped && tCover > tBall) continue;
                const fieldedS = stopped ? Math.max(tBall, tCover) : tBall;
                const play =
                  fieldedS +
                  THROW_RELEASE_S +
                  polarGapFt(b, at, FIRST_BASE.bearingDeg, FIRST_BASE.distFt) / THROW_SPEED_FPS;
                if (play < byPlay) byPlay = play;
                if (fieldedS < earliestPickup) {
                  earliestPickup = fieldedS;
                  playAtEarliest = play;
                }
              }
            }
            cases++;
            const gap = playAtEarliest - byPlay;
            if (gap > worstGapS) worstGapS = gap;
            if ((byPlay <= RUNNER_HOME_TO_FIRST_S) !== (playAtEarliest <= RUNNER_HOME_TO_FIRST_S)) {
              differ++;
            }
          }
        }
      }
    }
    log(
      `\n[OBJECTIVE] over ${cases} balls on the dirt, minimising the PLAY and minimising the\n` +
        `  PICKUP give plays that differ by at most ${worstGapS.toFixed(
          3,
        )} s and call ${differ} of them differently.\n` +
        `  A charge would pay only while the ball outran the throw (${THROW_SPEED_FPS.toFixed(
          1,
        )} ft/s), and a ball\n  a fielder has reached is slower than that.\n`,
    );
    expect(cases).toBeGreaterThan(2000);
    expect(differ).toBe(0);
    expect(worstGapS).toBeLessThan(1e-9);
  });

  it('⚠ the pickup point is DEEPER than the landing point, and that is the roll', () => {
    // The fielder is not standing where the ball first touched the ground, and
    // in a landing-point model that was the end of the story — the old
    // `GROUND_INTERCEPT_FT` existed precisely to paper over the gap. Here the
    // ball comes to HIM, which is the whole change, and the numbers say so: it
    // is gloved tens of feet past where it landed, later than it landed, and
    // from a spot the throw is measured from.
    const { fence, flight, play } = hit(55, -5, 44);
    const path = rollPath(fence.distFt, fence.bearingDeg, flight.landingGroundFps);
    expect(play.fieldedAtFt).toBeGreaterThan(fence.distFt + 10);
    expect(play.fieldedS).toBeGreaterThan(fence.hangS + rollTimeS(path, 5));
    expect(play.throwFt).toBeLessThan(
      polarGapFt(fence.bearingDeg, fence.distFt, FIRST_BASE.bearingDeg, FIRST_BASE.distFt),
    );
    expect(play.out).toBe(true);
    log(
      `\n[ROLL TO HIM] a 55 mph roller down the 1B line lands at ${fence.distFt.toFixed(
        0,
      )} ft; the ${play.fielder} takes it at ${play.fieldedAtFt.toFixed(
        0,
      )} ft (${play.fieldedS.toFixed(2)} s) and throws ${play.throwFt.toFixed(
        0,
      )} ft — ${play.playS.toFixed(2)} s.\n`,
    );
  });

  it('⚠ ROLL_GRASS_RATIO — the bound on what a FEEL KNOB can reach, computed', () => {
    // ⚠ THE MEASUREMENT LIVES HERE, NOT IN A COMMENT, and that is the whole
    // reason this test exists. `ROLL_GRASS_RATIO` is the one number in the
    // rolling phase with no source at all, so the two things a reader needs are
    // (a) an upper bound on what it can possibly touch and (b) whether it
    // co-varies with the constant fitted underneath it.
    //
    // (a) is exactly "how many plays are decided beyond the grass line", because
    // a play resolved entirely on the dirt cannot see the grass deceleration at
    // any value. (b) is answered by POPULATION rather than by grid, next door in
    // `duelSim.test.ts`: every putout the bench records is an infielder's.
    let n = 0;
    let beyond = 0;
    let outs = 0;
    let outsBeyond = 0;
    let outsByOutfielder = 0;
    for (let b = -45; b <= 45; b += 3) {
      const edge = infieldDepthFt(b);
      for (let d = 2; d < edge; d += 6) {
        for (let v = 40; v <= 150; v += 10) {
          for (const hang of [0.05, 0.3, 0.8, 1.3]) {
            for (const def of [0, 0.5, 1]) {
              const g = groundOut(d, b, hang, v, def);
              n++;
              const past = g.fieldedAtFt > edge;
              if (past) beyond++;
              if (!g.out) continue;
              outs++;
              if (past) outsBeyond++;
              if (!g.infield) outsByOutfielder++;
            }
          }
        }
      }
    }
    const pc = (a: number, b2: number) => `${((100 * a) / b2).toFixed(1)} %`;
    log(
      `\n[GRASS LEVERAGE] ${n} balls on the dirt, uniform grid.\n` +
        `  fielded beyond the grass line   ${beyond} (${pc(beyond, n)})   ← the most this knob can reach\n` +
        `  OUTS decided beyond it          ${outsBeyond} of ${outs} (${pc(outsBeyond, outs)})\n` +
        `  OUTS credited to an outfielder  ${outsByOutfielder} (${pc(outsByOutfielder, outs)})\n` +
        '  ⚠ A UNIFORM GRID IS NOT THE GAME. The duel bench, which is the population the\n' +
        '    ~72 % target is measured over, records ZERO outfielder putouts — see\n' +
        "    duelSim.test.ts. That is why this knob does not co-vary with the fit.\n",
    );
    // It is NOT decorative: a first draft of the constant's comment claimed no
    // call could move, and this is the assertion that would have caught it.
    expect(beyond / n).toBeGreaterThan(0.2);
    expect(outsBeyond).toBeGreaterThan(0);
    // …and it is still nearly powerless over the population that matters: an
    // outfielder essentially never throws anybody out at first.
    expect(outsByOutfielder / outs).toBeLessThan(0.01);
  });

  it('⚠ the ONE defender rating reaches the ground race, monotonically', () => {
    // ⚠ THE MUTATION THIS EXISTS FOR: the rating had an AIR test and no ground
    // test, so deleting it from the race was invisible. What is asserted is the
    // PROPERTY over a grid — a better defence never turns an out into a hit —
    // plus at least one ball it actually flips, because a rating that is wired
    // in but does nothing satisfies monotonicity trivially.
    let flips = 0;
    let violations = 0;
    for (let b = -44; b <= 44; b += 4) {
      for (const ev of [60, 75, 90, 100, 108]) {
        for (const la of [-25, -8, -2, 4]) {
          const worst = hit(ev, la, b, 0).play.out;
          const mid = hit(ev, la, b, 0.5).play.out;
          const best = hit(ev, la, b, 1).play.out;
          // A BETTER defence may never turn an out into a hit.
          if (worst && !mid) violations++;
          if (mid && !best) violations++;
          if (worst && !best) violations++;
          if (best !== worst) flips++;
        }
      }
    }
    log(`\n[DEFENCE] over the grid: ${flips} ground balls flip on the rating, ${violations} violations.\n`);
    expect(violations).toBe(0);
    expect(flips).toBeGreaterThan(5);
  });

  it('the same inputs always give the same play — no hidden randomness', () => {
    const once = groundOut(60, -22, 0.5, 120, 0.62);
    for (let i = 0; i < 5; i++) expect(groundOut(60, -22, 0.5, 120, 0.62)).toEqual(once);
    // …and every field is finite. A NaN gap would read as "unreachable" and
    // silently hand the batter a hit.
    for (const v of [0, 1, 200]) {
      for (const b of [-45, 0, 45]) {
        const g = groundOut(0, b, 0, v, 0.5);
        expect(Number.isFinite(g.playS) && Number.isFinite(g.fieldedS) && g.fielder !== '').toBe(true);
      }
    }
  });
});
