// The videoboard array's bench.
//
// ⚠ THE STANDARD THIS FILE IS WRITTEN TO. A canvas is hard to assert on, which
// is exactly why display code is where hollow tests breed — this repo has found
// eight, including `expect(spy).toHaveBeenCalledWith(v, undefined)` silently
// matching a one-argument call. So nothing here asserts that a function was
// called. It asserts WHAT WAS DRAWN:
//
//   • `boardArrayOps()` is a pure `(array, frame) => BoardOp[]`, so the picture
//     is an array of plain objects and "the distance is drawn, centred, bigger
//     than the exit velocity, before it in z-order" is an assertion about data.
//   • the RASTERISER is then driven through a RECORDING `Board2D` and the op log
//     is asserted — the strings, the coordinates, the stroke STYLE, the count of
//     strokes — so the step from data to pixels is measured too, not assumed.
//
// ⚠ AND EVERY TABLE-DRIVEN WALK RUNS OVER **ONE** FIXTURE DOMAIN. The previous
// bench had two: `ALL_SCREENS` for legibility and a separate `worst` list for
// overlap, so the extremes were never checked for legibility and shipped
// `HARBOURFRONT` at 9.9 CSS px, `ALPINE MEADOWS` at 8.5 and
// `MAXIMILIAN LONGNAME` at 8.4 against a 10 px floor the file claimed to
// enforce. `HARBOURFRONT` is the real park's name. Two domains is how a suite
// with 34 green assertions misses four violations of its own headline rule, so
// there is now exactly one: `ALL_STATES`.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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
  TRUNCATION_MARK,
  boardAdvancePx,
  boardTextWidthPx,
  glyphTableHash,
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
  MIN_LEGIBLE_CSS_PX,
  MIN_LEGIBLE_FT,
  TYPE_FT,
  boardAnimFrame,
  boardCssPxPerFt,
  boardLegibleCssPx,
  emitBoardOps,
  fitRun,
  panelType,
  runH,
} from './boardPaint';
import type { BoardOp } from './boardPaint';
import type { BoardArray, BoardScreen, BoardSide, BoardStrip } from './boardState';
import { boardArrayKey, boardScreenKey, normaliseScreen } from './boardState';
import {
  BOARD_ARRAY_ASPECT,
  BOARD_GEOMETRY,
  BOARD_PANELS,
  MIN_FRAME_GAP_FT,
  boardArrayOps,
  boardFloorCssPx,
  boardGeometryComplaints,
  boardPanel,
  panelCharBudget,
  panelRowBudget,
  validateBoardAtlas,
} from './boardAtlas';
import { HOME_RUN_WORD, boardMainOps, boardResultRows, countUp } from './boardScreens';
import { celebrationSides, sideRowBudget, stripColumnX } from './boardPanels';
import {
  RIBBON_CELLS,
  RIBBON_SWEEP_S,
  RIBBON_TYPE,
  ribbonCssPxAt,
  ribbonKey,
  ribbonOffsetU,
  ribbonOps,
  ribbonReadRangeFt,
  ribbonTrain,
  ribbonWraps,
} from './boardRibbon';
import { BOARD_TEXTURE_H, BOARD_TEXTURE_W, buildScoreboard } from './scoreboard';
import type { BoardCanvas } from './scoreboard';

// ---------------------------------------------------------------------------
// The recording surface
// ---------------------------------------------------------------------------

/**
 * A `Board2D` that writes down what it was asked to do.
 *
 * ⚠ IT RECORDS ARGUMENTS AND STYLE, NOT CALLS. Every entry carries the full
 * argument list AND the state that was in force, so an assertion can say "a
 * stroke of this colour, this wide, round-capped, through these points" — the
 * things a pixel is made of. A `vi.fn()` would let a draw at the wrong
 * coordinates pass.
 *
 * ⚠ `lineCap`/`lineJoin` ARE RECORDED BECAUSE THE INK MODEL RESTS ON THEM, and
 * they were not: changing `boardGlyphs`'s `'round'` to `'butt'`/`'miter'` passed
 * all 34 tests. The overlap check below inflates each text box by half a
 * `lineWidth` on every side, which is EXACTLY the envelope a round cap and a
 * round join sweep; under `miter` the apexes of `A`, `V`, `W` and `M` spike well
 * outside that box and the check silently stops describing the ink.
 */
type Rec = {
  op: string;
  args: number[];
  fill: string;
  stroke: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
};

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
      lineCap: g.lineCap,
      lineJoin: g.lineJoin,
    });
  }
  return g;
}

function fakeCanvas(): BoardCanvas & { g: ReturnType<typeof recorder> } {
  const g = recorder();
  return { width: 0, height: 0, g, getContext: () => g };
}

// ---------------------------------------------------------------------------
// Fixtures — ONE domain, covering every surface and every extreme
// ---------------------------------------------------------------------------

