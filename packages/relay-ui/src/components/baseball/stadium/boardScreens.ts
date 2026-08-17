// The videoboard's SIX SCREENS — the layouts themselves.
//
// ⚠ EXTRACTED FROM `boardPaint.ts` AT THE 500-LINE BUILDER CAP — extraction, not
// a raised cap, the discipline `budget.test.ts` states and `swingCopy.ts` was
// split under. The seam is the one the brief named: `boardPaint.ts` is the KIT
// (the op vocabulary, the palette, the type scale, the legibility floor, the
// time quantisation and the rasteriser) and this file is what is DRAWN WITH IT.
// A seventh screen lands here and touches nothing else; a change to the type
// scale lands there and every screen follows it.
//
// Every function is pure `(screen, frame, aspect) => BoardOp[]`. No canvas, no
// `three`, no clock, no gameplay — see `boardPaint.ts`'s header for all four.

import type { BoardOp, BoardScreen } from './boardPaint';
import {
  BOARD_ANIM_FPS,
  DIM,
  GOLD,
  INK,
  PANEL,
  RED,
  RULE,
  TONE_COLOR,
  T_BODY,
  T_HEAD,
  T_HERO,
  T_LABEL,
  T_TITLE,
  WHITE,
  backdrop,
  fit,
  int,
  runH,
} from './boardPaint';

/** How long the home-run strobe alternates for, s. Feel knob. */
const FLASH_S = 0.9;
/** Strobe half-period, s. 2.5 Hz — an alternation, deliberately not a flicker. */
const STROBE_S = 0.2;
/** How long the distance counts up, s. Feel knob. */
const COUNT_S = 0.8;
/** Chevron sweeps per second. Feel knob. */
const CHEVRON_HZ = 0.9;

/** Gap between two columns of a row, as a fraction of board WIDTH. */
const GUTTER = 0.035;
/** Padding inside the chain badge — width units and height units. */
const BADGE_PAD_X = 0.016;
const BADGE_PAD_Y = 0.028;
/** Right edge of the duel's runs column, clear of the count panel at 0.66. */
const RUNS_X = 0.62;

/**
 * Split a `describeSwing` line into board rows on its own ` · ` separator.
 * Exported because the test asserts, against `swingCopy` itself, that every
 * outcome's line survives the split at or above `MIN_LEGIBLE_H`.
 */
