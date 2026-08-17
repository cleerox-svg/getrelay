// The stadium's videoboard ARRAY — two `CanvasTexture`s and the upload policy
// behind them.
//
// ⚠ THIS IS A GAMEPLAY DISPLAY, NOT SET DRESSING. It shows the batter card the
// derby rests on, the outcome of the swing that just happened, and the home run
// that is the reason anybody is playing. It is built to the same standard as the
// reticle: it invents no numbers, it is deterministic, and it is asserted.
//
// ⚠ IT SUPPLIES THE PICTURE, NOT THE OBJECT. The caller builds the quads and the
// materials and places them in the park. What comes out of here is two textures,
// a panel table (`BOARD_PANELS` — each with the UV rect its quad must carry), an
// `update` and a `dispose`.
//
// ---------------------------------------------------------------------------
// THE THREE THINGS THIS FILE IS RESPONSIBLE FOR
// ---------------------------------------------------------------------------
//
// 1. THE CANVASES AND THE TEXTURES. One atlas canvas holding all four panels, so
//    four quads share ONE material and merge into ONE DRAW CALL; one long thin
//    ribbon canvas, tiled around the bowl, so every ribbon band in the stadium
//    is also one material. `generateMipmaps` is OFF and the min filter is
//    linear: a board that re-draws during a celebration would otherwise
//    regenerate a full mip chain on every upload.
//
// 2. THE UPLOAD POLICY, WHICH IS THE ONLY PERFORMANCE DECISION HERE. Triangles
//    are free; TEXEL TRAFFIC is not. 1024×512 RGBA is 2.0 MB per `needsUpdate`
//    and the ribbon is another 0.5 MB, so the rule is: re-upload **only when
//    that surface's picture would differ**. The two surfaces are keyed
//    SEPARATELY — a scrolling ribbon must not drag the atlas along with it.
//    The ribbon's SCROLL costs nothing at all: it is a texture offset.
//
// 3. NOTHING ELSE. No gameplay, no clock, no scene graph. `tS` is an argument.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
// No `Math.random`, no `performance.now()`, no `Date`. The caller passes seconds
// since the current state appeared, sourced from `lib/scene3d/clock.ts` — which
// the screenshot harness freezes — so a frozen scene paints one frame and then
// never uploads again, and two runs of the harness produce the same texels.
//
// The other half of that claim is that the DRAWING is machine-independent, which
// is why `boardGlyphs.ts` exists and why nothing here ever calls `fillText`.

import { CanvasTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';
import type { Board2D } from './boardGlyphs';
import type { BoardOp } from './boardPaint';
import { boardAnimFrame, emitBoardOps } from './boardPaint';
import type { BoardArray } from './boardState';
import { boardArrayKey } from './boardState';
import type { BoardGeometry } from './boardAtlas';
import {
  BOARD_ARRAY_ASPECT,
  BOARD_GEOMETRY,
  BOARD_PANELS,
  boardArrayOps,
  boardGeometryComplaints,
} from './boardAtlas';
import { RIBBON_H, RIBBON_W, ribbonKey, ribbonOffsetU, ribbonOps, ribbonWraps } from './boardRibbon';
import type { Disposable, Track } from './geom';
import type { StadiumQuality } from './quality';

export type { BoardOp } from './boardPaint';
export type { BoardArray, BoardScreen, BoardSide, BoardStrip, BoardTeam, BoardTone } from './boardState';
export { BOARD_ANIM_FPS, BOARD_ANIM_END_S, BOARD_ANIM_LAST_FRAME, MIN_LEGIBLE_CSS_PX } from './boardPaint';
export { BOARD_ARRAY_ASPECT, BOARD_GEOMETRY, BOARD_PANELS } from './boardAtlas';
export { HOME_RUN_WORD, boardResultRows } from './boardScreens';

/**
 * Atlas width, texels.
 *
 * ⚠ CHOSEN AGAINST THE ONLY CAMERA THAT READS THE BOARD, not by habit. From
 * `CAMERAS.batter` the reference 100 ft array spans 5.018 px/ft × 100 ft ≈ 502 px
 * of the harness's 900 px-wide frame, and ≈ 653 device px on a 1170-px phone. So
 * 1024 texels across is ~1.6 texels per device pixel — comfortably oversampled,
 * which is what keeps a stroked glyph's edge clean when the quad is minified.
 * 512 would be 0.78 texels/px, i.e. UNDER-sampled on the one surface whose whole
 * job is to be read; 2048 would quadruple the upload for a board that is never
 * larger than ~650 px on screen. No other camera gets closer: `flight` is 520 ft
 * out with a 55° fov, `wide` is 1000 ft up, and `pitcher` faces the other way.
 */
export const BOARD_TEXTURE_W = 1024;

/** Derived from the array's own proportions. Never re-typed. */
export const BOARD_TEXTURE_H = Math.round(BOARD_TEXTURE_W / BOARD_ARRAY_ASPECT);

/**
 * The canvas shape this module needs. Structural, so `HTMLCanvasElement`
 * satisfies it — and so a test can hand in a RECORDING surface with no jsdom, no
 * `node-canvas` and no WebGL. The vitest suite runs in a plain node environment,
 * which has no `document`; a builder that reached for `document.createElement`
 * unconditionally would be untestable there, and a display whose only test is a
 * screenshot is a display nobody asserts.
 */
export interface BoardCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): Board2D | null;
}

