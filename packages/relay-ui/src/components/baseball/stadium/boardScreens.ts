// The MAIN PANEL's six screens — the big central video panel of the array.
//
// ⚠ EXTRACTED FROM `boardPaint.ts` AT THE 500-LINE BUILDER CAP — extraction, not
// a raised cap. The seam: `boardPaint.ts` is the KIT, this file is what is drawn
// with it in the CENTRE panel, `boardPanels.ts` is what is drawn in the narrow
// columns and the strip, and `boardAtlas.ts` places all four.
//
// ⚠ EVERY LAYOUT HERE WAS RE-DERIVED FOR THE PANEL, NOT INHERITED FROM THE
// RECTANGLE. The old board was one 100 × 50 ft screen; the main panel is
// 60 × 29.5 ft, so it is **40 % narrower and 41 % shorter**, and a fraction that
// used to be a title is now nearly a hero. The type scale is in FEET
// (`TYPE_FT`) and the panel divides by its own height, which is what makes that
// re-derivation automatic instead of a hand-tuned second table.
//
// ⚠ AND THE ROW BUDGET IS NOW A MEASURED NUMBER, WHICH CHANGED THE CARD. At the
// legibility floor a 60 ft-wide panel carries **16 characters**, so
// `PITCH 7/27` and `LONG 428 FT` cannot share a row — 21 characters plus a
// gutter is simply wider than the panel. The batter card's bottom band is
// therefore a CAPTION-OVER-VALUE pair per column (`PITCH`/`7/27`,
// `LONG`/`428 FT`), which is the same `stack()` idiom the narrow columns use and
// fits inside the budget with 0.19 of the width to spare. This is what the
// array bought: the facts that no longer fit here have their own surfaces —
// the score, the round's homers and the ball's numbers all moved to columns.
//
// Every function is pure `(screen, frame, pt) => BoardOp[]`. No canvas, no
// `three`, no clock, no gameplay.

import type { BoardOp } from './boardPaint';
import {
  BOARD_ANIM_FPS,
  DIM,
  GOLD,
  GUTTER,
  INK,
  PANEL,
  RED,
  RULE,
  TONE_COLOR,
  WHITE,
  backdrop,
  fitRun,
  int,
  runW,
  stack,
} from './boardPaint';
import type { PanelType } from './boardPaint';
import type { BoardScreen } from './boardState';

/** How long the home-run strobe alternates for, s. Feel knob. */
export const FLASH_S = 0.9;
/** Strobe half-period, s. 2.5 Hz — an alternation, deliberately not a flicker. */
export const STROBE_S = 0.2;
/** How long the distance counts up, s. Feel knob. */
const COUNT_S = 0.8;
/** Chevron sweeps per second. Feel knob. */
export const CHEVRON_HZ = 0.9;

/** Padding inside the chain badge — width units and height units. */
const BADGE_PAD_X = 0.016;
const BADGE_PAD_Y = 0.024;

/** Left and right text margins, fractions of panel width. */
const L = 0.045;
const R = 0.955;
const SPAN = R - L;

/**
 * Split a `describeSwing` line into board rows on ITS OWN separators.
 *
 * ⚠ THE EM DASH IS A BREAK TOO, AND A RENDER IS WHAT PROVED IT. Splitting on
 * ` · ` alone left `Off the wall — 395 ft` as one 21-character row, which a
 * 60 ft panel cannot set above the floor: it truncated to `OFF THE WALL…` and
 * threw away the distance — the one number the player is looking for. Both
 * separators are `describeSwing`'s own punctuation, so this is a re-WRAP of the
 * HUD's line and not a second vocabulary; the words are still verbatim.
 */
