// The fielding bench. The model is deliberately tiny, so the tests are mostly
// BOUNDARIES — the middle of a lookup table is where it is easiest to be right
// and least interesting to assert.
//
// It also pins the model's stated LIMITATION (a grounder is scored off its
// landing point, not off a roll and a throw) so that nobody later reads a
// routine ground ball becoming an out as evidence of infield physics that is
// not there.

import { describe, expect, it } from 'vitest';
import { launchFromAngles, simulateBattedBall } from './battedBallSim';
import {
  ALIGNMENT,
  CORNER_DEG,
  DEFENSE_SPAN,
  fieldBattedBall,
  FIELDER_ACCEL_FPS2,
  FIELDER_REACTION_S,
  FIELDER_SPEED_FPS,
  FIELDER_TIME_TO_SPEED_S,
  GROUND_INTERCEPT_FT,
  INFIELD_ARC_R_FT,
  infieldDepthFt,
  nearestFielder,
  sprintFt,
  XB_DEPTH_DATUM_FT,
  XB_DEPTH_PER_FT,
  XB_DOUBLE_FT,
  XB_TRIPLE_FT,
} from './fielding';
import type { FieldingInput } from './fielding';
import { HARBOURFRONT, resolveFence } from './parks';
import { GAME_AIR } from './pitchSim';
import { RUBBER_D_FT } from './zone';

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

const ball = (distFt: number, bearingDeg: number, hangS: number): FieldingInput => ({
  outcome: 'inPlay',
  distFt,
  bearingDeg,
  hangS,
  foulTerritoryFt: HARBOURFRONT.foulTerritoryFt,
});

// ---------------------------------------------------------------------------