export interface ScoreboardConfig {
  /**
   * ⚠ THE REAL ARRAY THE SCENE BUILT. Defaults to `BOARD_GEOMETRY`, and a
   * geometry whose legibility floor lands under `MIN_LEGIBLE_CSS_PX` THROWS —
   * see `boardGeometryComplaints`. This is the seam that used to be a comment.
   */
  geometry?: BoardGeometry;
  /** Atlas width, texels. The height is DERIVED from the array's aspect. */
  widthPx?: number;
  /**
   * Only accepted so a caller can state its intent; it must equal the derived
   * height or the build throws. See the note on the field's use below.
   */
  heightPx?: number;
  /** Quality tier. `low` halves both textures; the picture is identical. */
  quality?: Pick<StadiumQuality, 'tier'>;
  /**
   * The composer's disposal register. Passing it is what puts the two textures
   * on the same teardown path as every other resource in the scene.
   */
  track?: Track;
  /**
   * Where a canvas comes from. Defaults to `document.createElement('canvas')`.
   * The tests inject; nothing in the app does.
   */
  createCanvas?: () => BoardCanvas;
}

export interface ScoreboardHandle {
  /** The panel atlas. Hand it to ONE material, shared by all four panel quads. */
  texture: CanvasTexture;
  /** The ribbon band. One material for every ribbon in the stadium. */
  ribbon: CanvasTexture;
  /** Where each panel's picture is — `uv` is what the quad's UVs must carry. */
  panels: typeof BOARD_PANELS;
  /** Tiles around the ring. Already applied to `ribbon.repeat.x`. */
  ribbonWraps: number;
  widthPx: number;
  heightPx: number;
  /**
   * Show `array`, `tS` seconds after it appeared. Returns TRUE if either texture
   * actually re-drew and re-uploaded.
   *
   * Safe to call every frame — that is the intended usage, and the whole point
   * of the key comparison is that doing so is free when nothing has changed.
   */
  update(array: BoardArray, tS: number): boolean;
  /**
   * What is on the array right now, or `null` before the first update.
   *
   * ⚠ A READ-BACK SEAM FOR THE GATE, and it deliberately reports what was
   * PAINTED rather than what was last passed in. `shoot-baseball.mjs`'s hardest
   * lesson is that a read-back which returns the setter's own argument cannot
   * fail; this returns the keys the paint was actually keyed on.
   */
  current(): { key: string; frame: number; ribbon: string; offsetU: number } | null;
  /**
   * ⚠ THIS MODULE'S OWN COUNT OF ITS REPAINTS — it is NOT read back off
   * `texture.version`, and an earlier commit message claimed it was. The
   * counter alone is self-referential: deleting `texture.needsUpdate = true`
   * leaves it perfectly correct and the board frozen. What closes that hole is
   * the ASSERTION, not this getter — `scoreboard.test.ts` reads `texture.version`
   * (which `three` increments inside the `needsUpdate` setter) beside this
   * number, and the counter is here because it is the one that can be compared
   * against a BUDGET.
   */
  uploads(): number;
  /** The same count for the ribbon, which is keyed separately. */
  ribbonUploads(): number;
  /** The last op list painted on the atlas — a COPY; the picture is not shared. */
  ops(): BoardOp[];
  /** The last op list painted on the ribbon. Also a copy. */
  ribbonOps(): BoardOp[];
  dispose(): void;
}

function defaultCanvas(): BoardCanvas {
  return document.createElement('canvas');
}

function makeTexture(canvas: BoardCanvas, name: string): CanvasTexture {
  // `CanvasTexture` wants a `TexImageSource`; `BoardCanvas` is the structural
  // subset this module uses. The cast is the seam that lets the suite run
  // without a DOM, and it is the ONLY place the two views of the canvas meet.
  const t = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = false;
  t.minFilter = LinearFilter;
  t.magFilter = LinearFilter;
  t.name = name;
  return t;
}

/**
 * Build the array's picture surfaces.
 *
 * ⚠ IT IS NOT `(ctx: StadiumCtx) => StadiumPart`, AND THAT IS DELIBERATE, not an
 * oversight — it is the one house shape this module does not fit. A
 * `StadiumPart` is `{ group: Group }`, and this builder adds nothing to the
 * scene graph: the quads are the scene's, because their size and position are
 * art. Returning an empty `Group` to satisfy the type would put a real, empty
 * object in the graph for the composer to add, traverse and dispose, in exchange
 * for a type check that would then be describing something untrue.
 *
 * What it DOES take is every field of `StadiumCtx` it can actually use —
 * `track` and `quality` — under those exact names, so the composer calls it as
 * `buildScoreboard({ ...ctx, geometry: BOARD_GEOMETRY })` and the textures land
 * on the same disposal path as every mesh in the park.
 */