export function boardResultRows(line: string): string[] {
  return line
    .split(' · ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function idleOps(label: string, aspect: number): BoardOp[] {
  return [
    ...backdrop(INK),
    { kind: 'panel', x: 0, y: 0.06, w: 1, h: 0.02, color: RULE },
    {
      kind: 'text',
      text: label,
      x: 0.5,
      y: 0.42,
      size: fit(label, 0.86, T_TITLE, aspect),
      align: 'centre',
      color: DIM,
    },
  ];
}

function derbyBatterOps(
  s: Extract<BoardScreen, { kind: 'derbyBatter' }>,
  aspect: number,
): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });

  // ⚠ THE NAME'S WIDTH ALLOWANCE IS COMPUTED FROM THE SCORE THAT IS ACTUALLY ON
  // THE BOARD, not hard-coded. It was hard-coded — 0.56, then 0.66 — and both
  // were wrong for a different reason: 0.56 shrank a 12-character name BELOW the
  // round line it is supposed to dominate, and 0.66 held only while the score
  // had four digits. A five-digit score set at `T_TITLE` reaches back to 0.659,
  // which a 0.66 name runs straight into. So the right column measures itself
  // (the wider of the value and its `SCORE` label) and the name gets what is
  // left, less a gutter. `fit` then shrinks a long card name rather than
  // clipping it, which is the right failure: a squeezed name is still a name.
  const scoreText = int(s.score);
  const rightColW =
    Math.max(runH(scoreText.length) * T_TITLE, runH('SCORE'.length) * T_LABEL) / aspect;
  ops.push({
    kind: 'text',
    text: s.batter,
    x: 0.045,
    y: 0.105,
    size: fit(s.batter, 0.955 - rightColW - GUTTER - 0.045, T_TITLE, aspect),
    align: 'left',
    color: WHITE,
  });
  ops.push({
    kind: 'text',
    text: `ROUND ${int(s.round)}/${int(s.rounds)}`,
    x: 0.045,
    y: 0.32,
    size: T_BODY,
    align: 'left',
    color: DIM,
  });
  ops.push({
    kind: 'text',
    text: 'SCORE',
    x: 0.955,
    y: 0.1,
    size: T_LABEL,
    align: 'right',
    color: DIM,
  });
  ops.push({
    kind: 'text',
    text: scoreText,
    x: 0.955,
    y: 0.215,
    size: T_TITLE,
    align: 'right',
    color: WHITE,
  });

  // ⚠ THE BOTTOM BAND IS TWO COLUMNS, AND IT USED TO BE THREE — which did not
  // fit and was only visible in a render. `PITCH 7/27`, `LONG 428 FT` and a
  // `×1.50` badge total 1.24 board widths at `T_BODY`: the badge was painted
  // straight over the word LONG and through the pitch count. Rows 4 and 5 of
  // the legibility derivation say this board carries four or five rows, so the
  // fix is not smaller type, it is FEWER THINGS — and when a chain is live it
  // is the more urgent of the two, so it TAKES the right column rather than
  // sharing it. (`swingCopy`'s rule that the multiplier shows only while it is
  // earning is what makes that swap safe: off-chain, the long ball is back.)
  ops.push({ kind: 'panel', x: 0, y: 0.66, w: 1, h: 0.34, color: PANEL });
  const colW = (0.955 - 0.045 - GUTTER) / 2;
  const pitchText = `PITCH ${int(s.pitch)}/${int(s.pitches)}`;
  ops.push({
    kind: 'text',
    text: pitchText,
    x: 0.045,
    y: 0.735,
    size: fit(pitchText, colW, T_BODY, aspect),
    align: 'left',
    color: WHITE,
  });
  if (s.chainX !== null && s.chainX > 1) {
    const chainText = `×${s.chainX.toFixed(2)}`;
    const size = fit(chainText, colW - 2 * BADGE_PAD_X, T_BODY, aspect);
    const w = (runH(chainText.length) * size) / aspect;
    ops.push({
      kind: 'panel',
      x: 0.955 - w - 2 * BADGE_PAD_X,
      y: 0.735 - BADGE_PAD_Y,
      w: w + 2 * BADGE_PAD_X,
      h: size + 2 * BADGE_PAD_Y,
      color: RED,
    });
    ops.push({
      kind: 'text',
      text: chainText,
      x: 0.955 - BADGE_PAD_X,
      y: 0.735,
      size,
      align: 'right',
      color: WHITE,
    });
  } else if (s.bestFt !== null) {
    const longText = `LONG ${int(s.bestFt)} FT`;
    ops.push({
      kind: 'text',
      text: longText,
      x: 0.955,
      y: 0.735,
      size: fit(longText, colW, T_BODY, aspect),
      align: 'right',
      color: DIM,
    });
  }
  return ops;
}

function resultOps(s: Extract<BoardScreen, { kind: 'result' }>, aspect: number): BoardOp[] {
  const ops = backdrop(INK);
  const accent = TONE_COLOR[s.tone];
  ops.push({ kind: 'panel', x: 0, y: 0.1, w: 1, h: 0.035, color: accent });
  const rows = boardResultRows(s.line);
  // ⚠ EACH ROW IS SIZED ON ITS OWN, and the first version sized them all to the
  // SMALLEST. That is what a text engine does and it is wrong for a scoreboard:
  // "Off the wall — 395 ft · +40" set that way drew the payout — three
  // characters with a whole board to live in — at the 21-character line's size,
  // which is a third of what it could be. The rows are independent facts, so
  // they get independent sizes and the short one gets to shout.
  const sizes = rows.map((r) => fit(r, 0.9, T_TITLE, aspect));
  const gap = 0.05;
  const total = sizes.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
  let y = 0.5 - total / 2;
  rows.forEach((row, i) => {
    ops.push({
      kind: 'text',
      text: row,
      x: 0.5,
      y,
      size: sizes[i]!,
      align: 'centre',
      color: i === 0 ? WHITE : accent,
    });
    y += sizes[i]! + gap;
  });
  return ops;
}

