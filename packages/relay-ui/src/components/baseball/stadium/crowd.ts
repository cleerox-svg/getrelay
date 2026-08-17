// THE CROWD — one procedural texture, no image asset, no instance, no mesh.
//
// Extracted from `stands.ts` at the 500-line cap when M3b gave it a second
// octave and per-section variation. Extraction, not a raised cap: `stands.ts` is
// the bowl's GEOMETRY and this is its surface, and the two were only ever in one
// file because the surface used to be twelve `fillRect`s.
//
// ⚠ THE CROWD WAS MEASURED INVISIBLE, AND THAT IS WHY THIS FILE CHANGED. On the
// nearest seating any shipping camera reaches — `pitcher`, ~115 ft — the visual
// gate measured luminance mean 22.96, sd **1.94**, range 15.9–24.1. Eight levels
// out of 255, and the 7.6–10.7 sd elsewhere in the deck was vomitories and
// ribbon, not people. The choice put was "raise the contrast until it reads, or
// delete it and bank the texture".
//
// KEPT, and here is the measurement the decision rests on. Deleting it does not
// bank a draw call — the crowd has never had one, it is a `map` on a material
// the bowl needs anyway — so the entire saving is ONE 1024×256 canvas, while the
// cost is that the deck becomes a flat navy slab, which is the exact defect the
// banding pass was written to fix one surface further out. The contrast is
// therefore raised, and the reason it was low is diagnosable rather than
// mysterious:
//
//   at 115 ft one seating section (30 ft) is ~64 px of a 900 px frame, so one
//   256 px tile is minified ~4:1. `LinearFilter` with no mip chain averages
//   4×4 texels per pixel, and a field of independent 1 px speckles averages to
//   its own mean — the signal is destroyed by exactly the filtering that keeps
//   it from shimmering.
//
// So the fix is not "more speckle". It is a SECOND, COARSER octave: blocks of
// `CLUMP_PX` texels that survive a 4:1 minification, on top of the per-texel
// speckle that carries the close view. Same two-octave argument as
// `stadium/grain.ts`, for the same measured reason, and it is the only thing
// that can raise `sd` at 115 ft without making the near view look like static.
//
// ⚠ AND THE TILE IS NOW FOUR SECTIONS WIDE, WHICH IS THE OTHER HALF. With one
// section per tile every vomitory in the park was identical in size, shape and
// spacing — a perfectly periodic lattice, both decks, both parks, which reads as
// a repeating tile because it IS one. Four sections per tile with a seeded
// per-section offset breaks the period at a cost of one wider canvas and zero
// draw calls. It cannot be done with `Texture.repeat`, which is exactly why the
// tile had to grow rather than the sampling change.
//
// ⚠ EVERY RANDOM NUMBER COMES FROM THE CALLER'S SEEDED `mulberry32`. Two runs of
// the screenshot harness must produce byte-identical PNGs; one `Math.random`
// here breaks that silently, and `determinism.test.ts` reads this file.

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

/**
 * Seating sections per texture tile.
 *
 * ⚠ IT IS ALSO A CONSTRAINT ON THE BOWL. `stands.ts` rounds its section count to
 * a multiple of this so the running `u` ends on a whole number of TILES — a
 * fractional last tile puts a texture discontinuity at bearing ±180, which is
 * directly behind the plate and dead centre of the `pitcher` frame.
 */
export const SECTIONS_PER_TILE = 4;

/**
 * Where the crowd texture's white FASCIA LANE starts, in v. Above this the
 * texture is untouched white so a fascia band can share the one texture without
 * picking up speckle; below it is seating. SCENE-ONLY.
 */
export const FASCIA_V0 = 0.96;

/**
 * Coarse crowd-clump block, texels. See the header — this is the octave that
 * survives minification, and it is SIZED AGAINST THAT MINIFICATION.
 *
 * At 115 ft one 256 px tile covers ~64 px of a 900 px frame, i.e. 4:1, so a
 * 6-texel clump lands on 1.5 px and is still averaged away — measured, sd only
 * 2.00 → 3.12 at that size. 12 texels lands on 3 px and survives. It is 4.7 % of
 * a 30 ft section, i.e. ~1.4 ft on the ground, which is a block of seats rather
 * than a person: the right physical scale for the thing it is standing in for.
 */
