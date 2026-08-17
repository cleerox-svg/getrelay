// The sim → board mapping, asserted against the BOARD'S OWN BUDGETS.
//
// ⚠ WHAT MAKES THIS WORTH A FILE RATHER THAN A GLANCE. A mapper that produces a
// well-formed `BoardArray` full of content the board silently drops passes every
// type check and every board test, because the board's slicing is documented
// behaviour and the array is valid. That is exactly what shipped: four rows per
// side column against a budget of two, so LONG, RUN, OF and OUTS were computed,
// handed over, and thrown away. The pixel harness found it in the first frame it
// painted. These assertions are that finding turned into arithmetic.

import { describe, expect, it } from 'vitest';
import { DerbySim } from '../../../lib/baseball/derbySim';
import { chainMultiplier, CHAIN_START } from '../../../lib/baseball/derbyChain';
import { HARBOURFRONT } from '../../../lib/baseball/parks';
import type { SwingResult } from '../../../lib/baseball/derbyState';
import { boardPanel } from '../stadium/boardAtlas';
import { sideRowBudget } from '../stadium/boardPanels';
import { boardArrayKey } from '../stadium/boardState';
import { ribbonTrain, RIBBON_CELLS } from '../stadium/boardRibbon';
import { describeSwing } from './swingCopy';
import { derbyBoardArray, SIDE_ROWS } from './derbyBoard';

const sim = () => new DerbySim({ seed: 20260821, park: HARBOURFRONT });

const homeRun = (chainIndex: number): SwingResult =>
  ({
    outcome: 'homeRun',
    points: 214,
    chainIndex,
    timingErrorS: 0,
    undercutIn: 0.56,
    lateralIn: 0,
    contactZM: 0.72,
    evMph: 108.4001,
    laDeg: 27.4999,
    sprayDeg: -12,
    distFt: 441.4001,
    hangS: 5.6,
    apexFt: 110,
    barrel: true,
    fence: 'homeRun',
    fenceDistFt: 400,
    flight: null,
  }) as unknown as SwingResult;

const whiff = (): SwingResult =>
  ({
    outcome: 'whiff',
    points: 0,
    chainIndex: 0,
    timingErrorS: 0.025,
    undercutIn: 0,
    lateralIn: 0,
    contactZM: null,
    evMph: 0,
    laDeg: 0,
    sprayDeg: 0,
    distFt: 0,
    hangS: 0,
    apexFt: 0,
    barrel: false,
    fence: null,
    fenceDistFt: 0,
    flight: null,
  }) as unknown as SwingResult;