export function boardResultRows(line: string): string[] {
  return line
    .split(/ · | — /)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** True when a chain multiplier is EARNING and therefore worth showing. */
export const chainLive = (x: number | null): x is number => x !== null && x > 1;

function idleOps(label: string, pt: PanelType): BoardOp[] {
  const run = fitRun(label, 0.86, 'title', pt);
  return [
    ...backdrop(INK),
    { kind: 'panel', x: 0, y: 0.06, w: 1, h: 0.02, color: RULE },
    { kind: 'text', text: run.text, x: 0.5, y: 0.42, size: run.size, align: 'centre', color: DIM },
  ];
}

function derbyBatterOps(s: Extract<BoardScreen, { kind: 'derbyBatter' }>, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });

  // The name gets the whole width — the score moved to the left column, which is
  // what a stats column is FOR, and what the reference photograph shows.
  const name = fitRun(s.batter, SPAN, 'title', pt);
  ops.push({ kind: 'text', text: name.text, x: L, y: 0.1, size: name.size, align: 'left', color: WHITE });

  const round = fitRun(`ROUND ${int(s.round)}/${int(s.rounds)}`, SPAN, 'body', pt);
  ops.push({ kind: 'text', text: round.text, x: L, y: 0.4, size: round.size, align: 'left', color: DIM });

  // ⚠ THE BAND IS TWO CAPTION/VALUE STACKS, AND IT USED TO BE THREE PLAIN ROWS
  // that did not fit — `PITCH 7/27`, `LONG 428 FT` and a `×1.50` badge total
  // 1.24 panel widths, and a render showed the badge painted straight over the
  // word LONG. When a chain is live it is the more urgent of the two facts, so
  // it TAKES the right column rather than sharing it. (`swingCopy`'s rule that
  // the multiplier shows only while it is earning is what makes that swap safe.)
  ops.push({ kind: 'panel', x: 0, y: 0.6, w: 1, h: 0.4, color: PANEL });
  const colW = (SPAN - GUTTER) / 2;
  ops.push(
    ...stack({ label: 'PITCH', value: `${int(s.pitch)}/${int(s.pitches)}`, x: L, y: 0.66, w: colW, align: 'left', pt }).ops,
  );

  if (chainLive(s.chainX)) {
    const badge = stack({
      label: 'CHAIN',
      value: `×${s.chainX.toFixed(2)}`,
      x: R - BADGE_PAD_X,
      y: 0.66,
      w: colW - 2 * BADGE_PAD_X,
      align: 'right',
      pt,
      labelColor: WHITE,
    });
    const w = Math.max(...badge.ops.map((o) => (o.kind === 'text' ? runW(o.text, o.size, pt.aspect) : 0)));
    ops.push({
      kind: 'panel',
      x: R - w - 2 * BADGE_PAD_X,
      y: 0.66 - BADGE_PAD_Y,
      w: w + 2 * BADGE_PAD_X,
      h: badge.h + 2 * BADGE_PAD_Y,
      color: RED,
    });
    ops.push(...badge.ops);
  } else if (s.bestFt !== null) {
    ops.push(
      ...stack({ label: 'LONG', value: `${int(s.bestFt)} FT`, x: R, y: 0.66, w: colW, align: 'right', pt, color: GOLD }).ops,
    );
  }
  return ops;
}

function resultOps(s: Extract<BoardScreen, { kind: 'result' }>, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  const accent = TONE_COLOR[s.tone] ?? RULE;
  ops.push({ kind: 'panel', x: 0, y: 0.1, w: 1, h: 0.035, color: accent });
  // ⚠ EACH ROW IS SIZED ON ITS OWN, and the first version sized them all to the
  // SMALLEST. That is what a text engine does and it is wrong for a scoreboard:
  // "Off the wall — 395 ft · +40" set that way drew the payout — three
  // characters with a whole panel to live in — at the 21-character line's size.
  // The rows are independent facts, so the short one gets to shout.
  // 0.98, not 0.9: a result row is the ONLY thing on this panel, so it gets the
  // whole panel. At 0.9 the sixteen-character whiff line lost a character.
  const runs = boardResultRows(s.line).map((r) => fitRun(r, 0.98, 'title', pt));
  const gap = 0.05;
  const total = runs.reduce((a, b) => a + b.size, 0) + gap * (runs.length - 1);
  let y = 0.5 - total / 2;
  runs.forEach((run, i) => {
    ops.push({
      kind: 'text',
      text: run.text,
      x: 0.5,
      y,
      size: run.size,
      align: 'centre',
      color: i === 0 ? WHITE : accent,
    });
    y += run.size + gap;
  });
  return ops;
}