const BATTER: Extract<BoardScreen, { kind: 'derbyBatter' }> = {
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

const HOMER: Extract<BoardScreen, { kind: 'homeRun' }> = {
  kind: 'homeRun',
  distFt: 428.4,
  evMph: 108.2,
  laDeg: 26.6,
  points: 380,
  chainX: 1.5,
};

const DUEL: Extract<BoardScreen, { kind: 'duelScore' }> = {
  kind: 'duelScore',
  away: { name: 'ALPINE', runs: 3 },
  home: { name: 'HARBOUR', runs: 4 },
  inning: 3,
  half: 'bot',
  outs: 2,
  balls: 2,
  strikes: 1,
};

const SCORE_COL: BoardSide = {
  heading: 'SCORE',
  rows: [
    { label: 'PTS', value: '1240' },
    { label: 'LONG', value: '428' },
  ],
};
const ARM_COL: BoardSide = {
  heading: 'ARM',
  rows: [
    { label: 'NO', value: '#31' },
    { label: 'MPH', value: '94' },
  ],
};
const DUEL_STRIP: BoardStrip = {
  // ⚠ THREE COLUMNS BECAUSE THE DUEL IS THREE INNINGS — the charter's scope cap
  // written as data. Nine would fit too (the strip carries 26 characters), which
  // is why `columns` is a list and not a constant.
  columns: ['1', '2', '3'],
  totals: ['R', 'H', 'E'],
  rows: [
    { name: 'ALPINE', cells: [0, 1, null], totals: [1, 3, 0] },
    { name: 'HARBOUR', cells: [2, 0, null], totals: [2, 4, 1] },
  ],
};
const DERBY_STRIP: BoardStrip = {
  columns: ['R1', 'R2', 'R3'],
  totals: ['PTS'],
  rows: [{ name: 'YOU', cells: [1240, 980, null], totals: [2220] }],
};

const RIBBON = { items: ['HARBOURFRONT DOME', 'ROUND 2/3', '×1.50'] };

const arr = (main: BoardScreen, over: Partial<BoardArray> = {}): BoardArray => ({
  main,
  left: SCORE_COL,
  right: ARM_COL,
  strip: DUEL_STRIP,
  ribbon: RIBBON,
  ...over,
});

/**
 * THE ONE DOMAIN. Every screen kind, both branches of every conditional, and the
 * WIDEST content each surface can carry — a five-digit score, a 19-character
 * card name, a four-digit long ball, a three-digit run total, a 12-character
 * city and a heading longer than a narrow column can hold.
 */
const ALL_STATES: BoardArray[] = [
  arr({ kind: 'idle', label: 'HOME RUN DERBY' }, { left: null, right: null, strip: null }),
  arr(BATTER),
  arr({ ...BATTER, chainX: null, bestFt: null }),
  arr({ ...BATTER, chainX: null, bestFt: 4288, pitch: 27 }),
  arr({ ...BATTER, score: 99999, batter: 'MAXIMILIAN LONGNAME' }, { strip: DERBY_STRIP }),
  arr({ ...BATTER, chainX: 2, score: 99999, batter: "O'BRIEN" }),
  arr({ kind: 'result', line: 'GONE! 428 ft · +380 ×1.50', tone: 'gone' }),
  arr({ kind: 'result', line: 'Swing and a miss', tone: 'miss' }),
  arr({ kind: 'result', line: 'Off the wall — 395 ft · +40', tone: 'good' }),
  arr(HOMER),
  arr({ ...HOMER, chainX: null }),
  arr({ ...HOMER, distFt: 501.6, evMph: 121.4, laDeg: 32.8, points: 9999, chainX: 2 }),
  arr({ kind: 'roundSummary', round: 2, rounds: 3, roundScore: 1240, homeRuns: 7, bestFt: 428, total: 3980 }),
  arr({ kind: 'roundSummary', round: 3, rounds: 3, roundScore: 99999, homeRuns: 27, bestFt: 4288, total: 99999 }),
  arr(DUEL),
  arr({ ...DUEL, half: 'top', inning: 1, outs: 0, balls: 0, strikes: 0 }),
  arr({ ...DUEL, away: { name: 'MOUNTAINSIDE', runs: 17 }, home: { name: 'HARBOURFRONT', runs: 9 } }),
  arr({ ...DUEL, away: { name: 'ALPINE MEADOWS', runs: 123 }, home: { name: 'HARBOURFRONT', runs: 8 }, outs: 0 }),
  arr(BATTER, {
    left: { heading: 'HARBOURFRONT', rows: [{ label: 'LONGEST', value: '99999' }] },
    right: { heading: 'ARM', rows: [{ label: 'A', value: '1' }, { label: 'B', value: '2' }, { label: 'C', value: '3' }] },
    strip: {
      columns: ['1', '2', '3'],
      totals: ['R', 'H', 'E'],
      rows: [
        { name: 'MOUNTAINSIDE', cells: [12, 7, 3], totals: [123, 22, 4] },
        { name: 'HARBOURFRONT', cells: [9, 9, 9], totals: [27, 31, 2] },
      ],
    },
    ribbon: { items: [] },
  }),
];

const FRAMES = [0, 5, BOARD_ANIM_LAST_FRAME];

const texts = (ops: BoardOp[]) =>
  ops.filter((o): o is Extract<BoardOp, { kind: 'text' }> => o.kind === 'text');
const strings = (ops: BoardOp[]) => texts(ops).map((o) => o.text);
/** The MAIN panel's strings only — most screen assertions are about the middle. */
const mainStrings = (s: BoardScreen, frame = 0) =>
  strings(boardMainOps(s, frame, boardPanel('main').type));

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
    expect(validateGlyphs()).toEqual([]);
  });

  it('the glyph table is the table it was drawn as', () => {
    // ⚠ THE ASSERTION `validateGlyphs()` CANNOT MAKE. Swapping `E`'s and `F`'s
    // sources renders every E as an F and every F as an E, and the structural
    // validation passes unchanged because a swap preserves every property it
    // checks. Per-glyph point counts would not close it either — E and F differ,
    // but two same-budget glyphs, or two swapped coordinates inside one glyph,
    // would still slip through. One hash over the PARSED table catches all of it.
    const hash = glyphTableHash();
    // eslint-disable-next-line no-console
    console.log(`\n[BOARD — glyph table digest] ${hash}  (FNV-1a over the parsed polylines)\n`);
    expect(hash).toBe(GLYPH_TABLE_HASH);
    // Guard the guard: the digest must actually move when a shape does.
    expect(glyphTableHash()).toBe(hash);
  });

  it('covers every character the board and the HUD copy can produce', () => {
    // ⚠ THIS IS THE CROSS-MODULE HALF. `describeSwing` emits `·`, `—`, `×` and
    // digits; a glyph the copy layer uses and the table lacks renders as the
    // conspicuous fallback box on the biggest surface in the park. So the
    // coverage set is generated from `swingCopy`'s own output over every outcome
    // plus every string the array itself builds, across the whole domain.
    const lines = DERBY_OUTCOMES.flatMap((outcome) => [
      describeSwing(swing({ outcome, points: 380, chainIndex: 3, distFt: 428 })),
      describeSwing(swing({ outcome, points: 0, chainIndex: 0, fence: 'offWall', distFt: 395 })),
      describeSwing(swing({ outcome, points: 12, strike: false })),
    ]);
    const fromBoard = ALL_STATES.flatMap((s) =>
      FRAMES.flatMap((f) => [...strings(boardArrayOps(s, f)), ...strings(ribbonOps(s, f))]),
    );
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
    expect(fromBoard.join('')).toContain('#');
    // ⚠ AND THE TWO THE ARRAY ADDED. `O'BRIEN` is a legal card name and drew the
    // fallback box; `…` is the mark `fitRun` appends when it truncates, so a
    // table without it would print a box on every over-long name in the park.
    expect(fromBoard.join('')).toContain("'");
    expect(fromBoard.join('')).toContain(TRUNCATION_MARK);
    expect(hasGlyph(TRUNCATION_MARK)).toBe(true);
    for (const ch of ["'", ',', '(', ')', '%', '#']) expect(hasGlyph(ch)).toBe(true);
  });

  it('is monospaced, and the width arithmetic is the advance arithmetic', () => {
    expect(boardAdvancePx(100)).toBeCloseTo(100 * (GLYPH_W + GLYPH_TRACK), 12);
    expect(boardTextWidthPx('', 100)).toBe(0);
    expect(boardTextWidthPx('A', 100)).toBeCloseTo(100 * GLYPH_W, 12);
    expect(boardTextWidthPx('AB', 100)).toBeCloseTo(100 * (2 * (GLYPH_W + GLYPH_TRACK) - GLYPH_TRACK), 12);
    expect(boardTextWidthPx('WWW', 50)).toBe(boardTextWidthPx('.  ', 50));
    expect(boardTextWidthPx('©©', 50)).toBe(boardTextWidthPx('AB', 50));
  });

  it('strokes one path per printable glyph, round-capped and round-joined', () => {
    const g = recorder();
    strokeBoardText(g, 'A B', 0, 0, 100, '#fff');
    expect(g.log.filter((r) => r.op === 'beginPath')).toHaveLength(2);
    expect(g.log.filter((r) => r.op === 'stroke')).toHaveLength(2);
    expect(g.log.filter((r) => r.op === 'fill')).toHaveLength(0);
    expect(g.log.every((r) => r.stroke === '#fff' || r.stroke === '')).toBe(true);
    const strokes = g.log.filter((r) => r.op === 'stroke');
    expect(strokes[0]!.lineWidth).toBeCloseTo(100 * GLYPH_WEIGHT, 9);
    // ⚠ THE INK MODEL, ASSERTED. See the recorder's note: the overlap check's
    // half-lineWidth inflation IS the round envelope, and `miter` would push an
    // `A`'s apex 2.2× further than that while every other test stayed green.
    expect(strokes.every((r) => r.lineCap === 'round' && r.lineJoin === 'round')).toBe(true);

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
    const lower = recorder();
    const upper = recorder();
    strokeBoardText(lower, 'ft', 0, 0, 100, '#fff');
    strokeBoardText(upper, 'FT', 0, 0, 100, '#fff');
    expect(lower.log).toEqual(upper.log);
  });

  it('anchors left, centre and right at the coordinate it was given', () => {
    const w = boardTextWidthPx('428', 100);
    const firstX = (align: 'left' | 'centre' | 'right') => {
      const g = recorder();
      strokeBoardText(g, '428', 1000, 0, 100, '#fff', align);
      return g.log.find((r) => r.op === 'moveTo')!.args[0]!;
    };
    const inset = 0.75 * 100 * GLYPH_W;
    expect(firstX('left')).toBeCloseTo(1000 + inset, 9);
    expect(firstX('centre')).toBeCloseTo(1000 - w / 2 + inset, 9);
    expect(firstX('right')).toBeCloseTo(1000 - w + inset, 9);
    expect(new Set([firstX('left'), firstX('centre'), firstX('right')]).size).toBe(3);
  });

  it('draws an unknown character as the fallback box rather than nothing', () => {
    const g = recorder();
    strokeBoardText(g, 'é', 0, 0, 100, '#fff');
    expect(g.log.filter((r) => r.op === 'stroke')).toHaveLength(1);
    expect(g.log.filter((r) => r.op === 'lineTo')).toHaveLength(4);
    expect(hasGlyph('é')).toBe(false);
    expect(hasGlyph('e')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The atlas: where the panels are, and what they can carry
// ---------------------------------------------------------------------------

describe('board atlas', () => {
  it('the panel table is valid data', () => {
    // Charter rule 4 again: a `validate*()` run as a test makes bad data a test
    // failure. Panels inside the face, none overlapping, a real frame gap between
    // every pair, and every one of them big enough to carry something.
    expect(validateBoardAtlas()).toEqual([]);
    expect(BOARD_PANELS.map((p) => p.id)).toEqual(['stats', 'main', 'pitcher', 'strip']);
  });

  it('the UV rects are DERIVED from the ft placement, in three’s v-up space', () => {
    // ⚠ THE CONTRACT WITH THE SCENE. The quad for a panel carries `uv`; if these
    // are wrong the strip paints the pitcher's data and nothing in a unit test
    // would notice, so they are derived from one source and checked against it.
    for (const p of BOARD_PANELS) {
      expect(p.uv.u0).toBeCloseTo(p.xFt / BOARD_REF.widthFt, 12);
      expect(p.uv.u1).toBeCloseTo((p.xFt + p.wFt) / BOARD_REF.widthFt, 12);
      // v is UP in three and y is DOWN on the canvas — the flip is the bug this
      // pins. A panel at the TOP of the face must have the HIGHER v.
      expect(p.uv.v1).toBeCloseTo(1 - p.yFt / BOARD_REF.heightFt, 12);
      expect(p.uv.v0).toBeCloseTo(1 - (p.yFt + p.hFt) / BOARD_REF.heightFt, 12);
      expect(p.uv.v1).toBeGreaterThan(p.uv.v0);
      // The canvas rect is the same rect, y down.
      expect(p.rect.y).toBeCloseTo(p.yFt / BOARD_REF.heightFt, 12);
      expect(p.rect.h).toBeCloseTo(p.hFt / BOARD_REF.heightFt, 12);
    }
    expect(boardPanel('strip').uv.v1).toBeLessThan(boardPanel('main').uv.v0);
    expect(boardPanel('stats').uv.u1).toBeLessThan(boardPanel('main').uv.u0);
    expect(boardPanel('main').uv.u1).toBeLessThan(boardPanel('pitcher').uv.u0);
  });

  it('the information budget is a MEASUREMENT, per panel', () => {
    // ⚠ THE NUMBER THE WHOLE ARRAY EXISTS FOR. One 100 × 50 ft rectangle carries
    // ten floor-height rows and 26 characters; that was the row budget the last
    // design was stuck with, and it is why the batter card had to drop a band
    // from three items to two. Four panels carry the SAME total area differently:
    // the strip is short and very wide, the columns are tall and very narrow, and
    // each is budgeted against its own subtended size rather than the board's.
    const rows = BOARD_PANELS.map((p) => ({
      id: p.id,
      wFt: p.wFt,
      hFt: p.hFt,
      chars: panelCharBudget(p.wFt),
      lines: panelRowBudget(p.hFt),
      floor: p.type.floor,
    }));
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — the array's information budget, ${BOARD_REF.widthFt}×${BOARD_REF.heightFt} ft at ` +
        `${BOARD_REF.faceDistFt} ft, CAMERAS.batter]\n` +
        `  floor ${MIN_LEGIBLE_CSS_PX} CSS px = ${MIN_LEGIBLE_FT.toFixed(3)} ft of glyph = ` +
        `${(MIN_LEGIBLE_FT * (GLYPH_W + GLYPH_TRACK)).toFixed(3)} ft per character\n` +
        rows
          .map(
            (r) =>
              `  ${r.id.padEnd(8)} ${String(r.wFt).padStart(5)} × ${String(r.hFt).padStart(4)} ft   ` +
              `${String(r.chars).padStart(3)} chars   ${String(r.lines).padStart(2)} rows   ` +
              `floor ${r.floor.toFixed(4)} of panel height`,
          )
          .join('\n') +
        `\n  TOTAL ${rows.reduce((a, b) => a + b.lines, 0)} rows against the ` +
        `${panelRowBudget(BOARD_REF.heightFt)} a single rectangle of the same face carries.\n` +
        `  ⚠ The columns carry NUMBERS: ${panelCharBudget(18)} characters is a jersey number, not a name.\n`,
    );
    // The columns are narrow, the strip is wide, and both facts are load-bearing.
    expect(panelCharBudget(boardPanel('stats').wFt)).toBe(5);
    expect(panelCharBudget(boardPanel('main').wFt)).toBeGreaterThanOrEqual(16);
    expect(panelCharBudget(boardPanel('strip').wFt)).toBeGreaterThanOrEqual(26);
    expect(panelRowBudget(boardPanel('strip').hFt)).toBe(3);
    // The array beats the single rectangle it replaced on total rows.
    expect(rows.reduce((a, b) => a + b.lines, 0)).toBeGreaterThan(panelRowBudget(BOARD_REF.heightFt));
  });

  it('the legibility floor follows from the camera it claims to follow', () => {
    // ⚠ THE FLOOR IS A DERIVATION, SO IT IS CHECKED AS ONE. Two things could
    // quietly falsify it: the camera moving, or the ART AGENT building a
    // different array — and the second is the likely one. Both are asserted.
    expect(CAMERAS.batter.pos[2]).toBe(8);
    expect(CAMERAS.batter.fov).toBe(40);
    expect(MIN_LEGIBLE_FT * boardCssPxPerFt()).toBeCloseTo(MIN_LEGIBLE_CSS_PX, 9);
    expect(TYPE_FT.label).toBe(MIN_LEGIBLE_FT);
    expect(boardLegibleCssPx(MIN_LEGIBLE_FT / BOARD_REF.heightFt)).toBeCloseTo(10, 6);
    // Linear in heightFt / faceDistFt — the property every warning here rests on.
    expect(boardLegibleCssPx(0.1, 25)).toBeCloseTo(boardLegibleCssPx(0.1, 50) / 2, 9);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — the type scale, in feet of glyph and CSS px on a phone]\n` +
        (Object.entries(TYPE_FT) as Array<[string, number]>)
          .map(
            ([k, ft]) =>
              `  ${k.padEnd(6)} ${ft.toFixed(2).padStart(6)} ft  →  ` +
              `${(ft * boardCssPxPerFt()).toFixed(1).padStart(5)} CSS px   ` +
              `main ${(ft / boardPanel('main').hFt).toFixed(3)} · ` +
              `column ${(ft / boardPanel('stats').hFt).toFixed(3)} · ` +
              `strip ${(ft / boardPanel('strip').hFt).toFixed(3)} of panel height`,
          )
          .join('\n') +
        `\n  ⚠ ONE SCALE IN FEET, THREE SETS OF FRACTIONS. The same 0.155 was a title on a 50 ft\n` +
        `  board and an unreadable 2.6 ft on the strip — which is why the scale is absolute now.\n`,
    );
  });

  it('a geometry that cannot be read is a BUILD FAILURE, not a smaller board', () => {
    // ⚠ THE SEAM THAT USED TO BE "GENUINELY UNGUARDABLE". It was not. The board's
    // size belongs to the scene; what it means for the board's legibility belongs
    // here, and a 30 ft array at the same range puts the floor at 6.0 CSS px
    // while the whole suite passes. Now it throws.
    expect(boardGeometryComplaints(BOARD_GEOMETRY)).toEqual([]);
    expect(boardFloorCssPx(BOARD_GEOMETRY)).toBeCloseTo(MIN_LEGIBLE_CSS_PX, 6);

    const small = { ...BOARD_GEOMETRY, widthFt: 60, heightFt: 30 };
    expect(boardFloorCssPx(small)).toBeCloseTo(6.0, 1);
    expect(boardGeometryComplaints(small).join(' ')).toMatch(/under the 10 px floor/);
    expect(() => buildScoreboard({ geometry: small, createCanvas: fakeCanvas })).toThrow(/CSS px/);

    // Further away is the same failure by the other variable.
    const far = { ...BOARD_GEOMETRY, faceDistFt: 700 };
    expect(boardGeometryComplaints(far).length).toBeGreaterThan(0);
    // A BIGGER array is fine, and so is a nearer one.
    expect(boardGeometryComplaints({ ...BOARD_GEOMETRY, widthFt: 140, heightFt: 70 })).toEqual([]);
    expect(boardGeometryComplaints({ ...BOARD_GEOMETRY, faceDistFt: 380 })).toEqual([]);
    // A stretched array is refused too — the panel table is authored at 2:1.
    expect(boardGeometryComplaints({ ...BOARD_GEOMETRY, widthFt: 160 }).join(' ')).toMatch(/aspect/);
    expect(boardGeometryComplaints({ ...BOARD_GEOMETRY, heightFt: 0 }).join(' ')).toMatch(/positive/);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — the integration guard]\n` +
        [BOARD_GEOMETRY, small, far, { ...BOARD_GEOMETRY, widthFt: 140, heightFt: 70 }]
          .map(
            (g) =>
              `  ${String(g.widthFt).padStart(4)}×${String(g.heightFt).padStart(3)} ft @ ` +
              `${String(g.faceDistFt).padStart(4)} ft  →  floor ${boardFloorCssPx(g).toFixed(1).padStart(5)} CSS px  ` +
              `${boardGeometryComplaints(g).length === 0 ? 'BUILD' : 'THROW'}`,
          )
          .join('\n') +
        '\n',
    );
  });
});

