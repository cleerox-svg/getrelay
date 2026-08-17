// The array's OTHER surfaces — the two narrow side columns and the wide
// linescore strip — plus the home-run moment that takes all of them over.
//
// ⚠ ONE PAINTER FOR BOTH COLUMNS. The left stats column and the right pitcher
// panel are the same rectangle with different content, so they are the same
// function with different data. A second painter would be a fork with no reason
// to exist (charter rule 3).
//
// ⚠ THE COLUMNS CARRY NUMBERS, AND THAT IS GEOMETRY, NOT TASTE. An 18 ft-wide
// panel 430 ft from the plate carries **five characters** at the legibility
// floor — `boardAtlas`'s printed table measures it. So a column row is a short
// CAPTION over a NUMBER (`PTS` / `+380`, `EV` / `108`), a heading is ≤ 5
// characters, and anything longer is truncated with a visible mark by `fitRun`
// rather than shrunk below the floor. That is exactly what the reference
// photograph shows in the narrow columns: numbers, not prose.
//
// ⚠ THE STRIP IS DENSE BECAUSE IT IS WIDE AND SHORT. 98 × 17 ft gives it only
// 3.7 rows but 26 characters, so it takes the tabular content — three inning
// columns plus R/H/E for the duel, three rounds plus a total for the derby —
// which is precisely the content that could never fit on a single-rectangle
// board. Columns are DATA (`BoardStrip.columns`), never a branch.

import type { BoardOp } from './boardPaint';
import { DIM, GOLD, INK, PANEL, RED, RULE, WHITE, backdrop, fitRun, int, stack, stackH } from './boardPaint';
import type { PanelType } from './boardPaint';
import type { BoardScreen, BoardSide, BoardStrip } from './boardState';
import { chevrons, strobeOn } from './boardScreens';

/**
 * Side column datums, fractions of panel height and width.
 *
 * ⚠ `SIDE_W = 0.98` IS NOT GENEROSITY, IT IS THE FIVE-DIGIT SCORE. At the floor
 * a five-cell run is 17.57 ft of the column's 18, i.e. 0.976 of its width, so a
 * 0.96 budget would truncate `99999` to `999…`. And `SIDE_TOP` / `SIDE_GAP` are
 * the tightest pair that still fits TWO rows under the heading without their ink
 * touching — the overlap walk found the first attempt at both.
 */
const SIDE_X = 0.5;
const SIDE_W = 0.98;
const SIDE_HEAD_Y = 0.02;
const SIDE_TOP = 0.2;
/** Vertical gap between two stacked rows, fraction of panel height. */
const SIDE_GAP = 0.04;

/**
 * How many caption/value rows a side column can carry, DERIVED from the panel's
 * own type scale rather than chosen.
 *
 * A row is `label + LEAD + body`; the budget is what fits between `SIDE_TOP` and
 * the bottom edge. At the reference geometry this is **2**, and a caller that
 * hands in five rows gets the first two and a test that says so — a silently
 * dropped row and a silently unreadable one are the same defect.
 */
export function sideRowBudget(pt: PanelType): number {
  return Math.max(1, Math.floor((1 - SIDE_TOP + SIDE_GAP) / (stackH(pt) + SIDE_GAP)));
}