/** A sweeping chevron band — the moving furniture of the home-run moment. */
export function chevrons(frame: number, y: number, h: number, color: string, pitch = 0.16): BoardOp[] {
  const t = frame / BOARD_ANIM_FPS;
  const phase = (t * CHEVRON_HZ) % 1;
  const ops: BoardOp[] = [];
  const wide = pitch * 0.375;
  const skew = pitch * 0.1875;
  for (let i = -1; i < Math.ceil(1 / pitch) + 1; i++) {
    const x = (i + phase) * pitch;
    ops.push({ kind: 'poly', pts: [x, y, x + wide, y, x + wide - skew, y + h, x - skew, y + h], color });
  }
  return ops;
}

/**
 * The word the home-run screen leads with.
 *
 * ⚠ IT IS ASSERTED AGAINST `swingCopy.describeSwing`'s OWN OUTPUT — by EQUALITY
 * with its first word, not by `startsWith`. `startsWith` let `GONE!` → `GONE!!`
 * pass all 34 tests, which is two surfaces saying different things about one
 * event: exactly the "second vocabulary" the charter forbids.
 */
export const HOME_RUN_WORD = 'GONE!';

/** The count-up's eased fraction at a frame. `ease(1) === 1`, exactly. */
export function countUp(frame: number): number {
  const u = Math.min(1, Math.max(0, frame / BOARD_ANIM_FPS / COUNT_S));
  return u * u * (3 - 2 * u);
}

/** True while the home-run strobe is inverting the backdrop. */
export const strobeOn = (frame: number) => {
  const t = frame / BOARD_ANIM_FPS;
  return t < FLASH_S && Math.floor(t / STROBE_S) % 2 === 0;
};

function homeRunOps(s: Extract<BoardScreen, { kind: 'homeRun' }>, frame: number, pt: PanelType): BoardOp[] {
  const strobe = strobeOn(frame);
  const ops = backdrop(strobe ? RED : INK);
  ops.push(...chevrons(frame, 0.0, 0.06, strobe ? WHITE : RULE));
  ops.push(...chevrons(frame, 0.94, 0.06, strobe ? WHITE : RULE));

  // ⚠ 0.09 / 0.48, AND A RENDER MOVED BOTH. At 0.12 / 0.45 the `!`'s lower dot
  // sat on the top of the `0` — clear of the overlap check's box by 0.013 of the
  // panel and visibly touching, because the check measures a rectangle and a
  // glyph is not one. The two biggest things on the array need air, not tolerance.
  ops.push({ kind: 'text', text: HOME_RUN_WORD, x: 0.5, y: 0.09, size: pt.t('head'), align: 'centre', color: WHITE });

  // ⚠ THE COUNT-UP LANDS EXACTLY ON THE SIM'S NUMBER. `countUp(last) === 1`, so
  // the final frame prints `distFt` rounded and nothing else — the board must
  // never be the reason a player reads a different distance than the HUD.
  const dist = fitRun(`${int(s.distFt * countUp(frame))} FT`, 0.82, 'hero', pt);
  ops.push({ kind: 'text', text: dist.text, x: 0.5, y: 0.48, size: dist.size, align: 'centre', color: GOLD });

  // ⚠ THE EXIT VELOCITY, THE LAUNCH ANGLE AND THE PAYOUT ARE NOT HERE ANY MORE,
  // and that is the array doing its job rather than an omission. Four rows do
  // not fit in 29.5 ft at this type scale; `boardPanels.celebrationSides()`
  // paints them on the two columns either side, at the same instant, from the
  // same `frame`. See `boardAtlas.boardArrayOps`.
  return ops;
}