/** A sweeping chevron band — the only moving furniture on the home-run screen. */
function chevrons(frame: number, y: number, h: number, color: string): BoardOp[] {
  const t = frame / BOARD_ANIM_FPS;
  const phase = (t * CHEVRON_HZ) % 1;
  const ops: BoardOp[] = [];
  const pitch = 0.16;
  const wide = 0.06;
  for (let i = -1; i < 8; i++) {
    const x = (i + phase) * pitch;
    ops.push({
      kind: 'poly',
      pts: [x, y, x + wide, y, x + wide - 0.03, y + h, x - 0.03, y + h],
      color,
    });
  }
  return ops;
}

/**
 * The word the home-run screen leads with.
 *
 * ⚠ IT IS ASSERTED AGAINST `swingCopy.describeSwing`'s OWN OUTPUT, not merely
 * copied from it — see `scoreboard.test.ts`. Two surfaces saying different
 * things about the same event is the "second vocabulary" the charter forbids,
 * and the only way to keep them together is a test that reads both.
 */
export const HOME_RUN_WORD = 'GONE!';

function homeRunOps(s: Extract<BoardScreen, { kind: 'homeRun' }>, frame: number, aspect: number): BoardOp[] {
  const t = frame / BOARD_ANIM_FPS;
  const strobe = t < FLASH_S && Math.floor(t / STROBE_S) % 2 === 0;
  const ops = backdrop(strobe ? RED : INK);
  ops.push(...chevrons(frame, 0.0, 0.05, strobe ? WHITE : RULE));
  ops.push(...chevrons(frame, 0.95, 0.05, strobe ? WHITE : RULE));

  ops.push({
    kind: 'text',
    text: HOME_RUN_WORD,
    x: 0.5,
    y: 0.035,
    size: T_HEAD,
    align: 'centre',
    color: WHITE,
  });

  // ⚠ THE COUNT-UP LANDS EXACTLY ON THE SIM'S NUMBER. `ease(1) === 1`, so the
  // final frame prints `distFt` rounded and nothing else — the board must never
  // be the reason a player reads a different distance than the HUD.
  const u = Math.min(1, Math.max(0, t / COUNT_S));
  const ease = u * u * (3 - 2 * u);
  const shown = Math.round(s.distFt * ease);
  const dist = `${int(shown)} FT`;
  ops.push({
    kind: 'text',
    text: dist,
    x: 0.5,
    // ⚠ 0.30 AT `T_HEAD` = 0.22 PUT THE HEADLINE'S STROKE THROUGH THE TOP OF
    // THE DISTANCE — a glyph's stroke extends half a `lineWidth` past its cell,
    // which a purely cell-based layout does not account for. Rendered and
    // measured: 13 px of overlap at 1024×512. The headline came down to 0.19 and
    // moved up to 0.035; the hero came down to 0.32.
    y: 0.285,
    size: fit(dist, 0.82, T_HERO, aspect),
    align: 'centre',
    color: GOLD,
  });

  const detail = `${s.evMph.toFixed(0)} MPH · ${s.laDeg.toFixed(0)}°`;
  ops.push({
    kind: 'text',
    text: detail,
    x: 0.5,
    y: 0.69,
    size: fit(detail, 0.8, T_BODY, aspect),
    align: 'centre',
    color: WHITE,
  });
  const pts =
    s.chainX !== null && s.chainX > 1
      ? `+${int(s.points)} ×${s.chainX.toFixed(2)}`
      : `+${int(s.points)}`;
  ops.push({
    kind: 'text',
    text: pts,
    x: 0.5,
    y: 0.845,
    size: fit(pts, 0.8, T_BODY, aspect),
    align: 'centre',
    color: GOLD,
  });
  return ops;
}