// ---------------------------------------------------------------------------
// What each surface actually says
// ---------------------------------------------------------------------------

describe('board screens', () => {
  it('the batter card says who and where; the columns say how much', () => {
    // ⚠ THE SCORE MOVED OFF THE MAIN PANEL, AND THAT IS THE ARRAY WORKING. The
    // main panel is 59 × 29.5 ft — 41 % shorter than the rectangle it replaced —
    // so it carries WHO and WHERE, and the numbers live in the column that the
    // reference photograph puts them in.
    expect(mainStrings(BATTER)).toEqual(['HARBOUR CITY', 'ROUND 2/3', 'PITCH', '7/27', 'CHAIN', '×1.50']);
    const byText = new Map(texts(boardMainOps(BATTER, 0, boardPanel('main').type)).map((o) => [o.text, o]));
    expect(byText.get('HARBOUR CITY')!.size).toBeGreaterThan(byText.get('ROUND 2/3')!.size);
    expect(byText.get('7/27')!.align).toBe('left');
    expect(byText.get('×1.50')!.align).toBe('right');
    // The full array carries the score, on the left column.
    expect(strings(boardArrayOps(arr(BATTER), 0))).toContain('1240');
  });

  it('hides the chain badge and the long-ball line when there is nothing to say', () => {
    // ⚠ THE MULTIPLIER IS SHOWN ONLY WHILE EARNING — `swingCopy` states the rule
    // for the HUD and the board must not contradict it with a permanent ×1.00.
    expect(mainStrings({ ...BATTER, chainX: null, bestFt: null })).toEqual([
      'HARBOUR CITY',
      'ROUND 2/3',
      'PITCH',
      '7/27',
    ]);
    expect(mainStrings({ ...BATTER, chainX: 1 }).some((s) => s.startsWith('×'))).toBe(false);
    expect(mainStrings({ ...BATTER, chainX: 2 })).toContain('×2.00');
    // Off-chain, the long ball has the right column back.
    expect(mainStrings({ ...BATTER, chainX: null })).toContain('428 FT');
    expect(mainStrings({ ...BATTER, chainX: null }).some((t) => t.startsWith('×'))).toBe(false);
  });

  it('no two pieces of text on any surface overlap', () => {
    // ⚠ THE ASSERTION THAT CAUGHT WHAT EVERY OTHER CHECK IN THIS FILE MISSED. The
    // suite was green over a batter card whose chain badge was painted across the
    // word LONG and over a round summary whose two columns met with no gutter —
    // both found by rendering a PNG and looking at it. Extents are exact
    // arithmetic here (the face is monospaced), so a canvas is not needed.
    //
    // ⚠ THE BOX IS THE INK, NOT THE CELL. A stroked glyph extends half a
    // `lineWidth` past its cell on every side, so two runs whose cells merely
    // TOUCH already overlap by a full stroke. That inflation is exactly the
    // round-cap/round-join envelope the emitter test now pins.
    //
    // ⚠ AND IT RUNS IN ATLAS SPACE, WHICH IS WHY IT ALSO CATCHES A PANEL
    // COLLISION. Two panels whose content spills across a frame gap fail here
    // just as two runs inside one panel do, because after `mapOps` there is only
    // one coordinate system left.
    const extent = (o: Extract<BoardOp, { kind: 'text' }>) => {
      const w = (runH(o.text.length) * o.size) / BOARD_ARRAY_ASPECT;
      const x0 = o.align === 'left' ? o.x : o.align === 'right' ? o.x - w : o.x - w / 2;
      const inkY = (o.size * GLYPH_WEIGHT) / 2;
      const inkX = inkY / BOARD_ARRAY_ASPECT;
      return { x0: x0 - inkX, x1: x0 + w + inkX, y0: o.y - inkY, y1: o.y + o.size + inkY, t: o.text };
    };
    for (const state of ALL_STATES) {
      for (const frame of FRAMES) {
        const boxes = texts(boardArrayOps(state, frame)).map(extent);
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i]!;
            const b = boxes[j]!;
            const hits = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
            expect(hits, `${state.main.kind}: "${a.t}" overlaps "${b.t}"`).toBe(false);
          }
        }
      }
    }
  });

  it('the result screen is the HUD line, split on its own separator', () => {
    expect(mainStrings({ kind: 'result', line: 'GONE! 428 ft · +380 ×1.50', tone: 'gone' })).toEqual([
      'GONE! 428 ft',
      '+380 ×1.50',
    ]);
    // Both of `describeSwing`'s own separators break a row — see the note on
    // `boardResultRows`. One 21-character row could not be set above the floor
    // and lost the distance to a truncation mark.
    expect(boardResultRows('Off the wall — 395 ft · +40')).toEqual(['Off the wall', '395 ft', '+40']);
    expect(mainStrings({ kind: 'result', line: 'Off the wall — 395 ft · +40', tone: 'good' })).toEqual([
      'Off the wall',
      '395 ft',
      '+40',
    ]);
    // The longest single row the HUD can produce fits WHOLE — the panel is 60 ft
    // for this string and no other.
    expect(mainStrings({ kind: 'result', line: 'Swing and a miss', tone: 'miss' })).toEqual(['Swing and a miss']);
    expect(boardResultRows('Swing and a miss')).toEqual(['Swing and a miss']);
  });

  it('EVERY `describeSwing` outcome fits the main panel at a legible size', () => {
    // ⚠ THE ASSERTION THE WHOLE `result` DESIGN RESTS ON. The board reuses the
    // HUD's vocabulary verbatim, so it inherits the HUD's string LENGTHS — and a
    // 25-character line set as one row lands under the floor. Splitting on ` · `
    // is what fixes that, and `fitRun` truncating rather than shrinking is what
    // stops the residue from being drawn illegibly anyway.
    const rows: Array<[string, number, string]> = [];
    for (const outcome of DERBY_OUTCOMES) {
      for (const variant of [
        swing({ outcome, points: 380, chainIndex: 3, distFt: 428.4 }),
        swing({ outcome, points: 40, chainIndex: 0, fence: 'offWall', distFt: 395.2 }),
        swing({ outcome, points: 0, chainIndex: 0, strike: false, distFt: 0 }),
      ]) {
        const line = describeSwing(variant);
        const ops = texts(boardArrayOps(arr({ kind: 'result', line, tone: 'neutral' }), 0));
        const smallest = Math.min(...ops.map((o) => o.size));
        rows.push([line, boardLegibleCssPx(smallest), ops.map((o) => o.text).join(' | ')]);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — every describeSwing line on the result screen; floor ${MIN_LEGIBLE_CSS_PX} CSS px]\n` +
        [...new Map(rows.map((r) => [r[0], r])).values()]
          .map(([line, px]) => `  ${(px as number).toFixed(1).padStart(5)} px  ${line}`)
          .join('\n') +
        '\n',
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const [line, px] of rows) {
      expect(px, `"${line}" sets at ${(px as number).toFixed(2)} CSS px`).toBeGreaterThanOrEqual(
        MIN_LEGIBLE_CSS_PX - 1e-9,
      );
    }
  });

  it('the home run leads with the word the HUD leads with, EXACTLY', () => {
    // ⚠ EQUALITY WITH THE FIRST WORD, NOT `startsWith`. `startsWith` let
    // `GONE!` → `GONE!!` pass all 34 tests: the board would have shouted a word
    // the HUD never prints, which is the "second vocabulary" the charter forbids.
    const hud = describeSwing(swing({ outcome: 'homeRun', points: 380, chainIndex: 3, distFt: 428.4 }));
    expect(hud.split(' ')[0]).toBe(HOME_RUN_WORD);
    expect(mainStrings(HOMER, BOARD_ANIM_LAST_FRAME)[0]).toBe(HOME_RUN_WORD);
    expect(hud).toContain(`×${chainMultiplier(3).toFixed(2)}`);
  });

  it('the home run erupts across the WHOLE array, at one frame', () => {
    // ⚠ THE COORDINATED MOMENT. The main panel cannot carry four rows at this
    // type scale, so the moment spreads: `GONE!` and the counting distance in the
    // middle, the payout on the left, the ball's numbers on the right, a chase on
    // the strip and light sweeping the ribbons — all from ONE screen and ONE
    // integer frame, derived here rather than asked of the caller, so there is no
    // call site that can wire half of it.
    const ops = boardArrayOps(arr(HOMER), BOARD_ANIM_LAST_FRAME);
    const said = strings(ops);
    expect(said).toContain(HOME_RUN_WORD);
    expect(said).toContain('428 FT');
    expect(said).toContain('+380');
    expect(said).toContain('×1.50');
    expect(said).toContain('108');
    expect(said).toContain('27°');
    expect(said).toContain('HOME RUN');
    // The caller's own side content is IGNORED while it is going on.
    const withOther = boardArrayOps(
      arr(HOMER, { left: { heading: 'ZZZ', rows: [{ label: 'ZZZ', value: 'ZZZ' }] } }),
      BOARD_ANIM_LAST_FRAME,
    );
    expect(strings(withOther)).not.toContain('ZZZ');
    expect(strings(withOther)).toEqual(said);
    // The distance is the biggest thing in the park, and it is above the detail.
    const byText = new Map(texts(ops).map((o) => [o.text, o]));
    expect(byText.get('428 FT')!.size).toBeGreaterThan(byText.get(HOME_RUN_WORD)!.size);
    expect(byText.get('428 FT')!.size).toBeGreaterThan(byText.get('108')!.size);
    expect(byText.get('428 FT')!.y).toBeGreaterThan(byText.get(HOME_RUN_WORD)!.y);
    // No chain ⇒ no `×`, and the payout is still there.
    const plain = strings(boardArrayOps(arr({ ...HOMER, chainX: null }), BOARD_ANIM_LAST_FRAME));
    expect(plain).toContain('+380');
    expect(plain.some((s) => s.startsWith('×'))).toBe(false);
    expect(celebrationSides({ ...HOMER, chainX: null }).left.rows).toHaveLength(1);
  });

  it('the round summary and the duel line score render their own numbers', () => {
    const summary: BoardScreen = {
      kind: 'roundSummary',
      round: 2,
      rounds: 3,
      roundScore: 1240,
      homeRuns: 7,
      bestFt: 428,
      total: 3980,
    };
    // The middle carries the round's own two numbers; the columns carry the
    // other two, because four stacks is 28.0 ft of type in a 29.5 ft panel.
    expect(mainStrings(summary)).toEqual(['ROUND 2/3 DONE', 'ROUND', '+1240', 'TOTAL', '3980']);
    const whole = strings(boardArrayOps(arr(summary, { left: null, right: null, strip: null }), 0));
    expect(whole).toEqual([
      'ROUND 2/3 DONE',
      'ROUND',
      '+1240',
      'TOTAL',
      '3980',
      'HOMER',
      'THIS',
      '7',
      'LONG',
      'FT',
      '428',
    ]);

    // ⚠ THE DUEL VARIANT SHIPS NOW, PAINTED AND ASSERTED, MONTHS BEFORE
    // `duelSim.ts`. That is the point of a discriminated union: the 3-inning mode
    // lands as a caller change, never as a rewrite of this module.
    expect(mainStrings(DUEL)).toEqual(['ALPINE', '3', 'HARBOUR', '4', 'B3', '2-1']);
    const lamps = boardMainOps(DUEL, 0, boardPanel('main').type).filter((o) => o.kind === 'poly');
    expect(lamps).toHaveLength(3);
    expect(lamps.filter((o) => o.color === '#d7263d')).toHaveLength(2);
    expect(
      boardMainOps({ ...DUEL, outs: 0 }, 0, boardPanel('main').type).filter(
        (o) => o.kind === 'poly' && o.color === '#d7263d',
      ),
    ).toHaveLength(0);

    // ⚠ THE RUNS COLUMN MEASURES ITSELF, AND IT DID NOT. `runH(2)` was hard-coded
    // beside a comment claiming otherwise, so `runs: 123` ran the name straight
    // into the number — which the overlap walk over `ALL_STATES` now also catches.
    const big = boardMainOps({ ...DUEL, away: { name: 'MOUNTAINSIDE', runs: 123 } }, 0, boardPanel('main').type);
    expect(strings(big)).toContain('123');
    const name = texts(big).find((o) => o.text.startsWith('MOUNT'))!;
    const runs = texts(big).find((o) => o.text === '123')!;
    const nameW = (runH(name.text.length) * name.size) / boardPanel('main').type.aspect;
    const runsW = (runH(3) * runs.size) / boardPanel('main').type.aspect;
    expect(name.x + nameW).toBeLessThan(runs.x - runsW);
  });

  it('the side columns carry two rows of numbers, and truncate the rest', () => {
    // ⚠ THE ROW BUDGET IS DERIVED AND THE OVERFLOW IS DROPPED ON PURPOSE. A
    // column that quietly stacked a fifth row would draw it off the bottom of the
    // panel, and a column that shrank to fit would draw it under the floor. Both
    // are worse than showing the two that matter.
    const pt = boardPanel('stats').type;
    expect(sideRowBudget(pt)).toBe(2);
    const many: BoardSide = {
      heading: 'SCORE',
      rows: [
        { label: 'A', value: '1' },
        { label: 'B', value: '2' },
        { label: 'C', value: '3' },
        { label: 'D', value: '4' },
      ],
    };
    const said = strings(boardArrayOps(arr(BATTER, { left: many }), 0));
    expect(said).toContain('A');
    expect(said).toContain('B');
    expect(said).not.toContain('C');
    // A heading that cannot fit is CUT WITH A MARK, never shrunk below the floor.
    const long = strings(boardArrayOps(arr(BATTER, { left: { heading: 'HARBOURFRONT', rows: [] } }), 0));
    expect(long.some((s) => s.endsWith(TRUNCATION_MARK))).toBe(true);
    expect(long).not.toContain('HARBOURFRONT');
    // Five digits DO fit — that is why the column is 18 ft and not 17.
    const five = strings(
      boardArrayOps(arr(BATTER, { left: { heading: 'SCORE', rows: [{ label: 'PTS', value: '99999' }] } }), 0),
    );
    expect(five).toContain('99999');
    expect(five).toContain('SCORE');
  });

  it('the strip is a GRID, and its columns are data', () => {
    const said = strings(boardArrayOps(arr(DUEL), 0));
    for (const s of ['1', '2', '3', 'R', 'H', 'E', 'ALPINE', 'HARBOUR']) expect(said).toContain(s);
    // A `null` cell is an inning not yet played and prints nothing at all.
    const cells = texts(boardArrayOps(arr(DUEL), 0)).filter(
      (o) => o.y > boardPanel('strip').rect.y && o.align === 'right',
    );
    expect(cells.length).toBe(6 + 2 * 5); // 6 headings + 5 printed numbers per row
    // Columns are ascending and never collide with the name.
    const xs = stripColumnX(DUEL_STRIP);
    expect(xs).toHaveLength(6);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(xs[xs.length - 1]).toBeLessThanOrEqual(1);
    // A derby strip is the SAME painter with different data — never a branch.
    const derby = strings(boardArrayOps(arr(BATTER, { strip: DERBY_STRIP }), 0));
    expect(derby).toContain('R1');
    expect(derby).toContain('2220');
    expect(stripColumnX(DERBY_STRIP)).toHaveLength(4);
  });

  it('a surface with nothing to say is DARK, not blank', () => {
    // An unlit panel is what a real array does between innings; a transparent one
    // is whatever the sky and the truss happen to be behind it.
    const ops = boardArrayOps(
      arr({ kind: 'idle', label: 'HOME RUN DERBY' }, { left: null, right: null, strip: null }),
      0,
    );
    for (const id of ['stats', 'pitcher', 'strip'] as const) {
      const r = boardPanel(id).rect;
      const covering = ops.filter(
        (o) => o.kind === 'panel' && o.x <= r.x + 1e-9 && o.w >= r.w - 1e-9 && o.h >= r.h - 1e-9,
      );
      expect(covering.length, id).toBeGreaterThan(0);
    }
  });

  it('every surface starts with an opaque full-bleed backdrop', () => {
    // ⚠ THE ONE THING NO OTHER ASSERTION HERE COULD SEE. Deleting the backdrop
    // failed ZERO tests before this one existed: the op-log length checks are
    // dominated by glyph strokes, and the emitter check counts panels out of the
    // same list it is verifying, so both stayed happily self-consistent over a
    // board with a transparent background.
    for (const state of ALL_STATES) {
      const ops = boardArrayOps(state, 4);
      // The architectural FRAME first, full bleed, behind everything.
      expect(ops[0], state.main.kind).toMatchObject({ kind: 'panel', x: 0, y: 0, w: 1, h: 1 });
      // Then every panel's own opaque ground, exactly covering its rect.
      for (const p of BOARD_PANELS) {
        const own = ops.find(
          (o) =>
            o.kind === 'panel' &&
            Math.abs(o.x - p.rect.x) < 1e-9 &&
            Math.abs(o.y - p.rect.y) < 1e-9 &&
            Math.abs(o.w - p.rect.w) < 1e-9 &&
            Math.abs(o.h - p.rect.h) < 1e-9,
        );
        expect(own, `${state.main.kind}/${p.id}`).toBeDefined();
      }
    }
    // ...and the LED scanline pattern: 32 full-width stripes in the main panel,
    // in order, none of them the background colour.
    const main = boardMainOps(BATTER, 0, boardPanel('main').type);
    const stripes = main.slice(1, 33);
    expect(stripes.every((o) => o.kind === 'panel' && o.w === 1 && o.x === 0)).toBe(true);
    expect(new Set(stripes.map((o) => (o as { color: string }).color)).size).toBe(1);
    expect((stripes[0] as { color: string }).color).not.toBe((main[0] as { color: string }).color);
    const ys = stripes.map((o) => (o as { y: number }).y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });

  it('every op stays inside its panel, and every panel inside the atlas', () => {
    for (const state of ALL_STATES) {
      for (const frame of FRAMES) {
        for (const op of boardArrayOps(state, frame)) {
          if (op.kind === 'panel') {
            expect(op.x).toBeGreaterThanOrEqual(-1e-9);
            expect(op.y).toBeGreaterThanOrEqual(-1e-9);
            expect(op.x + op.w).toBeLessThanOrEqual(1.0001);
            expect(op.y + op.h).toBeLessThanOrEqual(1.0001);
          } else if (op.kind === 'text') {
            expect(op.y + op.size, `${state.main.kind} "${op.text}"`).toBeLessThanOrEqual(1.0001);
            expect(op.y).toBeGreaterThanOrEqual(-1e-9);
          }
        }
      }
    }
  });

  it('NOTHING on ANY surface, in ANY state, is drawn below the legible floor', () => {
    // ⚠ THE DESIGN RULE, ENFORCED OVER THE WHOLE DOMAIN. This walk used to run
    // over a different fixture list than the overlap walk, and the four
    // violations that hid in the gap are named at the top of this file. One
    // domain now, both walks, every frame.
    //
    // In ATLAS space the per-panel floors collapse into a single number, because
    // an op's `size` is already a fraction of the array's own height — which is
    // the clearest possible statement that one absolute type scale is what the
    // camera actually imposes.
    const rows: string[] = [];
    let worst = { px: Infinity, what: '' };
    for (const state of ALL_STATES) {
      for (const frame of FRAMES) {
        for (const op of texts(boardArrayOps(state, frame))) {
          const px = boardLegibleCssPx(op.size);
          rows.push(`  ${px.toFixed(1).padStart(5)} px  ${state.main.kind.padEnd(12)} "${op.text}"`);
          if (px < worst.px) worst = { px, what: `${state.main.kind} "${op.text}"` };
          expect(px, `${state.main.kind} "${op.text}" at ${px.toFixed(2)} CSS px`).toBeGreaterThanOrEqual(
            MIN_LEGIBLE_CSS_PX - 1e-9,
          );
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — every text op, every surface, every state; floor ${MIN_LEGIBLE_CSS_PX} CSS px]\n` +
        [...new Set(rows)].sort().join('\n') +
        `\n  worst: ${worst.px.toFixed(2)} px — ${worst.what}\n`,
    );
    expect(rows.length).toBeGreaterThan(200);
    // The floor is REACHED, not merely respected — otherwise it is not a floor,
    // it is a number nothing is near and a mutation could move freely.
    expect(worst.px).toBeLessThan(MIN_LEGIBLE_CSS_PX + 0.5);
  });

  it('`fitRun` holds the floor and truncates, and never returns a negative size', () => {
    // ⚠ THE FOUR FIXTURES THAT SHIPPED UNDER THE FLOOR, as a direct unit check.
    const pt = panelType('t', 59, 29.5);
    for (const text of ['HARBOURFRONT', 'MOUNTAINSIDE', 'ALPINE MEADOWS', 'MAXIMILIAN LONGNAME']) {
      const run = fitRun(text, 0.3, 'title', pt);
      expect(run.size, text).toBeGreaterThanOrEqual(pt.floor - 1e-12);
      expect(run.text.endsWith(TRUNCATION_MARK), text).toBe(true);
      expect(run.text.length).toBeLessThan(text.length);
      // And the truncated run genuinely FITS the budget it was given.
      expect((runH(run.text.length) * run.size) / pt.aspect).toBeLessThanOrEqual(0.3 + 1e-9);
    }
    // A budget that fits leaves the text alone.
    expect(fitRun('428 FT', 0.9, 'body', pt)).toEqual({ text: '428 FT', size: pt.t('body') });
    // ⚠ A NEGATIVE BUDGET USED TO RETURN A NEGATIVE SIZE — a glyph drawn inside
    // out, which the old legibility walk would have flagged and the old overlap
    // walk would have called a zero-width box.
    expect(fitRun('X', -0.5, 'body', pt).size).toBeGreaterThan(0);
    expect(fitRun('X', -0.5, 'body', pt).text).toBe('');
    // ⚠ THE TEXT IS WHAT DISTINGUISHES THE GUARD, NOT THE SIZE, and a mutation
    // proved it: deleting the `isFinite && > 0` clamp still returns the floor for
    // a negative budget, because the truncation branch computes a negative cell
    // count and bails. A NaN budget is the case that separates them — the clamp
    // draws NOTHING, the unguarded version draws a bare truncation mark, i.e. a
    // glyph in a column that has no room for one.
    expect(fitRun('X', Number.NaN, 'body', pt).size).toBe(pt.floor);
    expect(fitRun('X', Number.NaN, 'body', pt).text).toBe('');
    expect(fitRun('LONGNAME', Number.NaN, 'body', pt).text).toBe('');
    expect(fitRun('LONGNAME', -1, 'body', pt).text).toBe('');
    expect(fitRun('LONGNAME', 0, 'body', pt).text).toBe('');
    // The empty string keeps the cap rather than dividing by zero.
    expect(fitRun('', 0.5, 'body', pt).size).toBe(pt.t('body'));
    // The five-character column: the exact inverse of `runH` is load-bearing.
    const col = panelType('c', 18, 29.5);
    expect(fitRun('99999', 0.98, 'body', col).text).toBe('99999');
    expect(fitRun('999999', 0.98, 'body', col).text).toBe(`9999${TRUNCATION_MARK}`);
  });
});

