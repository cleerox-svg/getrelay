// The stadium's videoboard — a `CanvasTexture` and the state machine behind it.
//
// ⚠ THIS IS A GAMEPLAY DISPLAY, NOT SET DRESSING. It shows the batter card the
// derby rests on, the outcome of the swing that just happened, and the home run
// that is the reason anybody is playing. The owner's brief was "use the screen
// for in game things", so it is built to the same standard as the reticle: it
// invents no numbers, it is deterministic, and it is asserted.
//
// ⚠ IT SUPPLIES THE PICTURE, NOT THE OBJECT. The caller builds the quad and the
// material and places it in the park — the board's SIZE and POSITION are scene
// art and belong with the bowl, the roof and the fence, which a different
// milestone owns. What comes out of here is a texture, an `update` and a
// `dispose`. Build the quad at `BOARD_ASPECT` or the picture is stretched; that
// is the one geometric contract, and it is exported so nobody re-types 2.0.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THIS FILE IS RESPONSIBLE FOR
// ---------------------------------------------------------------------------
//
// 1. THE CANVAS AND THE TEXTURE. One canvas, one `CanvasTexture`, one material's
//    worth of upload. `generateMipmaps` is OFF and the min filter is linear: a
//    board that re-draws during a celebration would otherwise regenerate a full
//    mip chain on every upload, and the board is a near-flat surface facing the
//    batter, so the chain buys nothing.
//
// 2. THE UPLOAD POLICY, WHICH IS THE ONLY PERFORMANCE DECISION HERE. Triangles
//    are free (the caller draws one quad); TEXEL TRAFFIC is not. 1024×512 RGBA is
//    2.0 MB per `needsUpdate`, so the rule is: re-upload **only when the picture
//    would differ**. `boardPaint.ts` makes that decidable by quantising time —
//    the picture is a pure function of `(screen, frame)`, so the pair is a KEY,
//    and an update whose key is unchanged does nothing at all. Measured
//    consequence: a whole derby at rest costs **zero** uploads per frame, and the
//    home-run celebration costs 12 per second for 2.6 s and then zero, because
//    `boardAnimFrame` clamps.
//
// 3. NOTHING ELSE. No gameplay, no clock, no scene graph. `tS` is an argument.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
// No `Math.random`, no `performance.now()`, no `Date`. The caller passes seconds
// since the current screen appeared, sourced from `lib/scene3d/clock.ts` — which
// the screenshot harness freezes — so a frozen scene paints one frame and then
// never uploads again, and two runs of the harness produce the same texels.
//
// The other half of that claim is that the DRAWING is machine-independent, which
// is why `boardGlyphs.ts` exists and why this file never calls `fillText`. The
// measurement behind that decision is in that file's header.

import { CanvasTexture, LinearFilter, SRGBColorSpace } from 'three';
import type { Board2D } from './boardGlyphs';
import type { BoardOp, BoardScreen } from './boardPaint';
import { boardAnimFrame, boardScreenKey, emitBoardOps } from './boardPaint';
import { boardOps } from './boardScreens';

export type { BoardOp, BoardScreen, BoardTeam, BoardTone } from './boardPaint';
export { BOARD_ANIM_FPS, BOARD_ANIM_END_S, BOARD_ANIM_LAST_FRAME, MIN_LEGIBLE_H } from './boardPaint';
export { HOME_RUN_WORD, boardResultRows } from './boardScreens';

/**
 * Texture size, texels.
 *
 * ⚠ CHOSEN AGAINST THE ONLY CAMERA THAT READS THE BOARD, not by habit. From
 * `CAMERAS.batter` the reference 100 ft board spans 5.018 px/ft × 100 ft ≈ 502 px
 * of the harness's 900 px-wide frame, and ≈ 653 device px on a 1170-px phone. So
 * 1024 texels across is ~1.6 texels per device pixel — comfortably oversampled,
 * which is what keeps a stroked glyph's edge clean when the quad is minified.
 * 512 would be 0.78 texels/px, i.e. UNDER-sampled on the one surface whose whole
 * job is to be read; 2048 would quadruple the upload for a board that is never
 * larger than ~650 px on screen. No other camera gets closer: `flight` is 520 ft
 * out with a 55° fov, `wide` is 1000 ft up, and `pitcher` faces the other way.
 *
 * A low-tier caller may pass a smaller pair — the layout is fractional, so the
 * picture is identical and only the sharpness moves.
 */
export const BOARD_TEXTURE_W = 1024;
export const BOARD_TEXTURE_H = 512;