const CLUMP_PX = 12;

/** Clump amplitude, as a fraction of white. FEEL KNOB, and it is the contrast dial. */
const CLUMP_AMP = 0.34;

/** Per-texel speckle density, fraction of texels touched. FEEL KNOB. */
const SPECKLE_DENSITY = 0.16;

/**
 * The crowd, as ONE procedural texture.
 *
 * `px` is the tile HEIGHT; the canvas is `SECTIONS_PER_TILE × px` wide, so one
 * seating section is `px` square and the speckle stays square on the ground.
 * Everything is a `fillRect` or an `ImageData` write, and every random number
 * comes from `rng`.
 *
 * Returns `null` when there is no DOM (a unit test, an SSR pass) or when the
 * tier has switched the crowd off — the caller then ships a flat navy material,
 * which is a legitimate low tier and not a broken one.
 */
export function buildCrowdTexture(
  px: number,
  rng: () => number,
  base = 1,
): CanvasTexture | null {
  if (px <= 0 || typeof document === 'undefined') return null;
  const w = px * SECTIONS_PER_TILE;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // ⚠ V RUNS UP THE DECK, CANVAS Y RUNS DOWN THE IMAGE. Three's texture origin
  // is bottom-left, so `v = 0` (the FRONT row, at the rail) is the BOTTOM of the
  // canvas. Everything below is authored in v and converted once, because
  // getting this backwards puts the vomitory in the sky.
  const yOf = (v: number) => (1 - v) * px;
  /** A band in (u, v) where `u` is in TILE units, 0…SECTIONS_PER_TILE. */
  const band = (v0: number, v1: number, style: string, u0: number, u1: number) => {
    ctx.fillStyle = style;
    ctx.fillRect((u0 / SECTIONS_PER_TILE) * w, yOf(v1), ((u1 - u0) / SECTIONS_PER_TILE) * w, (v1 - v0) * px);
  };

  // ⚠ WHITE IS "UNCHANGED". The map MULTIPLIES the vertex colour, so a white
  // texel leaves the navy exactly as authored and every mark below is a
  // modulation of it. That is also what lets the FASCIA share this one texture:
  // the top 4 % of it is a clean white lane the fascia bands sample, so a fascia
  // strip carries a UV, the merge keeps the uv attribute, and the whole lit
  // shell is still one geometry and one material. (`mergeGeometries` takes the
  // INTERSECTION of attributes — one band without UVs would silently drop the
  // texture off all nine.)
  // ⚠ `base` IS 1 IN DAYLIGHT AND ~0.26 AT NIGHT, AND IT IS THE WHOLE NIGHT
  // CROWD. This map MULTIPLIES the seat colour, so a texel can only ever DARKEN
  // — "bright points on dark" is therefore authored by dropping the GROUND and
  // raising the seat colour to match (`daylight.seatsHex`), never by brightening
  // the dots. The speckle below already writes near-1.0 texels; against a 0.26
  // ground they become the dense field of phone screens the night photographs
  // actually show, out of the same texels the day crowd was already paying for.
  const lvl = Math.round(255 * Math.max(0, Math.min(1, base)));
  band(0, 1, `rgb(${lvl},${lvl},${lvl})`, 0, SECTIONS_PER_TILE);

  // --- OCTAVE 1: crowd CLUMPS, the octave that survives minification. Blocks of
  // `CLUMP_PX` texels, brighter low in the bowl because that is where a real
  // house fills first. This is what raises `sd` at 115 ft.
  const seatRows = Math.floor(px * FASCIA_V0);
  const cols = Math.ceil(w / CLUMP_PX);
  const rows = Math.ceil(seatRows / CLUMP_PX);
  const img = ctx.getImageData(0, 0, w, px);
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      // v of this block's centre, 0 at the rail.
      const v = 1 - ((by + 0.5) * CLUMP_PX) / px;
      const fill = 0.45 + 0.55 * Math.max(0, Math.min(1, 1 - v)); // fuller down low
      const k = 1 + (rng() * 2 - 1) * CLUMP_AMP * fill;
      for (let y = by * CLUMP_PX; y < Math.min(seatRows, (by + 1) * CLUMP_PX); y++) {
        for (let x = bx * CLUMP_PX; x < Math.min(w, (bx + 1) * CLUMP_PX); x++) {
          const i = (y * w + x) * 4;
          const c = Math.max(0, Math.min(255, 255 * base * k));
          img.data[i] = c;
          img.data[i + 1] = c;
          img.data[i + 2] = c;
        }
      }
    }
  }
  // --- OCTAVE 2: per-texel speckle, which carries the close view. Never
  // individuals — one or two texels each, which is also all a seat is worth.
  const dots = Math.round(w * seatRows * SPECKLE_DENSITY);
  for (let n = 0; n < dots; n++) {
    const x = Math.floor(rng() * w);
    const y = Math.floor(rng() * seatRows);
    const warm = rng();
    const i = (y * w + x) * 4;
    // Warm/cool clothing, as a MULTIPLIER on the navy — the seats stay navy and
    // the people on them do not, which is the whole reason this is a map.
    const rgb =
      warm < 0.5 ? [255, 255, 255] : warm < 0.8 ? [255, 226, 196] : [198, 214, 255];
    for (let c = 0; c < 3; c++) {
      img.data[i + c] = Math.min(255, (img.data[i + c] ?? 0) * 0.35 + (rgb[c] ?? 255) * 0.9);
    }
  }
  ctx.putImageData(img, 0, 0);

  // Seat rows — very low contrast horizontal banding, the thing that makes a
  // deck read as tiered rather than as a painted ramp. Drawn AFTER the octaves
  // so the row lines survive the speckle.
  const rowPx = Math.max(2, Math.round(px / 48));
  for (let y = 0; y < seatRows; y += rowPx) {
    ctx.fillStyle = (y / rowPx) % 2 === 0 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, y, w, 1);
  }

  // --- PER-SECTION STRUCTURE: one aisle and one vomitory per section, with the
  // vomitory's height and width SEEDED per section so the lattice is broken.
  for (let s = 0; s < SECTIONS_PER_TILE; s++) {
    // Aisles: ONE dark vertical per section, on the leading edge. ⚠ NOT ONE ON
    // EACH EDGE — the tile repeats, so a stripe on both edges puts two of them
    // side by side at every seam and the bowl reads as barred rather than
    // sectioned.
    band(0, FASCIA_V0, 'rgba(0,0,0,0.34)', s, s + 1 / 96);
    // The vomitory — the tunnel mouth. This is the feature that stops a seating
    // field reading as one slab. Not pure black: a tunnel mouth in daylight is a
    // dark grey, and 0.86 alpha over navy read as a punched hole.
    const v0 = 0.09 + rng() * 0.1; // seeded height in the deck
    const hw = 0.055 + rng() * 0.02; // seeded half-width, in tile units
    const tall = 0.13 + rng() * 0.05;
    const c = s + 0.5;
    band(v0, v0 + tall, 'rgba(0,0,0,0.55)', c - hw, c + hw);
    band(v0 + tall, v0 + tall + 0.025, 'rgba(0,0,0,0.28)', c - hw * 1.25, c + hw * 1.25);
  }

  const tex = new CanvasTexture(canvas);
  // ⚠ REPEAT ACROSS, CLAMP UP. `u` tiles once per SECTIONS_PER_TILE sections and
  // must wrap; `v` must NOT, or the fascia lane at v ≈ 0.98 bleeds the front row
  // into it.
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  // Linear, no mipmaps: the speckle IS the signal, and a mip chain averages it
  // to flat navy at exactly the distance the bowl is usually seen from.
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