// ---------------------------------------------------------------------------
// The ribbons
// ---------------------------------------------------------------------------

describe('board ribbon', () => {
  it('tiles seamlessly, and the tile count is derived from the ring', () => {
    // ⚠ THE SEAM IS THE WHOLE PROBLEM WITH A WRAPPED TEXTURE. The band repeats
    // around the bowl, so if the advance grid does not divide the tile exactly
    // there is a visible stitch every 157 ft, all the way round. The type size is
    // therefore SOLVED from the cell count rather than chosen.
    expect(RIBBON_TYPE * RIBBON_CELLS * (GLYPH_W + GLYPH_TRACK)).toBeCloseTo(2048 / 64, 9);
    expect(ribbonTrain(['A', 'B'])).toHaveLength(RIBBON_CELLS);
    expect(ribbonTrain([])).toHaveLength(RIBBON_CELLS);
    expect(ribbonTrain(['HARBOURFRONT DOME'])).toHaveLength(RIBBON_CELLS);
    expect(ribbonTrain(['A', 'B'])).toContain('A');
    expect(ribbonTrain(['A', 'B'])).toContain('B');
    // ⚠ AND IT ENDS ON A WHOLE ITEM, WHICH A RENDER IS WHAT CAUGHT. Cutting to
    // length mid-word made the seam read `…HARBOHARBOURFRONT DOME`, twelve times
    // round the bowl — a defect that a length check passes with flying colours.
    for (const items of [
      ['HARBOURFRONT DOME', 'ROUND 2/3', '×1.50'],
      ['ALPINE HEIGHTS', 'TOP 3'],
      ['GONE!'],
    ]) {
      const tile = ribbonTrain(items);
      expect(tile).toHaveLength(RIBBON_CELLS);
      expect(tile.trimEnd().endsWith('·'), `"${tile}" ends mid-item`).toBe(true);
      // every item the tile shows at all, it shows WHOLE
      for (const item of items) {
        if (tile.includes(item.slice(0, 3))) expect(tile).toContain(item);
      }
    }
    // A single item wider than the whole tile is the one case that must cut —
    // and it says so with the mark rather than stopping in the middle of a word.
    const huge = ribbonTrain(['A'.repeat(RIBBON_CELLS + 20)]);
    expect(huge).toHaveLength(RIBBON_CELLS);
    expect(huge.endsWith(TRUNCATION_MARK)).toBe(true);
    // The wrap count is a function of the ring, never a constant.
    const g = BOARD_GEOMETRY;
    expect(ribbonWraps(g)).toBe(Math.round((2 * Math.PI * g.ribbonRadiusFt) / (32 * g.ribbonHeightFt)));
    expect(ribbonWraps({ ...g, ribbonRadiusFt: 600 })).toBe(2 * ribbonWraps(g));
  });

  it('is TEXT near the plate and LIGHT in centre field, and says which', () => {
    // ⚠ THE HONEST FINDING. A 5 ft band sets 3.5 ft of glyph. At the array's own
    // 430 ft that is 7.4 CSS px — under the floor — so the outfield ribbon cannot
    // carry a word, and pretending otherwise would put unreadable copy on the
    // largest lit surface in the stadium. Inside 325 ft it clears the floor, so
    // the bands down the lines and behind the plate DO carry the count and the
    // score. The sweep is what the far ones are for: light reads at any distance.
    const g = BOARD_GEOMETRY;
    const range = ribbonReadRangeFt(g);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — ribbon legibility, ${g.ribbonHeightFt} ft band, ` +
        `${(RIBBON_TYPE * g.ribbonHeightFt).toFixed(2)} ft of glyph]\n` +
        [120, 200, 260, 325, 400, 430]
          .map(
            (d) =>
              `  ${String(d).padStart(4)} ft  →  ${ribbonCssPxAt(g, d).toFixed(1).padStart(5)} CSS px  ` +
              `${ribbonCssPxAt(g, d) >= MIN_LEGIBLE_CSS_PX ? 'TEXT' : 'light'}`,
          )
          .join('\n') +
        `\n  crossover ${range.toFixed(0)} ft. A 4 ft band would put it at ` +
        `${ribbonReadRangeFt({ ...g, ribbonHeightFt: 4 }).toFixed(0)} ft, which is why the band is 5.\n`,
    );
    expect(range).toBeGreaterThan(300);
    expect(ribbonCssPxAt(g, 120)).toBeGreaterThan(MIN_LEGIBLE_CSS_PX);
    expect(ribbonCssPxAt(g, BOARD_REF.faceDistFt)).toBeLessThan(MIN_LEGIBLE_CSS_PX);
    expect(ribbonCssPxAt(g, range)).toBeCloseTo(MIN_LEGIBLE_CSS_PX, 3);
  });

  it('scrolls without uploading, and sweeps the ring during a home run', () => {
    // ⚠ THE SWEEP IS A QUANTISED OFFSET, WHICH IS WHAT MAKES IT DETERMINISTIC AND
    // FREE AT ONCE. Nothing is repainted to move the light: `texture.offset.x` is
    // a float assignment, so the scroll costs zero texel traffic, and the value
    // is a pure function of a quantised time so two runs of the harness agree.
    const g = BOARD_GEOMETRY;
    const idle = arr(BATTER);
    const hr = arr(HOMER);
    expect(ribbonOffsetU(idle, 0, g)).toBe(0);
    expect(ribbonOffsetU(idle, -1, g)).toBe(0);
    expect(ribbonOffsetU(idle, Number.NaN, g)).toBe(0);
    // Monotone within a wrap, and it MOVES.
    expect(ribbonOffsetU(idle, 1, g)).toBeLessThan(0);
    expect(ribbonOffsetU(idle, 2, g)).toBeLessThan(ribbonOffsetU(idle, 1, g));
    // Two times in one 60 Hz bucket give the same offset — the quantisation.
    expect(ribbonOffsetU(idle, 1.0, g)).toBe(ribbonOffsetU(idle, 1.0 + 0.9 / 60, g));
    expect(ribbonOffsetU(idle, 1.0, g)).not.toBe(ribbonOffsetU(idle, 1.0 + 1.1 / 60, g));
    // The celebration travels the whole ring in RIBBON_SWEEP_S: `wraps` units.
    expect(Math.abs(ribbonOffsetU(hr, RIBBON_SWEEP_S, g))).toBeCloseTo(0, 6);
    expect(Math.abs(ribbonOffsetU(hr, RIBBON_SWEEP_S / 2, g))).toBeCloseTo(ribbonWraps(g) / 2, 3);
    // ...and it is far faster than the reading scroll, which is the point.
    expect(Math.abs(ribbonOffsetU(hr, 0.5, g))).toBeGreaterThan(20 * Math.abs(ribbonOffsetU(idle, 0.5, g)));
  });

  it('the ribbon is keyed on its OWN content, not the board’s', () => {
    // A scrolling ribbon must not drag a 2.0 MB atlas upload along with it, and
    // a changed batter must not repaint a ribbon that says the same thing.
    const a = arr(BATTER);
    const b = arr({ ...BATTER, score: 9999 });
    expect(ribbonKey(a, 0)).toBe(ribbonKey(b, 0));
    expect(ribbonKey(a, 0)).not.toBe(ribbonKey(arr(BATTER, { ribbon: { items: ['X'] } }), 0));
    // During the moment it is keyed on the frame, so it animates with the board.
    expect(ribbonKey(arr(HOMER), 3)).not.toBe(ribbonKey(arr(HOMER), 4));
    expect(ribbonOps(arr(HOMER), 3)).not.toEqual(ribbonOps(arr(HOMER), 4));
    expect(strings(ribbonOps(arr(HOMER), 0)).join('')).toContain('GONE!');
    expect(strings(ribbonOps(a, 0)).join('')).toContain('HARBOURFRONT');
  });
});

// ---------------------------------------------------------------------------
// Time, and the state machine
// ---------------------------------------------------------------------------

describe('board animation', () => {
  it('only the home run animates, and it stops', () => {
    for (const state of ALL_STATES) {
      if (state.main.kind === 'homeRun') continue;
      expect(boardAnimFrame(state.main, 0)).toBe(0);
      expect(boardAnimFrame(state.main, 1.7)).toBe(0);
      expect(boardAnimFrame(state.main, 600)).toBe(0);
    }
    expect(boardAnimFrame(HOMER, 0)).toBe(0);
    expect(boardAnimFrame(HOMER, 1 / BOARD_ANIM_FPS)).toBe(1);
    expect(boardAnimFrame(HOMER, 1.0)).toBe(12);
    expect(boardAnimFrame(HOMER, BOARD_ANIM_END_S)).toBe(BOARD_ANIM_LAST_FRAME);
    expect(boardAnimFrame(HOMER, 60)).toBe(BOARD_ANIM_LAST_FRAME);
    expect(boardAnimFrame(HOMER, -3)).toBe(0);
    expect(boardAnimFrame(HOMER, Number.NaN)).toBe(0);
  });

  it('the distance counts UP and lands exactly on the sim number', () => {
    // ⚠ THE LANDING IS THE ASSERTION. A count-up whose easing does not reach 1
    // leaves the board reading 427 while the HUD reads 428, which is the worst
    // kind of bug in a display: quiet, and about the number the player came for.
    const shown = (frame: number) => mainStrings(HOMER, frame).find((s) => s.endsWith(' FT'))!;
    const seq = [0, 2, 4, 6, 8, 10, BOARD_ANIM_LAST_FRAME].map(shown);
    const nums = seq.map((s) => Number(s.replace(' FT', '')));
    // eslint-disable-next-line no-console
    console.log(`\n[BOARD — home-run count-up @ ${BOARD_ANIM_FPS} Hz]  ${seq.join('  →  ')}\n`);
    expect(countUp(BOARD_ANIM_LAST_FRAME)).toBe(1);
    expect(nums[0]).toBe(0);
    expect(nums.at(-1)).toBe(428);
    for (let i = 1; i < nums.length; i++) expect(nums[i]!).toBeGreaterThanOrEqual(nums[i - 1]!);
    expect(nums[1]).toBeGreaterThan(0);
    expect(nums[1]).toBeLessThan(428);
    expect(new Set(nums).size).toBeGreaterThanOrEqual(5);
  });

  it('the strobe alternates and then stops, on every surface at once', () => {
    const bg = (ops: BoardOp[], i: number) => (ops[i] as { color: string }).color;
    const mainBg = (frame: number) => bg(boardMainOps(HOMER, frame, boardPanel('main').type), 0);
    expect(mainBg(0)).toBe('#d7263d');
    expect(mainBg(3)).toBe('#08122b');
    expect(mainBg(5)).toBe('#d7263d');
    expect(mainBg(12)).toBe('#08122b');
    expect(mainBg(BOARD_ANIM_LAST_FRAME)).toBe('#08122b');
    // ⚠ IN STEP. The ribbon and the strip strobe on the same frames as the main
    // panel — a coordinated moment that goes out of phase is worse than none.
    for (const frame of [0, 3, 5, 12]) {
      expect(bg(ribbonOps(arr(HOMER), frame), 0), `ribbon @ ${frame}`).toBe(mainBg(frame));
    }
  });

  it('the same state and the same time produce the same draw sequence', () => {
    // ⚠ THE INVARIANT THE VISUAL GATE DEPENDS ON. `baseball-visual-qa` fails on
    // any pixel difference between two runs, so this is that claim expressed at
    // the level the module controls: identical inputs, identical ops, and
    // identical canvas calls all the way down to the coordinates.
    for (const state of ALL_STATES) {
      for (const frame of FRAMES) {
        expect(boardArrayOps(state, frame)).toEqual(boardArrayOps(state, frame));
        const a = recorder();
        const b = recorder();
        emitBoardOps(a, boardArrayOps(state, frame), 1024, 512);
        emitBoardOps(b, boardArrayOps(state, frame), 1024, 512);
        expect(a.log).toEqual(b.log);
        expect(a.log.length).toBeGreaterThan(100);
      }
    }
  });

  it('two times inside one frame bucket paint the same picture', () => {
    // ⚠ THE REASON THE PAINTERS TAKE A FRAME AND NOT A `tS`. The upload policy
    // skips a repaint when the frame is unchanged; if a painter read raw time it
    // would want to draw something different while the key said "identical".
    const inBucket = [0.5 / BOARD_ANIM_FPS, 0.99 / BOARD_ANIM_FPS];
    const frames = inBucket.map((t) => boardAnimFrame(HOMER, t));
    expect(new Set(frames).size).toBe(1);
    expect(boardArrayOps(arr(HOMER), frames[0]!)).toEqual(boardArrayOps(arr(HOMER), frames[1]!));
    expect(boardArrayOps(arr(HOMER), frames[0]!)).not.toEqual(boardArrayOps(arr(HOMER), frames[0]! + 1));
  });

  it('the key changes whenever ANY displayed value on ANY screen does', () => {
    // ⚠ TABLE-DRIVEN OVER EVERY SCREEN AND EVERY SCALAR FIELD, and the expected
    // key is NOT computed by calling the function under test. The old test walked
    // `derbyBatter`'s five fields only, so keying home runs on `chainX` alone and
    // the duel on `inning` alone passed it — two home runs of different distances
    // back to back, or a count going 2-1 → 3-1, would have left stale numbers on
    // the biggest surface in the park. That is verbatim the failure
    // `boardState.ts` says `JSON.stringify` "can never MISS".
    const mutate = (screen: BoardScreen, path: string[], v: unknown): BoardScreen => {
      const out = structuredClone(screen) as unknown as Record<string, unknown>;
      let cursor = out;
      for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string, unknown>;
      cursor[path[path.length - 1]!] =
        typeof v === 'number' ? v + 1 : typeof v === 'string' ? `${v}Z` : v === null ? 1 : !v;
      return out as unknown as BoardScreen;
    };
    const paths = (node: Record<string, unknown>, at: string[] = []): string[][] =>
      Object.entries(node).flatMap(([k, v]) =>
        k === 'kind'
          ? []
          : v !== null && typeof v === 'object'
            ? paths(v as Record<string, unknown>, [...at, k])
            : [[...at, k]],
      );

    // ⚠ THE KEY CLAUSE IS UNIVERSAL AND UNCONDITIONAL. Every scalar of every
    // screen must move the key, with no exceptions and no "unless" — a key that
    // misses a field is a board showing the last batter's numbers, and no layout
    // argument makes that acceptable.
    let checked = 0;
    const byKind = new Map<string, BoardScreen[]>();
    for (const s of ALL_STATES) byKind.set(s.main.kind, [...(byKind.get(s.main.kind) ?? []), s.main]);
    expect([...byKind.keys()].sort()).toEqual(
      ['derbyBatter', 'duelScore', 'homeRun', 'idle', 'result', 'roundSummary'].sort(),
    );
    for (const screens of byKind.values()) {
      for (const screen of screens) {
        for (const path of paths(screen as unknown as Record<string, unknown>)) {
          let cursor = screen as unknown as Record<string, unknown>;
          for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string, unknown>;
          checked++;
          expect(
            boardScreenKey(mutate(screen, path, cursor[path[path.length - 1]!])),
            `${screen.kind}.${path.join('.')} did not move the key`,
          ).not.toBe(boardScreenKey(screen));
        }
      }
    }

    // ⚠ THE PICTURE CLAUSE IS "SOMEWHERE IN THE DOMAIN", AND THAT WEAKENING IS
    // DELIBERATE RATHER THAN CONVENIENT. Some fields are hidden ON PURPOSE in
    // some states — `bestFt` is not drawn while a chain is live, because the
    // multiplier takes the column — so demanding a visible change in EVERY state
    // would force the board to contradict `swingCopy`'s own rule. What must hold
    // is that no field is DEAD: every scalar has to change the picture in at
    // least one state of its own kind, or it is a field the board never shows and
    // should not be carrying.
    const bare = (m: BoardScreen, f: number) =>
      JSON.stringify(
        boardArrayOps({ main: m, left: null, right: null, strip: null, ribbon: { items: [] } }, f),
      );
    const leaf = (screen: BoardScreen, path: string[]) => {
      let cursor = screen as unknown as Record<string, unknown>;
      for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string, unknown>;
      return cursor[path[path.length - 1]!];
    };
    const dead: string[] = [];
    for (const screens of byKind.values()) {
      const kind = screens[0]!.kind;
      for (const path of paths(screens[0]! as unknown as Record<string, unknown>)) {
        // ⚠ A CLOSED STRING UNION NEEDS A VALUE FROM ITS OWN DOMAIN. `half` is
        // `'top' | 'bot'` and the painter branches on `=== 'top'`, so the
        // synthetic `'bot' + 'Z'` paints an identical `B` and would have been
        // reported as dead. The candidates therefore include every value the
        // field actually takes anywhere in the fixture domain — which is also
        // why the domain carries both halves.
        const alts = new Set(ALL_STATES.filter((s) => s.main.kind === kind).map((s) => leaf(s.main, path)));
        const shows = screens.some((screen) =>
          FRAMES.some((f) => {
            const before = bare(screen, f);
            const here = leaf(screen, path);
            if (bare(mutate(screen, path, here), f) !== before) return true;
            return [...alts].some((alt) => {
              if (alt === here) return false;
              const swapped = structuredClone(screen) as unknown as Record<string, unknown>;
              let cursor = swapped;
              for (const step of path.slice(0, -1)) cursor = cursor[step] as Record<string, unknown>;
              cursor[path[path.length - 1]!] = alt;
              return bare(swapped as unknown as BoardScreen, f) !== before;
            });
          }),
        );
        if (!shows) dead.push(`${kind}.${path.join('.')}`);
      }
    }
    expect(dead, `fields the array never draws anywhere:\n${dead.join('\n')}`).toEqual([]);
    // eslint-disable-next-line no-console
    console.log(
      `\n[BOARD — key sensitivity] ${checked} scalar mutations across ${byKind.size} screens, 0 missed\n`,
    );
    expect(checked).toBeGreaterThan(40);

    // The whole ARRAY is keyed too — a changed column or strip cell repaints.
    const base = arr(BATTER);
    expect(boardArrayKey({ ...base, left: null })).not.toBe(boardArrayKey(base));
    expect(boardArrayKey({ ...base, strip: DERBY_STRIP })).not.toBe(boardArrayKey(base));
    expect(boardArrayKey({ ...base, ribbon: { items: ['X'] } })).not.toBe(boardArrayKey(base));
    expect(boardArrayKey({ ...base })).toBe(boardArrayKey(base));
  });

  it('sim jitter below the printed precision does NOT repaint', () => {
    // ⚠ THE OTHER HALF OF THE KEY, AND IT IS A REAL COST. `bestFt`, `chainX` and
    // `distFt` are floats off the sim and the HUD polls on an interval, so two
    // polls a frame apart hand in 428.4001 and 428.4002 — a different key, a full
    // 2.0 MB repaint, and a byte-identical picture. Rounding to the precision the
    // painters actually print is what closes it, and the painters read the SAME
    // rounded value so the "key moves whenever the picture does" invariant holds.
    expect(boardScreenKey({ ...HOMER, distFt: 428.4001 })).toBe(boardScreenKey({ ...HOMER, distFt: 428.4002 }));
    expect(boardScreenKey({ ...HOMER, evMph: 108.2 })).toBe(boardScreenKey({ ...HOMER, evMph: 108.4 }));
    expect(boardScreenKey({ ...BATTER, bestFt: 428.1 })).toBe(boardScreenKey({ ...BATTER, bestFt: 428.4 }));
    expect(boardScreenKey({ ...BATTER, chainX: 1.5001 })).toBe(boardScreenKey({ ...BATTER, chainX: 1.4999 }));
    // ...and a change ABOVE the precision still moves it.
    expect(boardScreenKey({ ...HOMER, distFt: 428.6 })).not.toBe(boardScreenKey({ ...HOMER, distFt: 428.4 }));
    expect(boardScreenKey({ ...BATTER, chainX: 1.51 })).not.toBe(boardScreenKey({ ...BATTER, chainX: 1.5 }));
    // The rounding is IDEMPOTENT and the painters see it.
    expect(normaliseScreen(normaliseScreen(HOMER))).toEqual(normaliseScreen(HOMER));
    expect(boardMainOps({ ...HOMER, distFt: 428.4001 }, 6, boardPanel('main').type)).toEqual(
      boardMainOps({ ...HOMER, distFt: 428.4002 }, 6, boardPanel('main').type),
    );
  });
});

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

describe('buildScoreboard', () => {
  it('sizes the canvases, the textures and the quads from one source', () => {
    const canvases: Array<ReturnType<typeof fakeCanvas>> = [];
    const make = () => {
      const c = fakeCanvas();
      canvases.push(c);
      return c;
    };
    const board = buildScoreboard({ createCanvas: make });
    expect(canvases[0]!.width).toBe(BOARD_TEXTURE_W);
    expect(canvases[0]!.height).toBe(BOARD_TEXTURE_H);
    expect(board.widthPx).toBe(BOARD_TEXTURE_W);
    expect(board.heightPx).toBe(BOARD_TEXTURE_H);
    expect(BOARD_TEXTURE_H).toBe(BOARD_TEXTURE_W / BOARD_ARRAY_ASPECT);
    expect(board.texture.image).toBe(canvases[0]);
    expect(board.ribbon.image).toBe(canvases[1]);
    expect(board.texture.generateMipmaps).toBe(false);
    // The ribbon is wrapped and tiled for the caller — one place to be wrong.
    expect(board.ribbon.repeat.x).toBe(ribbonWraps(BOARD_GEOMETRY));
    expect(board.ribbonWraps).toBe(ribbonWraps(BOARD_GEOMETRY));
    // The panel table is handed out so the scene can build the quads' UVs.
    expect(board.panels).toBe(BOARD_PANELS);
    board.dispose();
  });

  it('derives the height from the aspect, and refuses a contradiction', () => {
    // ⚠ ASPECT PLUMBING GOES UNASSERTED, AND THIS ONE DID. `widthPx` and
    // `heightPx` were independent options and the only other-size test used
    // 512×256 — the SAME 2:1 ratio — so swapping them inside the builder passed
    // the whole suite. A NON-2:1 pair is now exercised, and the height is derived.
    expect(buildScoreboard({ createCanvas: fakeCanvas, widthPx: 640 }).heightPx).toBe(320);
    expect(() => buildScoreboard({ createCanvas: fakeCanvas, widthPx: 512, heightPx: 200 })).toThrow(
      /contradicts widthPx/,
    );
    expect(() => buildScoreboard({ createCanvas: fakeCanvas, widthPx: 512, heightPx: 256 })).not.toThrow();

    // ⚠ AND THE ASPECT IS PROVED TO REACH THE PAINTER, which a size check alone
    // cannot do: the ops are compared against an INDEPENDENTLY computed picture,
    // so a swapped `widthPx / heightPx` inside the builder shows up as different
    // glyph sizes rather than as a differently-shaped canvas.
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    board.update(arr(BATTER), 0);
    expect(board.ops()).toEqual(boardArrayOps(arr(BATTER), 0));
    board.dispose();
  });

  it('throws rather than silently drawing nothing', () => {
    expect(() =>
      buildScoreboard({ createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }),
    ).toThrow(/2D context/);
  });

  it('uploads ONLY when the picture changes, per surface', () => {
    // ⚠ THE GPU BUDGET, AS A TEST. 1024×512 RGBA is 2.0 MB per upload. The
    // charter gives this array one draw call; the cost that actually bites is
    // texel traffic, so "called every frame, uploads on change" is the property.
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    expect(board.current()).toBeNull();

    // ⚠ `texture.version` IS THE UPLOAD, `uploads()` IS ONLY THIS MODULE'S COUNT
    // OF IT. Asserting the counter alone is self-referential — deleting
    // `texture.needsUpdate = true` altogether leaves the counter perfectly
    // correct and the board frozen on its first frame. `three` increments
    // `version` in the `needsUpdate` setter, so reading it back reads THREE's
    // state, not ours.
    const v0 = board.texture.version;
    expect(board.update(arr(BATTER), 0)).toBe(true);
    expect(board.uploads()).toBe(1);
    expect(board.ribbonUploads()).toBe(1);
    expect(board.texture.version).toBeGreaterThan(v0);
    expect(board.ribbon.version).toBeGreaterThan(v0);

    // 120 frames of a HUD polling the same state: no further texel traffic at
    // all — though the ribbon has still been SCROLLING the whole time.
    const v1 = board.texture.version;
    for (let i = 0; i < 120; i++) board.update(arr(BATTER), i / 60);
    expect(board.uploads()).toBe(1);
    expect(board.ribbonUploads()).toBe(1);
    expect(board.texture.version).toBe(v1);
    expect(board.ribbon.offset.x).not.toBe(0);

    // A changed number is a changed picture — on the atlas only.
    expect(board.update(arr({ ...BATTER, score: 1300 }), 2)).toBe(true);
    expect(board.uploads()).toBe(2);
    expect(board.ribbonUploads()).toBe(1);
    board.dispose();
  });

  it('the celebration uploads at the animation rate and then stops', () => {
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    for (let i = 0; i <= 240; i++) board.update(arr(HOMER), i / 60);
    expect(board.uploads()).toBe(BOARD_ANIM_LAST_FRAME + 1);
    expect(board.ribbonUploads()).toBe(BOARD_ANIM_LAST_FRAME + 1);
    expect(board.current()).toMatchObject({ frame: BOARD_ANIM_LAST_FRAME });
    // ⚠ AND THE TAIL IS FREE. Everything after `BOARD_ANIM_END_S` is the same
    // picture, so a celebration left on screen — or a FROZEN harness clock —
    // costs nothing at all.
    const settled = board.uploads();
    for (let i = 0; i < 300; i++) board.update(arr(HOMER), 10 + i / 60);
    expect(board.uploads()).toBe(settled);
    board.dispose();
  });

  it('a frozen clock repaints once and never again', () => {
    // This is exactly what `lib/scene3d/clock.ts` does to the scene under the
    // screenshot harness: `tickSceneClock` returns the same value every frame.
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    for (let i = 0; i < 50; i++) board.update(arr(HOMER), 0.5);
    expect(board.uploads()).toBe(1);
    expect(board.ribbonUploads()).toBe(1);
    board.dispose();
  });

  it('rasterises the painted ops into the canvas, and uses no text API', () => {
    const canvases: Array<ReturnType<typeof fakeCanvas>> = [];
    const board = buildScoreboard({
      createCanvas: () => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      },
    });
    board.update(arr(BATTER), 0);
    const log = canvases[0]!.g.log;
    expect(log[0]!.op).toBe('clearRect');
    expect(log[0]!.args).toEqual([0, 0, BOARD_TEXTURE_W, BOARD_TEXTURE_H]);
    const panels = board.ops().filter((o) => o.kind === 'panel').length;
    expect(log.filter((r) => r.op === 'fillRect')).toHaveLength(panels);
    const glyphs = board
      .ops()
      .filter((o): o is Extract<BoardOp, { kind: 'text' }> => o.kind === 'text')
      .reduce((n, o) => n + [...o.text].filter((c) => c !== ' ').length, 0);
    expect(log.filter((r) => r.op === 'stroke')).toHaveLength(glyphs);
    expect(log.filter((r) => r.op === 'stroke').every((r) => r.lineCap === 'round')).toBe(true);
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

  it('a low tier is the SAME picture, only smaller', () => {
    // Ops are fractional, so a low tier is a resolution change and not a second
    // layout — and `quality` now actually REACHES the board, which was documented
    // and not plumbed.
    const big = buildScoreboard({ createCanvas: fakeCanvas });
    const small = buildScoreboard({ createCanvas: fakeCanvas, quality: { tier: 'low' } });
    big.update(arr(BATTER), 0);
    small.update(arr(BATTER), 0);
    expect(small.ops()).toEqual(big.ops());
    expect(small.ribbonOps()).toEqual(big.ribbonOps());
    expect(small.widthPx).toBe(BOARD_TEXTURE_W / 2);
    expect(small.heightPx).toBe(BOARD_TEXTURE_H / 2);
    big.dispose();
    small.dispose();
  });

  it('registers with the composer’s disposal path, and disposal LATCHES', () => {
    // ⚠ TWO GAPS IN ONE TEST. `track()` was never taken, so the composer's
    // teardown could not see the textures; and `dispose()` did not latch, so a
    // render loop that outlived the unmount would repaint into a disposed
    // texture and cheerfully report an upload.
    const tracked: unknown[] = [];
    const board = buildScoreboard({
      createCanvas: fakeCanvas,
      track: (<T>(r: T) => {
        tracked.push(r);
        return r;
      }) as never,
    });
    expect(tracked).toEqual([board.texture, board.ribbon]);
    board.update(arr(BATTER), 0);
    expect(board.uploads()).toBe(1);
    board.dispose();
    expect(board.update(arr(HOMER), 1)).toBe(false);
    expect(board.uploads()).toBe(1);
  });

  it('hands out a COPY of the op list', () => {
    // `ops()` returned the module's own array; a caller that sorted or spliced it
    // would be editing what the board believes it painted.
    const board = buildScoreboard({ createCanvas: fakeCanvas });
    board.update(arr(BATTER), 0);
    const a = board.ops();
    expect(a).not.toBe(board.ops());
    a.length = 0;
    expect(board.ops().length).toBeGreaterThan(0);
    board.dispose();
  });
});

// ---------------------------------------------------------------------------
// Determinism, as a source guard
// ---------------------------------------------------------------------------

describe('board determinism guard', () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const read = (n: string) => readFileSync(join(HERE, n), 'utf8');
  const isComment = (line: string) => /^\s*(\/\/|\/\*|\*)/.test(line);

  /**
   * ⚠ THE SOURCE SET IS DISCOVERED, NOT LISTED, AND THAT WAS A REAL HOLE. Both
   * guards below hard-coded four filenames while both module headers said "a
   * seventh screen lands here" — so a FIFTH file containing
   * `g.font = '48px Impact'; g.fillText(...); Date.now()`, imported from
   * `boardScreens.ts`, passed all 34 tests. The array shipped three more files,
   * which is exactly the growth the old list could not see.
   */
  const SOURCES = readdirSync(HERE)
    .filter((n) => /^(board.*|scoreboard)\.ts$/.test(n) && !n.endsWith('.test.ts'))
    .sort();

  it('discovers every board source, and knows the ones it expects', () => {
    for (const known of [
      'boardAtlas.ts',
      'boardGlyphs.ts',
      'boardPaint.ts',
      'boardPanels.ts',
      'boardRibbon.ts',
      'boardScreens.ts',
      'boardState.ts',
      'scoreboard.ts',
    ]) {
      expect(SOURCES, `${known} was not discovered — the glob is broken`).toContain(known);
    }
    expect(SOURCES).not.toContain('scoreboard.test.ts');
    expect(SOURCES.length).toBeGreaterThanOrEqual(8);
    // eslint-disable-next-line no-console
    console.log(`\n[BOARD — source guard scans] ${SOURCES.join(' ')}\n`);
  });

  it('reads no clock and no RNG', () => {
    // ⚠ STRICTER THAN `determinism.test.ts` IS FOR THE SCENE, ON PURPOSE. That
    // guard lets the render layer keep a wall clock, because a rAF loop is how a
    // frame loop works. These modules are not a loop: they take `tS` as an
    // argument precisely so the harness's frozen `lib/scene3d/clock.ts` can
    // control them, and one `performance.now()` in here would put the array's
    // animation back on the machine's clock where two runs differ.
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
    expect(read('scoreboard.ts').length).toBeGreaterThan(500);
  });

  it('never rasterises a system font', () => {
    // ⚠ THE MEASURED RISK, WRITTEN AS A GUARD. In this container's headless
    // Chromium, `Impact`, `Verdana`, `Tahoma`, `Roboto`, `Georgia` and
    // `Trebuchet MS` are all MISSING and substituted silently, `Arial` resolves
    // to Liberation Sans and `system-ui` to DejaVu Sans, and
    // `document.fonts.check()` answered TRUE for a family that does not exist —
    // so nothing at runtime can detect the substitution.
    //
    // ⚠ WHAT THAT MEASUREMENT WAS: a ONE-OFF. Three browser launches, the canvas
    // call log replayed against a real 2D context and the PNG hashed to the same
    // 16-hex-character digest each time. That replay is NOT committed and is NOT
    // a standing guard — nothing in `scripts/` re-runs it, so it cannot regress
    // and must not be cited as though it could. THIS scan is the standing guard.
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

/**
 * The glyph table's golden digest.
 *
 * ⚠ CHANGING A GLYPH CHANGES THIS NUMBER, AND THAT IS THE POINT. Update it only
 * together with a render you have looked at: the digest cannot tell a better `S`
 * from an upside-down one, it can only tell you that the table is not the table
 * the last render was taken of.
 */
const GLYPH_TABLE_HASH = '159f209c';