describe('how far a fielder gets', () => {
  it('accelerates rather than teleporting to sprint speed', () => {
    // ⚠ THE RAMP IS NOT COSMETIC. A fielder treated as instantly at 27 ft/s is
    // credited v·t_acc/2 = 24.3 ft too much on every play longer than the ramp,
    // which is the difference between a gap double and a routine out.
    expect(FIELDER_ACCEL_FPS2).toBeCloseTo(FIELDER_SPEED_FPS / FIELDER_TIME_TO_SPEED_S, 12);
    let table = '\n[REACH — ground covered from a standing start, ft]\n  hang s   this model   instant-sprint   over-credit\n';
    for (const h of [1, 1.5, 2, 3, 4, 5, 6]) {
      const naive = FIELDER_SPEED_FPS * Math.max(0, h - FIELDER_REACTION_S);
      table += `  ${h.toFixed(1).padStart(5)}   ${sprintFt(h).toFixed(1).padStart(9)}   ${naive
        .toFixed(1)
        .padStart(13)}   ${(naive - sprintFt(h)).toFixed(1).padStart(10)}\n`;
    }
    table += `\n  Published catch-probability envelope: ~100 ft covered on a ~4 s hang is a\n  five-star play. This model: ${sprintFt(
      4,
    ).toFixed(1)} ft. The instant-sprint version gives ${(
      FIELDER_SPEED_FPS * 3.5
    ).toFixed(1)}, which would make one routine.\n`;
    log(table);

    // Nothing happens before the reaction is over, then it is smooth and
    // strictly increasing — a jump at the ramp/sprint join would be a fielder
    // teleporting mid-play.
    expect(sprintFt(FIELDER_REACTION_S)).toBe(0);
    expect(sprintFt(0.2)).toBe(0);
    const join = FIELDER_REACTION_S + FIELDER_TIME_TO_SPEED_S;
    expect(Math.abs(sprintFt(join - 1e-7) - sprintFt(join + 1e-7))).toBeLessThan(1e-4);
    expect(sprintFt(join)).toBeCloseTo(0.5 * FIELDER_SPEED_FPS * FIELDER_TIME_TO_SPEED_S, 9);
    for (let h = 0; h < 7; h += 0.05) expect(sprintFt(h + 0.05)).toBeGreaterThanOrEqual(sprintFt(h));
    expect(sprintFt(4)).toBeCloseTo(70.2, 1);
  });

  it('the alignment is fixed data — the "no shifts" rule, expressed as a constant', () => {
    expect(ALIGNMENT).toHaveLength(7);
    expect(ALIGNMENT.map((f) => f.pos)).toEqual(['3B', 'SS', '2B', '1B', 'LF', 'CF', 'RF']);
    // Mirrored infield and outfield, so a pull-side and an oppo ball of the same
    // shape get the same defence.
    expect(nearestFielder(-19, 145).gapFt).toBeCloseTo(nearestFielder(19, 145).gapFt, 9);
    expect(nearestFielder(-29, 290).pos).toBe('LF');
    expect(nearestFielder(29, 290).pos).toBe('RF');
    expect(nearestFielder(0, 315).pos).toBe('CF');
    expect(nearestFielder(0, 315).gapFt).toBeCloseTo(0, 9);
  });

  it('the infield edge is the 95 ft ARC struck from the rubber, not a circle', () => {
    // ⚠ THE TEST WITH TEETH IS THE DEFINING PROPERTY, NOT THE TABLE. Any number
    // of wrong-shaped functions reproduce 155.5 ft at dead centre — the circle
    // this replaced did. What only the right one satisfies: every point of the
    // edge is EXACTLY 95 ft from the rubber. Asserted by converting the model's
    // plate-centred answer back to Cartesian and measuring it against the
    // rubber's own position, i.e. by the inverse of the derivation.
    for (let b = -90; b <= 90; b += 1.5) {
      const r = infieldDepthFt(b);
      const x = r * Math.sin((b * Math.PI) / 180);
      const y = r * Math.cos((b * Math.PI) / 180);
      expect(Math.hypot(x, y - RUBBER_D_FT), `${b}°`).toBeCloseTo(INFIELD_ARC_R_FT, 9);
    }
    // The plate is INSIDE the arc, so the discriminant can never go negative and
    // there is no clamp to hide a bug in — true at every bearing, behind the
    // plate included.
    expect(RUBBER_D_FT).toBeLessThan(INFIELD_ARC_R_FT);
    expect(infieldDepthFt(180)).toBeCloseTo(INFIELD_ARC_R_FT - RUBBER_D_FT, 9);

    let table =
      '\n[INFIELD EDGE — plate to the dirt at a bearing, ft]\n' +
      '  bearing    arc (this model)   old plate-centred circle   over-stated by\n';
    for (const b of [0, 10, 20, 29, 38, 45]) {
      const r = infieldDepthFt(b);
      table += `  ${String(b).padStart(5)}°   ${r.toFixed(1).padStart(14)}   ${(RUBBER_D_FT + 95)
        .toFixed(1)
        .padStart(23)}   ${(RUBBER_D_FT + 95 - r).toFixed(1).padStart(14)}\n`;
    }
    log(table);

    // The four figures BASEBALL.md quotes for the true arc, now the shipped ones.
    expect(infieldDepthFt(0)).toBeCloseTo(RUBBER_D_FT + 95, 9);
    expect(infieldDepthFt(20)).toBeCloseTo(149.6, 1);
    expect(infieldDepthFt(38)).toBeCloseTo(135.1, 1);
    expect(infieldDepthFt(45)).toBeCloseTo(127.6, 1);
    expect(RUBBER_D_FT + 95 - infieldDepthFt(45)).toBeCloseTo(27.9, 1);
    // Mirrored, and shrinking monotonically from centre out to the line — the
    // shape a circle cannot have.
    for (let b = 0; b < 45; b += 1) {
      expect(infieldDepthFt(-b)).toBeCloseTo(infieldDepthFt(b), 12);
      expect(infieldDepthFt(b + 1)).toBeLessThan(infieldDepthFt(b));
    }
  });
});

// ---------------------------------------------------------------------------

