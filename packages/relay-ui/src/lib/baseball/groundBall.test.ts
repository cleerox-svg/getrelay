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
// groundBall, fielding, duel, budget and determinism suites run, then reverted
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
  MAX_ROLL_FT,
  ROLL_DECEL_DIRT_FPS2,
  ROLL_SAMPLE_FT,
  ROLL_DECEL_TURF_FPS2,
  ROLL_GRASS_RATIO,
  RUNNER_HOME_TO_FIRST_S,
  THROW_RELEASE_S,
  THROW_SPEED_FPS,
  THROW_SPEED_MPH,
  groundOut,
  rollPath,
  rollTimeS,
} from './groundBall';
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

describe('the roll', () => {
  it('is the closed-form solution of constant deceleration, on each surface', () => {
    // ⚠ THE DEFINING PROPERTY, NOT A TABLE. `v² = v₀² − 2as` on each surface and
    // the crossing between them is exact — the same standard every other event
    // in this game is held to. Asserted by re-deriving the speed at a sampled
    // point from the TIME the model reports, which is the inverse of what the
    // model computes and so cannot pass on a mis-stated formula.
    for (const bearing of [0, -20, 38, -44]) {
      const edge = infieldDepthFt(bearing);
      for (const [d0, v0] of [[10, 60], [10, 140], [90, 120], [edge - 1, 100], [edge + 20, 90]]) {
        const p = rollPath(d0!, bearing, v0!);
        expect(rollTimeS(p, 0)).toBe(0);
        expect(rollTimeS(p, p.rollFt)).toBeCloseTo(p.stopS, 6);
        expect(p.stopDistFt).toBeCloseTo(d0! + p.rollFt, 12);
        // Monotone in distance, and never past the stop.
        let prev = -1;
        for (let s = 0; s <= p.rollFt + 5; s += 0.5) {
          const t = rollTimeS(p, s);
          expect(t).toBeGreaterThanOrEqual(prev);
          prev = t;
        }
        // Speed at a mid-dirt sample, two ways.
        if (p.dirtFt > 4) {
          const s = p.dirtFt / 2;
          const v = Math.sqrt(v0! ** 2 - 2 * ROLL_DECEL_DIRT_FPS2 * s);
          expect(rollTimeS(p, s)).toBeCloseTo((v0! - v) / ROLL_DECEL_DIRT_FPS2, 9);
        }
      }
    }
    // A ball with no ground speed left does not roll, and never NaNs.
    const dead = rollPath(40, 12, 0);
    expect(dead.rollFt).toBe(0);
    expect(dead.stopS).toBe(0);
    expect(rollTimeS(dead, 50)).toBe(0);
    expect(rollPath(40, 12, -30).rollFt).toBe(0);
    // The bound bites instead of scanning forever.
    expect(rollPath(1, 0, 400).rollFt).toBe(MAX_ROLL_FT);
    // ⚠ THE SEARCH IS SAMPLED, SO THE SPACING HAS TO BE ARGUED RATHER THAN
    // ASSUMED. The out/safe verdict is a comparison against a 4.30 s runner and
    // the plays that matter land within ~0.1 s of it. One foot of roll is at
    // most `1 / v₀` seconds — 0.0067 s on the fastest ball this game produces —
    // so the discretisation is an order of magnitude finer than the decision it
    // feeds. It is asserted as that inequality, not as the number 1.
    expect(ROLL_SAMPLE_FT / 150).toBeLessThan(0.01);
  });

  it('⚠ crosses the grass line and slows THERE, not at the landing point', () => {
    // ⚠ THE TEST IS THE SAME BALL AT TWO BEARINGS, because the grass line is a
    // FUNCTION of bearing (`fielders.infieldDepthFt`) and a model that used one
    // radius would roll both the same distance. Down the line the ball reaches
    // grass 27.9 ft sooner than it does to centre, so it stops sooner.
    // Fast enough to CROSS the line at both bearings — a ball that stops on the
    // dirt never sees the second surface and would pass this test vacuously.
    const centre = rollPath(20, 0, 150);
    const line = rollPath(20, 45, 150);
    expect(ROLL_DECEL_TURF_FPS2).toBeCloseTo(ROLL_GRASS_RATIO * ROLL_DECEL_DIRT_FPS2, 12);
    expect(ROLL_GRASS_RATIO).toBeGreaterThan(1);
    expect(centre.dirtFt).toBeCloseTo(infieldDepthFt(0) - 20, 9);
    expect(line.dirtFt).toBeCloseTo(infieldDepthFt(45) - 20, 9);
    expect(centre.rollFt).toBeGreaterThan(centre.dirtFt);
    expect(line.rollFt).toBeGreaterThan(line.dirtFt);
    expect(line.rollFt).toBeLessThan(centre.rollFt);
    // …and it really is the SURFACE doing it, not the shorter dirt run: with one
    // deceleration everywhere the same ball would roll `v²/2a` from wherever it
    // landed, identically at both bearings.
    expect(centre.rollFt).toBeLessThan((150 * 150) / (2 * ROLL_DECEL_DIRT_FPS2));
    let table =
      '\n[ROLL — a 150 ft/s ground ball from 20 ft out, by bearing]\n' +
      '  bearing   grass line   dirt run   total roll   stops at   time to rest\n';
    for (const b of [0, 20, 38, 45]) {
      const p = rollPath(20, b, 150);
      table += `  ${String(b).padStart(5)}°   ${infieldDepthFt(b).toFixed(1).padStart(10)}   ${p.dirtFt
        .toFixed(1)
        .padStart(8)}   ${p.rollFt.toFixed(1).padStart(10)}   ${p.stopDistFt
        .toFixed(1)
        .padStart(8)}   ${p.stopS.toFixed(2).padStart(12)}\n`;
    }
    table +=
      `\n  ⚠ The tail is over-decelerated and the constant's own comment says so: a\n` +
      `  91 mph ground ball comes to rest ${rollPath(26, 0, 133).stopDistFt.toFixed(
        0,
      )} ft out, where a real one is still moving\n  when the outfielder picks it up. Not observable in this milestone's outcome\n  set — every ball that gets through the infield is a single either way.\n`;
    log(table);
  });

  it('⚠ the roll starts at the GROUND speed, which is where the angle lives', () => {
    // A topped chopper and a grazing screamer can land at the same SPEED and
    // roll at wildly different ones, because one of them is spending most of its
    // velocity going down. That is the whole angle dependence of the model and it
    // arrives free, out of the integrator, with no bounce-retention knob.
    const fps = (mph: number) => mph * MPH_TO_FPS;
    let table =
      '\n[GROUND SPEED — what the bounce keeps, by launch angle]\n' +
      '  LA    lands at   speed ft/s   GROUND ft/s   kept    roll ft (from 20 ft out)\n';
    for (const la of [-45, -30, -15, -5, 2, 10]) {
      const f = simulateBattedBall(launchFromAngles(95, la, 0, 1500), GAME_AIR);
      const v = fps(f.landingSpeedMph);
      table += `  ${String(la).padStart(3)}°  ${f.carryFt.toFixed(0).padStart(8)}   ${v
        .toFixed(0)
        .padStart(10)}   ${f.landingGroundFps.toFixed(0).padStart(11)}   ${(
        (100 * f.landingGroundFps) / v
      )
        .toFixed(0)
        .padStart(3)} %   ${rollPath(20, 0, f.landingGroundFps).rollFt.toFixed(0).padStart(6)}\n`;
    }
    log(table);
    // The steeper the ball comes in, the smaller the fraction the ground keeps —
    // and the ROLL is the thing that shrinks with it. ⚠ It is NOT the same claim
    // as "a chopper lands slower than a screamer": a topped ball lands almost at
    // once and barely decelerates in the air, so it can land FASTER and still
    // roll less. The decomposition, not the speed, is the mechanism.
    const steep = simulateBattedBall(launchFromAngles(95, -45, 0, 1500), GAME_AIR);
    const graze = simulateBattedBall(launchFromAngles(95, -2, 0, 1500), GAME_AIR);
    expect(steep.landingGroundFps / fps(steep.landingSpeedMph)).toBeLessThan(0.8);
    expect(graze.landingGroundFps / fps(graze.landingSpeedMph)).toBeGreaterThan(0.99);
    expect(rollPath(20, 0, steep.landingGroundFps).rollFt).toBeLessThan(
      rollPath(20, 0, graze.landingGroundFps).rollFt,
    );
  });
});

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
    // ⚠ AND THE MIRRORED PAIRS ARE THE SHARPEST ROWS IN IT. Rows 1/2, 3/4 and
    // 6/7 are the same batted ball at ±the same bearing, and they are called
    // DIFFERENTLY — because first base is on one side of the diamond and the
    // throw from the left side is 80–100 ft longer. A model that decided
    // grounders on speed alone would call every pair the same way.
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
      ['scorched one-hopper down the 3B line', 108, 1, -43, 'SAFE'],
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
    // A first baseman standing on the ball IS the throw, 21.6 ft of it, and that
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

  it('⚠ the reported play is the BEST one available — the minimisation, checked', () => {
    // ⚠ THIS IS THE ASSERTION THAT KILLED THE "MINIMISE THE PICKUP" MUTATION,
    // and the charge test below did NOT: on the balls that test names, the two
    // objectives happen to agree, so it passed the mutant. What is asserted here
    // is the SPEC instead of an example — for every fielder and every point on
    // the roll that he could legally take the ball at, the play the model
    // reports must be no worse. Any other objective (earliest pickup, nearest
    // fielder, shortest throw) violates it somewhere in the grid.
    let checked = 0;
    let bestAlt = 0;
    for (let b = -44; b <= 44; b += 7) {
      for (const d0 of [5, 40, 90, 130]) {
        for (const v0 of [50, 80, 120, 150]) {
          for (const hang of [0.05, 0.6, 1.4]) {
            const got = groundOut(d0, b, hang, v0, 0.5);
            const path = rollPath(d0, b, v0);
            const mul = reachMultiplier(0.5);
            for (const f of ALIGNMENT) {
              for (let s = 0; s <= path.rollFt + 1e-9; s += 2) {
                const at = d0 + Math.min(s, path.rollFt);
                const tBall = hang + rollTimeS(path, Math.min(s, path.rollFt));
                const tCover = timeToCoverS(
                  polarGapFt(b, at, f.bearingDeg, f.distFt) / mul,
                  FIELDER_GROUND_REACTION_S,
                );
                const stopped = Math.min(s, path.rollFt) >= path.rollFt - 1e-9;
                if (!stopped && tCover > tBall) continue; // the ball has gone past
                const fieldedS = stopped ? Math.max(tBall, tCover) : tBall;
                const throwFt = polarGapFt(b, at, FIRST_BASE.bearingDeg, FIRST_BASE.distFt);
                const alt = fieldedS + THROW_RELEASE_S + throwFt / THROW_SPEED_FPS;
                checked++;
                if (alt < got.playS - 1e-9) bestAlt++;
              }
            }
          }
        }
      }
    }
    log(
      `\n[OPTIMAL] ${checked} legal (fielder, pickup point) pairs across the grid; ` +
        `${bestAlt} of them beat the play the model reported.\n` +
        '  (Only FEASIBLE pairs are counted — a fielder who arrives after the ball has\n' +
        '   gone past is not an alternative, he is a fielder who has missed it.)\n',
    );
    expect(checked).toBeGreaterThan(2000);
    expect(bestAlt).toBe(0);
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
    // ⚠ AND IT IS A SMALL THEOREM RATHER THAN LUCK, WHICH IS WHY THIS IS
    // RECORDED INSTEAD OF PAPERED OVER. Taking the ball one foot deeper costs
    // `1/v_ball` seconds and saves at most `1/v_throw` — so charging can only pay
    // while the ball is still moving FASTER than the throw. `THROW_SPEED_FPS` is
    // 117.3, and any ball a fielder has actually caught up with is slower than
    // that by then. The charge is real physics that this game's numbers happen
    // to price at zero; the day an arm gets weaker or a surface gets faster the
    // margin closes, and this test is what says so.
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
