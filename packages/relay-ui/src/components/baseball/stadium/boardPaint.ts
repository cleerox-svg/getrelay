// The videoboard's DRAWING KIT — the op vocabulary, the palette, the type
// scale, the legibility floor, the time quantisation and the rasteriser.
//
// The screens themselves are in `boardScreens.ts`, split off here at the
// 500-line builder cap (extraction, not a raised cap). The seam: this file is
// what a screen is drawn WITH, that file is what is drawn. A seventh screen
// touches only that one; a change to the type scale lands here and every screen
// follows it.
//
// ⚠ THE LAYOUT IS A LIST OF OPS, NOT A SEQUENCE OF CANVAS CALLS, and that split
// is the single most important decision in this feature. `boardOps()` is a pure
// `(screen, frame, aspect) => BoardOp[]`: no canvas, no `three`, no clock. The
// rasteriser (`emitBoardOps`, at the foot of this file) does nothing but turn
// each op into strokes. Three things follow that a canvas-first version could
// not have:
//
//   • THE TESTS ASSERT THE PICTURE, NOT A SPY. "Was the distance drawn, in that
//     position, at that size, before the exit velocity?" is a question about an
//     array of plain objects. The alternative — `expect(ctx.fillText).toHaveBeen
//     Called()` — is the hollow-assertion shape this project keeps finding.
//   • LEGIBILITY IS ENFORCEABLE. `MIN_LEGIBLE_H` below is derived from the
//     camera, and because every text op carries its own `size`, a test can walk
//     EVERY op of EVERY screen and fail the one that is too small to read from
//     the batter's box. That is a design rule the compiler cannot state and a
//     screenshot can only hint at.
//   • RESOLUTION INDEPENDENCE. Ops are fractions — `x`/`w` of the canvas WIDTH,
//     `y`/`h`/`size` of its HEIGHT — so a low-tier 512×256 board is the same
//     picture as a 1024×512 one, not a second layout.
//
// ⚠ NO CLOCK, ANYWHERE. Every animated quantity is a function of `frame`, an
// integer the CALLER computed from `lib/scene3d/clock.ts`. See
// `boardAnimFrame`.
//
// ⚠ IT DECIDES NO GAMEPLAY. Every number in a `BoardScreen` was produced by the
// sim and handed here. The board computes distances, points and multipliers
// exactly as much as `swingCopy.ts` does — which is to say not at all.

import type { Board2D, BoardAlign } from './boardGlyphs';
import { GLYPH_TRACK, GLYPH_W, strokeBoardText } from './boardGlyphs';

// ---------------------------------------------------------------------------
// The screen states
// ---------------------------------------------------------------------------

/** The accent colour of a result line. Mirrors the OUTCOME, not the copy. */
export type BoardTone = 'gone' | 'good' | 'neutral' | 'miss';

/** One side of a duel line score. */
export interface BoardTeam {
  name: string;
  runs: number;
}

/**
 * Everything the board can show.
 *
 * ⚠ A DISCRIMINATED UNION SO THE DUEL IS A VARIANT, NOT A REWRITE. `duelScore`
 * already exists here and is already painted and tested, months before
 * `duelSim.ts` does — precisely so that the 3-inning mode cannot arrive and find
 * a board hard-coded to derby fields. Adding the next screen is a member plus a
 * painter plus a row in the test table; it is never a change to `scoreboard.ts`.
 *
 * Every field is a plain scalar. The board deliberately does NOT import
 * `DerbyState` or `SwingResult`: the HUD maps the sim's readout onto this shape
 * (the same way `swingCopy.ts` maps it onto a string), so the display layer has
 * no opinion about, and no coupling to, how the game is scored.
 */
export type BoardScreen =
  /** Pre-game / between-sessions. `label` is copy the caller owns. */
  | { kind: 'idle'; label: string }
  /** The derby's resting state: who is up, where we are, what it is worth. */
  | {
      kind: 'derbyBatter';
      batter: string;
      round: number;
      rounds: number;
      pitch: number;
      pitches: number;
      score: number;
      /** The chain multiplier, when it is EARNING. `null` = not on a chain. */
      chainX: number | null;
      /** Longest ball of the session, ft. `null` before the first one. */
      bestFt: number | null;
    }
  /**
   * The outcome of one swing.
   *
   * ⚠ `line` IS `swingCopy.describeSwing(r)`, VERBATIM. The board does not own a
   * second vocabulary for the same eight outcomes — the charter's "one
   * implementation per concept" applied to words. The caller passes the string
   * the HUD is already printing; this screen decides only how big it is and
   * where it sits. `boardResultRows` splits it on the ` · ` separator that
   * `describeSwing` itself uses, so a long line becomes two legible rows rather
   * than one unreadable one.
   */
  | { kind: 'result'; line: string; tone: BoardTone }
  /** The money moment. The only screen that animates. */
  | {
      kind: 'homeRun';
      distFt: number;
      evMph: number;
      laDeg: number;
      points: number;
      chainX: number | null;
    }
  /** Between rounds. */
  | {
      kind: 'roundSummary';
      round: number;
      rounds: number;
      roundScore: number;
      homeRuns: number;
      bestFt: number;
      total: number;
    }
  /** DUEL-READY, and shipped now on purpose — see the union's note. */
  | {
      kind: 'duelScore';
      away: BoardTeam;
      home: BoardTeam;
      inning: number;
      half: 'top' | 'bot';
      outs: number;
      balls: number;
      strikes: number;
    };