/** The quad the caller must build. Derived — never re-typed as `2`. */
export const BOARD_ASPECT = BOARD_TEXTURE_W / BOARD_TEXTURE_H;

/**
 * The canvas shape this module needs. Structural, so `HTMLCanvasElement`
 * satisfies it — and so a test can hand in a RECORDING surface with no jsdom, no
 * `node-canvas` and no WebGL. The vitest suite runs in a plain node environment
 * (see `vitest.config.ts`), which has no `document`; a builder that reached for
 * `document.createElement` unconditionally would be untestable there, and a
 * display whose only test is a screenshot is a display nobody asserts.
 */
export interface BoardCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): Board2D | null;
}

export interface ScoreboardConfig {
  /** Texel width. Default `BOARD_TEXTURE_W`. */
  widthPx?: number;
  /** Texel height. Default `BOARD_TEXTURE_H`. */
  heightPx?: number;
  /**
   * Where the canvas comes from. Defaults to `document.createElement('canvas')`.
   * The tests inject; nothing in the app does.
   */
  createCanvas?: () => BoardCanvas;
}

export interface ScoreboardHandle {
  /** Hand this to the caller's own material as its `map`. */
  texture: CanvasTexture;
  widthPx: number;
  heightPx: number;
  /**
   * Show `screen`, `tS` seconds after it appeared. Returns TRUE if the board
   * actually re-drew and re-uploaded.
   *
   * Safe to call every frame — that is the intended usage, and the whole point
   * of the key comparison is that doing so is free when nothing has changed.
   */
  update(screen: BoardScreen, tS: number): boolean;
  /**
   * What is on the board right now: the paint key and the animation frame, or
   * `null` before the first update.
   *
   * ⚠ A READ-BACK SEAM FOR THE GATE, and it deliberately reports what was
   * PAINTED rather than what was last passed in. `shoot-baseball.mjs`'s hardest
   * lesson is that a read-back which returns the setter's own argument cannot
   * fail (see its note on `ballScene()`); this returns the key the paint was
   * actually keyed on.
   */
  current(): { key: string; frame: number } | null;
  /** How many times the texture has been re-uploaded. The budget read-back. */
  uploads(): number;
  /** The last op list painted — what the picture IS, for a test or the gate. */
  ops(): BoardOp[];
  dispose(): void;
}

function defaultCanvas(): BoardCanvas {
  return document.createElement('canvas');
}

/**
 * Build the board's picture surface.
 *
 * A pure `(cfg) => handle` in the house style, except that it adds nothing to
 * the scene, so it takes a config rather than a `StadiumCtx`: it has no geometry
 * to own and no `track()` to register with. The caller disposes the material and
 * the geometry it built; `dispose()` here disposes the texture.
 */
export function buildScoreboard(cfg: ScoreboardConfig = {}): ScoreboardHandle {
  const widthPx = cfg.widthPx ?? BOARD_TEXTURE_W;
  const heightPx = cfg.heightPx ?? BOARD_TEXTURE_H;
  const canvas = (cfg.createCanvas ?? defaultCanvas)();
  canvas.width = widthPx;
  canvas.height = heightPx;

  const g = canvas.getContext('2d');
  if (!g) {
    // ⚠ THROW, DO NOT DEGRADE. A board that silently draws nothing is a black
    // rectangle in the middle of centre field that every automated check passes.
    throw new Error('buildScoreboard: the canvas has no 2D context');
  }

  // `CanvasTexture` wants a `TexImageSource`; `BoardCanvas` is the structural
  // subset this module uses. The cast is the seam that lets the suite run
  // without a DOM, and it is the ONLY place the two views of the canvas meet.
  const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.name = 'scoreboard';

  let key: string | null = null;
  let frameNow = 0;
  let uploads = 0;
  let lastOps: BoardOp[] = [];
  const aspect = widthPx / heightPx;

  return {
    texture,
    widthPx,
    heightPx,
    update(screen, tS) {
      const frame = boardAnimFrame(screen, tS);
      const next = `${boardScreenKey(screen)}#${frame}`;
      if (next === key) return false;
      key = next;
      frameNow = frame;
      lastOps = boardOps(screen, frame, aspect);
      emitBoardOps(g, lastOps, widthPx, heightPx);
      texture.needsUpdate = true;
      uploads++;
      return true;
    },
    current: () => (key === null ? null : { key, frame: frameNow }),
    uploads: () => uploads,
    ops: () => lastOps,
    dispose() {
      texture.dispose();
      key = null;
      lastOps = [];
    },
  };
}
