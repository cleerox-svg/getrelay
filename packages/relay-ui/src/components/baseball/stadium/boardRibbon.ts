// THE RIBBON BANDS — the lit strips that divide the seating decks and run the
// full circumference of the bowl, plus the field-level boards along the
// outfield wall.
//
// ⚠ THIS IS THE OWNER'S SECOND NOTE ON THE REFERENCE PHOTOGRAPH: "all around the
// stadium the dividers between each level are also screens." They are, and they
// are the best thing in the picture — a continuous lit line that ties the whole
// bowl together and, once a ball leaves the park, sweeps light all the way round
// it. The ribbon GEOMETRY already exists in `stands.ts`, so this is a material
// swap at integration and **not one extra draw call**.
//
// ⚠ ONE TEXTURE, TILED, AND THE TILE COUNT IS DERIVED. The band wraps the ring
// `wraps` times, where `wraps = circumference / (RIBBON_ASPECT · bandHeight)` —
// the count at which a glyph on the texture is the same shape as a glyph in the
// park. Hand-setting it stretches the typeface, so it is computed, and the scene
// only has to promise that `u` runs 0 → 1 once around the ring.
//
// ⚠ AND THE HONEST HALF: A RIBBON IS NOT READABLE FROM THE PLATE. `ribbonReadRangeFt`
// derives the crossover — a 5 ft band sets 3.5 ft of glyph, which reaches the
// 10 CSS px floor at **325 ft** and no further. So the ribbons down the lines and
// behind the plate carry TEXT (the count, the score, the park's name) and the
// ones out in centre field, 430 ft away, are LIGHT. That is a property of the
// camera, not a failure of the content, and it is what the sweep is for: light
// is legible at any distance.
//
// No canvas, no `three`, no clock, no gameplay. Ops only, rasterised by
// `emitBoardOps` — the SAME rasteriser the atlas uses. One implementation.

import type { BoardOp } from './boardPaint';
import {
  GOLD,
  INK,
  MIN_LEGIBLE_CSS_PX,
  RED,
  RULE,
  WHITE,
  boardCssPxPerFt,
  backdrop,
} from './boardPaint';
import { GLYPH_TRACK, GLYPH_W } from './boardGlyphs';
import type { BoardArray, BoardRibbon } from './boardState';
import { chevrons, strobeOn } from './boardScreens';
import type { BoardGeometry } from './boardAtlas';

/**
 * The ribbon canvas. Long and thin, because the surface is: 2048 × 64 is 32:1,
 * and the tile it maps onto is 32 band-heights of circumference.
 *
 * 0.5 MB per upload against the atlas's 2.0 MB, and it uploads only when the
 * content changes — the SCROLL costs nothing, because it is a texture offset.
 */
export const RIBBON_W = 2048;
export const RIBBON_H = 64;
export const RIBBON_ASPECT = RIBBON_W / RIBBON_H;

/**
 * Characters per tile, and the type size that makes them fill it EXACTLY.
 *
 * ⚠ THE SIZE IS DERIVED FROM THE CELL COUNT, NOT CHOSEN, AND THAT IS WHAT MAKES
 * THE TILE SEAMLESS. The band repeats around the ring, so the last cell's right
 * edge has to land on the first cell's left edge; if the advance grid does not
 * divide the tile exactly there is a visible stitch every 157 ft, all the way
 * round. `size · cells · (GLYPH_W + GLYPH_TRACK) = RIBBON_ASPECT` is that
 * condition, solved for the size.
 */
export const RIBBON_CELLS = 57;
export const RIBBON_TYPE = RIBBON_ASPECT / (RIBBON_CELLS * (GLYPH_W + GLYPH_TRACK));

/** Scroll speed of the message train, ft/s of ring travelled. Feel knob. */
export const RIBBON_SCROLL_FT_S = 22;

/**
 * Quantisation of the SCROLL, Hz — deliberately finer than `BOARD_ANIM_FPS`.
 *
 * The scroll is a texture OFFSET, so it costs no upload at all and a fine grid
 * is free; the 12 Hz grid exists to bound texel traffic and has nothing to say
 * about a float assignment. It is still quantised rather than continuous so that
 * `current()` can report the complete state of every surface as a finite key.
 */
export const RIBBON_SCROLL_FPS = 60;

/** How long the home-run light takes to travel once round the ring, s. */
export const RIBBON_SWEEP_S = 1.3;

/** The chase's shade against a strobing red band — darker than the ground. */
const CHASE_ON_RED = '#8e1526';

/** Fraction of the band height a ribbon glyph occupies. */
export const ribbonGlyphFt = (g: BoardGeometry) => RIBBON_TYPE * g.ribbonHeightFt;

/** One tile's width along the ring, ft — `RIBBON_ASPECT` band heights. */
export const ribbonTileFt = (g: BoardGeometry) => RIBBON_ASPECT * g.ribbonHeightFt;

/**
 * How many times the tile repeats around the ring. The scene sets
 * `texture.repeat.x` to this and `wrapS = RepeatWrapping`; `buildScoreboard`
 * does it for the caller so there is one place it can be wrong.
 */
export const ribbonWraps = (g: BoardGeometry) =>
  Math.max(1, Math.round((2 * Math.PI * g.ribbonRadiusFt) / ribbonTileFt(g)));

/**
 * The distance inside which ribbon text reaches the legibility floor, ft.
 * Derived by inverting `boardCssPxPerFt`, which is `952.4 / (d + 8)`.
 */
