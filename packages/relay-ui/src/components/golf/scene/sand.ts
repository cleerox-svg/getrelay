/**
 * Bunker sand — the shared material maps for every golf scene that draws sand.
 *
 * WHY THIS EXISTS
 * ---------------
 * `GOLF.md` has carried "real sand/bunkers" as outstanding from the first
 * lighting pass. Bunkers rendered as an albedo-only `MeshStandardMaterial` at a
 * flat `roughness: 1`, and the Course and Putt each painted their OWN grain
 * (`makeSand` at 256², `makeSandTexture` at 128², near-identical speckle
 * densities of 0.137 and 0.134 dots/px — two implementations of one idea, free
 * to drift). A surface with no roughness variance and no normal cannot respond
 * to a moving light at all: whatever the sun does, sand renders as the same flat
 * beige, which is exactly how it read.
 *
 * WHAT MAKES SAND LOOK LIKE SAND
 * ------------------------------
 * Not the albedo — dry sand is very nearly one colour. It is that the surface is
 * (a) micro-bumpy, so the sun rakes it and the shaded side of every ripple goes
 * dark, and (b) unevenly packed, so raked furrows and footprints are glossier
 * than the loose crust between them. Those are a NORMAL map and a ROUGHNESS map,
 * which is what this module adds. All three maps share one height field, so the
 * bumps, the sheen and the grain agree instead of being three unrelated noises.
 *
 * ⚠ SEEDED, NEVER `Math.random` (`/GRAPHICS.md` §7). Every generator here takes
 * a `mulberry32` stream off a fixed seed, so two harness runs paint identical
 * pixels. This is load-bearing: with `Math.random` the visual gate cannot prove
 * a change was pixel-identical.
 *
 * ⚠ NO `onBeforeCompile`, no `ShaderMaterial`. This is three `CanvasTexture`s on
 * a stock `MeshStandardMaterial` — nothing for a future TSL port to unpick
 * (`/GRAPHICS.md` §2, asserted by `lib/scene3d/budget.test.ts`).
 */

import * as THREE from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import type { Track } from '../../../lib/golf/scenery';

/** The three maps a sand material needs. */
export interface SandMaps {
  /** Albedo: warm base, two-tone grain speckle, soft rake arcs. */
  map: THREE.Texture;
  /** Tangent-space normals from the shared height field. */
  normalMap: THREE.Texture;
  /** Greyscale roughness — furrows and packed patches are glossier than crust. */
  roughnessMap: THREE.Texture;
}

export interface SandOptions {
  /** Canvas edge, px. */
  size?: number;
  /** Texture repeat, applied to all three maps so they stay registered. */
  repeat?: number;
  /** Base sand colour, CSS. */
  base?: string;
  /** Draw the raked arcs. A mini-golf sand trap is too small to read them. */
  rake?: boolean;
  /** PRNG seed — same seed, same sand, every load. */
  seed?: number;
}

/** Roughest (loosest) sand. Dry crust is essentially Lambertian. */
const ROUGH_MAX = 1;
/** Glossiest (most packed) sand — a raked furrow floor, damp and compressed. */
const ROUGH_MIN = 0.62;

/**
 * A smooth, tileable value-noise field in [0, 1], plus the rake ridges.
 *
 * ONE field feeds all three maps. `x`/`y` wrap at `S`, so central differences at
 * the canvas edge sample across the seam and the normal map tiles without a
 * visible ridge — the failure `makeTurfNormalMap` avoids the same way.
 */
function sandHeightField(S: number, seed: number, rake: boolean) {
  // Pre-hash a lattice rather than hashing on the fly: a trig hash (what
  // makeTurfNormalMap uses) is fine for grass streaks but its regularity shows
  // up as a plaid on a surface this uniform.
  const lattice = (cells: number, salt: number): Float32Array => {
    const rnd = mulberry32((seed ^ (salt * 0x9e3779b1)) >>> 0);
    const a = new Float32Array(cells * cells);
    for (let i = 0; i < a.length; i++) a[i] = rnd();
    return a;
  };
  const fade = (t: number) => t * t * (3 - 2 * t);
  const octave = (cells: number, salt: number) => {
    const a = lattice(cells, salt);
    return (x: number, y: number) => {
      const fx = (x / S) * cells;
      const fy = (y / S) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fade(fx - x0);
      const ty = fade(fy - y0);
      const i0 = ((x0 % cells) + cells) % cells;
      const j0 = ((y0 % cells) + cells) % cells;
      const i1 = (i0 + 1) % cells;
      const j1 = (j0 + 1) % cells;
      const v00 = a[j0 * cells + i0]!;
      const v10 = a[j0 * cells + i1]!;
      const v01 = a[j1 * cells + i0]!;
      const v11 = a[j1 * cells + i1]!;
      return (
        v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
      );
    };
  };
  // Three octaves: coarse dune undulation, mid clumping, fine grain.
  const o1 = octave(6, 1);
  const o2 = octave(19, 2);
  const o3 = octave(61, 3);

  return (x: number, y: number): number => {
    let h = o1(x, y) * 0.5 + o2(x, y) * 0.32 + o3(x, y) * 0.18;
    if (rake) {
      // Concentric rake furrows, the SAME arcs the albedo draws (centre below
      // the tile, 16 px pitch) so the grooves you see are the grooves that
      // catch the light. A cosine ridge, not a drawn line — a rake leaves a
      // profile, and a profile is what a normal map can express.
      const dx = x - S / 2;
      const dy = y - S * 1.1;
      const r = Math.hypot(dx, dy);
      h += Math.cos((r / 16) * Math.PI * 2) * 0.13;
    }
    return h;
  };
}