// ---------------------------------------------------------------------------
// Time — quantised, so that "what is painted" is a finite key
// ---------------------------------------------------------------------------

/**
 * How often the animated screen re-draws, Hz. **FEEL KNOB with a measured
 * cost**, and it is a texture-UPLOAD budget more than a look: a 1024×512 RGBA
 * canvas is 2.0 MB per `needsUpdate`, so 12 Hz is 24 MB/s while the home-run
 * celebration is on screen and **exactly zero** either side of it. At 60 Hz it
 * would be 120 MB/s, which is the kind of number that costs frames on a phone
 * for an effect nobody can see at 12.
 */
export const BOARD_ANIM_FPS = 12;

/**
 * When the home-run screen stops moving, s. After this the frame index CLAMPS,
 * so the paint key stops changing and the board stops uploading entirely while
 * the celebration is still on screen. Feel knob.
 */
export const BOARD_ANIM_END_S = 2.6;

/** The last animated frame index. Derived. */
export const BOARD_ANIM_LAST_FRAME = Math.round(BOARD_ANIM_END_S * BOARD_ANIM_FPS);

/**
 * The animation frame a screen is on at `tS` seconds since it appeared.
 *
 * ⚠ QUANTISING HERE IS WHAT MAKES THE PICTURE A FUNCTION OF THE KEY. `boardOps`
 * takes the integer, never `tS`, so two calls that produce the same frame
 * produce byte-identical ops — which is exactly the invariant the upload policy
 * in `scoreboard.ts` relies on when it skips a repaint. A painter that read
 * `tS` directly would drift silently: the key would say "unchanged" while the
 * picture had moved on.
 *
 * Static screens return 0 always, so they never repaint and never upload.
 */
export function boardAnimFrame(screen: BoardScreen, tS: number): number {
  if (screen.kind !== 'homeRun') return 0;
  if (!Number.isFinite(tS) || tS <= 0) return 0;
  return Math.min(Math.floor(tS * BOARD_ANIM_FPS), BOARD_ANIM_LAST_FRAME);
}

/**
 * A string that changes whenever the PICTURE would.
 *
 * `JSON.stringify` is chosen for a stated reason: it can produce a spurious
 * change (two objects with the same fields in a different key order), which
 * costs one extra upload, but it can never MISS one — and a missed repaint is a
 * board showing the last batter's numbers.
 */
export function boardScreenKey(screen: BoardScreen): string {
  return JSON.stringify(screen);
}

// ---------------------------------------------------------------------------
// Palette and type scale
// ---------------------------------------------------------------------------

// Royal blue / red / white, per BASEBALL.md's Toronto homage. A colour scheme,
// not a mark.
export const INK = '#08122b';
export const PANEL = '#0f2050';
const SCAN = '#0b1836';
export const RULE = '#1f4fd8';
export const RED = '#d7263d';
export const WHITE = '#f4f8ff';
export const DIM = '#6d8ad6';
export const GOLD = '#ffc233';
const GREEN = '#2fb46b';

export const TONE_COLOR: Record<BoardTone, string> = {
  gone: GOLD,
  good: GREEN,
  neutral: RULE,
  miss: RED,
};