export function ribbonReadRangeFt(g: BoardGeometry): number {
  let lo = 1;
  let hi = 5000;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ribbonGlyphFt(g) * boardCssPxPerFt(mid) >= MIN_LEGIBLE_CSS_PX) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Glyph size in CSS px at a viewing distance. The ribbon's half of the floor. */
export const ribbonCssPxAt = (g: BoardGeometry, distFt: number) =>
  ribbonGlyphFt(g) * boardCssPxPerFt(distFt);

/**
 * Lay the caller's items out as EXACTLY `RIBBON_CELLS` characters.
 *
 * ⚠ A FIXED-LENGTH TILE IS THE SEAM. The items are cycled and separated by
 * ` · `, then padded with spaces or hard-cut, so the tile is always the same
 * width and always joins itself. Building the string from the content's own
 * length instead would leave a ragged edge that repeats round the whole bowl.
 */
export function ribbonTrain(items: string[]): string {
  const clean = items.map((s) => s.trim()).filter((s) => s.length > 0);
  if (clean.length === 0) return ' '.repeat(RIBBON_CELLS);
  // ⚠ IT PADS, IT DOES NOT CUT — and a render is what proved the difference. A
  // hard slice at `RIBBON_CELLS` ends the tile mid-word, and because the tile
  // repeats around the ring the seam reads `…HARBOHARBOURFRONT DOME`, twelve
  // times, all the way round the bowl. Whole items only, then spaces to the exact
  // tile width: the width stays fixed (which is what makes the join seamless)
  // and the join lands in a gap.
  const SEP = '   ·   ';
  let out = '';
  for (let i = 0; i < clean.length * 8; i++) {
    const next = `${clean[i % clean.length]}${SEP}`;
    if (out.length + next.length > RIBBON_CELLS) break;
    out += next;
  }
  if (out.length === 0) out = `${clean[0]!.slice(0, Math.max(0, RIBBON_CELLS - 1))}…`;
  return out.padEnd(RIBBON_CELLS, ' ').slice(0, RIBBON_CELLS);
}

/** The idle/live ribbon: one line of the train, centred in the band. */
function trainOps(ribbon: BoardRibbon): BoardOp[] {
  const ops = backdrop(INK, 4);
  ops.push({
    kind: 'text',
    text: ribbonTrain(ribbon.items),
    x: 0,
    y: (1 - RIBBON_TYPE) / 2,
    size: RIBBON_TYPE,
    align: 'left',
    color: WHITE,
  });
  return ops;
}

/**
 * The home-run ribbon: a chase, strobing in step with the board.
 *
 * ⚠ THE CHASE IS `wraps` LIGHTS RUNNING IN STEP, NOT ONE LIGHT GOING ROUND, and
 * that is a consequence of tiling rather than a compromise: the tile repeats
 * twelve times at the reference geometry, so whatever is painted is painted
 * twelve times. A single travelling light would need a single wrap and a 12×
 * stretched typeface everywhere else. Twelve lights sweeping together is what a
 * real ribbon chase looks like, and the sweep RATE is set so that the pattern
 * travels the whole ring once per `RIBBON_SWEEP_S`.
 */
function celebrationOps(frame: number): BoardOp[] {
  const strobe = strobeOn(frame);
  const ops = backdrop(strobe ? RED : INK, 4);
  // ⚠ THE CHASE RUNS BEHIND THE WORD, NOT THROUGH IT. The first version drew
  // WHITE chevrons at full band height under INK text on a red ground: rendered,
  // the word was unreadable and the band looked like a fault. The chase is a
  // DARKER shade of the ground it is on, and the word keeps the brightest ink —
  // which is also the right reading of what a ribbon chase is for, since past
  // 325 ft the word is not legible anyway and the LIGHT is the whole message.
  ops.push(...chevrons(frame, 0, 1, strobe ? CHASE_ON_RED : RULE, 0.035));
  ops.push({
    kind: 'text',
    text: ribbonTrain(['GONE!']),
    x: 0,
    y: (1 - RIBBON_TYPE) / 2,
    size: RIBBON_TYPE,
    align: 'left',
    color: strobe ? WHITE : GOLD,
  });
  return ops;
}

/** THE RIBBON'S PICTURE, as data. Pure `(array, frame) => BoardOp[]`. */
export function ribbonOps(array: BoardArray, frame: number): BoardOp[] {
  return array.main.kind === 'homeRun' ? celebrationOps(frame) : trainOps(array.ribbon);
}

/** What changes the ribbon's picture — content, or the celebration's frame. */
export const ribbonKey = (array: BoardArray, frame: number): string =>
  array.main.kind === 'homeRun'
    ? `hr#${frame}`
    : `train#${ribbonTrain(array.ribbon.items)}`;

/**
 * The texture offset, in TILES, at `tS` seconds since the current state
 * appeared.
 *
 * Positive offset moves the content the way the ring is wound, so the train
 * reads left-to-right for a viewer facing the band. One unit of offset is one
 * tile; the ring is `wraps` tiles, so a full lap is `wraps` units — which is why
 * the celebration rate is so much higher than the scroll rate.
 */
export function ribbonOffsetU(array: BoardArray, tS: number, g: BoardGeometry): number {
  if (!Number.isFinite(tS) || tS <= 0) return 0;
  const t = Math.floor(tS * RIBBON_SCROLL_FPS) / RIBBON_SCROLL_FPS;
  const rate =
    array.main.kind === 'homeRun'
      ? ribbonWraps(g) / RIBBON_SWEEP_S
      : RIBBON_SCROLL_FT_S / ribbonTileFt(g);
  return -(t * rate) % ribbonWraps(g);
}
