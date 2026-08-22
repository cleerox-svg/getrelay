// The fielding bench. The model is deliberately tiny, so the tests are mostly
// BOUNDARIES — the middle of a lookup table is where it is easiest to be right
// and least interesting to assert.
//
// ⚠ WHAT MOVED WHEN THE ROLLING PHASE LANDED. The alignment, the ramp and the
// infield arc are now `fielders.ts` and their tests are `fielders.test.ts`; the
// ball on the ground is `groundBall.ts` and its ladder is `groundBall.test.ts`.
// What is left here is what this file was always about: the ball in the AIR, and
// the ONE function where a batted ball becomes a result. The test that used to
// pin the LANDING-POINT LIMITATION is gone with the limitation — in its place is
// a test that the dirt HANDS OFF to the rolling phase, because "it rolls now" is
// the thing a future reader needs to be unable to break silently.

import { describe, expect, it } from 'vitest';
import { launchFromAngles, simulateBattedBall } from './battedBallSim';
import {
  ALIGNMENT,
  DEFENSE_SPAN,
  infieldDepthFt,
  nearestFielder,
  sprintFt,
} from './fielders';
import {
  CORNER_DEG,
  fieldBattedBall,
  XB_DEPTH_DATUM_FT,
  XB_DEPTH_PER_FT,
  XB_DOUBLE_FT,
  XB_TRIPLE_FT,
} from './fielding';
import type { FieldingInput } from './fielding';
import { RUNNER_HOME_TO_FIRST_S } from './groundBall';
import { HARBOURFRONT, resolveFence } from './parks';
import { GAME_AIR } from './pitchSim';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/**
 * A batted ball, by where and when it landed.
 *
 * ⚠ `groundFps` DEFAULTS TO ZERO — a ball that stops dead where it hits the
 * ground. That is deliberately the LEAST interesting input the rolling phase can
 * be given, so a fly-ball row cannot pass by accident on a roll it never had;
 * the rows that land on the dirt pass their own, taken from a real flight.
 */
const ball = (
  distFt: number,
  bearingDeg: number,
  hangS: number,
  groundFps = 0,
): FieldingInput => ({
  outcome: 'inPlay',
  distFt,
  bearingDeg,
  hangS,
  landingGroundFps: groundFps,
  foulTerritoryFt: HARBOURFRONT.foulTerritoryFt,
});

// ---------------------------------------------------------------------------

