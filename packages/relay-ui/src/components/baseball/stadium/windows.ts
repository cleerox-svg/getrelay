// A FACADE OF WINDOWS, as ONE seeded texture. Two callers, one implementation.
//
// ⚠ IT IS A MODULE BECAUSE IT IS A CONCEPT WITH TWO USERS, and the second one is
// what made the first one's private copy a duplication rather than a detail.
// `centrefield.ts` needs the hotel band that overlooks the field; `skyline.ts`
// needs office facades on sixteen high-rises. They differ in nothing but the
// grid and the lit fraction, so they are arguments.
//
// ⚠ TEXTURE AND NOT GEOMETRY, and the arithmetic decides it rather than taste. A
// four-storey band of forty rooms is 160 openings; sixteen towers of office
// glazing is thousands. As geometry that is either thousands of draw calls
// (authored naively) or a merged mesh whose triangle count is spent on
// something that is 2 px tall in `wide`. As a map it is one canvas, zero
// triangles and zero draw calls — the same trade `skyline.ts` already takes to
// merge its whole city into one mesh.
//
// ⚠ WHITE IS "UNCHANGED", the same convention `crowd.ts` and `grain.ts` use: the
// map MULTIPLIES the surface's authored colour, so an untouched texel leaves the
// concrete exactly as authored and every opening is a modulation of it. A window
// map can therefore never shift a building's hue, only punch holes in it.
//
// ⚠ SEEDED. Which rooms are lit comes from the caller's `mulberry32` stream —
// never `Math.random`, because two harness runs must produce byte-identical
// PNGs and "some lights are on" is exactly the kind of variation that would
// otherwise differ every run.

import { CanvasTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';

export interface WindowGridOpts {
  /** Canvas edge, px. `0` ⇒ no map, and the caller ships its flat colour. */
  px: number;
  /** Openings across and up ONE tile of the map. */
  cols: number;
  rows: number;
  /** Fraction of rooms with the light on. */
  litFraction: number;
  /** Fraction of the cell the opening fills, across and up. */
  fillU?: number;
  fillV?: number;
  /**
   * Fraction of the canvas HEIGHT left untouched white at the top.
   *
   * ⚠ IT IS A BLANK LANE, AND IT EXISTS SO ONE MAP CAN SERVE A GLAZED SURFACE
   * AND AN UNGLAZED ONE. `skyline.ts` merges sixteen office blocks and a
   * concrete communications tower into ONE mesh with ONE material; without a
   * plain region to point at, the tower came back covered in office windows —
   * measured on `homerun.png`, where it read as a mesh tube. This is the same
   * trick `crowd.ts` plays with its fascia lane, and for the same reason: a
   * shared material is only shareable if the map has somewhere neutral in it.
   */
  plainTopFraction?: number;
  rng: () => number;
}

/**
 * Build the grid. Returns `null` with no DOM (a unit test, an SSR pass) or when
 * the tier has switched maps off — a legitimate cheap tier, not a broken one.
 *
 * The canvas is `cols`-proportioned so an opening stays roughly square on the
 * canvas whatever grid it is asked for; the caller's UVs decide its shape on the
 * building.
 */
export function buildWindowTexture(opts: WindowGridOpts): CanvasTexture | null {
  const { px, cols, rows, litFraction, rng } = opts;
  if (px <= 0 || cols <= 0 || rows <= 0 || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = Math.max(4, Math.round((px * rows) / cols));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  const fillU = opts.fillU ?? 0.62;
  const fillV = opts.fillV ?? 0.5;
  const plain = opts.plainTopFraction ?? 0;
  const cw = w / cols;
  const ch = (h * (1 - plain)) / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = rng() < litFraction;
      // The MULLION INSET is what makes a run of windows read as a run of
      // windows rather than as a stripe: the opening is smaller than its cell,
      // so there is authored wall between two of them and above and below.
      ctx.fillStyle = lit
        ? `rgba(255,236,190,${(0.8 + rng() * 0.2).toFixed(3)})`
        : `rgba(30,36,46,${(0.65 + rng() * 0.25).toFixed(3)})`;
      ctx.fillRect(
        c * cw + (cw * (1 - fillU)) / 2,
        h * plain + r * ch + (ch * (1 - fillV)) / 2,
        cw * fillU,
        ch * fillV,
      );
    }
  }

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  // ⚠ NO MIPMAPS, the same reason as the crowd speckle and the ground grain: a
  // mip chain averages a window grid to flat concrete at exactly the distance a
  // skyline is seen from, which is the only distance it is ever seen from.
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