export function sideOps(side: BoardSide, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  const head = fitRun(side.heading, SIDE_W, 'label', pt);
  ops.push({ kind: 'text', text: head.text, x: SIDE_X, y: SIDE_HEAD_Y, size: head.size, align: 'centre', color: GOLD });
  // The rule sits BETWEEN the heading and the first row, not under the row: at
  // +0.035 it landed at 0.211 against a first row starting at 0.20 and struck
  // straight through the caption. A render found it; the arithmetic is
  // `SIDE_HEAD_Y + head + gap < SIDE_TOP`.
  ops.push({ kind: 'panel', x: 0.06, y: SIDE_HEAD_Y + head.size + 0.01, w: 0.88, h: 0.012, color: RULE });

  let y = SIDE_TOP;
  for (const row of side.rows.slice(0, sideRowBudget(pt))) {
    const s = stack({ label: row.label, value: row.value, x: SIDE_X, y, w: SIDE_W, align: 'centre', pt });
    ops.push(...s.ops);
    y += s.h + SIDE_GAP;
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The linescore strip
// ---------------------------------------------------------------------------

/** Strip margins and the name column's width budget, fractions of strip width. */
const STRIP_L = 0.012;
const STRIP_R = 0.988;
const NAME_W = 0.3;
const STRIP_GAP = 0.012;

/**
 * The three row datums, fractions of strip height.
 *
 * ⚠ THE WHOLE STRIP SETS AT THE FLOOR, AND THAT IS ARITHMETIC. Three rows —
 * headings and two teams — at `body` (5.5 ft) plus the round-cap ink between
 * them needs 16.97 ft of the strip's 17, i.e. no margin at all top or bottom,
 * and the overlap walk caught the first attempt with the two team rows' ink
 * touching. At `label` (4.6 ft) the same three rows take 15.0 ft and leave 2 ft
 * of margin. A line score is the smallest type on a real board for exactly this
 * reason; the alternative was a taller strip taken out of the main panel, which
 * is already the binding surface.
 */
const STRIP_ROW_Y = [0.03, 0.35, 0.67];

/**
 * Where each column's RIGHT edge sits, fraction of strip width. Equal slots
 * across whatever is left after the name column, with the totals block pushed
 * one gap clear of the innings so `R H E` reads as a separate group.
 */
export function stripColumnX(strip: BoardStrip): number[] {
  const n = strip.columns.length + strip.totals.length;
  const x0 = STRIP_L + NAME_W + STRIP_GAP;
  const span = STRIP_R - x0 - STRIP_GAP;
  const slot = span / Math.max(1, n);
  return Array.from({ length: n }, (_, i) => {
    const extra = i >= strip.columns.length ? STRIP_GAP : 0;
    return x0 + (i + 1) * slot + extra;
  });
}

export function stripOps(strip: BoardStrip, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  const xs = stripColumnX(strip);
  const heads = [...strip.columns, ...strip.totals];

  heads.forEach((h, i) => {
    const run = fitRun(h, 0.09, 'label', pt);
    ops.push({
      kind: 'text',
      text: run.text,
      x: xs[i]!,
      y: STRIP_ROW_Y[0]!,
      size: run.size,
      align: 'right',
      color: i < strip.columns.length ? DIM : GOLD,
    });
  });

  // A rule between the innings and the totals block, and a floor under the
  // headings — the two lines that make a grid read as a grid.
  const ruleX = xs[strip.columns.length - 1] ?? STRIP_L;
  ops.push({ kind: 'panel', x: STRIP_L, y: 0.31, w: STRIP_R - STRIP_L, h: 0.012, color: RULE });
  if (strip.totals.length > 0) {
    ops.push({ kind: 'panel', x: ruleX + STRIP_GAP, y: 0.02, w: 0.004, h: 0.95, color: PANEL });
  }

  strip.rows.slice(0, 2).forEach((row, r) => {
    const y = STRIP_ROW_Y[r + 1]!;
    const name = fitRun(row.name, NAME_W, 'label', pt);
    ops.push({ kind: 'text', text: name.text, x: STRIP_L, y, size: name.size, align: 'left', color: WHITE });
    [...row.cells, ...row.totals].forEach((v, i) => {
      if (v === null || xs[i] === undefined) return;
      ops.push({
        kind: 'text',
        text: int(v),
        x: xs[i]!,
        y,
        size: pt.t('label'),
        align: 'right',
        color: i < row.cells.length ? WHITE : GOLD,
      });
    });
  });
  return ops;
}

// ---------------------------------------------------------------------------
// The home-run moment — the whole array, at one frame
// ---------------------------------------------------------------------------

/**
 * ⚠ THE SIDE COLUMNS DURING A HOME RUN ARE DERIVED FROM THE SCREEN, NOT FROM
 * THE CALLER. The main panel cannot carry the distance, the exit velocity, the
 * launch angle and the payout at once — four rows do not fit in 29.5 ft at this
 * type scale, measured — so the moment SPREADS across the array: `GONE!` and
 * the counting distance in the middle, the payout on the left, the ball's
 * numbers on the right, a chevron chase on the strip, light sweeping the ribbons.
 *
 * Deriving them here rather than asking the caller is what makes that
 * simultaneity guaranteed instead of hoped for: there is no call site that can
 * forget to switch the columns over, and the whole array is a pure function of
 * one `homeRun` screen and one integer frame.
 */
export function celebrationSides(s: Extract<BoardScreen, { kind: 'homeRun' }>): {
  left: BoardSide;
  right: BoardSide;
} {
  const left: BoardSide = {
    heading: 'PTS',
    rows: [
      { label: 'THIS', value: `+${int(s.points)}` },
      ...(s.chainX !== null && s.chainX > 1
        ? [{ label: 'CHAIN', value: `×${s.chainX.toFixed(2)}` }]
        : []),
    ],
  };
  const right: BoardSide = {
    heading: 'BALL',
    rows: [
      { label: 'EV', value: int(s.evMph) },
      { label: 'LA', value: `${int(s.laDeg)}°` },
    ],
  };
  return { left, right };
}

/**
 * What a column says when the caller has not said anything.
 *
 * ⚠ THIS IS WHERE THE DERBY'S SCORE LIVES, AND MOVING IT HERE IS THE ARRAY'S
 * WHOLE ARGUMENT. The main panel is 59 × 29.5 ft: `ROUND 2/3` and a five-digit
 * score do not fit on one row (59.6 ft of type in a 59 ft panel, measured), and
 * dropping the score to `label` size would set the derby's headline number in
 * the smallest type on the board. A stats column beside the screen is exactly
 * what the reference photograph puts there, and it carries five characters —
 * which is a five-digit score, precisely.
 *
 * Deriving it rather than requiring it means `score` is never dead data and a
 * caller that passes `left: null` still sees the number it is playing for.
 */
export function defaultSides(main: BoardScreen): { left: BoardSide | null; right: BoardSide | null } {
  if (main.kind === 'derbyBatter') {
    return { left: { heading: 'SCORE', rows: [{ label: 'PTS', value: int(main.score) }] }, right: null };
  }
  if (main.kind === 'roundSummary') {
    return {
      // ⚠ FIVE CHARACTERS, INCLUDING THE HEADING. `HOMERS` is six and truncates
      // to `HOME…` in an 18 ft column — which the test caught, and which is the
      // budget doing exactly what it is for.
      left: { heading: 'HOMER', rows: [{ label: 'THIS', value: int(main.homeRuns) }] },
      right: { heading: 'LONG', rows: [{ label: 'FT', value: int(main.bestFt) }] },
    };
  }
  return { left: null, right: null };
}

/** The strip during the moment: a chase, and the two words. */
export function celebrationStripOps(frame: number, pt: PanelType): BoardOp[] {
  const strobe = strobeOn(frame);
  const ops = backdrop(strobe ? RED : INK);
  ops.push(...chevrons(frame, 0.0, 0.16, strobe ? WHITE : RULE, 0.05));
  ops.push(...chevrons(frame, 0.84, 0.16, strobe ? WHITE : RULE, 0.05));
  const run = fitRun('HOME RUN', 0.6, 'title', pt);
  ops.push({ kind: 'text', text: run.text, x: 0.5, y: 0.3, size: run.size, align: 'centre', color: GOLD });
  return ops;
}

/** A side column painted in celebration colours — same painter, red backdrop. */
export function celebrationSideOps(side: BoardSide, frame: number, pt: PanelType): BoardOp[] {
  const ops = sideOps(side, pt);
  if (strobeOn(frame)) ops[0] = { kind: 'panel', x: 0, y: 0, w: 1, h: 1, color: RED };
  return ops;
}