/**
 * Build the three registered maps.
 *
 * Every texture is handed to `track()` so it is disposed with the scene — the
 * caller must not build these per frame.
 */
export function makeSandMaps(track: Track, opts: SandOptions = {}): SandMaps {
  const S = opts.size ?? 256;
  const repeat = opts.repeat ?? 3;
  const base = opts.base ?? '#e6d6a8';
  const rake = opts.rake ?? true;
  const seed = opts.seed ?? 0x5a2d1e;
  const height = sandHeightField(S, seed, rake);

  // --- Albedo -------------------------------------------------------------
  const ac = document.createElement('canvas');
  ac.width = ac.height = S;
  const ag = ac.getContext('2d')!;
  const rnd = mulberry32(seed);
  ag.fillStyle = base;
  ag.fillRect(0, 0, S, S);
  // Grain density held at the ~0.137 dots/px both old generators happened to
  // land on, so the speckle reads the same at 128² and 256².
  const grains = Math.round(S * S * 0.137);
  for (let i = 0; i < grains; i++) {
    const a = 0.06 + rnd() * 0.08;
    ag.fillStyle = rnd() < 0.5 ? `rgba(150,130,90,${a})` : `rgba(255,250,230,${a})`;
    ag.fillRect(rnd() * S, rnd() * S, 1.4, 1.4);
  }
  if (rake) {
    ag.strokeStyle = 'rgba(160,140,100,0.18)';
    ag.lineWidth = 1.5;
    for (let r = 20; r < S; r += 16) {
      ag.beginPath();
      ag.arc(S / 2, S * 1.1, r, Math.PI * 1.15, Math.PI * 1.85);
      ag.stroke();
    }
  }

  // --- Normal + roughness, from the one height field ----------------------
  const nc = document.createElement('canvas');
  nc.width = nc.height = S;
  const ng = nc.getContext('2d')!;
  const nImg = ng.createImageData(S, S);
  const rc = document.createElement('canvas');
  rc.width = rc.height = S;
  const rg = rc.getContext('2d')!;
  const rImg = rg.createImageData(S, S);
  // Slope steepness in height units per px. Sand grain is fine and high
  // frequency, so this is deliberately strong; `normalScale` on the material is
  // the dial to soften it per scene without regenerating the texture.
  const SLOPE = 2.4;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = height(x + 1, y) - height(x - 1, y);
      const hy = height(x, y + 1) - height(x, y - 1);
      let nx = -hx * SLOPE;
      let ny = -hy * SLOPE;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const idx = (y * S + x) * 4;
      nImg.data[idx] = (nx * 0.5 + 0.5) * 255;
      nImg.data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      nImg.data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      nImg.data[idx + 3] = 255;

      // Packed sand sits in the TROUGHS — a rake compresses what it pushes
      // down, and the loose crust is what stands proud. So roughness tracks
      // height: low ground is glossier.
      const h = Math.max(0, Math.min(1, height(x, y)));
      const rough = ROUGH_MIN + (ROUGH_MAX - ROUGH_MIN) * h;
      const v = Math.round(rough * 255);
      rImg.data[idx] = v;
      rImg.data[idx + 1] = v;
      rImg.data[idx + 2] = v;
      rImg.data[idx + 3] = 255;
    }
  }
  ng.putImageData(nImg, 0, 0);
  rg.putImageData(rImg, 0, 0);

  const finish = (canvas: HTMLCanvasElement, srgb: boolean): THREE.Texture => {
    const t = track(new THREE.CanvasTexture(canvas));
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat, repeat);
    t.anisotropy = 4;
    return t;
  };

  return {
    map: finish(ac, true),
    normalMap: finish(nc, false),
    roughnessMap: finish(rc, false),
  };
}

/**
 * A stock sand material. `roughness` stays 1 because it MULTIPLIES the roughness
 * map; the map is the variance and the material is its ceiling.
 *
 * `side` is caller's choice: the Course's bunker cap is a fan whose downward
 * normals must not cull, Putt's is a plane.
 */
export function makeSandMaterial(
  track: Track,
  maps: SandMaps,
  opts: { side?: THREE.Side; normalScale?: number } = {},
): THREE.MeshStandardMaterial {
  const mat = track(
    new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      roughness: 1,
      metalness: 0,
      side: opts.side ?? THREE.FrontSide,
    }),
  );
  const s = opts.normalScale ?? 0.9;
  mat.normalScale.set(s, s);
  return mat;
}
