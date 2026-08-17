// The videoboard's bench.
//
// ⚠ THE STANDARD THIS FILE IS WRITTEN TO. A canvas is hard to assert on, which
// is exactly why display code is where hollow tests breed — this repo has found
// eight, including `expect(spy).toHaveBeenCalledWith(v, undefined)` silently
// matching a one-argument call. So nothing here asserts that a function was
// called. It asserts WHAT WAS DRAWN:
//
//   • `boardOps()` is a pure `(screen, frame, aspect) => BoardOp[]`, so the
//     picture is an array of plain objects and "the distance is drawn, centred,
//     bigger than the exit velocity, before it in z-order" is an assertion about
//     data rather than about a mock.
//   • the RASTERISER is then driven through a RECORDING `Board2D` and the op log
//     is asserted — the strings, the coordinates, the count of strokes — so the
//     step from data to pixels is measured too, not assumed.
//
// ⚠ EVERY ASSERTION BELOW HAS BEEN WATCHED TO FAIL. The mutation table is in the
// session report: each mutation is named beside the number of assertions that
// died on it. An assertion nobody has watched fail is not an assertion, and this
// project's own guard tests (`determinism.test.ts`, `budget.test.ts`) say so in
// their own headers.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainMultiplier } from '../../../lib/baseball/derbyChain';
import { DERBY_OUTCOMES } from '../../../lib/baseball/derbyScoring';
import type { SwingResult } from '../../../lib/baseball/derbyState';
import { describeSwing } from '../shared/swingCopy';
import {
  GLYPH_TRACK,
  GLYPH_W,
  GLYPH_WEIGHT,
  boardAdvancePx,
  boardTextWidthPx,
  hasGlyph,
  strokeBoardText,
  validateGlyphs,
} from './boardGlyphs';
import type { Board2D } from './boardGlyphs';
import { CAMERAS } from './camera';
import {
  BOARD_ANIM_END_S,
  BOARD_ANIM_FPS,
  BOARD_ANIM_LAST_FRAME,
  BOARD_REF,
  MIN_LEGIBLE_H,
  boardLegibleCssPx,
  boardAnimFrame,
  boardScreenKey,
  emitBoardOps,
  runH,
} from './boardPaint';
import type { BoardOp, BoardScreen } from './boardPaint';
import { HOME_RUN_WORD, boardOps, boardResultRows } from './boardScreens';
import { BOARD_ASPECT, BOARD_TEXTURE_H, BOARD_TEXTURE_W, buildScoreboard } from './scoreboard';
import type { BoardCanvas } from './scoreboard';

// ---------------------------------------------------------------------------
// The recording surface
// ---------------------------------------------------------------------------

/**
 * A `Board2D` that writes down what it was asked to do.
 *
 * ⚠ IT RECORDS ARGUMENTS, NOT CALLS. Every entry carries the full argument list
 * AND the style state that was in force, so an assertion can say "a stroke of
 * this colour, this wide, through these points" — the things a pixel is made of.
 * A `vi.fn()` would let a draw at the wrong coordinates pass.
 */
type Rec = { op: string; args: number[]; fill: string; stroke: string; lineWidth: number };

function recorder() {
  const log: Rec[] = [];
  const g: Board2D & { log: Rec[] } = {
    log,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineCap: 'butt',
    lineJoin: 'miter',
    clearRect: (...a: number[]) => push('clearRect', a),
    fillRect: (...a: number[]) => push('fillRect', a),
    beginPath: () => push('beginPath', []),
    moveTo: (...a: number[]) => push('moveTo', a),
    lineTo: (...a: number[]) => push('lineTo', a),
    closePath: () => push('closePath', []),
    fill: () => push('fill', []),
    stroke: () => push('stroke', []),
  };
  function push(op: string, args: number[]) {
    log.push({
      op,
      args,
      fill: String(g.fillStyle),
      stroke: String(g.strokeStyle),
      lineWidth: g.lineWidth,
    });
  }
  return g;
}

function fakeCanvas(): BoardCanvas & { g: ReturnType<typeof recorder> } {
  const g = recorder();
  return { width: 0, height: 0, g, getContext: () => g };
}

// ---------------------------------------------------------------------------
// Fixtures — every screen, once, so the table-driven checks have a full domain
// ---------------------------------------------------------------------------

const BATTER: BoardScreen = {
  kind: 'derbyBatter',
  batter: 'HARBOUR CITY',
  round: 2,
  rounds: 3,
  pitch: 7,
  pitches: 27,
  score: 1240,
  chainX: 1.5,
  bestFt: 428,
};

const HOMER: BoardScreen = {
  kind: 'homeRun',
  distFt: 428.4,
  evMph: 108.2,
  laDeg: 26.6,
  points: 380,
  chainX: 1.5,
};

const ALL_SCREENS: BoardScreen[] = [
  { kind: 'idle', label: 'HOME RUN DERBY' },
  BATTER,
  { ...(BATTER as Extract<BoardScreen, { kind: 'derbyBatter' }>), chainX: null, bestFt: null },
  { kind: 'result', line: 'GONE! 428 ft · +380 ×1.50', tone: 'gone' },
  { kind: 'result', line: 'Swing and a miss', tone: 'miss' },
  HOMER,
  { ...(HOMER as Extract<BoardScreen, { kind: 'homeRun' }>), chainX: null },
  { kind: 'roundSummary', round: 2, rounds: 3, roundScore: 1240, homeRuns: 7, bestFt: 428, total: 3980 },
  {
    kind: 'duelScore',
    away: { name: 'ALPINE', runs: 3 },
    home: { name: 'HARBOUR', runs: 4 },
    inning: 3,
    half: 'bot',
    outs: 2,
    balls: 2,
    strikes: 1,
  },
];

