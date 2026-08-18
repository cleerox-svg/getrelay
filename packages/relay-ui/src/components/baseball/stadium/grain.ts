// SURFACE GRAIN — one seeded noise tile, built ONCE and cloned per surface.
//
// ⚠ THIS FILE EXISTS BECAUSE OF A MEASURED CROSS-GAME PARITY FAILURE. The visual
// gate measured high-frequency detail as the mean |px − 3×3 blur| in luminance
// levels over a flat patch of each surface:
//
//     golf fairway            3.43
//     golf rough              2.92
//     baseball turf           0.41
//     baseball warning track  1.36
//     baseball infield dirt   0.0000   ← ONE COLOUR over a 400×150 px patch
//
// The infield clay is ~26 % of the most-played frame and was a single flat
// value. Golf bought its grain by calling `Math.random()` ~9,500 times per build
// and LOST determinism (23 of 25 golf scenes differ between two identical runs);
// baseball bought byte-identical PNGs by having no procedural surface detail at
// all. Neither is the answer. `mulberry32` is: the same three-free PRNG the sim
// uses, seeded from a constant, so the pixels are grain to the eye and a pure
// function to the harness.
//
// ⚠ AND IT IS ONE TILE, CLONED — NOT ONE TILE PER SURFACE. This is golf's other
// measured renderer defect, and it is cheaper to get right here than to retrofit:
// `CourseGL` generates six byte-identical turf normal maps, ~31.7 ms and 256 KB
// each, because they differ only in `.repeat` — which is a property of the
// TEXTURE while `clone()` shares the source `image`. `PuttGL` does it correctly
// and is what this copies. The stadium has four repeated ground surfaces (turf,
// warning track, infield clay, the plate circle), so the saving compounds: one
// canvas, four `Texture` objects sharing its bitmap, four different `repeat`s.
//
// ⚠ WHAT IT IS NOT: a normal map, and not a colour map either. It is a
// MULTIPLIER around 1.0 — white is "leave the authored colour alone" — so every
// surface keeps the flat colour `field.ts` argues for and gains only variation
// about it. That keeps the palette decisions in one place and means a grain tile
// can never shift a surface's hue.

import { CanvasTexture, LinearFilter, RepeatWrapping, SRGBColorSpace } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';

/**
 * Fixed seed. Determinism is the entire point — see the header. Deliberately
 * NOT the bowl's seed, so a change to one texture's draw order cannot silently
 * re-roll the other.
 */
const GRAIN_SEED = 20260817;

/**
 * The two octaves, as amplitude fractions of full white. FEEL KNOBS.
 *
 * ⚠ TWO, AND NOT ONE, BECAUSE OF THE VIEWING RANGE. The same square foot of
 * clay is read at 20 ft from the `batter` camera and at 1,200 ft from `wide`.
 * A single per-texel octave is grain up close and — filtered — dead flat far
 * away; a single coarse octave is blotches up close and grain far away. The
 * fine octave is per texel; the coarse one is blocks of `COARSE_PX`, which at
 * the tile sizes below is a few feet on the ground and survives minification.
 */
const FINE_AMP = 0.105;
const COARSE_AMP = 0.055;
const COARSE_PX = 8;

/**
 * Build the shared grain tile. `px` is the edge; `0` (the `low` tier) returns
 * `null` and every caller then ships its flat colour, which is a legitimate
 * cheap tier and not a broken one — exactly as `crowd.ts` does.
 *
 * Returns `null` with no DOM, too (a unit test, an SSR pass).
 */
export function buildGrainTile(px: number): CanvasTexture | null {
  if (px <= 0 || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const rng = mulberry32(GRAIN_SEED);
  const img = ctx.createImageData(px, px);
  // The coarse octave first, as a small grid sampled per texel — cheaper than a
  // second pass and it keeps the whole build to one loop over the texels.
  const blocks = Math.max(1, Math.ceil(px / COARSE_PX));
  const coarse = Array.from({ length: blocks * blocks }, () => (rng() * 2 - 1) * COARSE_AMP);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const c = coarse[Math.floor(y / COARSE_PX) * blocks + Math.floor(x / COARSE_PX)] ?? 0;
      const f = (rng() * 2 - 1) * FINE_AMP;
      // Clamped to [0, 1] and centred on 1: a multiplier can darken and lighten
      // but must never invent a colour.
      const v = Math.max(0, Math.min(1, 1 + c + f)) * 255;
      const i = (y * px + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  // ⚠ NO MIPMAPS, SAME REASON AS THE CROWD SPECKLE: a mip chain averages the
  // fine octave to flat grey at exactly the distance the field is usually seen
  // from, which is the defect this file exists to remove. The coarse octave is
  // what carries the far view, and `LinearFilter` keeps it.
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * A view of the shared tile at a given ground scale, ft per tile.
 *
 * ⚠ `clone()` SHARES `image` AND COPIES EVERYTHING ELSE, which is precisely the
 * property golf's six identical normal maps failed to use. The canvas is
 * generated once; each clone is a few hundred bytes of `Texture` state and its
 * own `repeat`. `needsUpdate` is set because a clone starts with a fresh
 * `version` and would otherwise never be uploaded.
 *
 * The UVs are already ft/`tileFt` (see `geom.planarUV`), so `repeat` here is a
 * FURTHER subdivision — pass 1 to use the geometry's own scale.
 */
export function grainAt(tile: CanvasTexture | null, repeat: number): CanvasTexture | null {
  if (!tile) return null;
  const t = tile.clone();
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}
