// The videoboard's DRAWING KIT — the op vocabulary, the palette, the type scale
// in FEET, the legibility floor, the time quantisation and the rasteriser.
//
// The state shapes live in `boardState.ts`, the panel layout in `boardAtlas.ts`,
// the screens in `boardScreens.ts` and `boardPanels.ts`, the ribbon in
// `boardRibbon.ts`. Each split happened at the 500-line cap — extraction, not a
// raised cap. The seam: this file is what a panel is drawn WITH; those files are
// what is drawn. A change to the type scale lands HERE and every surface in the
// stadium follows it.
//
// ⚠ THE LAYOUT IS A LIST OF OPS, NOT A SEQUENCE OF CANVAS CALLS, and that split
// is the single most important decision in this feature. Every painter is a pure
// `(state, frame, panel) => BoardOp[]`: no canvas, no `three`, no clock. The
// rasteriser (`emitBoardOps`, at the foot of this file) does nothing but turn
// each op into strokes. Three things follow that a canvas-first version could
// not have:
//
//   • THE TESTS ASSERT THE PICTURE, NOT A SPY. "Was the distance drawn, in that
//     position, at that size, before the exit velocity?" is a question about an
//     array of plain objects.
//   • LEGIBILITY IS ENFORCEABLE. Every text op carries its own `size`, so a test
//     can walk EVERY op of EVERY surface and fail the one that is too small to
//     read from the batter's box — against that PANEL's own floor.
//   • RESOLUTION INDEPENDENCE. Ops are fractions, so a low-tier 512×256 atlas is
//     the same picture as a 1024×512 one, not a second layout.
//
// ⚠ NO CLOCK, ANYWHERE. Every animated quantity is a function of `frame`, an
// integer the CALLER computed from `lib/scene3d/clock.ts`.
//
// ⚠ IT DECIDES NO GAMEPLAY. Every number in a `BoardArray` was produced by the
// sim and handed here.

import type { Board2D, BoardAlign } from './boardGlyphs';
import { GLYPH_TRACK, GLYPH_W, GLYPH_WEIGHT, TRUNCATION_MARK, strokeBoardText } from './boardGlyphs';
import type { BoardScreen } from './boardState';

// ---------------------------------------------------------------------------
// Time — quantised, so that "what is painted" is a finite key
// ---------------------------------------------------------------------------

/**
 * How often the animated surfaces re-draw, Hz. **FEEL KNOB with a measured
 * cost**, and it is a texture-UPLOAD budget more than a look: a 1024×512 RGBA
 * atlas is 2.0 MB per `needsUpdate` and the 2048×64 ribbon is another 0.5 MB, so
 * 12 Hz is 30 MB/s while the home-run celebration is on screen and **exactly
 * zero** either side of it. At 60 Hz it would be 150 MB/s, which is the kind of
 * number that costs frames on a phone for an effect nobody can see at 12.
 */
export const BOARD_ANIM_FPS = 12;

/**
 * When the home-run moment stops moving, s. After this the frame index CLAMPS,
 * so the paint key stops changing and the board stops uploading entirely while
 * the celebration is still on screen. Feel knob.
 */
export const BOARD_ANIM_END_S = 2.6;

/** The last animated frame index. Derived. */
export const BOARD_ANIM_LAST_FRAME = Math.round(BOARD_ANIM_END_S * BOARD_ANIM_FPS);

/**
 * The animation frame the array is on at `tS` seconds since it appeared.
 *
 * ⚠ QUANTISING HERE IS WHAT MAKES THE PICTURE A FUNCTION OF THE KEY. The
 * painters take the integer, never `tS`, so two calls that produce the same frame
 * produce byte-identical ops — which is exactly the invariant the upload policy
 * in `scoreboard.ts` relies on when it skips a repaint. A painter that read `tS`
 * directly would drift silently: the key would say "unchanged" while the picture
 * had moved on.
 *
 * Static screens return 0 always, so they never repaint and never upload.
 */
