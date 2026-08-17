// THE PANEL ATLAS — where each display surface lives on the one texture, how
// big it is in the park, and the composite that paints all of them at once.
//
// ⚠ THE BOARD IS AN ARRAY, AND THIS FILE IS THE CONTRACT BETWEEN THE PICTURE AND
// THE GEOMETRY. The owner's reference photograph of the real venue shows a large
// central video panel, a stats column to its left, a pitcher panel to its right
// and a wide linescore strip below, all set into a dark architectural frame.
// This module owns the PICTURE — one canvas, four regions. The scene owns the
// GEOMETRY — four quads, each reading its own UV rect out of that one texture,
// with ONE material, so the whole array merges into ONE DRAW CALL.
//
// ⚠ THE ATLAS IS A SCALE MODEL OF THE ARRAY, and that is a deliberate choice
// against a tighter packing. A shelf packer would save the ~10 % of texels that
// the frame gaps occupy; laying the panels out in their real arrangement instead
// buys three things worth more than 9 % of a 2 MB texture:
//
//   • THE UV RECTS ARE DERIVED, NOT AUTHORED. `uv` is `xFt/widthFt` and nothing
//     else, so there is no second table to keep in step with the first, and the
//     charter's "never hand-set a derived value" holds for the atlas too.
//   • THE TEXTURE LOOKS LIKE THE BOARD. The visual gate photographs a canvas; a
//     packed atlas is a jumble no reviewer can eyeball, and "the strip is
//     painting the pitcher's data" is instantly visible in a scale model.
//   • THE GAPS ARE FREE GUARD BANDS. Linear filtering samples a texel either
//     side of a UV edge, so a tight pack needs authored padding to stop one
//     panel bleeding into its neighbour. Here the architectural frame IS the
//     padding, at no cost.
//
// ⚠ WHAT IS NOT HERE: the architectural surround. The hotel window band, the
// banners above the array and the truss it hangs from are scene geometry and
// belong to the art slice, not to a texture module. This file assumes DISPLAY
// SURFACES ONLY and publishes the rectangle they occupy; what frames that
// rectangle is somebody else's.

import type { BoardOp } from './boardPaint';
import {
  BOARD_REF,
  FRAME,
  INK,
  MIN_LEGIBLE_CSS_PX,
  MIN_LEGIBLE_FT,
  boardCssPxPerFt,
  backdrop,
  panelType,
} from './boardPaint';
import type { PanelType } from './boardPaint';
import { GLYPH_TRACK, GLYPH_W } from './boardGlyphs';
import type { BoardArray } from './boardState';
import { normaliseArray } from './boardState';
import { boardMainOps } from './boardScreens';
import {
  celebrationSideOps,
  celebrationSides,
  celebrationStripOps,
  defaultSides,
  sideOps,
  stripOps,
} from './boardPanels';

export type BoardPanelId = 'stats' | 'main' | 'pitcher' | 'strip';

/** A panel's placement on the array face, ft, measured from its TOP-LEFT. */
export interface BoardPanelSpec {
  id: BoardPanelId;
  xFt: number;
  yFt: number;
  wFt: number;
  hFt: number;
}

/**
 * ⚠ THE ONE PLACE THE ARRAY'S PROPORTIONS ARE STATED. Authored against
 * `BOARD_REF` (100 × 50 ft); everything else — UV rects, aspect ratios, type
 * fractions, character budgets — is derived from these twelve numbers.
 *
 * ⚠ RE-SOLVED FOR A 66 × 33 FACE. See `BOARD_REF` for why the reference moved
 * (it did not fit the batter camera's frustum) and `scoreboard.test.ts` for the
 * budget table this arrangement produces. Every constraint below is the SAME
 * constraint as before, re-evaluated at the corrected legibility floor — which
 * is 2.286 ft of glyph, not the 4.599 ft the old arrangement was solved at,
 * because that number came off a 40° lens that no longer exists.
 *
 * The 1.0 ft frame gap and the 1.0 ft outer margin are art and did NOT scale
 * with the board; a foot of dark surround on a 33 ft face is proportionally
 * twice what it was, which reads MORE like an array of panels and not less.
 * The sizes:
 *
 *   • the side columns are 12 ft, which is 6 characters at the floor — down
 *     from 10 on the old 18 ft column, and still comfortably over the 5-digit
 *     score that was the binding case when the floor was twice as coarse.
 *   • the main panel is 38 ft, which is 21 characters — the longest single row
 *     the HUD's own vocabulary can produce is `Swing and a miss` at sixteen, and
 *     a RENDER of the old 59 ft panel setting it as `SWING AND A MI…` is why
 *     that constraint is written down rather than assumed. 21 ≥ 16 with five
 *     characters of margin.
 *   • the strip is 8 ft tall and it is the BINDING SURFACE of this arrangement.
 *     It carries three rows — headings and two teams — and three rows of
 *     round-capped ink is 3 × 2.286 × 1.13 = 7.75 ft, so 8 ft leaves 0.25 ft.
 *     Every other panel could have been smaller; this one could not.
 *   • the upper row is 22 ft because that is the smallest height at which a side
 *     column still carries TWO caption-over-value rows (`sideRowBudget`), and
 *     dropping to one would have cost the board a field. 22 + 8 + three 1 ft
 *     gaps and margins is 33 exactly, so the vertical arrangement has no slack
 *     at all — which is stated rather than hidden, because the next person to
 *     add a row needs to know they are taking it from somewhere.
 */