describe('the batted-ball ladder', () => {
  it('⚠ GOLDEN: the model\'s own ladder, named so a drift reads as a wrong call', () => {
    // ⚠ EVERY ROW BELOW IS MODEL OUTPUT FROZEN, NOT PUBLISHED DATA, and the
    // table has to say so as loudly as the header does. Nothing outside this
    // repo publishes "a 355 ft fly to the LC gap with a 4.6 s hang is an out";
    // what the rows encode is that the LOOKUP reads the way baseball reads, and
    // they are pinned as goldens so that a change to any of the feel knobs
    // (XB_*, DEFENSE_SPAN, CORNER_DEG) surfaces as a specific wrong call rather
    // than as a table nobody re-read.
    //
    // The distinction matters for what you do when one fails: a golden that
    // moves is a decision to make, not a bug to fix. Compare the carry ladder in
    // `battedBallSim.test.ts`, where the right-hand column IS published and a
    // residual moving is evidence about the physics.
    //
    // ⚠ NOT ONE CALL IN THIS LADDER MOVED WHEN THE ROLLING PHASE LANDED, AND
    // THAT IS THE INTERESTING PART. The two infield rows are resolved by a
    // completely different mechanism now — a roll, a race and a throw in
    // `groundBall.ts`, instead of the deleted `GROUND_INTERCEPT_FT` — and they
    // land on the same answers, which is the check that the feel knob had been
    // standing in for roughly the right physics rather than for nothing. They do
    // carry a new INPUT (the ground speed at the bounce, taken from the flights
    // that produce those landings); the eleven fly-ball rows pass zero, because
    // for a ball in the air the roll is not consulted at all.
    const cases: Array<[string, number, number, number, number, string]> = [
      ['routine grounder to SS', 120, -20, 1.05, 118, 'OUT'],
      ['chopper to third', 95, -36, 1.3, 96, 'OUT'],
      ['seeing-eye up the middle', 150, -3, 1.4, 112, 'SINGLE'],
      ['screamer up the middle', 175, 0, 1.5, 0, 'SINGLE'],
      ['texas leaguer to short LF', 205, -12, 2.4, 0, 'SINGLE'],
      // ⚠ THE TWO ROWS THAT MEASURE THE DATUM DECISION are this one and the
      // 'deep LC screamer' below — the only two of the thirteen that an ARC
      // datum would have flipped, and it would have flipped both by a whisker:
      // this bloop indexes 67.29 against the 68 ft threshold and would have gone
      // to 68.17, the screamer 129.42 against 130 and would have gone to 131.20.
      // Both stay because `XB_DEPTH_DATUM_FT` is flat; see its declaration for
      // why, and for what the alternative costs across the whole lookup.
      ['bloop into shallow RC', 225, 14, 2.7, 0, 'SINGLE'],
      ['lazy fly to right', 300, 30, 4.4, 0, 'OUT'],
      ['can of corn to centre', 330, 0, 4.9, 0, 'OUT'],
      ['high fly into the LC gap', 355, -22, 4.6, 0, 'OUT'],
      ['liner into the LC gap', 360, -22, 3.6, 0, 'DOUBLE'],
      ['down the left-field line', 320, -43, 3.6, 0, 'DOUBLE'],
      ['deep LC screamer', 390, -20, 3.4, 0, 'DOUBLE'],
      ['scorched into the LC gap', 405, -19, 3.2, 0, 'TRIPLE'],
    ];
    let table =
      '\n[FIELDING LADDER — defence 0.5. ⚠ GOLDEN: every call is model output]\n' +
      '  batted ball                   dist  bear  hang  ft/s   who    gap   reach   miss   edge   call\n' +
      '  (gap/reach/miss are AIR numbers and are 0 on the two rows the roll resolves)\n';
    // ⚠ EVERY ROW IS EVALUATED AND THE TABLE IS PRINTED BEFORE ANYTHING IS
    // ASSERTED. An `expect` inside the loop aborts on the first bad row, so a
    // change that moves two calls reports one, gets "fixed", and reports the
    // other on the next run — which is exactly what happened while this fix was
    // being made. A ladder is read whole or it is not read.
    const wrong: string[] = [];
    for (const [name, d, b, h, g, want] of cases) {
      const p = fieldBattedBall(ball(d, b, h, g), 0.5);
      table += `  ${name.padEnd(28)}${String(d).padStart(5)}${String(b).padStart(6)}${h
        .toFixed(1)
        .padStart(6)}${String(g).padStart(6)}   ${p.nearest.padEnd(4)}${p.gapFt
        .toFixed(1)
        .padStart(6)}${p.reachFt.toFixed(1).padStart(8)}${p.missFt.toFixed(1).padStart(7)}${infieldDepthFt(
        b,
      )
        .toFixed(1)
        .padStart(7)}   ${p.result}${p.result === want ? '' : `   ⚠ pinned ${want}`}\n`;
      if (p.result !== want) wrong.push(`${name} (${d} ft / ${b}° / ${h} s): ${want} → ${p.result}`);
    }
    log(table);
    expect(wrong).toEqual([]);
  });

  it('⚠ the DATUM decision, as a counterfactual rather than as prose', () => {
    // ⚠ WHAT AN ARC DATUM WOULD HAVE DONE, COMPUTED. `XB_DEPTH_DATUM_FT` is flat
    // while `infieldDepthFt` is not, and that split is the one judgement call in
    // the infield-arc fix — so the alternative is evaluated here rather than
    // described, and the two rows it would flip are named. The shipped index is
    // `fieldBattedBall`'s own output; the counterfactual re-runs the same
    // arithmetic with the datum swapped, which is the only thing that differs.
    const cases: Array<[string, number, number, number]> = [
      ['texas leaguer to short LF', 205, -12, 2.4],
      ['bloop into shallow RC', 225, 14, 2.7],
      ['liner into the LC gap', 360, -22, 3.6],
      ['down the left-field line', 320, -43, 3.6],
      ['deep LC screamer', 390, -20, 3.4],
      ['scorched into the LC gap', 405, -19, 3.2],
    ];
    const call = (xb: number) =>
      xb < XB_DOUBLE_FT ? 'SINGLE' : xb < XB_TRIPLE_FT ? 'DOUBLE' : 'TRIPLE';
    let table =
      '\n[DATUM COUNTERFACTUAL — extra-base index, flat datum (shipped) vs the arc]\n' +
      '  batted ball                   bear   flat    call     arc    call\n';
    const flipped: string[] = [];
    for (const [name, d, b, h] of cases) {
      const p = fieldBattedBall(ball(d, b, h), 0.5);
      const flat = p.missFt + XB_DEPTH_PER_FT * (d - XB_DEPTH_DATUM_FT);
      const arc = p.missFt + XB_DEPTH_PER_FT * (d - infieldDepthFt(b));
      table += `  ${name.padEnd(28)}${String(b).padStart(5)}${flat.toFixed(2).padStart(8)}   ${call(
        flat,
      ).padEnd(7)}${arc.toFixed(2).padStart(7)}   ${call(arc)}\n`;
      expect(call(flat), name).toBe(p.result); // the counterfactual reproduces the model
      if (call(flat) !== call(arc)) flipped.push(`${name}: ${call(flat)} → ${call(arc)}`);
    }
    table += `\n  Rows an arc datum would flip: ${flipped.join('; ')}\n`;
    log(table);
    expect(flipped).toEqual([
      'bloop into shallow RC: SINGLE → DOUBLE',
      'deep LC screamer: DOUBLE → TRIPLE',
    ]);
  });

  it('⚠ a ball that lands on the DIRT is handed to the rolling phase', () => {
    // ⚠ THIS IS THE TEST THAT REPLACED THE LANDING-POINT LIMITATION, and it
    // asserts the PROPERTY rather than the example: for every ball landing
    // inside the arc, at every bearing, hang and ground speed, the result is an
    // OUT or a SINGLE and the play carries the rolling phase's own numbers. A
    // dirt ball can never be scored an extra-base hit off the miss arithmetic,
    // which is what the old `GROUND_INTERCEPT_FT` era's cap existed to prevent
    // and what the roll now prevents by construction.
    //
    // ⚠ AND IT WOULD HAVE CAUGHT THE OLD DEFECT. A routine grounder to short
    // lands 25.1 ft from him with 0.55 s of usable time, in which he covers
    // 2.3 ft; before the roll existed, that ball reached the fielder only
    // through a labelled feel knob, and setting it to 0 made every routine
    // ground ball a base hit. It is now an out because the ball ROLLS to him.
    let checked = 0;
    for (let b = -44; b <= 44; b += 2) {
      const edge = infieldDepthFt(b);
      for (let d = 3; d < edge; d += 7) {
        for (const h of [0.05, 0.4, 1.2, 3.0]) {
          for (const g of [0, 60, 110, 145]) {
            const p = fieldBattedBall(ball(d, b, h, g), 0.5);
            checked++;
            // ⚠ THE DISCRIMINATOR IS `ground`, NOT `missFt`. A ground play now
            // reports `missFt: 0` too — see `FieldingPlay.gapFt` — so keying
            // this on the zero would silently start asserting the wrong branch,
            // which is exactly what it did on the first run of this edit.
            if (p.ground === null) {
              // Caught in the air — the one way a dirt ball skips the roll.
              expect(p.result).toBe('OUT');
              expect(p.missFt).toBe(0);
              continue;
            }
            expect(['OUT', 'SINGLE'], `${d}/${b}/${h}/${g}`).toContain(p.result);
            expect(p.result === 'OUT').toBe(p.ground!.playS <= RUNNER_HOME_TO_FIRST_S);
            // The reported fielder is the one who made the play, not the one
            // nearest the spot the ball first touched — and the AIR trio is
            // zeroed with him, because `gapFt` was measured to somebody else.
            expect(p.nearest).toBe(p.ground!.fielder);
            expect([p.gapFt, p.reachFt, p.missFt]).toEqual([0, 0, 0]);
          }
        }
      }
    }
    const routine = fieldBattedBall(ball(120, -20, 1.05, 118), 0.5);
    // The 25.1 ft is a fact about the LANDING POINT and the nearest fielder to
    // it, so it is read from `fielders.nearestFielder` rather than from a play
    // that no longer claims to report it.
    const near = nearestFielder(-20, 120);
    log(
      `\n[DIRT] ${checked} balls landing inside the arc, all OUT or SINGLE, all with a roll.\n` +
        `  The routine grounder to short: he is ${near.gapFt.toFixed(
          1,
        )} ft from where it landed and covers ${sprintFt(1.05).toFixed(
          1,
        )} ft under his own power in the air,\n  and the ball rolls to him — the ${routine.ground?.fielder} gloves it at ${routine.ground?.fieldedAtFt.toFixed(
          0,
        )} ft, ${routine.ground?.fieldedS.toFixed(2)} s, throws ${routine.ground?.throwFt.toFixed(
          0,
        )} ft: ${routine.ground?.playS.toFixed(2)} s against ${RUNNER_HOME_TO_FIRST_S} → ${routine.result}.\n`,
    );
    expect(routine.result).toBe('OUT');
    expect(near.pos).toBe('SS');
    expect(near.gapFt).toBeCloseTo(25.1, 1);
    expect(sprintFt(1.05)).toBeLessThan(3);
  });
});