export function boardAnimFrame(main: BoardScreen, tS: number): number {
  if (main.kind !== 'homeRun') return 0;
  if (!Number.isFinite(tS) || tS <= 0) return 0;
  return Math.min(Math.floor(tS * BOARD_ANIM_FPS), BOARD_ANIM_LAST_FRAME);
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

// Royal blue / red / white, per BASEBALL.md's Toronto homage. A colour scheme,
// not a mark.

/** The architectural frame the panels are set into — the darkest thing here. */
export const FRAME = '#050a18';
export const INK = '#08122b';
export const PANEL = '#0f2050';
const SCAN = '#0b1836';
export const RULE = '#1f4fd8';
export const RED = '#d7263d';
export const WHITE = '#f4f8ff';
export const DIM = '#6d8ad6';
export const GOLD = '#ffc233';
const GREEN = '#2fb46b';

export const TONE_COLOR: Record<string, string> = {
  gone: GOLD,
  good: GREEN,
  neutral: RULE,
  miss: RED,
};

// ---------------------------------------------------------------------------
// The camera, and the type scale it forces
// ---------------------------------------------------------------------------

/** `CAMERAS.batter`'s eye, scene ft, and its vertical fov. Duplicated on purpose:
 * importing `camera.ts` here would pull the rig into a module whose whole point
 * is that it is pure layout. The values are asserted against `CAMERAS.batter` in
 * `scoreboard.test.ts`, so the copy cannot drift.
 *
 * ⚠⚠ AND THE GUARD EARNED ITS KEEP THE FIRST TIME TWO BRANCHES MET. These read
 * 8 ft / 40° — the pre-M3b batter camera — and the shipped one is 19.5 ft / 20°.
 * The board slice was authored against one branch and the M3b re-frame landed on
 * another, so the merge produced a legibility floor derived from a lens that no
 * longer exists. Nothing about it was visible: the board still built, still
 * passed its own `boardGeometryComplaints`, and 52 tests were green. The ONE
 * thing that saw it is the assertion in `scoreboard.test.ts` that pins these two
 * numbers against `CAMERAS.batter` itself — which is exactly the case its own
 * comment predicted ("the camera moving, or the ART AGENT building a different
 * array").
 *
 * The error was CONSERVATIVE — a 20° lens magnifies ~2× against a 40° one, so
 * every glyph was twice the size the floor demanded — but conservative in a
 * derivation is still wrong, and it was suppressing the whole information budget:
 * an 18 ft column carries 10 characters at the real floor, not 5.
 */
const BATTER_EYE_Z_FT = 19.5;
const BATTER_FOV_DEG = 20;
/** Portrait phone: CSS px across, and the harness frame's px across and down. */
const PHONE_CSS_W = 390;
const SHOT_PX_W = 900;
const SHOT_PX_H = 1600;

/**
 * ⚠ THE REFERENCE ARRAY EVERY NUMBER BELOW IS DERIVED AGAINST — exported because
 * it is an INTEGRATION CONTRACT, not documentation.
 *
 * ⚠⚠ **66 × 33, NOT 100 × 50 — AN OWNER DECISION ON A MEASUREMENT.** The array
 * was authored at 100 × 50 against a 40° batter lens; the shipped camera is a
 * 20° lens at 19.5 ft, which magnifies ~2×, so that board was 1009 px of a
 * 900 px frame and **cropped on three sides** — and on a 390 px phone the two
 * side columns were very nearly outside the picture entirely (73.4 % of the
 * width in frame, 84.2 % of the height). `board.test.ts` pinned those as goldens
 * and the owner's call was that they are wrong "regardless of what the atlas
 * would prefer".
 *
 * ⚠ AND IT HAD TO MOVE HERE, NOT IN THE SCENE. `boardGeometryComplaints` refuses
 * a board shorter than `BOARD_REF`, because the atlas is authored at these
 * proportions and STRETCHED onto whatever quad the scene builds — so a smaller
 * quad draws smaller type and lands under the floor. 100 × 50 @ 430 was the
 * UNIQUE admissible point of this module's own rules. Re-authoring the reference
 * and the panel table TOGETHER is the only move that changes the size without
 * changing the legibility guarantee, which is why it is one commit and not two.
 *
 * The aspect is unchanged at 2.0, so every UV rect, every panel's own aspect and
 * every derived fraction survives; what changes is the information BUDGET, and
 * `scoreboard.test.ts` prints the new per-panel table beside the old one.
 *
 * The array's real size and position are scene art and belong to whoever owns
 * the bowl and the truss, not to this module. But every legibility number here
 * scales linearly with `heightFt / faceDistFt`, so an array built at, say, 30 ft
 * tall instead of 50 silently makes the floor a 6 CSS px lie and the whole rule
 * stops meaning anything. `buildScoreboard` now TAKES the real geometry and
 * THROWS when it lands under the threshold — see `scoreboard.ts`.
 */
export const BOARD_REF = { widthFt: 66, heightFt: 33, faceDistFt: 430 } as const;

/** CSS pixels per foot of board face, on a portrait phone, from `CAMERAS.batter`. */
export function boardCssPxPerFt(faceDistFt: number = BOARD_REF.faceDistFt): number {
  const depth = faceDistFt + BATTER_EYE_Z_FT;
  const frameFt = 2 * depth * Math.tan(((BATTER_FOV_DEG / 2) * Math.PI) / 180);
  return (SHOT_PX_H / frameFt) * (PHONE_CSS_W / SHOT_PX_W);
}

/**
 * How many CSS pixels of glyph a text `size` becomes on a phone, from the batter
 * camera, for a surface of the given height at the given face distance.
 *
 * `size` is a fraction of THAT SURFACE's height — so a side column and the main
 * panel take different fractions to reach the same pixels, which is the whole
 * point of the per-panel derivation in `boardAtlas.ts`.
 */
export function boardLegibleCssPx(
  size: number,
  heightFt: number = BOARD_REF.heightFt,
  faceDistFt: number = BOARD_REF.faceDistFt,
): number {
  return size * heightFt * boardCssPxPerFt(faceDistFt);
}

/**
 * ⚠ THE SMALLEST TEXT ANY SURFACE IN THIS STADIUM MAY EVER DRAW, in CSS pixels
 * of cap height on a phone. Not a fraction — a fraction is meaningless until you
 * say a fraction OF WHAT, which is precisely the mistake the single-rectangle
 * board made.
 *
 * ~10 CSS px is the floor for reading a word at a glance and ~14 is comfortable.
 */
export const MIN_LEGIBLE_CSS_PX = 10;

/**
 * The floor expressed in FEET OF GLYPH at the reference face distance. Derived:
 * `MIN_LEGIBLE_CSS_PX / boardCssPxPerFt(430)` = 4.599 ft.
 *
 * ⚠ AND THE HONEST CONSEQUENCE, UNCHANGED BY THE ARRAY: a real videoboard sets
 * body copy at roughly 1.5–2.5 ft, which lands at 3–5 CSS px here and cannot be
 * read at all. Every surface in this stadium runs at about **3× a real board's
 * type scale**. What the array changes is not the scale — it is the BUDGET:
 * one 100 × 50 ft rectangle carries ten floor-height rows and 26 characters, and
 * one row is one row for everything; four panels carry **21 rows** between them,
 * because the strip is short but very wide, the columns are tall but very narrow,
 * and each is budgeted against its OWN subtended size. `boardAtlas.ts` prints the
 * measurement every run.
 */
export const MIN_LEGIBLE_FT = MIN_LEGIBLE_CSS_PX / boardCssPxPerFt();

/**
 * ⚠ THE TYPE SCALE IS IN FEET, AND THAT IS THE FIX FOR THE ARRAY. It used to be
 * fractions of board height, which is only a scale at all while there is exactly
 * one surface: the same 0.155 is 7.8 ft on the old 50 ft board, 4.6 ft in a
 * 29.5 ft main panel and 2.6 ft on the strip — three different, mostly illegible
 * sizes for one named role. Absolute feet is the invariant the CAMERA actually
 * imposes, and each panel divides by its own height to get its own fraction.
 *
 * `label` sits EXACTLY on `MIN_LEGIBLE_FT`, so the smallest named size is the
 * floor by construction rather than by coincidence.
 *
 * ⚠⚠ **AND THE OTHER FOUR ARE MULTIPLES OF IT NOW, WHICH IS A CORRECTION, NOT A
 * TIDY-UP.** They were absolute feet — 13 / 8 / 6.5 / 5.5 — chosen when the
 * floor was 4.599 ft, i.e. at 2.83× / 1.74× / 1.41× / 1.20× the floor. Fixing
 * the floor for the real 20° batter lens halved it to 2.286 ft and moved
 * `label` with it, because `label` IS the floor — but left the other four
 * where they were. The scale silently became 5.7× / 3.5× / 2.8× / 2.4× the
 * floor: an internally inconsistent type ramp in which `body` was more than
 * twice `label` where it had been a fifth more.
 *
 * Nothing failed. What it cost was ROOM, and the bill arrived at the resize: on
 * a 22 ft main panel the batter card's four rows summed to 1.05 of the panel and
 * the bottom stack overflowed into the linescore strip — which the overlap walk
 * caught as `"7/27" overlaps "1"`, i.e. as a collision between two different
 * panels, which is what an overflowing panel looks like from the outside.
 *
 * Written as multiples, the ramp cannot drift from the floor again: change the
 * camera, change the floor, and all five sizes follow. The ratios are the ones
 * the array was designed at, recovered to three decimals.
 */
export const TYPE_FT = {
  hero: 2.827 * MIN_LEGIBLE_FT,
  head: 1.740 * MIN_LEGIBLE_FT,
  title: 1.414 * MIN_LEGIBLE_FT,
  body: 1.196 * MIN_LEGIBLE_FT,
  label: MIN_LEGIBLE_FT,
} as const;

export type TypeKey = keyof typeof TYPE_FT;

/**
 * A panel's own type scale — everything a painter needs to lay out inside one
 * rectangle without knowing where in the array that rectangle is.
 *
 * `t(k)` and `floor` are fractions of THIS PANEL's height; `aspect` is the
 * panel's own w/h, which is what turns a width budget into a glyph size.
 */
export interface PanelType {
  id: string;
  aspect: number;
  widthFt: number;
  heightFt: number;
  floor: number;
  t(k: TypeKey): number;
}

export function panelType(id: string, widthFt: number, heightFt: number): PanelType {
  return {
    id,
    aspect: widthFt / heightFt,
    widthFt,
    heightFt,
    floor: MIN_LEGIBLE_FT / heightFt,
    t: (k) => TYPE_FT[k] / heightFt,
  };
}

// ---------------------------------------------------------------------------
// The op list
// ---------------------------------------------------------------------------

/**
 * One drawing instruction. `x`/`w` are fractions of the surface's WIDTH; `y`,
 * `h` and `size` are fractions of its HEIGHT. `poly.pts` is `[x0, y0, x1, y1, …]`
 * in those same two units.
 */
export type BoardOp =
  | { kind: 'panel'; x: number; y: number; w: number; h: number; color: string }
  | {
      kind: 'text';
      text: string;
      x: number;
      y: number;
      size: number;
      align: BoardAlign;
      color: string;
    }
  | { kind: 'poly'; pts: number[]; color: string };

/** Width of a run of `n` monospaced cells, in units of surface HEIGHT. */
export const runH = (n: number) => (n === 0 ? 0 : n * (GLYPH_W + GLYPH_TRACK) - GLYPH_TRACK);

/** Width of a run at a given size, as a fraction of surface WIDTH. */
export const runW = (text: string, size: number, aspect: number) =>
  (runH(text.length) * size) / aspect;

/** A laid-out run: the text that will actually be drawn, and how big. */
export interface Run {
  text: string;
  size: number;
}

/**
 * Set `text` into `maxFracW` of the surface's width, at or below `cap`, and
 * NEVER below the panel's legibility floor.
 *
 * ⚠ IT TRUNCATES RATHER THAN SHRINKING OUT OF THE RULE, and that is the repair
 * of a real hole. The old `fit()` returned `min(cap, maxFracW·aspect/cells)` with
 * no floor at all, so on this module's OWN fixtures it shipped `HARBOURFRONT` at
 * 9.9 CSS px, `MOUNTAINSIDE` at 9.9, `ALPINE MEADOWS` at 8.5 and
 * `MAXIMILIAN LONGNAME` at 8.4 — under a 10 px floor the suite claimed to
 * enforce, and `Harbourfront` is the real park name in `parks.ts`. It also
 * returned a NEGATIVE size for a negative width budget, which is a glyph drawn
 * inside out. The legibility walk missed all of it because it ran over a
 * different fixture list than the overlap walk; both now run over both.
 *
 * A truncated name is still a name and the mark says so. A name at 8.4 px is a
 * grey smear that the test suite calls legible.
 */
export function fitRun(text: string, maxFracW: number, cap: TypeKey | number, pt: PanelType): Run {
  const capH = typeof cap === 'number' ? cap : pt.t(cap);
  const budget = Number.isFinite(maxFracW) && maxFracW > 0 ? maxFracW : 0;
  const cells = runH(text.length);
  if (cells <= 0) return { text, size: capH };

  const ideal = Math.min(capH, (budget * pt.aspect) / cells);
  if (ideal >= pt.floor) return { text, size: ideal };

  // Below the floor: hold the floor and cut the run instead. `n` is how many
  // cells fit at the floor — the EXACT inverse of `runH`, trailing track and
  // all. Dropping that `+ GLYPH_TRACK` loses a whole character on a narrow
  // column: an 18 ft side panel carries five digits at the floor (17.57 ft of
  // the 18) and the sloppy inversion says four, so a five-digit score would
  // print as `999…`.
  const n = Math.floor(
    ((budget * pt.aspect) / pt.floor + GLYPH_TRACK) / (GLYPH_W + GLYPH_TRACK) + 1e-9,
  );
  if (n <= 0) return { text: '', size: pt.floor };
  if (n >= text.length) return { text, size: pt.floor };
  const kept = text.slice(0, Math.max(0, n - 1)).trimEnd();
  return { text: `${kept}${TRUNCATION_MARK}`, size: pt.floor };
}

export const int = (v: number) => Math.round(v).toString();

/** Gap between two columns of a row, as a fraction of surface WIDTH. */
export const GUTTER = 0.035;

/**
 * Breathing room between a caption and its value, ON TOP OF the ink.
 *
 * ⚠ THE LEADING IS DERIVED, NOT CHOSEN, and a fixed 0.02 was caught by the
 * overlap walk: a stroked glyph extends half a `lineWidth` past its cell on
 * every side, so a `label` over a `body` needs `GLYPH_WEIGHT·(a + b)/2` of gap
 * before a single pixel of clearance exists — 0.0222 in the main panel against
 * the 0.02 that was there. A constant that happens to work at one type scale is
 * a collision waiting for the next panel; `stackGap` is the real quantity.
 */
export const LEAD = 0.012;

/** The gap two stacked runs need: the round-cap ink envelope, plus `LEAD`. */
export const stackGap = (a: number, b: number) => (GLYPH_WEIGHT * (a + b)) / 2 + LEAD;

/** The height of a full-size caption-over-value stack in a panel. */
export const stackH = (pt: PanelType) =>
  pt.t('label') + stackGap(pt.t('label'), pt.t('body')) + pt.t('body');

/**
 * A CAPTION OVER A NUMBER — the one idiom every narrow surface in this stadium
 * is built from: the side columns' rows, the batter card's bottom band, the
 * pitcher panel, the celebration's payout.
 *
 * ⚠ IT IS ONE FUNCTION BECAUSE THE ALTERNATIVE IS FOUR COPIES OF THE SAME THREE
 * LINES that drift apart the first time the leading changes. Charter rule 3
 * ("one implementation per concept") is usually quoted at integrators and
 * parks; it applies to a label and a number just as hard.
 *
 * Returns the ops and the height consumed, so a caller can stack them.
 */
export function stack(o: {
  label: string;
  value: string;
  x: number;
  y: number;
  /** Width budget, fraction of surface width. */
  w: number;
  align: BoardAlign;
  pt: PanelType;
  color?: string;
  /** Caption colour. Overridden only where the caption sits on a lit ground —
   * `DIM` blue on the chain badge's red was measured unreadable in a render. */
  labelColor?: string;
}): { ops: BoardOp[]; h: number } {
  const cap = fitRun(o.label, o.w, 'label', o.pt);
  const val = fitRun(o.value, o.w, 'body', o.pt);
  const gap = stackGap(cap.size, val.size);
  const ops: BoardOp[] = [
    {
      kind: 'text',
      text: cap.text,
      x: o.x,
      y: o.y,
      size: cap.size,
      align: o.align,
      color: o.labelColor ?? DIM,
    },
    {
      kind: 'text',
      text: val.text,
      x: o.x,
      y: o.y + cap.size + gap,
      size: val.size,
      align: o.align,
      color: o.color ?? WHITE,
    },
  ];
  return { ops, h: cap.size + gap + val.size };
}

/** Background: flat ink plus horizontal scanlines, so it reads as an LED panel. */
export function backdrop(bg: string, rows = 32): BoardOp[] {
  const ops: BoardOp[] = [{ kind: 'panel', x: 0, y: 0, w: 1, h: 1, color: bg }];
  for (let i = 0; i < rows; i++) {
    ops.push({ kind: 'panel', x: 0, y: (i + 0.55) / rows, w: 1, h: 0.45 / rows, color: SCAN });
  }
  return ops;
}

/**
 * THE RASTERISER. The only part that touches a canvas, and it holds no state of
 * its own — every op sets the styles it uses, so nothing leaks between ops and
 * nothing is inherited from whatever the caller last did to the context.
 */
export function emitBoardOps(g: Board2D, ops: BoardOp[], wPx: number, hPx: number): void {
  g.clearRect(0, 0, wPx, hPx);
  for (const op of ops) {
    if (op.kind === 'panel') {
      g.fillStyle = op.color;
      g.fillRect(op.x * wPx, op.y * hPx, op.w * wPx, op.h * hPx);
    } else if (op.kind === 'poly') {
      g.fillStyle = op.color;
      g.beginPath();
      for (let i = 0; i + 1 < op.pts.length; i += 2) {
        const x = op.pts[i]! * wPx;
        const y = op.pts[i + 1]! * hPx;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
      g.fill();
    } else {
      strokeBoardText(g, op.text, op.x * wPx, op.y * hPx, op.size * hPx, op.color, op.align);
    }
  }
}