export function buildScoreboard(cfg: ScoreboardConfig = {}): ScoreboardHandle {
  const geometry = cfg.geometry ?? BOARD_GEOMETRY;
  const complaints = boardGeometryComplaints(geometry);
  if (complaints.length > 0) {
    // ⚠ THROW, DO NOT DEGRADE. An unreadable board is not a smaller board — it
    // is a grey smear in centre field that every automated check passes and no
    // player can use. The failure has to be loud and it has to be at build time.
    throw new Error(`buildScoreboard: ${complaints.join('; ')}`);
  }

  const low = cfg.quality?.tier === 'low';
  const widthPx = cfg.widthPx ?? (low ? BOARD_TEXTURE_W / 2 : BOARD_TEXTURE_W);
  const heightPx = Math.round(widthPx / BOARD_ARRAY_ASPECT);
  if (cfg.heightPx !== undefined && cfg.heightPx !== heightPx) {
    // ⚠ THE ASPECT IS PLUMBING AND PLUMBING GOES UNASSERTED. `widthPx` and
    // `heightPx` used to be two independent options, so swapping them inside
    // this function passed the whole suite — the only other-size test used
    // 512×256, which has the SAME ratio as 1024×512, so a swap was invisible.
    // The height is derived now and a contradictory one is a build failure.
    throw new Error(
      `buildScoreboard: heightPx ${cfg.heightPx} contradicts widthPx ${widthPx} at ` +
        `aspect ${BOARD_ARRAY_ASPECT} (expected ${heightPx})`,
    );
  }
  const ribbonW = low ? RIBBON_W / 2 : RIBBON_W;
  const ribbonH = low ? RIBBON_H / 2 : RIBBON_H;

  const make = cfg.createCanvas ?? defaultCanvas;
  const atlasCanvas = make();
  atlasCanvas.width = widthPx;
  atlasCanvas.height = heightPx;
  const ribbonCanvas = make();
  ribbonCanvas.width = ribbonW;
  ribbonCanvas.height = ribbonH;

  const ga = atlasCanvas.getContext('2d');
  const gr = ribbonCanvas.getContext('2d');
  if (!ga || !gr) {
    throw new Error('buildScoreboard: the canvas has no 2D context');
  }

  const track = cfg.track ?? (<T extends Disposable>(r: T) => r);
  const texture = track(makeTexture(atlasCanvas, 'boardAtlas'));
  const ribbon = track(makeTexture(ribbonCanvas, 'boardRibbon'));
  const wraps = ribbonWraps(geometry);
  ribbon.wrapS = RepeatWrapping;
  ribbon.repeat.x = wraps;

  let key: string | null = null;
  let rKey: string | null = null;
  let frameNow = 0;
  let offsetNow = 0;
  let uploads = 0;
  let rUploads = 0;
  let atlasOps: BoardOp[] = [];
  let bandOps: BoardOp[] = [];
  let disposed = false;

  return {
    texture,
    ribbon,
    panels: BOARD_PANELS,
    ribbonWraps: wraps,
    widthPx,
    heightPx,
    update(array, tS) {
      // ⚠ DISPOSAL LATCHES. Without this a late `update()` from a render loop
      // that outlived the unmount repaints into a disposed texture — three has
      // already released the GPU handle, so it is a silent no-op at best and a
      // context warning at worst, and the module would happily report an upload.
      if (disposed) return false;
      const frame = boardAnimFrame(array.main, tS);
      let drew = false;

      const next = `${boardArrayKey(array)}#${frame}`;
      if (next !== key) {
        key = next;
        frameNow = frame;
        atlasOps = boardArrayOps(array, frame);
        emitBoardOps(ga, atlasOps, widthPx, heightPx);
        texture.needsUpdate = true;
        uploads++;
        drew = true;
      }

      const nextR = ribbonKey(array, frame);
      if (nextR !== rKey) {
        rKey = nextR;
        bandOps = ribbonOps(array, frame);
        emitBoardOps(gr, bandOps, ribbonW, ribbonH);
        ribbon.needsUpdate = true;
        rUploads++;
        drew = true;
      }

      // Free: an offset assignment, no upload. This is the scroll.
      offsetNow = ribbonOffsetU(array, tS, geometry);
      ribbon.offset.x = offsetNow;
      return drew;
    },
    current: () =>
      key === null ? null : { key, frame: frameNow, ribbon: rKey ?? '', offsetU: offsetNow },
    uploads: () => uploads,
    ribbonUploads: () => rUploads,
    // ⚠ COPIES. Returning `atlasOps` itself handed the caller the module's own
    // array; a test that sorted it in place, or a HUD that spliced it, would be
    // editing what the board believes it painted.
    ops: () => atlasOps.slice(),
    ribbonOps: () => bandOps.slice(),
    dispose() {
      disposed = true;
      texture.dispose();
      ribbon.dispose();
      key = null;
      rKey = null;
      atlasOps = [];
      bandOps = [];
    },
  };
}