export const BOARD_PANEL_SPECS: readonly BoardPanelSpec[] = [
  { id: 'stats', xFt: 1.0, yFt: 1.0, wFt: 12.0, hFt: 19.0 },
  { id: 'main', xFt: 14.0, yFt: 1.0, wFt: 38.0, hFt: 19.0 },
  { id: 'pitcher', xFt: 53.0, yFt: 1.0, wFt: 12.0, hFt: 19.0 },
  { id: 'strip', xFt: 1.0, yFt: 21.0, wFt: 64.0, hFt: 11.0 },
] as const;

/** The quad the caller must build for the WHOLE array. Derived — never re-typed. */
export const BOARD_ARRAY_ASPECT = BOARD_REF.widthFt / BOARD_REF.heightFt;

/**
 * A rect on the atlas in CANVAS fractions — x right, y DOWN, origin top-left.
 * This is what op coordinates are mapped through.
 */
export interface AtlasRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A rect in THREE's UV space — u right, v UP, origin bottom-left. This is what
 * the scene writes into the quad's `uv` attribute.
 */
export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface BoardPanel extends BoardPanelSpec {
  rect: AtlasRect;
  uv: UvRect;
  type: PanelType;
}

function derivePanel(s: BoardPanelSpec): BoardPanel {
  const { widthFt: W, heightFt: H } = BOARD_REF;
  return {
    ...s,
    rect: { x: s.xFt / W, y: s.yFt / H, w: s.wFt / W, h: s.hFt / H },
    uv: {
      u0: s.xFt / W,
      u1: (s.xFt + s.wFt) / W,
      v0: 1 - (s.yFt + s.hFt) / H,
      v1: 1 - s.yFt / H,
    },
    type: panelType(s.id, s.wFt, s.hFt),
  };
}

export const BOARD_PANELS: readonly BoardPanel[] = BOARD_PANEL_SPECS.map(derivePanel);

export const boardPanel = (id: BoardPanelId): BoardPanel =>
  BOARD_PANELS.find((p) => p.id === id)!;

// ---------------------------------------------------------------------------
// The information budget, measured
// ---------------------------------------------------------------------------

/**
 * How many characters a surface of this width carries at the legibility floor.
 *
 * Exact inverse of `runH` at `MIN_LEGIBLE_FT`, and note that the panel's HEIGHT
 * cancels out entirely: the type scale is absolute feet, so a column's character
 * budget is a property of its width in the park and nothing else.
 */
export const panelCharBudget = (widthFt: number) =>
  Math.floor((widthFt / MIN_LEGIBLE_FT + GLYPH_TRACK) / (GLYPH_W + GLYPH_TRACK) + 1e-9);

/** How many floor-height rows a surface of this height carries, ignoring leading. */
export const panelRowBudget = (heightFt: number) => Math.floor(heightFt / MIN_LEGIBLE_FT);

// ---------------------------------------------------------------------------
// The integration contract
// ---------------------------------------------------------------------------

/**
 * ⚠ WHAT THE SCENE MUST HAND THIS MODULE, exported the way `parks.ts` exports
 * fence data: ONE constant, read by the picture AND by the geometry, so the
 * board you can read is the board that got built.
 *
 * The scene module owns these numbers because they are art. This module owns
 * what happens when they make the display unreadable, which is
 * `boardGeometryComplaints` below — and `buildScoreboard` THROWS on a complaint
 * rather than shipping a grey smear that every automated check passes.
 */