describe('the batted-ball ladder', () => {
  it('⚠ GOLDEN: the model\'s own ladder, named so a drift reads as a wrong call', () => {
    // ⚠ EVERY ROW BELOW IS MODEL OUTPUT FROZEN, NOT PUBLISHED DATA, and the
    // table has to say so as loudly as the header does. Nothing outside this
    // repo publishes "a 355 ft fly to the LC gap with a 4.6 s hang is an out";
    // what the rows encode is that the LOOKUP reads the way baseball reads, and
    // they are pinned as goldens so that a change to any of the feel knobs
    // (GROUND_INTERCEPT_FT, XB_*, DEFENSE_SPAN, CORNER_DEG) surfaces as a
    // specific wrong call rather than as a table nobody re-read.
    //
    // The distinction matters for what you do when one fails: a golden that
    // moves is a decision to make, not a bug to fix. Compare the carry ladder in
    // `battedBallSim.test.ts`, where the right-hand column IS published and a
    // residual moving is evidence about the physics.
    const cases: Array<[string, number, number, number, string]> = [
      ['routine grounder to SS', 120, -20, 1.05, 'OUT'],
      ['chopper to third', 95, -36, 1.3, 'OUT'],
      ['seeing-eye up the middle', 150, -3, 1.4, 'SINGLE'],
      ['screamer up the middle', 175, 0, 1.5, 'SINGLE'],
      ['texas leaguer to short LF', 205, -12, 2.4, 'SINGLE'],
      // ⚠ THE TWO ROWS THAT MEASURE THE DATUM DECISION are this one and the
      // 'deep LC screamer' below — the only two of the thirteen that an ARC
      // datum would have flipped, and it would have flipped both by a whisker:
      // this bloop indexes 67.29 against the 68 ft threshold and would have gone
      // to 68.17, the screamer 129.42 against 130 and would have gone to 131.20.
      // Both stay because `XB_DEPTH_DATUM_FT` is flat; see its declaration for
      // why, and for what the alternative costs across the whole lookup.
      ['bloop into shallow RC', 225, 14, 2.7, 'SINGLE'],
      ['lazy fly to right', 300, 30, 4.4, 'OUT'],
      ['can of corn to centre', 330, 0, 4.9, 'OUT'],
      ['high fly into the LC gap', 355, -22, 4.6, 'OUT'],
      ['liner into the LC gap', 360, -22, 3.6, 'DOUBLE'],
      ['down the left-field line', 320, -43, 3.6, 'DOUBLE'],
      ['deep LC screamer', 390, -20, 3.4, 'DOUBLE'],
      ['scorched into the LC gap', 405, -19, 3.2, 'TRIPLE'],
    ];
    let table =
      '\n[FIELDING LADDER — defence 0.5. ⚠ GOLDEN: every call is model output]\n' +
      '  batted ball                   dist  bear  hang   near   gap   reach   miss   edge   call\n';
    // ⚠ EVERY ROW IS EVALUATED AND THE TABLE IS PRINTED BEFORE ANYTHING IS
    // ASSERTED. An `expect` inside the loop aborts on the first bad row, so a
    // change that moves two calls reports one, gets "fixed", and reports the
    // other on the next run — which is exactly what happened while this fix was
    // being made. A ladder is read whole or it is not read.
    const wrong: string[] = [];
    for (const [name, d, b, h, want] of cases) {
      const p = fieldBattedBall(ball(d, b, h), 0.5);
      table += `  ${name.padEnd(28)}${String(d).padStart(5)}${String(b).padStart(6)}${h
        .toFixed(1)
        .padStart(6)}   ${p.nearest.padEnd(4)}${p.gapFt.toFixed(1).padStart(6)}${p.reachFt
        .toFixed(1)
        .padStart(8)}${p.missFt.toFixed(1).padStart(7)}${infieldDepthFt(b)
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

  it('⚠ the grounder is scored off the landing point — the limitation, pinned', () => {
    // A routine grounder to short lands 25.1 ft from him with 0.55 s of usable
    // time, in which he covers 2.3 ft. Without GROUND_INTERCEPT_FT — the
    // stand-in for the roll and the throw this model does not have — every
    // routine ground ball is a base hit. That is arithmetic, not opinion, and it
    // is asserted so the knob's job stays visible.
    const g = fieldBattedBall(ball(120, -20, 1.05), 0.5);
    expect(g.result).toBe('OUT');
    expect(g.gapFt).toBeCloseTo(25.1, 1);
    expect(sprintFt(1.05)).toBeLessThan(3);
    expect(g.reachFt - GROUND_INTERCEPT_FT).toBeLessThan(g.gapFt);
    expect(GROUND_INTERCEPT_FT).toBeGreaterThan(0);
    log(
      `\n[LIMITATION] the SS covers ${sprintFt(1.05).toFixed(
        1,
      )} ft under his own power on a 1.05 s grounder ${g.gapFt.toFixed(
        1,
      )} ft away.\n  GROUND_INTERCEPT_FT = ${GROUND_INTERCEPT_FT} ft is what makes it an out; the roll and the throw are NOT modelled.\n`,
    );
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
    // Deep enough that the infield credit is not in play, so `reach` is purely
    // the sprint model.
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

  it('⚠ the infield cap and the depth term overlap — the margin, measured', () => {
    // ⚠ A MUTATION THAT CANNOT BE KILLED, MEASURED INSTEAD OF IGNORED.
    // `fieldBattedBall` caps any unfielded ball landing on the dirt at a single,
    // and then indexes deeper balls on `miss + 0.3·(dist − DATUM)`. Deleting
    // the CAP changes no call at all, because for a shallow ball that index is
    // negative-shifted enough to stay under the single/double threshold anyway.
    // That is not a testing gap in the shipped model — it is the two clauses
    // overlapping in effect — but it does mean the cap's mutation is
    // unobservable, so what is asserted here is the MARGIN that makes it so.
    // If a feel knob ever narrows this, the cap becomes load-bearing and this
    // test says so before a wrong call does.
    let worst = -Infinity;
    let at = '';
    for (let d = 0; d < infieldDepthFt(0); d += 0.5) {
      for (let b = -45; b <= 45; b += 1) {
        const edge = infieldDepthFt(b);
        if (d >= edge) continue; // off the dirt at THIS bearing — not the cap's case
        for (let h = 0.2; h <= 6; h += 0.2) {
          for (const def of [0, 0.5, 1]) {
            const mul = 1 + (def - 0.5) * DEFENSE_SPAN;
            const miss = Math.max(0, nearestFielder(b, d).gapFt - (sprintFt(h) + GROUND_INTERCEPT_FT) * mul);
            if (miss === 0) continue; // an out either way — the cap never sees it
            const xb = miss + XB_DEPTH_PER_FT * (d - XB_DEPTH_DATUM_FT);
            if (xb > worst) {
              worst = xb;
              at = `${d} ft / ${b}° / ${h.toFixed(1)} s / defence ${def}`;
            }
          }
        }
      }
    }
    log(
      `\n[OVERLAP] with the infield cap removed, the deepest index any ball on the dirt\n` +
        `  could reach is ${worst.toFixed(2)} against the ${XB_DOUBLE_FT} ft single/double threshold` +
        ` (at ${at}),\n  i.e. ${(XB_DOUBLE_FT - worst).toFixed(2)} ft of margin. The cap is currently belt-and-braces.\n`,
    );
    expect(worst).toBeLessThan(XB_DOUBLE_FT);
    // GOLDEN — the margin, so a knob move shows. ⚠ It survived the infield-arc
    // fix UNMOVED at 39.25, and that is evidence rather than luck: the peak is
    // set at d = 0, which is inside the dirt at every bearing, and the index is
    // measured from the flat `XB_DEPTH_DATUM_FT`. Under an arc datum it would
    // have risen to 47.62 — the margin eaten from 28.75 ft to 20.38 — which is
    // the same decision this file's ladder rows measure, seen from the other end.
    expect(worst).toBeCloseTo(39.25, 1);
  });

  it('⚠ 140 ft down the line is OUTFIELD GRASS — the defect the arc fixed', () => {
    // ⚠ THIS IS THE ASSERTION THE OLD CONSTANT FAILED, AND THE ONE A CIRCLE OF
    // ANY RADIUS CANNOT PASS. The same 140 ft at two bearings: down the line it
    // is 12 ft PAST the dirt (edge 127.6) and to centre field it is 15 ft short
    // of it (edge 155.5). One plate-centred radius must call both the same way;
    // only a bearing-dependent edge can call them differently, which is why this
    // pair is the test and the printed table is only the documentation.
    const line = ball(140, -45, 2);
    const centre = ball(140, 0, 2);
    expect(infieldDepthFt(-45)).toBeLessThan(140);
    expect(infieldDepthFt(0)).toBeGreaterThan(140);
    // Down the line: no infield credit, so the 3B does not get there.
    const l = fieldBattedBall(line, 0.5);
    expect(l.reachFt).toBeCloseTo(sprintFt(2) * 1, 9);
    expect(l.result).toBe('SINGLE');
    // To centre: still on the dirt, still credited the roll-and-throw stand-in.
    const c = fieldBattedBall(centre, 0.5);
    expect(c.reachFt).toBeCloseTo(sprintFt(2) + GROUND_INTERCEPT_FT, 9);
    log(
      `[ARC] 140 ft / −45° (edge ${infieldDepthFt(-45).toFixed(1)}): reach ${l.reachFt.toFixed(
        1,
      )} → ${l.result}\n[ARC] 140 ft /   0° (edge ${infieldDepthFt(0).toFixed(
        1,
      )}): reach ${c.reachFt.toFixed(1)} → ${c.result}\n`,
    );
  });

  it('the single/double boundary sits exactly on XB_DOUBLE_FT', () => {
    // Depth credit is 0.3 ft per foot beyond the infield, so pick a gap that
    // puts the index a hair either side of the threshold.
    // A short hang so the fielder's reach is small enough for a real gap to
    // open; this is a probe of the lookup, not of a plausible flight.
    const hang = 2.5;
    const reach = sprintFt(hang);
    const cf = ALIGNMENT.find((a) => a.pos === 'CF');
    if (!cf) throw new Error('CF');
    // `beyond(g)` puts the ball g ft straight out past CF, so miss = g − reach
    // and the depth credit grows with g too. Solve the threshold exactly:
    //   (g − reach) + 0.3·(cf + g − INFIELD) = XB_DOUBLE_FT
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
  });

  it('a home run is a home run, and nobody is asked about it', () => {
    const hr = fieldBattedBall({ ...ball(430, -10, 5), outcome: 'homeRun' }, 0);
    expect(hr.result).toBe('HR');
    expect(hr.nearest).toBe('');
    expect(hr.reachFt).toBe(0);
  });

  it('a foul pop is caught only inside the park\'s own foul territory', () => {
    // Depth into foul ground = dist·sin(|bearing| − 45). At 150 ft the 28 ft of
    // Harbourfront foul ground runs out somewhere near 55.7°.
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
    // The whole stage-4 chain on one ball: launch → flight → fence → fielders.
    let table =
      '\n[END TO END — Harbourfront, roof shut, defence 0.5]\n  EV   LA   spray   carry   hang    fence     result\n';
    const rows: Array<[number, number, number, string]> = [
      [88, 27, 0, 'OUT'], // a lazy fly to centre
      [93, 27, -25, 'OUT'], // one step in front of the LC wall
      [95, 27, -25, 'DOUBLE'], // off the wall
      [96, 27, -25, 'HR'], // over it
      [102, 14, -20, 'DOUBLE'], // a liner into the gap
      [100, -22, 15, 'SINGLE'], // a chopper — the landing-point limitation, capped
      [106, 27, 50, 'FOUL'], // pulled foul
    ];
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
          foulTerritoryFt: HARBOURFRONT.foulTerritoryFt,
        },
        0.5,
      );
      table += `  ${ev}${String(la).padStart(5)}°${String(spray).padStart(6)}°  ${f.carryFt
        .toFixed(1)
        .padStart(6)}  ${fence.hangS.toFixed(2).padStart(5)}  ${fence.outcome.padEnd(9)} ${play.result}\n`;
      expect(play.result, `${ev} mph, ${la}° LA, ${spray}° spray`).toBe(want);
    }
    log(table);
  });

  it('the same inputs always give the same play — no hidden randomness', () => {
    const b = ball(340, 12, 3.9);
    const once = fieldBattedBall(b, 0.62);
    for (let i = 0; i < 5; i++) expect(fieldBattedBall(b, 0.62)).toEqual(once);
    const f = simulateBattedBall(launchFromAngles(103, 26, -12, 2200), GAME_AIR);
    expect(resolveFence(f, HARBOURFRONT, false)).toEqual(resolveFence(f, HARBOURFRONT, false));
  });
});