// ---------------------------------------------------------------------------

describe('boundaries', () => {
  /** A ball placed exactly `gap` feet straight out beyond a fielder. */
  const beyond = (pos: string, gapFt: number, hangS: number): FieldingInput => {
    const f = ALIGNMENT.find((a) => a.pos === pos);
    if (!f) throw new Error(pos);
    return ball(f.distFt + gapFt, f.bearingDeg, hangS);
  };

  it('the catch boundary is exactly the reach', () => {
    // Deep enough that the ball is nowhere near the dirt, so the only thing in
    // play is the sprint model.
    const hang = 4;
    const reach = sprintFt(hang);
    expect(fieldBattedBall(beyond('CF', reach, hang), 0.5).result).toBe('OUT');
    expect(fieldBattedBall(beyond('CF', reach, hang), 0.5).missFt).toBe(0);
    const justOut = fieldBattedBall(beyond('CF', reach + 0.01, hang), 0.5);
    expect(justOut.result).not.toBe('OUT');
    expect(justOut.missFt).toBeGreaterThan(0);
    log(
      `\n[BOUNDARY] CF, 4.0 s hang, reach ${reach.toFixed(4)} ft: at ${reach.toFixed(
        4,
      )} ft it is an OUT, at ${(reach + 0.01).toFixed(4)} ft it is a ${justOut.result}.\n`,
    );
  });

  it('⚠ 140 ft down the line is OUTFIELD GRASS — the defect the arc fixed', () => {
    // ⚠ THIS IS THE ASSERTION THE OLD CONSTANT FAILED, AND THE ONE A CIRCLE OF
    // ANY RADIUS CANNOT PASS. The same 140 ft at two bearings: down the line it
    // is 12 ft PAST the dirt (edge 127.6) and to centre field it is 15 ft short
    // of it (edge 155.5). One plate-centred radius must call both the same way;
    // only a bearing-dependent edge can call them differently.
    //
    // ⚠ WHAT THE TWO SIDES OF THE BRANCH DO IS NOW DIFFERENT IN KIND, not merely
    // in a reach credit: past the arc a ball is scored on the extra-base index
    // off its LANDING POINT and can be a double, inside it the ball ROLLS and
    // can only be an out or a single. That is a bigger difference than the one
    // this test was written for, so it is a stronger test than it was.
    const line = fieldBattedBall(ball(140, -45, 2, 120), 0.5);
    const centre = fieldBattedBall(ball(140, 0, 2, 120), 0.5);
    expect(infieldDepthFt(-45)).toBeLessThan(140);
    expect(infieldDepthFt(0)).toBeGreaterThan(140);
    // Down the line: outfield grass, so the air lookup and the extra-base index.
    expect(line.ground).toBeNull();
    expect(line.reachFt).toBeCloseTo(sprintFt(2), 9);
    // To centre: on the dirt, so it rolls and is thrown at.
    expect(centre.ground).not.toBeNull();
    log(
      `[ARC] 140 ft / −45° (edge ${infieldDepthFt(-45).toFixed(
        1,
      )}): no roll, reach ${line.reachFt.toFixed(1)} → ${line.result}\n[ARC] 140 ft /   0° (edge ${infieldDepthFt(
        0,
      ).toFixed(1)}): rolls to ${centre.ground?.path.stopDistFt.toFixed(
        0,
      )} ft, ${centre.ground?.fielder} throws ${centre.ground?.throwFt.toFixed(0)} ft → ${centre.result}\n`,
    );
  });

  it('the single/double boundary sits exactly on XB_DOUBLE_FT', () => {
    // Depth credit is 0.3 ft per foot beyond the datum, so pick a gap that puts
    // the index a hair either side of the threshold. A short hang so the
    // fielder's reach is small enough for a real gap to open; this is a probe of
    // the lookup, not of a plausible flight.
    const hang = 2.5;
    const reach = sprintFt(hang);
    const cf = ALIGNMENT.find((a) => a.pos === 'CF');
    if (!cf) throw new Error('CF');
    // `beyond(g)` puts the ball g ft straight out past CF, so miss = g − reach
    // and the depth credit grows with g too. Solve the threshold exactly:
    //   (g − reach) + 0.3·(cf + g − DATUM) = XB_DOUBLE_FT
    const g = (XB_DOUBLE_FT + reach - XB_DEPTH_PER_FT * (cf.distFt - XB_DEPTH_DATUM_FT)) /
      (1 + XB_DEPTH_PER_FT);
    const under = fieldBattedBall(beyond('CF', g - 0.05, hang), 0.5);
    const over = fieldBattedBall(beyond('CF', g + 0.05, hang), 0.5);
    log(
      `[BOUNDARY] single/double at gap ${g.toFixed(3)} ft (miss ${(g - reach).toFixed(
        2,
      )} ft + ${(XB_DEPTH_PER_FT * (cf.distFt + g - XB_DEPTH_DATUM_FT)).toFixed(
        2,
      )} ft of depth credit): ${under.result} / ${over.result}\n`,
    );
    expect(under.result).toBe('SINGLE');
    expect(over.result).toBe('DOUBLE');
  });

  it('off the wall is never an out, and a corner is a triple', () => {
    // The ball has already gone past everybody; no hang time saves it.
    const wall = (bearingDeg: number) => ({ ...ball(400, bearingDeg, 6), outcome: 'offWall' as const });
    expect(fieldBattedBall(wall(0), 1).result).toBe('DOUBLE');
    expect(fieldBattedBall(wall(CORNER_DEG - 0.01), 1).result).toBe('DOUBLE');
    expect(fieldBattedBall(wall(CORNER_DEG), 1).result).toBe('TRIPLE');
    expect(fieldBattedBall(wall(-CORNER_DEG), 1).result).toBe('TRIPLE');
    // ...even with a monstrous hang time and the best defender in the game.
    expect(fieldBattedBall({ ...wall(0), hangS: 20 }, 1).result).toBe('DOUBLE');
    // …and no roll is consulted: the ball is off the wall, not on the dirt.
    expect(fieldBattedBall(wall(0), 1).ground).toBeNull();
  });

  it('a home run is a home run, and nobody is asked about it', () => {
    const hr = fieldBattedBall({ ...ball(430, -10, 5), outcome: 'homeRun' }, 0);
    expect(hr.result).toBe('HR');
    expect(hr.nearest).toBe('');
    expect(hr.reachFt).toBe(0);
    expect(hr.ground).toBeNull();
  });

  it('a foul pop is caught only inside the park\'s own foul territory', () => {
    // Depth into foul ground = dist·sin(|bearing| − 45). At 150 ft the home
    // park's 60 ft backstop runs out near 68.6° (it was 28 ft ⇒ 55.7° before the
    // published profile landed — the boundary is read from the park, not typed,
    // so the assertion moved with the data and the printed line says where).
    const foul = (bearingDeg: number, hangS: number) => ({
      ...ball(150, bearingDeg, hangS),
      outcome: 'foul' as const,
    });
    const edgeDeg = 45 + (Math.asin(HARBOURFRONT.foulTerritoryFt / 150) * 180) / Math.PI;
    log(
      `[BOUNDARY] foul ground ${HARBOURFRONT.foulTerritoryFt} ft deep ⇒ a 150 ft pop is catchable out to ${edgeDeg.toFixed(
        2,
      )}°\n`,
    );
    expect(fieldBattedBall(foul(edgeDeg - 0.01, 3), 0.5).result).toBe('OUT');
    expect(fieldBattedBall(foul(edgeDeg + 0.01, 3), 0.5).result).toBe('FOUL');
    // A screaming foul liner is not catchable however shallow it is.
    expect(fieldBattedBall(foul(46, 1.5), 0.5).result).toBe('FOUL');
    expect(fieldBattedBall(foul(46, 3), 0.5).result).toBe('OUT');
    // A park with no foul ground catches nothing.
    expect(fieldBattedBall({ ...foul(46, 3), foulTerritoryFt: 1 }, 0.5).result).toBe('FOUL');
  });

  it('the one defender rating spans exactly ±15 %, and it flips a real play', () => {
    const b = ball(310, -14, 4);
    const worst = fieldBattedBall(b, 0);
    const mid = fieldBattedBall(b, 0.5);
    const best = fieldBattedBall(b, 1);
    log(
      `[DEFENCE] the same ball ${b.distFt} ft / ${b.bearingDeg}° / ${b.hangS} s, gap ${mid.gapFt.toFixed(
        1,
      )} ft:\n  0.0 → ${worst.result} (reach ${worst.reachFt.toFixed(1)})   0.5 → ${mid.result} (reach ${mid.reachFt.toFixed(
        1,
      )})   1.0 → ${best.result} (reach ${best.reachFt.toFixed(1)})\n`,
    );
    expect(best.reachFt / worst.reachFt).toBeCloseTo((1 + DEFENSE_SPAN / 2) / (1 - DEFENSE_SPAN / 2), 9);
    expect(worst.result).toBe('SINGLE');
    expect(best.result).toBe('OUT');
    // Out-of-range ratings clamp rather than extrapolating to a superhero.
    expect(fieldBattedBall(b, 99).reachFt).toBe(best.reachFt);
    expect(fieldBattedBall(b, -99).reachFt).toBe(worst.reachFt);
  });
});