export interface BoardGeometry {
  /** The array face — the outer bound of all four display panels, ft. */
  widthFt: number;
  heightFt: number;
  /** Plate to the array face, ft. */
  faceDistFt: number;
  /** The ribbon band's height, ft, and the radius of the ring it wraps. */
  ribbonHeightFt: number;
  ribbonRadiusFt: number;
}

/** The default geometry — the reference array `MIN_LEGIBLE_FT` was derived at. */
export const BOARD_GEOMETRY: BoardGeometry = {
  widthFt: BOARD_REF.widthFt,
  heightFt: BOARD_REF.heightFt,
  faceDistFt: BOARD_REF.faceDistFt,
  // ⚠ NOMINAL, AND THE SCENE DOES NOT USE THEM. `board.boardGeometryFor`
  // MEASURES both off the bowl it actually built — `stands.ribbonHeightFt` and
  // `stands.ribbonRingFt` — because the tile count that keeps a ribbon glyph the
  // same shape in the park as on the texture is derived from the band's real
  // height and the ring's real arc length, and this bowl is not a circle. These
  // two survive as the DEFAULT a test can reason about, not as a dimension.
  ribbonHeightFt: 5.0,
  ribbonRadiusFt: 300,
};

/**
 * The smallest glyph the array will draw, in CSS px on a phone, AT THE SUPPLIED
 * GEOMETRY.
 *
 * Type sizes are fractions of panel height and panels are fractions of the
 * array, so the whole scale is linear in `heightFt`: an array built at 30 ft
 * tall draws every glyph at 0.6× the size the floor was derived for.
 */
export const boardFloorCssPx = (g: BoardGeometry) =>
  MIN_LEGIBLE_FT * (g.heightFt / BOARD_REF.heightFt) * boardCssPxPerFt(g.faceDistFt);

/**
 * Everything wrong with a proposed array geometry. Empty = build it.
 *
 * ⚠ THIS IS THE SEAM THAT USED TO BE UNGUARDABLE, AND IT WAS NOT. The old
 * module exported `BOARD_REF` as documentation and hoped: a 30 ft board at the
 * same range put the real floor at 6.0 CSS px, made `MIN_LEGIBLE_H` a lie, and
 * THE WHOLE SUITE STILL PASSED because nothing here could see the geometry.
 * Taking the geometry as an argument converts a silently unreadable board into
 * a loud failure at build time.
 */
export function boardGeometryComplaints(g: BoardGeometry): string[] {
  const bad: string[] = [];
  for (const [k, v] of Object.entries(g)) {
    if (!Number.isFinite(v) || (v as number) <= 0) bad.push(`${k}: ${v} is not a positive number`);
  }
  if (bad.length > 0) return bad;

  const px = boardFloorCssPx(g);
  if (px < MIN_LEGIBLE_CSS_PX) {
    bad.push(
      `a ${g.widthFt}×${g.heightFt} ft array at ${g.faceDistFt} ft puts the smallest glyph at ` +
        `${px.toFixed(1)} CSS px, under the ${MIN_LEGIBLE_CSS_PX} px floor — it needs to be ` +
        `${(BOARD_REF.heightFt * (MIN_LEGIBLE_CSS_PX / px)).toFixed(1)} ft tall at that range`,
    );
  }
  const aspect = g.widthFt / g.heightFt;
  if (Math.abs(aspect - BOARD_ARRAY_ASPECT) > 0.02) {
    bad.push(
      `array aspect ${aspect.toFixed(3)} is not the ${BOARD_ARRAY_ASPECT.toFixed(3)} the panel ` +
        `table is authored at — the panels would be stretched`,
    );
  }
  return bad;
}

/**
 * Everything wrong with the PANEL TABLE itself, run as a test. Charter rule 4:
 * content is data, and a `validate*()` run as a test makes bad data a test
 * failure rather than a render nobody looks at closely enough.
 */