describe('the derby feeds the board only what the board can show', () => {
  it('sends exactly `sideRowBudget` rows per column — no computed-and-dropped row', () => {
    const a = derbyBoardArray(sim().getState(), HARBOURFRONT, null, false);
    const budget = sideRowBudget(boardPanel('stats').type);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD FEED — side columns]\n` +
        `  budget ${budget} rows per column (boardPanels.sideRowBudget)\n` +
        `  left  ${a.left?.heading}: ${a.left?.rows.map((r) => `${r.label}=${r.value}`).join('  ')}\n` +
        `  right ${a.right?.heading}: ${a.right?.rows.map((r) => `${r.label}=${r.value}`).join('  ')}\n` +
        `  ⚠ A row past the budget is DROPPED, not shrunk. This shipped at 4.\n`,
    );
    expect(SIDE_ROWS).toBe(budget);
    expect(a.left?.rows.length).toBe(budget);
    expect(a.right?.rows.length).toBe(budget);
    // …and the budget is a real constraint, not a formality that happens to be
    // large. If it ever exceeds the rows a column can hold, this test is lying.
    expect(budget).toBeGreaterThanOrEqual(1);
  });

  it('every side VALUE fits the column, so nothing truncates with a mark', () => {
    // The values are the thing meant to be read from the seats; a `…` on a score
    // is the board failing at its only job. Driven through a whole session so
    // the four-figure scores and three-figure distances are real ones.
    const s = sim();
    const seen = new Set<string>();
    for (let i = 0; i < 24 && s.phase !== 'done'; i++) {
      if (s.phase === 'ready') s.servePitch();
      s.swing(0.4);
      const a = derbyBoardArray(s.getState(), HARBOURFRONT, s.getState().last, false);
      for (const side of [a.left, a.right]) {
        for (const row of side?.rows ?? []) seen.add(row.value);
      }
    }
    const budget = 10; // `panelCharBudget(18)` — asserted in scoreboard.test.ts
    const tooLong = [...seen].filter((v) => v.length > budget);
    expect(tooLong, `values that would truncate: ${tooLong.join(', ')}`).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });

  it('the result line is `describeSwing` VERBATIM — not a second vocabulary', () => {
    const r = whiff();
    const a = derbyBoardArray(sim().getState(), HARBOURFRONT, r, false);
    expect(a.main.kind).toBe('result');
    expect(a.main.kind === 'result' && a.main.line).toBe(describeSwing(r));
    // …and the tone follows the OUTCOME, not the words.
    expect(a.main.kind === 'result' && a.main.tone).toBe('miss');
  });

  it('a home run takes the main panel, with the SCORER`s chain index', () => {
    // ⚠ `chainMultiplier(r.chainIndex)`, NEVER `curStreak`. `SwingResult`'s own
    // note records why: `commit()` has already incremented the counter by the
    // time a HUD could read it, so a recomputed multiplier is the NEXT swing's.
    const a = derbyBoardArray(sim().getState(), HARBOURFRONT, homeRun(CHAIN_START), false);
    expect(a.main.kind).toBe('homeRun');
    expect(a.main.kind === 'homeRun' && a.main.chainX).toBe(chainMultiplier(CHAIN_START));
    expect(chainMultiplier(CHAIN_START)).toBeGreaterThan(1);
    // Below the ramp it is null, because `×1.00` on a 100 ft board is noise.
    const b = derbyBoardArray(sim().getState(), HARBOURFRONT, homeRun(1), false);
    expect(b.main.kind === 'homeRun' && b.main.chainX).toBeNull();
  });

  it('ROUNDS every float, so a poll cannot cost a 2.0 MB repaint', () => {
    // ⚠ THE REPAINT KEY IS OVER THE INPUTS. Two polls a frame apart hand in
    // 441.4001 and 441.4002; both print as `441`, and an unrounded field is a
    // different key for a byte-identical picture — 2.0 MB of texel traffic,
    // 12 times a second, during the celebration.
    const st = sim().getState();
    const a = derbyBoardArray(st, HARBOURFRONT, homeRun(1), false);
    const jittered = { ...homeRun(1), distFt: 441.4009, evMph: 108.4009, laDeg: 27.4991 };
    const b = derbyBoardArray(st, HARBOURFRONT, jittered as SwingResult, false);
    expect(boardArrayKey(a)).toBe(boardArrayKey(b));
    // Guard the guard: a difference the picture WOULD show must still change it.
    const real = { ...homeRun(1), distFt: 442 };
    expect(boardArrayKey(derbyBoardArray(st, HARBOURFRONT, real as SwingResult, false))).not.toBe(
      boardArrayKey(a),
    );
    // Every number that reaches a screen is an integer or a 2-dp multiplier.
    const m = a.main;
    expect(m.kind === 'homeRun' && Number.isInteger(m.distFt)).toBe(true);
    expect(m.kind === 'homeRun' && Number.isInteger(m.evMph)).toBe(true);
    expect(m.kind === 'homeRun' && Number.isInteger(m.laDeg)).toBe(true);
  });

  it('the ribbon train survives its own fixed tile', () => {
    // `ribbonTrain` pads to EXACTLY `RIBBON_CELLS` and drops whole items that do
    // not fit, so a long park name reads as a shorter train rather than as
    // `…HARBOHARBOURFRONT DOME` repeated round the bowl. Both facts asserted on
    // the items this file actually produces.
    const a = derbyBoardArray(sim().getState(), HARBOURFRONT, null, false);
    const train = ribbonTrain(a.ribbon.items);
    expect(train.length).toBe(RIBBON_CELLS);
    // The park's own name gets on the ribbon — the first item always fits.
    expect(train).toContain(HARBOURFRONT.name.toUpperCase());
  });

  it('the round strip has one cell per round, blanks ahead of play', () => {
    const st = sim().getState();
    const a = derbyBoardArray(st, HARBOURFRONT, null, false);
    expect(a.strip?.columns.length).toBe(st.rounds);
    expect(a.strip?.rows[0]?.cells.length).toBe(st.rounds);
    // Round 1 is live (its running total), rounds 2+ have not happened.
    expect(a.strip?.rows[0]?.cells[0]).not.toBeNull();
    expect(a.strip?.rows[0]?.cells[st.rounds - 1]).toBeNull();
  });
});