// ---------------------------------------------------------------------------

describe('end to end: a swing, a park and a defence', () => {
  it('the fence walk and the fielding lookup agree on one real flight', () => {
    // The whole chain on one ball: launch → flight → fence → fielders, and now
    // → the roll. ⚠ THE CHOPPER ROW IS THE ONE THAT MOVED WITH THE ROLLING
    // PHASE and it moved for the right reason: a 100 mph ball hit at −22° used
    // to be capped at a SINGLE because it landed on the dirt and nothing could
    // reach it. It now rolls, and the fielder throws.
    let table =
      '\n[END TO END — SkyDome, roof shut, defence 0.5]\n  EV   LA   spray   carry   hang   ft/s    fence     result\n';
    const rows: Array<[number, number, number, string]> = [
      [88, 27, 0, 'OUT'], // a lazy fly to centre
      [93, 27, -25, 'OUT'], // one step in front of the LC wall
      [95, 27, -25, 'DOUBLE'], // off the wall
      [97, 27, -25, 'HR'], // over it
      [103, 14, -20, 'DOUBLE'], // a liner into the gap
      [100, -22, 15, 'OUT'], // a chopper — fielded on the ground and thrown out
      [106, 27, 50, 'FOUL'], // pulled foul
    ];
    const wrong: string[] = [];
    for (const [ev, la, spray, want] of rows) {
      const f = simulateBattedBall(launchFromAngles(ev, la, spray, 2200), {
        elevFt: HARBOURFRONT.elevationFt,
        tempF: 72,
        rh: 0.4,
      });
      const fence = resolveFence(f, HARBOURFRONT, true);
      const play = fieldBattedBall(
        {
          outcome: fence.outcome,
          distFt: fence.distFt,
          bearingDeg: fence.bearingDeg,
          hangS: fence.hangS,
          landingGroundFps: f.landingGroundFps,
          foulTerritoryFt: HARBOURFRONT.foulTerritoryFt,
        },
        0.5,
      );
      table += `  ${ev}${String(la).padStart(5)}°${String(spray).padStart(6)}°  ${f.carryFt
        .toFixed(1)
        .padStart(6)}  ${fence.hangS.toFixed(2).padStart(5)}  ${f.landingGroundFps
        .toFixed(0)
        .padStart(5)}  ${fence.outcome.padEnd(9)} ${play.result}${
        play.result === want ? '' : `   ⚠ pinned ${want}`
      }\n`;
      if (play.result !== want) wrong.push(`${ev} mph, ${la}° LA, ${spray}° spray: ${want} → ${play.result}`);
    }
    log(table);
    expect(wrong).toEqual([]);
  });

  it('the same inputs always give the same play — no hidden randomness', () => {
    const b = ball(340, 12, 3.9, 60);
    const once = fieldBattedBall(b, 0.62);
    for (let i = 0; i < 5; i++) expect(fieldBattedBall(b, 0.62)).toEqual(once);
    const g = ball(80, 12, 0.6, 120);
    const gOnce = fieldBattedBall(g, 0.62);
    for (let i = 0; i < 5; i++) expect(fieldBattedBall(g, 0.62)).toEqual(gOnce);
    const f = simulateBattedBall(launchFromAngles(103, 26, -12, 2200), GAME_AIR);
    expect(resolveFence(f, HARBOURFRONT, false)).toEqual(resolveFence(f, HARBOURFRONT, false));
  });
});