export function validateBoardAtlas(): string[] {
  const bad: string[] = [];
  const seen = new Set<string>();
  const { widthFt: W, heightFt: H } = BOARD_REF;
  for (const p of BOARD_PANEL_SPECS) {
    if (seen.has(p.id)) bad.push(`${p.id}: duplicate id`);
    seen.add(p.id);
    if (p.wFt <= 0 || p.hFt <= 0) bad.push(`${p.id}: non-positive size`);
    if (p.xFt < 0 || p.yFt < 0 || p.xFt + p.wFt > W || p.yFt + p.hFt > H) {
      bad.push(`${p.id}: outside the ${W}×${H} array face`);
    }
    if (panelCharBudget(p.wFt) < 3) {
      bad.push(`${p.id}: ${p.wFt} ft carries ${panelCharBudget(p.wFt)} characters — under three`);
    }
    if (panelRowBudget(p.hFt) < 2) {
      bad.push(`${p.id}: ${p.hFt} ft carries ${panelRowBudget(p.hFt)} rows — under two`);
    }
  }
  for (let i = 0; i < BOARD_PANEL_SPECS.length; i++) {
    for (let j = i + 1; j < BOARD_PANEL_SPECS.length; j++) {
      const a = BOARD_PANEL_SPECS[i]!;
      const b = BOARD_PANEL_SPECS[j]!;
      const gapX = Math.max(a.xFt - (b.xFt + b.wFt), b.xFt - (a.xFt + a.wFt));
      const gapY = Math.max(a.yFt - (b.yFt + b.hFt), b.yFt - (a.yFt + a.hFt));
      const gap = Math.max(gapX, gapY);
      if (gap < MIN_FRAME_GAP_FT) {
        bad.push(`${a.id}/${b.id}: ${gap.toFixed(2)} ft apart, under the ${MIN_FRAME_GAP_FT} ft frame gap`);
      }
    }
  }
  return bad;
}

/** The architectural frame between two panels, ft. Art — and a UV guard band. */
export const MIN_FRAME_GAP_FT = 1.0;

// ---------------------------------------------------------------------------
// The composite
// ---------------------------------------------------------------------------

/** Move a panel-local op list into atlas coordinates. */
export function mapOps(ops: BoardOp[], r: AtlasRect): BoardOp[] {
  return ops.map((op) => {
    if (op.kind === 'panel') {
      return { ...op, x: r.x + op.x * r.w, y: r.y + op.y * r.h, w: op.w * r.w, h: op.h * r.h };
    }
    if (op.kind === 'poly') {
      const pts = op.pts.map((v, i) => (i % 2 === 0 ? r.x + v * r.w : r.y + v * r.h));
      return { ...op, pts };
    }
    return { ...op, x: r.x + op.x * r.w, y: r.y + op.y * r.h, size: op.size * r.h };
  });
}

/**
 * A panel with nothing to say: LIT BUT EMPTY, not dark.
 *
 * ⚠ IT WAS `FRAME`-COLOURED AND A RENDER SHOWED WHY THAT IS WRONG. A panel the
 * same shade as the architectural surround does not read as an idle screen, it
 * reads as an array that is only one rectangle wide — which is precisely the
 * impression this whole design exists to undo. An empty LED panel is on and
 * blank, scanlines and all.
 */
const dark = (): BoardOp[] => backdrop(INK);

/**
 * THE WHOLE ARRAY'S PICTURE, as data. Pure: same `(array, frame)` ⇒ deep-equal
 * ops, always, on any machine.
 *
 * ⚠ THE HOME RUN TAKES OVER EVERY SURFACE, and it does so HERE rather than at
 * the call site, so the eruption cannot be half-wired: one `homeRun` screen and
 * one integer frame determine the middle, both columns, the strip and (in
 * `boardRibbon.ts`) the light sweeping the ring.
 */
export function boardArrayOps(array: BoardArray, frame: number): BoardOp[] {
  const a = normaliseArray(array);
  const ops: BoardOp[] = [{ kind: 'panel', x: 0, y: 0, w: 1, h: 1, color: FRAME }];
  const put = (id: BoardPanelId, panelOps: BoardOp[]) => {
    ops.push(...mapOps(panelOps, boardPanel(id).rect));
  };

  put('main', boardMainOps(a.main, frame, boardPanel('main').type));

  if (a.main.kind === 'homeRun') {
    const { left, right } = celebrationSides(a.main);
    put('stats', celebrationSideOps(left, frame, boardPanel('stats').type));
    put('pitcher', celebrationSideOps(right, frame, boardPanel('pitcher').type));
    put('strip', celebrationStripOps(frame, boardPanel('strip').type));
    return ops;
  }

  const fallback = defaultSides(a.main);
  const left = a.left ?? fallback.left;
  const right = a.right ?? fallback.right;
  put('stats', left ? sideOps(left, boardPanel('stats').type) : dark());
  put('pitcher', right ? sideOps(right, boardPanel('pitcher').type) : dark());
  put('strip', a.strip ? stripOps(a.strip, boardPanel('strip').type) : dark());
  return ops;
}