function roundSummaryOps(
  s: Extract<BoardScreen, { kind: 'roundSummary' }>,
  aspect: number,
): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });
  const title = `ROUND ${int(s.round)}/${int(s.rounds)} DONE`;
  ops.push({
    kind: 'text',
    text: title,
    x: 0.5,
    y: 0.11,
    size: fit(title, 0.88, T_TITLE, aspect),
    align: 'centre',
    color: WHITE,
  });
  const rows: Array<[string, string]> = [
    [`ROUND +${int(s.roundScore)}`, `HOMERS ${int(s.homeRuns)}`],
    [`LONG ${int(s.bestFt)} FT`, `TOTAL ${int(s.total)}`],
  ];
  // ⚠ TWO COLUMNS WITH A GUTTER BETWEEN THEM, and the first version had none:
  // 0.45 + 0.45 from a 0.05 margin meets at 0.50, so `LONG 428 FT` and
  // `TOTAL 3980` were drawn touching. Rendered, measured, and now the same
  // `colW` the batter card's band uses.
  const colW = (0.955 - 0.045 - GUTTER) / 2;
  rows.forEach(([left, right], i) => {
    const y = 0.42 + i * 0.26;
    ops.push({
      kind: 'text',
      text: left,
      x: 0.045,
      y,
      size: fit(left, colW, T_BODY, aspect),
      align: 'left',
      color: DIM,
    });
    ops.push({
      kind: 'text',
      text: right,
      x: 0.955,
      y,
      size: fit(right, colW, T_BODY, aspect),
      align: 'right',
      color: WHITE,
    });
  });
  return ops;
}

function duelScoreOps(s: Extract<BoardScreen, { kind: 'duelScore' }>, aspect: number): BoardOp[] {
  const ops = backdrop(INK);
  ops.push({ kind: 'panel', x: 0, y: 0.055, w: 1, h: 0.018, color: RULE });
  const sides = [s.away, s.home];
  // The runs column measures itself, exactly as the derby score does, so a
  // two-digit inning total cannot be run into by a long city name.
  const runsW = (runH(2) * T_TITLE) / aspect;
  const nameMax = RUNS_X - runsW - GUTTER - 0.045;
  sides.forEach((team, i) => {
    const y = 0.14 + i * 0.36;
    ops.push({
      kind: 'text',
      text: team.name,
      x: 0.045,
      y,
      size: fit(team.name, nameMax, T_TITLE, aspect),
      align: 'left',
      color: WHITE,
    });
    ops.push({
      kind: 'text',
      text: int(team.runs),
      x: RUNS_X,
      y,
      size: T_TITLE,
      align: 'right',
      color: GOLD,
    });
  });

  ops.push({ kind: 'panel', x: 0.66, y: 0.06, w: 0.3, h: 0.88, color: PANEL });
  ops.push({
    kind: 'text',
    text: `${s.half === 'top' ? 'T' : 'B'}${int(s.inning)}`,
    x: 0.81,
    y: 0.14,
    size: T_TITLE,
    align: 'centre',
    color: WHITE,
  });
  ops.push({
    kind: 'text',
    text: `${int(s.balls)}-${int(s.strikes)}`,
    x: 0.81,
    y: 0.44,
    size: T_BODY,
    align: 'centre',
    color: DIM,
  });
  // Outs as three lamps: lit ones are red, the rest are the panel's own shade.
  for (let i = 0; i < 3; i++) {
    const x = 0.735 + i * 0.05;
    ops.push({
      kind: 'poly',
      pts: [x, 0.74, x + 0.035, 0.74, x + 0.035, 0.83, x, 0.83],
      color: i < s.outs ? RED : INK,
    });
  }
  return ops;
}

/**
 * THE PICTURE, as data. Pure: same `(screen, frame, aspect)` ⇒ deep-equal ops,
 * always, on any machine.
 */
export function boardOps(screen: BoardScreen, frame: number, aspect: number): BoardOp[] {
  switch (screen.kind) {
    case 'idle':
      return idleOps(screen.label, aspect);
    case 'derbyBatter':
      return derbyBatterOps(screen, aspect);
    case 'result':
      return resultOps(screen, aspect);
    case 'homeRun':
      return homeRunOps(screen, frame, aspect);
    case 'roundSummary':
      return roundSummaryOps(screen, aspect);
    case 'duelScore':
      return duelScoreOps(screen, aspect);
  }
}