/**
 * ⚠ THE SMALLEST TEXT THE BOARD MAY EVER DRAW, as a fraction of board height —
 * and it is DERIVED from the camera, not chosen.
 *
 * The reference board is 100 ft × 50 ft with its face 430 ft from the plate
 * (just beyond Harbourfront's 400 ft centre-field wall). `CAMERAS.batter` stands
 * at scene [0, 3.2, 8] with a 40° VERTICAL fov, so the board is 438 ft away and
 * the harness's 900×1600 portrait frame spans
 *
 *     2 · 438 · tan 20° = 318.8 ft   over 1600 px   ⇒   5.018 px/ft
 *
 * That is the SCREENSHOT's scale. A phone is ~390 CSS px wide where the shot is
 * 900, so on the device it is 5.018 × 390/900 = **2.175 CSS px per foot** of
 * board. Taking ~10 CSS px of cap height as the floor for reading a word at a
 * glance and ~14 px as comfortable:
 *
 *     10 CSS px  ⇒  4.60 ft of glyph  ⇒  0.092 of a 50 ft board   ← this constant
 *     14 CSS px  ⇒  6.44 ft of glyph  ⇒  0.129                    ← `T_BODY`
 *
 * ⚠ AND THE HONEST CONSEQUENCE: a real videoboard sets its body copy at roughly
 * 1.5–2.5 ft, which lands at 3–5 CSS px here and cannot be read at all. This
 * board therefore runs at about **3× a real board's type scale** and carries
 * four or five rows of information where a real one carries twenty. That is a
 * design finding, not a bug — but it means "put the whole box score up there"
 * is not available, and any future screen has to be budgeted in rows.
 *
 * `scoreboard.test.ts` walks every op of every screen against this number.
 */
export const MIN_LEGIBLE_H = 0.092;

/**
 * ⚠ THE REFERENCE BOARD `MIN_LEGIBLE_H` IS DERIVED FROM — exported because it is
 * an INTEGRATION CONTRACT, not documentation.
 *
 * The board's real size and position are scene art and belong to whoever owns
 * the bowl and the truss, not to this module. But every legibility number above
 * scales linearly with `heightFt / distFt`, so a board built at, say, 60 ft wide
 * instead of 100 silently makes `MIN_LEGIBLE_H` a 6 CSS px lie and the whole
 * floor stops meaning anything. Exporting the assumption lets the integration
 * ASSERT it — `boardLegibleCssPx()` below is the one-line check — instead of
 * discovering it in a screenshot nobody could read.
 */
export const BOARD_REF = { widthFt: 100, heightFt: 50, faceDistFt: 430 } as const;

/** `CAMERAS.batter`'s eye, scene ft, and its vertical fov. Duplicated on purpose:
 * importing `camera.ts` here would pull the rig into a module whose whole point
 * is that it is pure layout. The values are asserted against `CAMERAS.batter` in
 * `scoreboard.test.ts`, so the copy cannot drift. */
const BATTER_EYE_Z_FT = 8;
const BATTER_FOV_DEG = 40;
/** Portrait phone: CSS px across, and the harness frame's px across. */
const PHONE_CSS_W = 390;
const SHOT_PX_W = 900;
const SHOT_PX_H = 1600;

/**
 * How many CSS pixels of glyph a text `size` becomes on a phone, from the batter
 * camera, for a board of the given height at the given face distance.
 *
 * Pure trigonometry, written out so the integration can re-run it against the
 * board it actually built.
 */
export function boardLegibleCssPx(
  size: number,
  heightFt: number = BOARD_REF.heightFt,
  faceDistFt: number = BOARD_REF.faceDistFt,
): number {
  const depth = faceDistFt + BATTER_EYE_Z_FT;
  const frameFt = 2 * depth * Math.tan(((BATTER_FOV_DEG / 2) * Math.PI) / 180);
  const shotPxPerFt = SHOT_PX_H / frameFt;
  const cssPxPerFt = shotPxPerFt * (PHONE_CSS_W / SHOT_PX_W);
  return size * heightFt * cssPxPerFt;
}

export const T_HERO = 0.32;
export const T_HEAD = 0.19;
export const T_TITLE = 0.155;
export const T_BODY = 0.13;
export const T_LABEL = 0.095;

// ---------------------------------------------------------------------------
// The op list
// ---------------------------------------------------------------------------

/**
 * One drawing instruction. `x`/`w` are fractions of the canvas WIDTH; `y`, `h`
 * and `size` are fractions of its HEIGHT. `poly.pts` is `[x0, y0, x1, y1, …]` in
 * those same two units.
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

/** Width of a run of `n` monospaced cells, in units of board HEIGHT. */
export const runH = (n: number) => (n === 0 ? 0 : n * (GLYPH_W + GLYPH_TRACK) - GLYPH_TRACK);

/**
 * The largest size at or below `cap` that fits `text` into `maxFracW` of the
 * board's width. Monospaced advance makes this exact arithmetic rather than a
 * measure-and-retry loop — which also means it works with no canvas in sight.
 */
export function fit(text: string, maxFracW: number, cap: number, aspect: number): number {
  const cells = runH(text.length);
  if (cells <= 0) return cap;
  return Math.min(cap, (maxFracW * aspect) / cells);
}

export const int = (v: number) => Math.round(v).toString();

/** Background: flat ink plus horizontal scanlines, so it reads as an LED panel. */
export function backdrop(bg: string): BoardOp[] {
  const ops: BoardOp[] = [{ kind: 'panel', x: 0, y: 0, w: 1, h: 1, color: bg }];
  const rows = 32;
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