const texts = (ops: BoardOp[]) => ops.filter((o): o is Extract<BoardOp, { kind: 'text' }> => o.kind === 'text');
const strings = (ops: BoardOp[]) => texts(ops).map((o) => o.text);

/** A `SwingResult` with only the fields `describeSwing` reads made meaningful. */
function swing(over: Partial<SwingResult>): SwingResult {
  return {
    outcome: 'inPlay',
    points: 0,
    chainIndex: 0,
    timingErrorS: 0,
    undercutIn: 0.56,
    lateralIn: 0,
    contactZM: 0.72,
    evMph: 100,
    laDeg: 26,
    sprayDeg: 0,
    distFt: 400,
    hangS: 5,
    apexFt: 90,
    barrel: true,
    fence: 'inPlay',
    fenceDistFt: 400,
    flight: null,
    pitchId: 'ff',
    plateX: 0,
    plateH: 2.5,
    plateSpeedMph: 86,
    strike: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The typeface
// ---------------------------------------------------------------------------

describe('board typeface', () => {
  it('the glyph table is valid data', () => {
    // Charter rule 4: content is data, and a `validate*()` run as a test makes
    // bad data a test failure. Every coordinate in the unit cell, every polyline
    // with at least two points, space empty and nothing else empty.
    expect(validateGlyphs()).toEqual([]);
  });

  it('covers every character the board and the HUD copy can produce', () => {
    // ⚠ THIS IS THE CROSS-MODULE HALF. `describeSwing` emits `·`, `—`, `×` and
    // digits; a glyph the copy layer uses and the table lacks renders as the
    // conspicuous fallback box on the biggest surface in the park. So the
    // coverage set is not a wish list — it is generated from `swingCopy`'s own
    // output over every outcome plus every string the board itself builds.
    const lines = DERBY_OUTCOMES.flatMap((outcome) => [
      describeSwing(swing({ outcome, points: 380, chainIndex: 3, distFt: 428 })),
      describeSwing(swing({ outcome, points: 0, chainIndex: 0, fence: 'offWall', distFt: 395 })),
      describeSwing(swing({ outcome, points: 12, strike: false })),
    ]);
    const fromBoard = ALL_SCREENS.flatMap((s) => strings(boardOps(s, 0, BOARD_ASPECT)));
    const missing = new Set<string>();
    for (const ch of [...lines, ...fromBoard].join('')) {
      if (!hasGlyph(ch)) missing.add(ch);
    }
    expect([...missing]).toEqual([]);
    // Guard the guard: the scan must actually have seen the exotic marks.
    expect(lines.join('')).toContain('·');
    expect(lines.join('')).toContain('—');
    expect(fromBoard.join('')).toContain('×');
    expect(fromBoard.join('')).toContain('°');
  });

  it('is monospaced, and the width arithmetic is the advance arithmetic', () => {
    // The layout in `boardPaint` computes text widths WITHOUT a canvas, which is
    // only legitimate while the face is monospaced. Pin both halves.
    expect(boardAdvancePx(100)).toBeCloseTo(100 * (GLYPH_W + GLYPH_TRACK), 12);
    expect(boardTextWidthPx('', 100)).toBe(0);
    expect(boardTextWidthPx('A', 100)).toBeCloseTo(100 * GLYPH_W, 12);
    expect(boardTextWidthPx('AB', 100)).toBeCloseTo(100 * (2 * (GLYPH_W + GLYPH_TRACK) - GLYPH_TRACK), 12);
    // Every character advances the same, including a space and an unknown one.
    expect(boardTextWidthPx('WWW', 50)).toBe(boardTextWidthPx('.  ', 50));
    expect(boardTextWidthPx('©©', 50)).toBe(boardTextWidthPx('AB', 50));
  });

  it('strokes one path per printable glyph, and nothing at all for a space', () => {
    const g = recorder();
    strokeBoardText(g, 'A B', 0, 0, 100, '#fff');
    // Two glyphs, one `beginPath`/`stroke` pair each; the space emits nothing.
    expect(g.log.filter((r) => r.op === 'beginPath')).toHaveLength(2);
    expect(g.log.filter((r) => r.op === 'stroke')).toHaveLength(2);
    // ...and it is a STROKE, never a fill: a filled glyph would be a different
    // face with different weight behaviour under minification.
    expect(g.log.filter((r) => r.op === 'fill')).toHaveLength(0);
    expect(g.log.every((r) => r.stroke === '#fff' || r.stroke === '')).toBe(true);
    expect(g.log.find((r) => r.op === 'stroke')!.lineWidth).toBeGreaterThan(0);

    // One `moveTo` per polyline, one `lineTo` per point after the first. `A` is
    // a three-point chevron plus a two-point crossbar; `B` is a stem plus two
    // five-point bowls. Counting them pins the TABLE, not just the plumbing.
    const only = (text: string) => {
      const r = recorder();
      strokeBoardText(r, text, 0, 0, 100, '#fff');
      return {
        moveTo: r.log.filter((x) => x.op === 'moveTo').length,
        lineTo: r.log.filter((x) => x.op === 'lineTo').length,
      };
    };
    expect(only('A')).toEqual({ moveTo: 2, lineTo: 3 });
    expect(only(' ')).toEqual({ moveTo: 0, lineTo: 0 });
    expect(only('AA')).toEqual({ moveTo: 4, lineTo: 6 });
  });

  it('upper-cases, because the face has no lower case', () => {
    // The op list carries the HUD's copy VERBATIM — `describeSwing` writes
    // "GONE! 428 ft" — so the casing is a property of the FACE, applied at
    // rasterisation. Assert it there rather than mangling the copy upstream.
    const lower = recorder();
    const upper = recorder();
    strokeBoardText(lower, 'ft', 0, 0, 100, '#fff');
    strokeBoardText(upper, 'FT', 0, 0, 100, '#fff');
    expect(lower.log).toEqual(upper.log);
  });

  it('anchors left, centre and right at the coordinate it was given', () => {
    // Alignment is arithmetic on the run width, so it is checkable exactly.
    const w = boardTextWidthPx('428', 100);
    const firstX = (align: 'left' | 'centre' | 'right') => {
      const g = recorder();
      strokeBoardText(g, '428', 1000, 0, 100, '#fff', align);
      return g.log.find((r) => r.op === 'moveTo')!.args[0]!;
    };
    // `4`'s first point is at x = .75 of the cell.
    const inset = 0.75 * 100 * GLYPH_W;
    expect(firstX('left')).toBeCloseTo(1000 + inset, 9);
    expect(firstX('centre')).toBeCloseTo(1000 - w / 2 + inset, 9);
    expect(firstX('right')).toBeCloseTo(1000 - w + inset, 9);
    // ...and the three are genuinely distinct, so a broken `align` cannot pass
    // by collapsing them onto each other.
    expect(new Set([firstX('left'), firstX('centre'), firstX('right')]).size).toBe(3);
  });

  it('draws an unknown character as the fallback box rather than nothing', () => {
    const g = recorder();
    strokeBoardText(g, 'é', 0, 0, 100, '#fff');
    expect(g.log.filter((r) => r.op === 'stroke')).toHaveLength(1);
    // Five points tracing a closed rectangle inside the cell.
    expect(g.log.filter((r) => r.op === 'lineTo')).toHaveLength(4);
    expect(hasGlyph('é')).toBe(false);
    expect(hasGlyph('e')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What each screen actually says
// ---------------------------------------------------------------------------

describe('board screens', () => {
  it('the batter card says who, where, and what it is worth', () => {
    const ops = boardOps(BATTER, 0, BOARD_ASPECT);
    expect(strings(ops)).toEqual([
      'HARBOUR CITY',
      'ROUND 2/3',
      'SCORE',
      '1240',
      'PITCH 7/27',
      // ⚠ NO `LONG 428 FT` HERE, AND THAT IS THE FIX FOR A COLLISION A RENDER
      // FOUND. The bottom band is two columns; a live chain TAKES the right one.
      // All three at `T_BODY` totalled 1.24 board widths and the badge was
      // painted over the word LONG. Off-chain the long ball is back — below.
      '×1.50',
    ]);
    // The name is the largest thing on it, and the score is the same weight —
    // that is the "calm, legible, most-of-the-time" screen's whole design.
    const byText = new Map(texts(ops).map((o) => [o.text, o]));
    expect(byText.get('HARBOUR CITY')!.size).toBeGreaterThanOrEqual(byText.get('ROUND 2/3')!.size);
    expect(byText.get('1240')!.align).toBe('right');
    expect(byText.get('PITCH 7/27')!.align).toBe('left');
  });

  it('hides the chain badge and the long-ball line when there is nothing to say', () => {
    // ⚠ THE MULTIPLIER IS SHOWN ONLY WHILE EARNING — `swingCopy` states the rule
    // for the HUD and the board must not contradict it with a permanent ×1.00.
    const quiet = boardOps({ ...BATTER, chainX: null, bestFt: null } as BoardScreen, 0, BOARD_ASPECT);
    expect(strings(quiet)).toEqual(['HARBOUR CITY', 'ROUND 2/3', 'SCORE', '1240', 'PITCH 7/27']);
    const one = boardOps({ ...BATTER, chainX: 1 } as BoardScreen, 0, BOARD_ASPECT);
    expect(strings(one).some((s) => s.startsWith('×'))).toBe(false);
    const two = boardOps({ ...BATTER, chainX: 2 } as BoardScreen, 0, BOARD_ASPECT);
    expect(strings(two)).toContain('×2.00');
    // Off-chain, the long ball has the right column back.
    const offChain = boardOps({ ...BATTER, chainX: null } as BoardScreen, 0, BOARD_ASPECT);
    expect(strings(offChain)).toContain('LONG 428 FT');
    expect(strings(offChain).some((t) => t.startsWith('×'))).toBe(false);
  });

  it('no two pieces of text on any screen overlap', () => {
    // ⚠ THE ASSERTION THAT CAUGHT WHAT EVERY OTHER CHECK IN THIS FILE MISSED.
    // The suite was green over a batter card whose chain badge was painted
    // across the word LONG and through the pitch count, AND over a round summary
    // whose two columns met with no gutter — both found by rendering a PNG and
    // looking at it, neither visible to a check that only asks "was the right
    // string emitted at a legible size". Extents are exact arithmetic here (the
    // face is monospaced), so a canvas is not needed to know that two runs of
    // text occupy the same rectangle.
    //
    // The fixtures include the WIDEST content each screen can carry, because
    // every one of these layouts fitted at its nominal values and failed at the
    // extremes: a five-digit score, a 19-character card name, a four-digit
    // long-ball distance and a two-digit run total.
    // ⚠ THE BOX IS THE INK, NOT THE CELL, and that distinction is what makes the
    // check bite. A stroked glyph extends half a `lineWidth` past its cell on
    // every side, so two runs whose cells merely TOUCH already overlap by a full
    // stroke — which is precisely what the round summary's original 0.45/0.45
    // columns did, and what a strict cell-vs-cell comparison called fine
    // (mutation M18, measured: 0 failures until this inflation was added).
    const extent = (o: Extract<BoardOp, { kind: 'text' }>) => {
      const w = (runH(o.text.length) * o.size) / BOARD_ASPECT;
      const x0 = o.align === 'left' ? o.x : o.align === 'right' ? o.x - w : o.x - w / 2;
      const inkY = (o.size * GLYPH_WEIGHT) / 2;
      const inkX = inkY / BOARD_ASPECT;
      return {
        x0: x0 - inkX,
        x1: x0 + w + inkX,
        y0: o.y - inkY,
        y1: o.y + o.size + inkY,
        t: o.text,
      };
    };
    const derby = BATTER as Extract<BoardScreen, { kind: 'derbyBatter' }>;
    const duel = ALL_SCREENS.find((s) => s.kind === 'duelScore') as Extract<
      BoardScreen,
      { kind: 'duelScore' }
    >;
    const worst: BoardScreen[] = [
      ...ALL_SCREENS,
      { ...derby, score: 99999, batter: 'MAXIMILIAN LONGNAME' },
      { ...derby, chainX: null, bestFt: 4288, pitch: 27 },
      { ...derby, chainX: 2, score: 99999 },
      { kind: 'roundSummary', round: 3, rounds: 3, roundScore: 99999, homeRuns: 27, bestFt: 4288, total: 99999 },
      { ...duel, away: { name: 'MOUNTAINSIDE', runs: 17 }, home: { name: 'HARBOURFRONT', runs: 9 } },
      { kind: 'result', line: 'Off the wall — 395 ft · +40', tone: 'good' },
      { kind: 'homeRun', distFt: 501.6, evMph: 121.4, laDeg: 32.8, points: 9999, chainX: 2 },
    ];
    for (const screen of worst) {
      for (const frame of [0, 6, BOARD_ANIM_LAST_FRAME]) {
        const boxes = texts(boardOps(screen, frame, BOARD_ASPECT)).map(extent);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!;
            const b = boxes[j]!;
            const hits = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
            expect(hits, `${screen.kind}: "${a.t}" overlaps "${b.t}"`).toBe(false);
          }
        }
      }
    }
  });

  it('the result screen is the HUD line, split on its own separator', () => {
    const ops = boardOps(
      { kind: 'result', line: 'GONE! 428 ft · +380 ×1.50', tone: 'gone' },
      0,
      BOARD_ASPECT,
    );
    // Verbatim, casing included — the face upper-cases when it draws.
    expect(strings(ops)).toEqual(['GONE! 428 ft', '+380 ×1.50']);
    expect(boardResultRows('Off the wall — 395 ft · +40')).toEqual([
      'Off the wall — 395 ft',
      '+40',
    ]);
    // A line with no separator stays one row.
    expect(boardResultRows('Swing and a miss')).toEqual(['Swing and a miss']);
  });

  it('EVERY `describeSwing` outcome fits the board at a legible size', () => {
    // ⚠ THE ASSERTION THE WHOLE `result` DESIGN RESTS ON. The board reuses the
    // HUD's vocabulary verbatim, so it inherits the HUD's string LENGTHS — and a
    // 25-character line set as one row lands at 0.090 of board height, which the
    // camera derivation says cannot be read. Splitting on ` · ` is what fixes
    // that, and this is what proves it fixes it for every outcome the sim can
    // produce rather than for the two somebody happened to try.
    const rows: Array<[string, number]> = [];
    for (const outcome of DERBY_OUTCOMES) {
      for (const variant of [
        swing({ outcome, points: 380, chainIndex: 3, distFt: 428.4 }),
        swing({ outcome, points: 40, chainIndex: 0, fence: 'offWall', distFt: 395.2 }),
        swing({ outcome, points: 0, chainIndex: 0, strike: false, distFt: 0 }),
      ]) {
        const line = describeSwing(variant);
        const ops = boardOps({ kind: 'result', line, tone: 'neutral' }, 0, BOARD_ASPECT);
        const smallest = Math.min(...texts(ops).map((o) => o.size));
        rows.push([line, smallest]);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — every describeSwing line, set on the result screen; floor ${MIN_LEGIBLE_H}]\n` +
        [...new Map(rows).entries()]
          .map(([line, size]) => `  ${size.toFixed(4)}  ${line}`)
          .join('\n') +
        '\n  size is a fraction of BOARD HEIGHT; see MIN_LEGIBLE_H for the camera derivation.\n',
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const [line, size] of rows) {
      expect(size, `"${line}" sets at ${size.toFixed(4)}`).toBeGreaterThanOrEqual(MIN_LEGIBLE_H);
    }
  });

  it('the home run leads with the word the HUD leads with', () => {
    // ⚠ READ OUT OF `describeSwing`, NOT COPIED FROM IT. Two surfaces are allowed
    // to lay the same event out differently; they are not allowed to call it two
    // different things.
    const hud = describeSwing(swing({ outcome: 'homeRun', points: 380, chainIndex: 3, distFt: 428.4 }));
    expect(hud.startsWith(HOME_RUN_WORD)).toBe(true);
    expect(strings(boardOps(HOMER, BOARD_ANIM_LAST_FRAME, BOARD_ASPECT))[0]).toBe(HOME_RUN_WORD);
    // And the multiplier it prints is the sim's own function of the sim's own
    // index — the same source `swingCopy` reads.
    expect(hud).toContain(`×${chainMultiplier(3).toFixed(2)}`);
  });

  it('the home run screen shows the distance, the exit velocity and the payout', () => {
    const ops = boardOps(HOMER, BOARD_ANIM_LAST_FRAME, BOARD_ASPECT);
    expect(strings(ops)).toEqual([HOME_RUN_WORD, '428 FT', '108 MPH · 27°', '+380 ×1.50']);
    const byText = new Map(texts(ops).map((o) => [o.text, o]));
    // ⚠ THE DISTANCE IS THE BIGGEST THING ON THE BOARD. This is the assertion
    // that dies if the distance and the exit velocity are ever swapped — see the
    // mutation table; a check that merely asserted both strings are present
    // would not.
    expect(byText.get('428 FT')!.size).toBeGreaterThan(byText.get('108 MPH · 27°')!.size);
    expect(byText.get('428 FT')!.size).toBeGreaterThan(byText.get(HOME_RUN_WORD)!.size);
    expect(byText.get('428 FT')!.y).toBeLessThan(byText.get('108 MPH · 27°')!.y);
    // No chain ⇒ no `×`, and the payout is still there.
    const plain = strings(boardOps({ ...HOMER, chainX: null } as BoardScreen, BOARD_ANIM_LAST_FRAME, BOARD_ASPECT));
    expect(plain[3]).toBe('+380');
  });

  it('the round summary and the duel line score render their own numbers', () => {
    const round = strings(
      boardOps(
        { kind: 'roundSummary', round: 2, rounds: 3, roundScore: 1240, homeRuns: 7, bestFt: 428, total: 3980 },
        0,
        BOARD_ASPECT,
      ),
    );
    expect(round).toEqual(['ROUND 2/3 DONE', 'ROUND +1240', 'HOMERS 7', 'LONG 428 FT', 'TOTAL 3980']);

    // ⚠ THE DUEL VARIANT SHIPS NOW, PAINTED AND ASSERTED, MONTHS BEFORE
    // `duelSim.ts`. That is the point of a discriminated union: the 3-inning
    // mode lands as a caller change, never as a rewrite of this module.
    const duel = ALL_SCREENS.find((s) => s.kind === 'duelScore')!;
    expect(strings(boardOps(duel, 0, BOARD_ASPECT))).toEqual([
      'ALPINE',
      '3',
      'HARBOUR',
      '4',
      'B3',
      '2-1',
    ]);
    // Two of three out lamps lit — geometry, not text.
    const lamps = boardOps(duel, 0, BOARD_ASPECT).filter((o) => o.kind === 'poly');
    expect(lamps).toHaveLength(3);
    expect(lamps.filter((o) => o.color === '#d7263d')).toHaveLength(2);
    const none = { ...(duel as Extract<BoardScreen, { kind: 'duelScore' }>), outs: 0 };
    expect(
      boardOps(none, 0, BOARD_ASPECT).filter((o) => o.kind === 'poly' && o.color === '#d7263d'),
    ).toHaveLength(0);
  });

  it('the legibility floor follows from the camera it claims to follow', () => {
    // ⚠ THE FLOOR IS A DERIVATION, SO IT IS CHECKED AS ONE. `MIN_LEGIBLE_H` is
    // 0.092 because that is ~10 CSS px of glyph on a phone from `CAMERAS.batter`
    // for a 100 × 50 ft board 430 ft out. Two things could quietly falsify it:
    // the camera moving, or the ART AGENT building a different board — and the
    // second is the likely one, because the board's size is not this module's
    // to decide. Both are asserted rather than trusted.
    expect(CAMERAS.batter.pos[2]).toBe(8);
    expect(CAMERAS.batter.fov).toBe(40);
    expect(boardLegibleCssPx(MIN_LEGIBLE_H)).toBeCloseTo(10, 0);
    expect(boardLegibleCssPx(0.13)).toBeCloseTo(14.1, 1);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — glyph size on a phone, ${BOARD_REF.widthFt}×${BOARD_REF.heightFt} ft board at ` +
        `${BOARD_REF.faceDistFt} ft, CAMERAS.batter]\n` +
        [
          ['MIN_LEGIBLE_H', MIN_LEGIBLE_H],
          ['body 0.13', 0.13],
          ['title 0.155', 0.155],
          ['hero 0.32', 0.32],
        ]
          .map(
            ([n, v]) =>
              `  ${String(n).padEnd(14)} ${((v as number) * BOARD_REF.heightFt).toFixed(2).padStart(5)} ft of glyph` +
              `  → ${boardLegibleCssPx(v as number).toFixed(1).padStart(5)} CSS px`,
          )
          .join('\n') +
        '\n  ⚠ Linear in heightFt/faceDistFt. A board built smaller than BOARD_REF makes the floor a lie.\n' +
        `  A 60 ft-tall board at the same range would put the floor at ` +
        `${boardLegibleCssPx(MIN_LEGIBLE_H, 60).toFixed(1)} CSS px; a 30 ft one at ` +
        `${boardLegibleCssPx(MIN_LEGIBLE_H, 30).toFixed(1)}.\n`,
    );
    // And the scaling is linear, which is the property the warning rests on.
    expect(boardLegibleCssPx(MIN_LEGIBLE_H, 25)).toBeCloseTo(
      boardLegibleCssPx(MIN_LEGIBLE_H, 50) / 2,
      9,
    );
  });

  it('nothing on any screen is drawn below the legible floor', () => {
    // ⚠ THE DESIGN RULE, ENFORCED. `MIN_LEGIBLE_H` is derived from
    // `CAMERAS.batter` and the reference board (see its note): 0.092 of board
    // height is ~10 CSS px of glyph on a phone. Anything under it is decoration
    // pretending to be information.
    const rows: string[] = [];
    for (const screen of ALL_SCREENS) {
      for (const frame of [0, 5, BOARD_ANIM_LAST_FRAME]) {
        for (const op of texts(boardOps(screen, frame, BOARD_ASPECT))) {
          rows.push(`  ${op.size.toFixed(4)}  ${screen.kind.padEnd(12)} "${op.text}"`);
          expect(op.size, `${screen.kind} "${op.text}"`).toBeGreaterThanOrEqual(MIN_LEGIBLE_H);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`\n[BOARD — every text op, every screen; floor ${MIN_LEGIBLE_H}]\n${[...new Set(rows)].sort().join('\n')}\n`);
    expect(rows.length).toBeGreaterThan(30);
  });

  it('every screen starts with an opaque full-bleed backdrop', () => {
    // ⚠ THE ONE THING NO OTHER ASSERTION HERE COULD SEE. Deleting the backdrop
    // failed ZERO tests before this one existed (mutation M12): the op-log
    // length checks are dominated by glyph strokes, and the emitter check counts
    // panels out of the same list it is verifying, so both stayed happily
    // self-consistent over a board with a transparent background. On a quad in
    // the outfield that is whatever the sky and the truss happen to be behind
    // it — a visual regression a screenshot would catch in 30 s and the suite
    // would never mention.
    for (const screen of ALL_SCREENS) {
      const ops = boardOps(screen, 4, BOARD_ASPECT);
      expect(ops[0], screen.kind).toMatchObject({ kind: 'panel', x: 0, y: 0, w: 1, h: 1 });
      // ...and the LED scanline pattern behind it: 32 full-width stripes, in
      // order, none of them the background colour.
      const stripes = ops.slice(1, 33);
      expect(stripes.every((o) => o.kind === 'panel' && o.w === 1 && o.x === 0)).toBe(true);
      expect(new Set(stripes.map((o) => (o as { color: string }).color)).size).toBe(1);
      expect((stripes[0] as { color: string }).color).not.toBe((ops[0] as { color: string }).color);
      const ys = stripes.map((o) => (o as { y: number }).y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  it('every op stays inside the board', () => {
    for (const screen of ALL_SCREENS) {
      for (const op of boardOps(screen, 3, BOARD_ASPECT)) {
        if (op.kind === 'panel') {
          expect(op.x).toBeGreaterThanOrEqual(0);
          expect(op.y).toBeGreaterThanOrEqual(0);
          expect(op.x + op.w).toBeLessThanOrEqual(1.0001);
          expect(op.y + op.h).toBeLessThanOrEqual(1.0001);
        } else if (op.kind === 'text') {
          // Bottom of the cell, in board-height units.
          expect(op.y + op.size, `${screen.kind} "${op.text}"`).toBeLessThanOrEqual(1.0001);
          expect(op.y).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Time, and the state machine
// ---------------------------------------------------------------------------

describe('board animation', () => {
  it('only the home run animates, and it stops', () => {
    for (const screen of ALL_SCREENS) {
      if (screen.kind === 'homeRun') continue;
      // A static screen's frame is 0 at every time — which is what makes its
      // upload cost exactly zero for as long as it is on screen.
      expect(boardAnimFrame(screen, 0)).toBe(0);
      expect(boardAnimFrame(screen, 1.7)).toBe(0);
      expect(boardAnimFrame(screen, 600)).toBe(0);
    }
    expect(boardAnimFrame(HOMER, 0)).toBe(0);
    expect(boardAnimFrame(HOMER, 1 / BOARD_ANIM_FPS)).toBe(1);
    expect(boardAnimFrame(HOMER, 1.0)).toBe(12);
    expect(boardAnimFrame(HOMER, BOARD_ANIM_END_S)).toBe(BOARD_ANIM_LAST_FRAME);
    expect(boardAnimFrame(HOMER, 60)).toBe(BOARD_ANIM_LAST_FRAME);
    // Negative and non-finite times clamp rather than producing a negative key.
    expect(boardAnimFrame(HOMER, -3)).toBe(0);
    expect(boardAnimFrame(HOMER, Number.NaN)).toBe(0);
  });

  it('the distance counts UP and lands exactly on the sim number', () => {
    // ⚠ THE LANDING IS THE ASSERTION. A count-up whose easing does not reach 1
    // leaves the board reading 427 while the HUD reads 428, which is the worst
    // kind of bug in a display: quiet, and about the number the player came for.
    const shown = (frame: number) =>
      strings(boardOps(HOMER, frame, BOARD_ASPECT)).find((s) => s.endsWith(' FT'))!;
    const seq = [0, 2, 4, 6, 8, 10, BOARD_ANIM_LAST_FRAME].map(shown);
    const nums = seq.map((s) => Number(s.replace(' FT', '')));
    // eslint-disable-next-line no-console
    console.log(`\n[BOARD — home-run count-up @ ${BOARD_ANIM_FPS} Hz]  ${seq.join('  →  ')}\n`);
    expect(nums[0]).toBe(0);
    expect(nums.at(-1)).toBe(428);
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThanOrEqual(nums[i - 1]!);
    // It is a RAMP, not a jump on frame 1 — a frozen animation would pass a
    // monotone check and fail this one.
    expect(nums[1]).toBeGreaterThan(0);
    expect(nums[1]).toBeLessThan(428);
    expect(new Set(nums).size).toBeGreaterThanOrEqual(5);
  });

  it('the strobe alternates and then stops', () => {
    // The backdrop's first op is the background fill; its colour is the strobe.
    const bg = (frame: number) => (boardOps(HOMER, frame, BOARD_ASPECT)[0] as { color: string }).color;
    expect(bg(0)).toBe('#d7263d');
    expect(bg(3)).toBe('#08122b');
    expect(bg(5)).toBe('#d7263d');
    // Past FLASH_S it settles for good.
    expect(bg(12)).toBe('#08122b');
    expect(bg(BOARD_ANIM_LAST_FRAME)).toBe('#08122b');
  });

  it('the same state and the same time produce the same draw sequence', () => {
    // ⚠ THE INVARIANT THE VISUAL GATE DEPENDS ON. `baseball-visual-qa` fails on
    // any pixel difference between two runs, so this is that claim expressed at
    // the level the module controls: identical inputs, identical ops, and
    // identical canvas calls all the way down to the coordinates.
    for (const screen of ALL_SCREENS) {
      for (const frame of [0, 7, BOARD_ANIM_LAST_FRAME]) {
        expect(boardOps(screen, frame, BOARD_ASPECT)).toEqual(boardOps(screen, frame, BOARD_ASPECT));
        const a = recorder();
        const b = recorder();
        emitBoardOps(a, boardOps(screen, frame, BOARD_ASPECT), 1024, 512);
        emitBoardOps(b, boardOps(screen, frame, BOARD_ASPECT), 1024, 512);
        expect(a.log).toEqual(b.log);
        expect(a.log.length).toBeGreaterThan(40);
      }
    }
  });

  it('two times inside one frame bucket paint the same picture', () => {
    // ⚠ THE REASON `boardOps` TAKES A FRAME AND NOT A `tS`. The upload policy
    // skips a repaint when the frame is unchanged; if the painter read raw time
    // it would want to draw something different while the key said "identical",
    // and the board would silently lag its own animation. Quantising at the
    // boundary makes "the key changed" and "the picture changed" the same event.
    const inBucket = [0.5 / BOARD_ANIM_FPS, 0.99 / BOARD_ANIM_FPS];
    const frames = inBucket.map((t) => boardAnimFrame(HOMER, t));
    expect(new Set(frames).size).toBe(1);
    expect(boardOps(HOMER, frames[0]!, BOARD_ASPECT)).toEqual(boardOps(HOMER, frames[1]!, BOARD_ASPECT));
    // ...and the NEXT bucket is genuinely a different picture.
    expect(boardOps(HOMER, frames[0]!, BOARD_ASPECT)).not.toEqual(
      boardOps(HOMER, frames[0]! + 1, BOARD_ASPECT),
    );
  });

  it('the screen key changes whenever any displayed number does', () => {
    const base = BATTER as Extract<BoardScreen, { kind: 'derbyBatter' }>;
    const key = boardScreenKey(base);
    expect(boardScreenKey({ ...base })).toBe(key);
    for (const mutated of [
      { ...base, score: base.score + 1 },
      { ...base, pitch: base.pitch + 1 },
      { ...base, batter: 'SOMEONE ELSE' },
      { ...base, chainX: null },
      { ...base, bestFt: null },
    ] as BoardScreen[]) {
      expect(boardScreenKey(mutated)).not.toBe(key);
    }
  });
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

describe('buildScoreboard', () => {
  it('sizes the canvas, the texture and the quad from one source', () => {
    const canvas = fakeCanvas();
    const board = buildScoreboard({ createCanvas: () => canvas });
    expect(canvas.width).toBe(BOARD_TEXTURE_W);
    expect(canvas.height).toBe(BOARD_TEXTURE_H);
    expect(board.widthPx).toBe(BOARD_TEXTURE_W);
    expect(board.heightPx).toBe(BOARD_TEXTURE_H);
    expect(BOARD_ASPECT).toBe(BOARD_TEXTURE_W / BOARD_TEXTURE_H);
    expect(board.texture.image).toBe(canvas);
    // Mipmaps off: the board re-uploads during a celebration and a mip chain
    // would be regenerated on every one of those uploads.
    expect(board.texture.generateMipmaps).toBe(false);
    board.dispose();
  });

  it('throws rather than silently drawing nothing', () => {
    expect(() =>
      buildScoreboard({ createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }),
    ).toThrow(/2D context/);
  });

  it('uploads ONLY when the picture changes', () => {
    // ⚠ THE GPU BUDGET, AS A TEST. 1024×512 RGBA is 2.0 MB per upload. The
    // charter gives this board one draw call; the cost that actually bites is
    // texel traffic, so "called every frame, uploads on change" is the property,
    // and it is measured rather than intended.
    const canvas = fakeCanvas();
    const board = buildScoreboard({ createCanvas: () => canvas });
    expect(board.current()).toBeNull();

    // ⚠ `texture.version` IS THE UPLOAD, `uploads()` IS ONLY THIS MODULE'S
    // COUNT OF IT. Asserting the counter alone is self-referential — deleting
    // `texture.needsUpdate = true` altogether leaves the counter perfectly
    // correct and the board frozen on its first frame, which is a defect no
    // other assertion in this file can see (mutation M14, measured: 0 failures
    // before this line existed). `three` increments `version` in the
    // `needsUpdate` setter, so reading it back reads THREE's state, not ours.
    const v0 = board.texture.version;
    expect(board.update(BATTER, 0)).toBe(true);
    expect(board.uploads()).toBe(1);
    expect(board.texture.version).toBeGreaterThan(v0);

    // 120 frames of a HUD polling the same state: no further traffic at all.
    const v1 = board.texture.version;
    for (let i = 0; i < 120; i++) expect(board.update(BATTER, i / 60)).toBe(false);
    expect(board.uploads()).toBe(1);
    expect(board.texture.version).toBe(v1);

    // A changed number is a changed picture.
    expect(board.update({ ...BATTER, score: 1300 } as BoardScreen, 2)).toBe(true);
    expect(board.uploads()).toBe(2);
    expect(board.texture.version).toBeGreaterThan(v1);
    board.dispose();
  });

  it('the celebration uploads at the animation rate and then stops', () => {
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    // 4 s of a 60 Hz render loop over the home-run screen.
    for (let i = 0; i <= 240; i++) board.update(HOMER, i / 60);
    // One upload per animation frame, inclusive of frame 0, and not one more —
    // 60 Hz in, 12 Hz out.
    expect(board.uploads()).toBe(BOARD_ANIM_LAST_FRAME + 1);
    expect(board.current()).toEqual({
      key: `${boardScreenKey(HOMER)}#${BOARD_ANIM_LAST_FRAME}`,
      frame: BOARD_ANIM_LAST_FRAME,
    });
    // ⚠ AND THE TAIL IS FREE. Everything after `BOARD_ANIM_END_S` is the same
    // picture, so a celebration left on screen — or a FROZEN harness clock —
    // costs nothing at all.
    const settled = board.uploads();
    for (let i = 0; i < 300; i++) board.update(HOMER, 10 + i / 60);
    expect(board.uploads()).toBe(settled);
    board.dispose();
  });

  it('a frozen clock repaints once and never again', () => {
    // This is exactly what `lib/scene3d/clock.ts` does to the scene under the
    // screenshot harness: `tickSceneClock` returns the same value every frame.
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    for (let i = 0; i < 50; i++) board.update(HOMER, 0.5);
    expect(board.uploads()).toBe(1);
    board.dispose();
  });

  it('rasterises the painted ops into the canvas, and uses no text API', () => {
    const canvas = fakeCanvas();
    const board = buildScoreboard({ createCanvas: () => canvas });
    board.update(BATTER, 0);
    const log = canvas.g.log;
    // The picture is cleared first, so nothing from a previous screen survives.
    expect(log[0]!.op).toBe('clearRect');
    expect(log[0]!.args).toEqual([0, 0, BOARD_TEXTURE_W, BOARD_TEXTURE_H]);
    // Panels became `fillRect`s at texel coordinates; text became strokes.
    const panels = board.ops().filter((o) => o.kind === 'panel').length;
    expect(log.filter((r) => r.op === 'fillRect')).toHaveLength(panels);
    const glyphs = board
      .ops()
      .filter((o): o is Extract<BoardOp, { kind: 'text' }> => o.kind === 'text')
      .reduce((n, o) => n + [...o.text].filter((c) => c !== ' ').length, 0);
    expect(log.filter((r) => r.op === 'stroke')).toHaveLength(glyphs);
    // Every drawn coordinate is inside the texture.
    for (const r of log) {
      if (r.op === 'moveTo' || r.op === 'lineTo') {
        expect(r.args[0]).toBeGreaterThanOrEqual(-1);
        expect(r.args[0]).toBeLessThanOrEqual(BOARD_TEXTURE_W + 1);
        expect(r.args[1]).toBeGreaterThanOrEqual(-1);
        expect(r.args[1]).toBeLessThanOrEqual(BOARD_TEXTURE_H + 1);
      }
    }
    board.dispose();
  });

  it('a smaller texture is the SAME picture, only smaller', () => {
    // Ops are fractional, so a low tier is a resolution change and not a second
    // layout. The op list must be identical; only the emitted pixels scale.
    const big = buildScoreboard({ createCanvas: fakeCanvas });
    const small = buildScoreboard({ createCanvas: fakeCanvas, widthPx: 512, heightPx: 256 });
    big.update(BATTER, 0);
    small.update(BATTER, 0);
    expect(small.ops()).toEqual(big.ops());
    expect(small.widthPx).toBe(512);
    big.dispose();
    small.dispose();
  });
});

// ---------------------------------------------------------------------------
// Determinism, as a source guard
// ---------------------------------------------------------------------------

describe('board determinism guard', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SOURCES = ['scoreboard.ts', 'boardPaint.ts', 'boardScreens.ts', 'boardGlyphs.ts'];
  const read = (n: string) => readFileSync(join(HERE, n), 'utf8');
  const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

  it('reads no clock and no RNG', () => {
    // ⚠ STRICTER THAN `determinism.test.ts` IS FOR THE SCENE, ON PURPOSE. That
    // guard lets the render layer keep a wall clock, because a rAF loop is how a
    // frame loop works. This module is not a loop: it takes `tS` as an argument
    // precisely so the harness's frozen `lib/scene3d/clock.ts` can control it,
    // and one `performance.now()` in here would put the board's animation back
    // on the machine's clock where two runs differ.
    const violations: string[] = [];
    for (const name of SOURCES) {
      read(name)
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          for (const pat of [/\bMath\.random\b/, /\bDate\.now\b/, /\bperformance\s*\./, /\bnew\s+Date\b/]) {
            if (pat.test(line)) violations.push(`${name}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(violations, violations.join('\n')).toEqual([]);
    // Guard the guard.
    expect(read('scoreboard.ts').length).toBeGreaterThan(500);
  });

  it('never rasterises a system font', () => {
    // ⚠ THE MEASURED RISK, WRITTEN AS A GUARD. In this container's headless
    // Chromium, `Impact`, `Verdana`, `Tahoma`, `Roboto`, `Georgia` and
    // `Trebuchet MS` are all MISSING and substituted silently, `Arial` resolves
    // to Liberation Sans and `system-ui` to DejaVu Sans, and
    // `document.fonts.check()` answered TRUE for a family that does not exist —
    // so nothing at runtime can detect the substitution. Two runs on THIS
    // machine were byte-identical (three launches, same SHA-256); two runs on
    // two machines would not be. The board therefore draws its own glyphs, and
    // this is what stops a later "just use fillText for the small stuff".
    const violations: string[] = [];
    for (const name of SOURCES) {
      read(name)
        .split('\n')
        .forEach((line, i) => {
          if (isComment(line)) return;
          for (const pat of [/\bfillText\b/, /\bstrokeText\b/, /\bmeasureText\b/, /\.font\s*=/]) {
            if (pat.test(line)) violations.push(`${name}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