function roundSummaryOps(s: Extract<BoardScreen, { kind: 'roundSummary' }>, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });
  const title = fitRun(`ROUND ${int(s.round)}/${int(s.rounds)} DONE`, 0.88, 'title', pt);
  ops.push({ kind: 'text', text: title.text, x: 0.5, y: 0.11, size: title.size, align: 'centre', color: WHITE });

  // ⚠ TWO STACKS, NOT FOUR, AND THE OTHER TWO MOVED TO THE COLUMNS. Four
  // caption/value stacks in two rows is 28.0 ft of type in a 29.5 ft panel
  // before a single gap, and the overlap walk caught their ink touching. The
  // round's own two numbers stay in the middle; `HOMERS` and `LONG` are exactly
  // the single figures a narrow column exists for, and `defaultSides` puts them
  // there — which is the same trade the home-run moment makes, for the same
  // measured reason. (The gutter itself is still derived from the span: an
  // earlier version had 0.45 + 0.45 from a 0.05 margin, meeting at 0.50, and
  // drew two runs touching.)
  const colW = (SPAN - GUTTER) / 2;
  ops.push(
    ...stack({ label: 'ROUND', value: `+${int(s.roundScore)}`, x: L, y: 0.45, w: colW, align: 'left', pt, color: GOLD })
      .ops,
  );
  ops.push(...stack({ label: 'TOTAL', value: int(s.total), x: R, y: 0.45, w: colW, align: 'right', pt }).ops);
  return ops;
}

function duelScoreOps(s: Extract<BoardScreen, { kind: 'duelScore' }>, pt: PanelType): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });

  // ⚠ THE COUNT PANEL'S WIDTH IS MEASURED FROM WHAT IS IN IT. It was a
  // hard-coded 0.30 at x 0.66 with the runs column pinned to `runH(2)` — a
  // two-digit allowance in a comment that claimed the column measured itself.
  // With `runs: 123` the name ran straight into the number. Both are derived
  // now, from the widest string each actually carries.
  const countW =
    Math.max(
      runW(`${s.half === 'top' ? 'T' : 'B'}${int(s.inning)}`, pt.t('title'), pt.aspect),
      runW(`${int(s.balls)}-${int(s.strikes)}`, pt.t('body'), pt.aspect),
      3 * 0.05,
    ) + 2 * GUTTER;
  const countX = 1 - countW;
  const runsX = countX - GUTTER;
  const sides = [s.away, s.home];
  const runsW = Math.max(...sides.map((t) => runW(int(t.runs), pt.t('title'), pt.aspect)));
  const nameMax = runsX - runsW - GUTTER - L;

  sides.forEach((team, i) => {
    const y = 0.16 + i * 0.38;
    const name = fitRun(team.name, nameMax, 'title', pt);
    ops.push({ kind: 'text', text: name.text, x: L, y, size: name.size, align: 'left', color: WHITE });
    ops.push({ kind: 'text', text: int(team.runs), x: runsX, y, size: pt.t('title'), align: 'right', color: GOLD });
  });

  ops.push({ kind: 'panel', x: countX, y: 0.06, w: countW, h: 0.88, color: PANEL });
  const cx = countX + countW / 2;
  ops.push({
    kind: 'text',
    text: `${s.half === 'top' ? 'T' : 'B'}${int(s.inning)}`,
    x: cx,
    y: 0.16,
    size: pt.t('title'),
    align: 'centre',
    color: WHITE,
  });
  ops.push({
    kind: 'text',
    text: `${int(s.balls)}-${int(s.strikes)}`,
    x: cx,
    y: 0.48,
    size: pt.t('body'),
    align: 'centre',
    color: DIM,
  });
  // Outs as three lamps: lit ones are red, the rest are the panel's own shade.
  for (let i = 0; i < 3; i++) {
    const x = cx - 0.075 + i * 0.05;
    ops.push({ kind: 'poly', pts: [x, 0.76, x + 0.035, 0.76, x + 0.035, 0.86, x, 0.86], color: i < s.outs ? RED : INK });
  }
  return ops;
}

/**
 * THE MAIN PANEL'S PICTURE, as data. Pure: same `(screen, frame, pt)` ⇒
 * deep-equal ops, always, on any machine.
 */
export function boardMainOps(screen: BoardScreen, frame: number, pt: PanelType): BoardOp[] {
  switch (screen.kind) {
    case 'idle':
      return idleOps(screen.label, pt);
    case 'derbyBatter':
      return derbyBatterOps(screen, pt);
    case 'result':
      return resultOps(screen, pt);
    case 'homeRun':
      return homeRunOps(screen, frame, pt);
    case 'roundSummary':
      return roundSummaryOps(screen, pt);
    case 'duelScore':
      return duelScoreOps(screen, pt);
  }
}
