// Interactive 3D scene for a course hole. It renders the hole from the terrain
// data (displaced ground vertex-coloured per lie — see terrain.ts) AND drives a
// live CourseSim on a fixed-timestep loop: the player drags to aim (slingshot,
// reused from the range), the shot flies and rolls on the terrain, the camera
// follows, a tracer trails the ball, and it plays shot-by-shot until holed. The
// React HUD (CourseGame.tsx) polls sim.getState() for readouts and runs the
// accuracy bar. World→scene: d → −Z, x → X, h → Y.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { FIXED_MS } from '../../lib/golf/tuning';
import {
  heightAt,
  surfaceAt,
  greenPadRadius,
  corridorHalfAt,
  corridorEdgeDist,
  centerlineArcYd,
  edgeNoise,
  edgeRadius,
  featureSeed,
  type CourseHole,
} from '../../lib/golf/terrain';
import {
  sampleHeightField,
  FLAGSTICK_HEIGHT_M,
  HOLE_DIAMETER_M,
  BALL_DIAMETER_M,
  YD_PER_M,
} from '../../lib/golf/courseData';
import {
  addSkyDome,
  createTreeKit,
  makeContactShadowTexture,
  makeFog,
  makeTurfColor,
  makeTurfNormalMap,
  makeWater,
  FRINGE_BAND,
  GREEN_COLOR,
  STRIPE_HI,
  STRIPE_LO,
  STRIPE_YD,
  SURFACE_RGB,
  TURF_NORMAL_SCALE,
  TURF_ROUGHNESS,
} from '../../lib/golf/scenery';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import { BALL_R, CUP_R } from '../../lib/golf/greenPhysics';
import type { CourseSim, CoursePrediction, CourseTrailPt } from '../../lib/golf/courseSim';

// Regulation liner (sunken cup) geometry. CUP_DEPTH ≈ 3.5×BALL_R so the ball
// sits clearly below the rim; the aperture punched in the green (grid + cap) is a
// hair past the visible lip so the collar patch's clean CUP_R inner edge is the
// only mouth you see. The camera can then look DOWN into a real hole.
const CUP_DEPTH = 0.7; // yd sunk below the green surface
const CUP_APERTURE_R = CUP_R + 0.12; // green removed out to here, hidden by the collar

interface Props {
  sim: CourseSim;
  // Raised when a drag is released into a valid shot (armed) — the HUD then runs
  // the accuracy bar and calls sim.fireArmed().
  onArm?: () => void;
  paused?: boolean;
}

// Per-lie base albedo, the intermediate-cut band width and the bold mow-stripe
// scale/contrast now live in the shared scenery kit (SURFACE_RGB / FRINGE_BAND /
// STRIPE_YD / STRIPE_HI / STRIPE_LO) so the Range and Course cut the SAME grass;
// makeSurfaceMap below consumes them. Fairway and rough stay far apart in
// hue+value (rough darker, more olive) so the corridor edge reads as a hard
// material change; green/fringe/tee/bunker/water are refined by overlay meshes.

// Fairway "first cut" (step-cut) colour, LOCKED to the green fringe collar
// (SURFACE_RGB.fringe / 0x3a6e30) so the fairway first cut and the greenside
// collar read as the SAME mown step-cut. It is NO LONGER baked into the surface
// map — it is drawn as a real geometry ribbon along the fairway corridor
// (buildFirstCutBand), the same technique as the green's collar annulus, so its
// edge stays vector-crisp/MSAA-smoothed at grazing angles instead of the
// texel-quantized seam a baked texel band gave. Change it here and the two stay
// in sync.
const CUT: readonly [number, number, number] = SURFACE_RGB.fringe;

// Smoothstep in [0,1] between edges e0..e1 — used to anti-alias JUST the 1-texel
// seam at each crisp surface-map boundary (a clean line, not a wide gradient).
function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

// Cheap deterministic hash noise in [0,1) for the baked surface texture.
function hashNoise(ix: number, iy: number): number {
  let h = (Math.floor(ix) * 73856093) ^ (Math.floor(iy) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smoothstep-interpolated value noise built on hashNoise → coherent, non-blocky
// (the raw hash gives hard cells; the rough/long-grass look needs continuous
// gradients). Deterministic in (x,y) so screenshots reproduce.
function smoothNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hashNoise(ix, iy);
  const b = hashNoise(ix + 1, iy);
  const c = hashNoise(ix, iy + 1);
  const e = hashNoise(ix + 1, iy + 1);
  const top = a + (b - a) * sx;
  const bot = c + (e - c) * sx;
  return top + (bot - top) * sy;
}

// A seeded PRNG (mulberry32) — one generator, shared by every canvas texture so
// their grain/speckle is IDENTICAL across mounts (no Math.random anywhere in the
// scene → the screenshot harness stays reproducible; determinism is a hard
// requirement, GOLF.md).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bake a TOP-DOWN albedo map of the whole hole from the surface model. Every
// texel is classified with surfaceAt() (which itself reads corridorHalfAt /
// greenPadRadius / the hazards) so the material boundaries are the SAME lines the
// ball plays and they scale to any hole with no code change. Seams are crisp at
// texel resolution (far finer than the mesh vertices the old per-vertex colour
// multiply was limited to). Fairway gets bold alternating MOW STRIPES down the
// hole; rough gets darker, wispy LONG-GRASS streaks (coherent, elongated
// downrange — not blocky patches) meeting the fairway at a single crisp seam
// (the "first cut" step-cut is drawn as a geometry ribbon on top, not baked
// here); the rest carry their base tint (their overlay meshes add the fine
// texture). Mapped planar over the mesh's (x,d) domain via the mesh UVs, so it
// lines up with the physics exactly.
function makeSurfaceMap(
  hole: CourseHole,
  xHalf: number,
  dMin: number,
  dMax: number,
): THREE.Texture {
  // ONE-TIME cost: this is a synchronous ~W×H (=524k) texel classify+paint loop
  // run ONCE at scene mount (tens of ms), never per frame. H is larger than W
  // because the hole is long; 512×1024 keeps the corridor seams crisp — drop H if
  // a future profile shows mount jank, at the cost of seam sharpness downrange.
  const W = 512; // across x
  const H = 1024; // along d (the hole is long)
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const img = g.createImageData(W, H);
  const data = img.data;
  // STRIPE_YD (mow band period downrange) is shared from scenery.ts so both
  // scenes cut the same stripes. The fairway|rough boundary is a SINGLE crisp
  // seam here (keyed off corridorEdgeDist); the "first cut" step-cut that used to
  // be baked as a texel band between them is now a real geometry ribbon
  // (buildFirstCutBand) so its edge reads sharp at grazing angles — removing it
  // here avoids a doubled/mismatched seam. Render-only; surfaceAt is unchanged.
  const FAIR = SURFACE_RGB.fairway;
  const ROUGH = SURFACE_RGB.rough;
  // Anti-alias half-width (yd) applied ONLY at the fairway|rough colour seam so
  // the line reads clean, not jaggy — roughly one surface-map texel (the hole
  // spans ~120 yd across 512 texels ≈ 0.24 yd/texel).
  const SEAM_AA = 0.18;
  const fair: [number, number, number] = [0, 0, 0];
  const rgh: [number, number, number] = [0, 0, 0];
  // Fairway albedo at (x,d): bold alternating mow stripes + a whisper of blade
  // speckle. The stripe band is keyed to ARC-LENGTH along the centerline (`arc`,
  // yd) rather than raw downrange `d`, so on a diagonal/dogleg corridor the band
  // boundaries run perpendicular to the LOCAL fairway direction and wrap the
  // bend — the ribbon reads as even width. On a straight hole arc ≈ d, so the
  // stripes are unchanged. Strong band contrast so the "fairway lines" read.
  const fairwayRGB = (x: number, d: number, arc: number, out: [number, number, number]) => {
    const band = Math.floor(arc / STRIPE_YD) % 2 === 0 ? STRIPE_HI : STRIPE_LO;
    const blade = 0.94 + hashNoise(x * 3.1, d * 3.1) * 0.12;
    const m = band * blade;
    out[0] = FAIR[0] * m;
    out[1] = FAIR[1] * m;
    out[2] = FAIR[2] * m;
  };
  // Rough albedo: LONG, wispy grass. Coherent smooth-noise streaks STRETCHED
  // down the hole (the d axis is sampled ~5× finer than x) read as tall blades
  // leaning downrange, tufted by a coarse clump octave and warped off-axis so it
  // never looks like blocky patches or a stripe. A dark floor + wide light/dark
  // swing keeps it clearly longer & less manicured than the fairway. `base` lets
  // OB reuse the same treatment on its darker tint.
  const roughRGB = (x: number, d: number, base: readonly [number, number, number], out: [number, number, number]) => {
    const warp = smoothNoise(x * 0.2, d * 0.05) * 2.0;
    const clump = smoothNoise(x * 0.68 + warp, d * 0.11); // long elongated tufts
    const wisp = smoothNoise(x * 2.0 + warp, d * 0.48); // longer leaning blades
    const streak = 0.6 * clump + 0.4 * wisp; // 0..1
    const m = 0.56 + streak * 0.86; // ~0.56..1.42 → clearer LONG-grass contrast
    out[0] = base[0] * m;
    out[1] = base[1] * m;
    out[2] = base[2] * m;
  };
  for (let py = 0; py < H; py++) {
    // Canvas row 0 is the TOP; CanvasTexture samples with flipY, so V=1 (d=dMax)
    // maps to the top row — invert to recover the world d for this row.
    const d = dMin + (1 - py / (H - 1)) * (dMax - dMin);
    for (let px = 0; px < W; px++) {
      const x = -xHalf + (px / (W - 1)) * (xHalf * 2);
      const surf = surfaceAt(hole, d, x);
      let r: number;
      let gg: number;
      let b: number;
      if (surf === 'fairway' || surf === 'rough') {
        // A SINGLE crisp seam at the corridor edge (ed=0) keyed off
        // corridorEdgeDist: fairway (mow stripes) inside, rough (long-grass
        // streaks) outside, anti-aliased across only ±SEAM_AA so the line reads
        // clean, NOT a gradient. The "first cut" step-cut band that used to sit
        // between them is now a geometry ribbon (buildFirstCutBand) drawn on top
        // along the corridor — baking it here as well would double the seam.
        // Render-only — surfaceAt still classifies fairway/rough here, so the lie
        // the ball plays is unchanged.
        const ed = corridorEdgeDist(hole, d, x);
        fairwayRGB(x, d, centerlineArcYd(hole, d, x), fair);
        roughRGB(x, d, ROUGH, rgh);
        const w = smoothstep(-SEAM_AA, SEAM_AA, ed); // 0 fairway → 1 rough
        r = fair[0] + (rgh[0] - fair[0]) * w;
        gg = fair[1] + (rgh[1] - fair[1]) * w;
        b = fair[2] + (rgh[2] - fair[2]) * w;
      } else if (surf === 'ob') {
        roughRGB(x, d, SURFACE_RGB.ob, rgh);
        r = rgh[0];
        gg = rgh[1];
        b = rgh[2];
      } else if (surf === 'cartpath') {
        const spec = 0.92 + hashNoise(x * 4, d * 4) * 0.16;
        r = SURFACE_RGB.cartpath[0] * spec;
        gg = SURFACE_RGB.cartpath[1] * spec;
        b = SURFACE_RGB.cartpath[2] * spec;
      } else {
        [r, gg, b] = SURFACE_RGB[surf];
      }
      const o = (py * W + px) * 4;
      data[o] = Math.min(255, r * 255);
      data[o + 1] = Math.min(255, gg * 255);
      data[o + 2] = Math.min(255, b * 255);
      data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// Fine putting-green grain: a UNIFORM manicured surface (no mow stripes — unlike
// the fairway) with a seeded blade-streak stipple so the green reads as real
// textured turf, not flat paint.
function makeGreenGrain(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  // UNIFORM base — no mow stripes on the putting surface. A single flat mid tone
  // (the old light-band colour) keeps the green's brightness while reading as a
  // continuous manicured surface; the seeded blade-streak stipple below + the
  // capNorm normalMap still give it mown-turf texture (not flat plastic).
  g.fillStyle = 'rgba(232,238,228,1)';
  g.fillRect(0, 0, S, S);
  // Seeded PRNG (mulberry32) instead of Math.random so the grain is IDENTICAL
  // across mounts — the screenshot harness stays reproducible and determinism is
  // preserved (GOLF.md). Fixed seed → same grain every load.
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 4000; i++) {
    const a = 0.05 + rnd() * 0.06;
    g.strokeStyle = rnd() < 0.5 ? `rgba(120,150,110,${a})` : `rgba(255,255,255,${a})`;
    g.lineWidth = 1;
    const x = rnd() * S;
    const y = rnd() * S;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 2, y - 2 - rnd() * 3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Sand: warm base with fine grain speckle + soft rake arcs. Seeded PRNG (not
// Math.random) so the grain is identical every load (screenshot reproducibility).
function makeSand(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(0x5a2d1e);
  g.fillStyle = '#e6d6a8';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const a = 0.06 + rnd() * 0.08;
    g.fillStyle = rnd() < 0.5 ? `rgba(150,130,90,${a})` : `rgba(255,250,230,${a})`;
    g.fillRect(rnd() * S, rnd() * S, 1.4, 1.4);
  }
  g.strokeStyle = 'rgba(160,140,100,0.18)';
  g.lineWidth = 1.5;
  for (let r = 20; r < S; r += 16) {
    g.beginPath();
    g.arc(S / 2, S * 1.1, r, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Tightly-mown TEE turf: a fine mow-band grass map (its colour is baked in so
// the pad reads as grass, not flat paint). Deliberately a hair coarser + darker
// than the green grain and finer than the fairway stripes — a distinct
// tee-turf look. Seeded PRNG → identical every load.
function makeTeeTurf(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(0x7ee1a5);
  // Base + alternating vertical mow bands (tight, tidy — a teeing ground).
  const bands = 10;
  const bw = S / bands;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 === 0 ? '#3f7f39' : '#377231';
    g.fillRect(i * bw, 0, bw, S);
  }
  // Fine blade streaks (light + dark passes) for a mown, textured surface.
  for (let i = 0; i < 5200; i++) {
    const light = rnd() < 0.5;
    const a = 0.06 + rnd() * 0.08;
    g.strokeStyle = light ? `rgba(150,196,120,${a})` : `rgba(28,58,24,${a})`;
    g.lineWidth = 1;
    const x = rnd() * S;
    const y = rnd() * S;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 1.6, y - 2 - rnd() * 3);
    g.stroke();
  }
  // Broad soft mottle so the pad isn't uniform.
  for (let i = 0; i < 40; i++) {
    const x = rnd() * S;
    const y = rnd() * S;
    const r = 16 + rnd() * 48;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, rnd() < 0.5 ? 'rgba(30,60,25,0.10)' : 'rgba(150,200,120,0.08)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// --- Organic feature meshes (see-what-you-play) ----------------------------
// A feature's outline is the SAME wavy edge terrain.ts classifies + dishes: a
// seeded, angle-periodic wobble via edgeRadius(seed, angle, baseR). These polar
// builders step that exact convention (angle where cos→+x, sin→+d) so the drawn
// outline == the played/baked outline, for ANY hole. Ring/fan quads are wound so
// the top surface FRONT-faces up (proven against the terrain grid winding).
type UVFn = (wx: number, wd: number, ang: number, frac: number) => [number, number];

// A filled organic disc (centre + concentric rings) out to edgeRadius(seed,
// angle, baseR); interior rings scale that same wavy radius inward (frac), so the
// shape stays coherent. `yAt` seats every vertex on the terrain (flush); pass a
// constant for a flat surface (water). Used for the green cap + bunker sand cap.
function buildOrganicDisc(
  seed: number,
  cd: number,
  cx: number,
  baseR: number,
  yAt: (d: number, x: number) => number,
  lift: number,
  uv: UVFn,
  rings: number,
  seg: number,
  // Optional cup aperture: drop every triangle overlapping the disc (pd,px,r) and
  // report the radius that must be covered by the collar patch (max pin→removed-
  // vertex distance) via onPunched. Used by the green cap so the sunken liner is
  // visible; other callers omit it.
  punch?: { pd: number; px: number; r: number; onPunched?: (coverR: number) => void },
): THREE.BufferGeometry {
  const vcount = 1 + rings * seg;
  const pos = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  pos[0] = cx;
  pos[1] = yAt(cd, cx) + lift;
  pos[2] = -cd;
  const cuv = uv(cx, cd, 0, 0);
  uvs[0] = cuv[0];
  uvs[1] = cuv[1];
  let p = 3;
  let u = 2;
  for (let ri = 1; ri <= rings; ri++) {
    const frac = ri / rings;
    for (let s = 0; s < seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      const rad = edgeRadius(seed, ang, baseR) * frac;
      const wx = cx + Math.cos(ang) * rad;
      const wd = cd + Math.sin(ang) * rad;
      pos[p] = wx;
      pos[p + 1] = yAt(wd, wx) + lift;
      pos[p + 2] = -wd;
      const vv = uv(wx, wd, ang, frac);
      uvs[u] = vv[0];
      uvs[u + 1] = vv[1];
      p += 3;
      u += 2;
    }
  }
  const idx: number[] = [];
  let coverR = 0;
  const keep = (i0: number, i1: number, i2: number): boolean => {
    if (!punch) return true;
    const ax = pos[i0 * 3]!, ad = -pos[i0 * 3 + 2]!;
    const bx = pos[i1 * 3]!, bd = -pos[i1 * 3 + 2]!;
    const cxv = pos[i2 * 3]!, cdv = -pos[i2 * 3 + 2]!;
    if (!triHitsDisc(punch.px, punch.pd, punch.r, ax, ad, bx, bd, cxv, cdv)) return true;
    // Removed: track how far its vertices reach so the collar patch fully hides it.
    for (const [vx, vd] of [[ax, ad], [bx, bd], [cxv, cdv]] as const) {
      const dd = Math.hypot(vx - punch.px, vd - punch.pd);
      if (dd > coverR) coverR = dd;
    }
    return false;
  };
  for (let s = 0; s < seg; s++) {
    const a = 1 + s, b = 1 + ((s + 1) % seg);
    if (keep(0, a, b)) idx.push(0, a, b);
  }
  for (let ri = 1; ri < rings; ri++) {
    const b0 = 1 + (ri - 1) * seg;
    const b1 = 1 + ri * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      if (keep(b0 + s, b1 + s, b0 + s1)) idx.push(b0 + s, b1 + s, b0 + s1);
      if (keep(b0 + s1, b1 + s, b1 + s1)) idx.push(b0 + s1, b1 + s, b1 + s1);
    }
  }
  if (punch) punch.onPunched?.(coverR);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// An organic annulus from edgeRadius(seed, angle, rInBase) to edgeRadius(seed,
// angle, rOutBase). edgeRadius is linear in baseR, so interpolating the base per
// ring is exactly interpolating the two wavy edges — and sharing `seed` with the
// green cap makes the fringe's inner edge nest perfectly against the cap's outer
// edge. Used for the fringe collar + the water shoreline. Flat if yAt is const.
// `colorAt`, when passed, writes a per-vertex 'color' attribute keyed by the
// ring position: frac (0 at rIn → 1 at rOut) and the ring's BASE radius (yd).
// The fringe collar uses it to FEATHER its outer edge from the collar green into
// the rough colour across a short apron band, so the collar→rough transition
// reads as a graded "first cut" (like the fairway↔rough band) instead of a hard
// mesh-edge line into the dark rough.
type ColorFn = (frac: number, base: number) => [number, number, number];
function buildOrganicAnnulus(
  seed: number,
  cd: number,
  cx: number,
  rInBase: number,
  rOutBase: number,
  yAt: (d: number, x: number) => number,
  lift: number,
  uv: UVFn,
  rings: number,
  seg: number,
  colorAt?: ColorFn,
): THREE.BufferGeometry {
  const vcount = (rings + 1) * seg;
  const pos = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const col = colorAt ? new Float32Array(vcount * 3) : null;
  let p = 0;
  let u = 0;
  for (let ri = 0; ri <= rings; ri++) {
    const frac = ri / rings;
    const base = rInBase + frac * (rOutBase - rInBase);
    const rgb = colorAt ? colorAt(frac, base) : null;
    for (let s = 0; s < seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      const rad = edgeRadius(seed, ang, base);
      const wx = cx + Math.cos(ang) * rad;
      const wd = cd + Math.sin(ang) * rad;
      pos[p] = wx;
      pos[p + 1] = yAt(wd, wx) + lift;
      pos[p + 2] = -wd;
      const vv = uv(wx, wd, ang, frac);
      uvs[u] = vv[0];
      uvs[u + 1] = vv[1];
      if (col && rgb) {
        col[p] = rgb[0];
        col[p + 1] = rgb[1];
        col[p + 2] = rgb[2];
      }
      p += 3;
      u += 2;
    }
  }
  const idx: number[] = [];
  for (let ri = 0; ri < rings; ri++) {
    const b0 = ri * seg;
    const b1 = (ri + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      idx.push(b0 + s, b1 + s, b0 + s1, b0 + s1, b1 + s, b1 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// --- Cup aperture (see-into-the-hole) --------------------------------------
// The regulation liner (a real sunken cup) needs the opaque green surfaces at the
// pin PUNCHED so the camera can see DOWN into it — a cylinder dropped below a
// continuous green cap is otherwise fully occluded. Both the coarse base terrain
// grid AND the finer green cap have their triangles OVER the cup removed; a small
// terrain-following "collar" patch (buildCupCollar) then restores the green right
// up to a clean circular lip at CUP_R, hiding the ragged coarse aperture. These
// tests classify which triangles to drop.
//
// True if triangle (a,b,c), in the (x,d) ground plane, overlaps the disc centred
// (px,pd) radius r: any edge passes within r, OR the disc centre is inside the
// triangle. (Endpoint-in-disc is covered by the edge test, which clamps to the
// segment ends.)
function segNearPt(px: number, pd: number, ax: number, ad: number, bx: number, bd: number, r: number): boolean {
  const dx = bx - ax;
  const dd = bd - ad;
  const l2 = dx * dx + dd * dd;
  let t = l2 > 0 ? ((px - ax) * dx + (pd - ad) * dd) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cd = ad + t * dd;
  const ex = px - cx;
  const ed = pd - cd;
  return ex * ex + ed * ed <= r * r;
}
function ptInTri(
  px: number, pd: number,
  ax: number, ad: number, bx: number, bd: number, cx: number, cd: number,
): boolean {
  const d1 = (px - bx) * (ad - bd) - (ax - bx) * (pd - bd);
  const d2 = (px - cx) * (bd - cd) - (bx - cx) * (pd - cd);
  const d3 = (px - ax) * (cd - ad) - (cx - ax) * (pd - ad);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function triHitsDisc(
  px: number, pd: number, r: number,
  ax: number, ad: number, bx: number, bd: number, cx: number, cd: number,
): boolean {
  return (
    segNearPt(px, pd, ax, ad, bx, bd, r) ||
    segNearPt(px, pd, bx, bd, cx, cd, r) ||
    segNearPt(px, pd, cx, cd, ax, ad, r) ||
    ptInTri(px, pd, ax, ad, bx, bd, cx, cd)
  );
}

// A plain circular, terrain-FOLLOWING annulus (green collar) from rIn to rOut,
// world-scaled grain UV so it tiles seamlessly with the green cap. Unlike the
// organic builders this keeps a CLEAN CIRCULAR inner edge — that inner edge is the
// visible cup lip, so it must not wobble. Wound top-face-up.
function buildCupCollar(
  cd: number,
  cx: number,
  rIn: number,
  rOut: number,
  yAt: (d: number, x: number) => number,
  lift: number,
  rings: number,
  seg: number,
): THREE.BufferGeometry {
  const vcount = (rings + 1) * seg;
  const pos = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  let p = 0;
  let u = 0;
  for (let ri = 0; ri <= rings; ri++) {
    const rad = rIn + (ri / rings) * (rOut - rIn);
    for (let s = 0; s < seg; s++) {
      const ang = (s / seg) * Math.PI * 2;
      const wx = cx + Math.cos(ang) * rad;
      const wd = cd + Math.sin(ang) * rad;
      pos[p] = wx;
      pos[p + 1] = yAt(wd, wx) + lift;
      pos[p + 2] = -wd;
      uvs[u] = wx / 6;
      uvs[u + 1] = wd / 6;
      p += 3;
      u += 2;
    }
  }
  const idx: number[] = [];
  for (let ri = 0; ri < rings; ri++) {
    const b0 = ri * seg;
    const b1 = (ri + 1) * seg;
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      idx.push(b0 + s, b1 + s, b0 + s1, b0 + s1, b1 + s, b1 + s1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// --- Fairway "first cut" ribbon (see-what-you-play, geometry parity) --------
// The fairway step-cut is drawn as a REAL geometry band hugging the fairway
// corridor — the SAME technique as the green's collar annulus — instead of a
// texel band baked into the surface map (which quantized + aliased at grazing
// angles). Two triangle strips (left + right of the centerline) follow the spine
// with an INNER edge locked to the corridor half-width (corridorHalfAt — the
// exact line the baked fairway→rough seam and the ball's fairway lie use, so the
// band abuts the fairway) and an OUTER edge firstCutW beyond it. The outer edge
// carries a seeded ±wobble (edgeNoise, keyed by arc length) so it has the same
// tasteful organic waver as the green collar, not a dead-straight line. It is
// terrain-FOLLOWING (yAt = heightAt) so it hugs the ground; explicit up-normals +
// a DoubleSide material keep it evenly lit regardless of winding. The band stops
// short of the green pad so it never fights the fringe collar. Scales to any hole
// (all geometry derives from the centerline + corridorHalfAt).
function buildFirstCutBand(
  hole: CourseHole,
  firstCutW: number,
  yAt: (d: number, x: number) => number,
  lift: number,
): THREE.BufferGeometry {
  const pts = hole.centerline;
  // Cumulative arc length so a sample's normalized position t drives corridorHalfAt.
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]!.d - pts[i]!.d, pts[i + 1]!.x - pts[i]!.x);
    segLen.push(l);
    total += l;
  }
  const pointAtArc = (arc: number): { d: number; x: number } => {
    let acc = 0;
    for (let i = 0; i < segLen.length; i++) {
      const l = segLen[i]!;
      if (arc <= acc + l || i === segLen.length - 1) {
        const f = l > 0 ? Math.max(0, Math.min(1, (arc - acc) / l)) : 0;
        const a = pts[i]!;
        const b = pts[i + 1]!;
        return { d: a.d + (b.d - a.d) * f, x: a.x + (b.x - a.x) * f };
      }
      acc += l;
    }
    return { d: pts[pts.length - 1]!.d, x: pts[pts.length - 1]!.x };
  };

  const STEP = 2; // ~2-yd arc spacing → a smooth ribbon through the doglegs
  const nS = Math.max(2, Math.ceil(total / STEP));
  const seed = featureSeed(hole.tee.d, hole.tee.x) ^ 0x1f3c;
  const WOBBLE_AMP = 0.28; // ±28% of firstCutW on the OUTER edge (inner stays locked)
  const PHASE_YD = 6; // arc→angle divisor: a gentle lobe every ~19 yd (edgeNoise freq 2)
  const INNER_OVERLAP = 0.8; // pull the inner edge this far INTO the fairway so it
  // always covers the baked fairway→rough seam (incl. the small dogleg bevel trim)
  // Stop the band before the green pad so it never overlaps the fringe collar.
  const g = hole.green;
  const trimDist = greenPadRadius(hole) + firstCutW + 6;

  // Per-sample world position + up-to-date corridor half-width; the tangent is a
  // central difference of the sampled positions (rotates smoothly through bends).
  const samp: { d: number; x: number; t: number; half: number; keep: boolean }[] = [];
  for (let k = 0; k <= nS; k++) {
    const arc = (k / nS) * total;
    const p = pointAtArc(arc);
    const t = total > 0 ? arc / total : 0;
    samp.push({
      d: p.d,
      x: p.x,
      t,
      half: corridorHalfAt(hole, t),
      keep: Math.hypot(p.d - g.d, p.x - g.x) >= trimDist,
    });
  }

  const vcount = (nS + 1) * 4; // per sample: leftInner, leftOuter, rightInner, rightOuter
  const pos = new Float32Array(vcount * 3);
  const uvs = new Float32Array(vcount * 2);
  const nrm = new Float32Array(vcount * 3);
  const put = (vi: number, wx: number, wd: number) => {
    pos[vi * 3] = wx;
    pos[vi * 3 + 1] = yAt(wd, wx) + lift;
    pos[vi * 3 + 2] = -wd;
    uvs[vi * 2] = wx / 6;
    uvs[vi * 2 + 1] = wd / 6;
    nrm[vi * 3 + 1] = 1; // flat up-normal → even lighting (DoubleSide covers winding)
  };
  for (let k = 0; k <= nS; k++) {
    const s = samp[k]!;
    const prev = samp[Math.max(0, k - 1)]!;
    const next = samp[Math.min(nS, k + 1)]!;
    let td = next.d - prev.d;
    let tx = next.x - prev.x;
    const tl = Math.hypot(td, tx) || 1;
    td /= tl;
    tx /= tl;
    // Unit normal (perpendicular to the tangent) in the (d,x) plane.
    const nd = tx;
    const nx = -td;
    const arc = s.t * total;
    const wobL = firstCutW * (1 + WOBBLE_AMP * edgeNoise(seed, arc / PHASE_YD));
    const wobR = firstCutW * (1 + WOBBLE_AMP * edgeNoise(seed ^ 0x55, arc / PHASE_YD + 1.7));
    const inOff = s.half - INNER_OVERLAP;
    const base = k * 4;
    // Left side (+normal): inner then outer.
    put(base + 0, s.x + nx * inOff, s.d + nd * inOff);
    put(base + 1, s.x + nx * (s.half + wobL), s.d + nd * (s.half + wobL));
    // Right side (−normal): inner then outer.
    put(base + 2, s.x - nx * inOff, s.d - nd * inOff);
    put(base + 3, s.x - nx * (s.half + wobR), s.d - nd * (s.half + wobR));
  }
  const idx: number[] = [];
  for (let k = 0; k < nS; k++) {
    if (!(samp[k]!.keep && samp[k + 1]!.keep)) continue;
    const a = k * 4;
    const b = (k + 1) * 4;
    // Left strip (inner=+0, outer=+1); right strip (inner=+2, outer=+3). Winding
    // is irrelevant (DoubleSide + explicit up-normals), so a simple quad each.
    idx.push(a + 0, a + 1, b + 0, b + 0, a + 1, b + 1);
    idx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(idx);
  return geo;
}

export default function CourseGL({ sim, onArm, paused }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onArmRef = useRef(onArm);
  onArmRef.current = onArm;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const hole: CourseHole = sim.hole;

    // Visible ball + cup radii (yards) come from the sim's single source of
    // truth (greenPhysics.BALL_R / CUP_R): the ball is drawn at the SAME radius
    // the sim plays and at ~0.4× the cup, so it visibly fits the hole and drops.

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    let w = host.clientWidth || window.innerWidth;
    let h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    // Warm distance haze from the shared kit (makeFog) — one near/far shared with
    // the range (reconciled to the course's wider values: the green sits ~512 yd
    // out, so the far plane clears the pin) so distant fairway/trees fade alike.
    scene.fog = makeFog();

    // Cloud + distant-hill sky dome (shared with the range) — replaces the old
    // flat 3-stop background so the sky reads with depth, not a painted wall.
    addSkyDome(scene, track);

    const hemi = new THREE.HemisphereLight(0xcdeaff, 0x4f7d3f, 1.05);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.7);
    sun.position.set(-160, 260, 120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 900;
    sun.shadow.camera.left = -320;
    sun.shadow.camera.right = 320;
    sun.shadow.camera.top = 340;
    sun.shadow.camera.bottom = -340;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.03;
    const mid = hole.centerline[Math.floor(hole.centerline.length / 2)] ?? hole.pin;
    sun.target.position.set(mid.x, 0, -mid.d);
    scene.add(sun);
    scene.add(sun.target);

    // --- Terrain mesh --------------------------------------------------
    // Frame the ground/surface-map to the HOLE, not fixed HOLE_1 numbers, so any
    // future hole (a wider corridor, a dogleg swinging far off centre, a tee not
    // at d≈0) renders fully with no code change. The lateral half-width covers the
    // widest point of the centreline plus the full rough band (roughHalf) plus a
    // margin; the downrange span runs from behind the tee to past the pin. If a
    // hole's playable area still exceeded this frame it would clip at the edges,
    // but deriving from the model means it fits by construction.
    const MARGIN = 30; // yд of grass beyond the OB line / behind tee / past pin
    let clMaxX = 0;
    let clMinD = hole.tee.d;
    let clMaxD = hole.pin.d;
    for (const p of hole.centerline) {
      clMaxX = Math.max(clMaxX, Math.abs(p.x));
      clMinD = Math.min(clMinD, p.d);
      clMaxD = Math.max(clMaxD, p.d);
    }
    const dMin = Math.min(hole.tee.d, clMinD) - MARGIN;
    const dMax = Math.max(hole.pin.d, clMaxD) + MARGIN + 80;
    const xHalf = clMaxX + hole.roughHalf + MARGIN;
    // Vertex counts scale with the framed span so seam crispness / triangle
    // density stay roughly constant regardless of hole size (~2.9 yd downrange,
    // ~1.9 yd lateral cells on HOLE_1), clamped so a tiny or huge hole stays sane.
    const nd = Math.max(160, Math.min(320, Math.round((dMax - dMin) / 2.9)));
    const nx = Math.max(96, Math.min(192, Math.round((xHalf * 2) / 1.9)));
    // The ground is a segmented plane DISPLACED from a HeightField (the Course
    // data layer, lib/golf/courseData.ts). The field's nodes are laid at exactly
    // this mesh's (nx+1)×(nd+1) vertices, sampling the hole's heightAt. With this
    // config the mesh's grid coords land on integer nodes, so bilinear returns
    // each stored sample and the displacement reproduces the elevation exactly at
    // every vertex — the rendered ground and the physics ground are the same
    // samples. (The scene works in yards; the metric normalization of this field
    // lives in buildCourseData.)
    const field = sampleHeightField(
      (x, d) => heightAt(hole, d, x),
      -xHalf,
      xHalf,
      dMin,
      dMax,
      nx + 1,
      nd + 1,
    );
    const geo = track(new THREE.BufferGeometry());
    const verts = new Float32Array((nd + 1) * (nx + 1) * 3);
    const uvs = new Float32Array((nd + 1) * (nx + 1) * 2);
    let vi = 0;
    let ui = 0;
    let fieldMin = Infinity;
    for (let j = 0; j <= nd; j++) {
      const d = dMin + (j / nd) * (dMax - dMin);
      for (let i = 0; i <= nx; i++) {
        const x = -xHalf + (i / nx) * (xHalf * 2);
        const y = field.height(x, d);
        if (y < fieldMin) fieldMin = y;
        verts[vi] = x;
        verts[vi + 1] = y;
        verts[vi + 2] = -d;
        // UVs span the mesh's (x,d) domain 0..1 so the baked top-down surface map
        // (makeSurfaceMap, same domain) registers pixel-for-pixel with the model.
        uvs[ui] = i / nx;
        uvs[ui + 1] = j / nd;
        vi += 3;
        ui += 2;
      }
    }
    const idx: number[] = [];
    const row = nx + 1;
    // Punch the cup aperture in the ground grid so the sunken liner is visible.
    // The grid is coarse (~2–3 yd cells), so removing the few triangles over the
    // pin leaves a ragged gap much larger than the cup; `gridCoverR` records how
    // far it reaches so the green collar patch is sized to fully hide it.
    const pinD = hole.pin.d;
    const pinX = hole.pin.x;
    const xOf = (i: number) => -xHalf + (i / nx) * (xHalf * 2);
    const dOf = (j: number) => dMin + (j / nd) * (dMax - dMin);
    let gridCoverR = 0;
    const keepGrid = (
      ja: number, ia: number, jb: number, ib: number, jc: number, ic: number,
    ): boolean => {
      const ax = xOf(ia), ad = dOf(ja);
      const bx = xOf(ib), bd = dOf(jb);
      const cx = xOf(ic), cd = dOf(jc);
      if (!triHitsDisc(pinX, pinD, CUP_APERTURE_R, ax, ad, bx, bd, cx, cd)) return true;
      for (const [vx, vd] of [[ax, ad], [bx, bd], [cx, cd]] as const) {
        const dd = Math.hypot(vx - pinX, vd - pinD);
        if (dd > gridCoverR) gridCoverR = dd;
      }
      return false;
    };
    for (let j = 0; j < nd; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * row + i;
        // Wind triangles so the top surface FRONT-faces up. The original winding
        // faced them down, so the whole top was back-face culled and only a flat
        // fill plane showed in the foreground — the "flat grass" bug. Now the
        // displaced, textured terrain renders directly (single-sided, cheap).
        if (keepGrid(j, i, j, i + 1, j + 1, i)) idx.push(a, a + 1, a + row);
        if (keepGrid(j, i + 1, j + 1, i + 1, j + 1, i)) idx.push(a + 1, a + row + 1, a + row);
      }
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Ground albedo is the BAKED top-down surface map — one crisp texture painted
    // straight from surfaceAt (fairway mow stripes / dark olive rough / cart path
    // / OB), so distinct lies read as distinct materials with clean seams that
    // scale to any hole. The green/fringe/tee/bunker/water each get a dedicated
    // overlay mesh on top. The shared blade normal map (scenery.ts) still rakes a
    // soft sun sheen across all of it; roughness stays at the range's 0.85.
    const turfTex = track(makeSurfaceMap(hole, xHalf, dMin, dMax));
    const turfNorm = track(makeTurfNormalMap());
    turfNorm.repeat.set(64, 180); // fine blade relief across the whole ground
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        map: turfTex,
        normalMap: turfNorm,
        roughness: TURF_ROUGHNESS,
        metalness: 0,
      }),
    );
    groundMat.normalScale.set(TURF_NORMAL_SCALE, TURF_NORMAL_SCALE);
    const ground = new THREE.Mesh(geo, groundMat);
    ground.receiveShadow = true;
    scene.add(ground);

    // Distant ground backdrop for the void BEYOND the terrain mesh edges (the
    // hole is only meshed to ±120 yd / just past the pin). Dropped a few yards
    // below the ACTUAL sampled terrain minimum (not the tee/green grade, which a
    // future hilly hole could dip well under) so it can never poke through and
    // occlude the playable ground — that back-face-cull + this poke-through were
    // the "flat grass" bug. Shared turf so the far ground reads as grass.
    const baseY = fieldMin - 3;
    const fillGeo = track(new THREE.PlaneGeometry(2600, 2600));
    const fillTex = track(makeTurfColor());
    fillTex.repeat.set(120, 120);
    const fillMat = track(new THREE.MeshStandardMaterial({ map: fillTex, roughness: 0.95 }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(hole.pin.x, baseY, -hole.pin.d / 2);
    fill.receiveShadow = true;
    scene.add(fill);

    // --- Fairway "first cut" band --------------------------------------
    // A real GEOMETRY ribbon along both sides of the fairway corridor (inner edge
    // on the corridor half-width, outer edge FRINGE_BAND beyond it with a seeded
    // organic wobble), the SAME technique as the green's collar annulus. It's
    // coloured with CUT (== SURFACE_RGB.fringe), so the fairway step-cut and the
    // greenside collar read alike, and its crisp mesh edge stays sharp at grazing
    // angles — the baked texel band was removed from makeSurfaceMap to avoid a
    // doubled seam. Terrain-following (heightAt) + a small lift & polygon offset
    // so it sits just above the ground without z-fighting the baked seam.
    const cutColor = new THREE.Color().setRGB(CUT[0], CUT[1], CUT[2], THREE.SRGBColorSpace);
    const bandNorm = track(makeTurfNormalMap());
    const bandGeo = track(
      buildFirstCutBand(hole, FRINGE_BAND, (d, x) => heightAt(hole, d, x), 0.02),
    );
    const bandMat = track(
      new THREE.MeshStandardMaterial({
        color: cutColor,
        roughness: 0.8,
        metalness: 0,
        normalMap: bandNorm,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    bandMat.normalScale.set(0.35, 0.35);
    const firstCut = new THREE.Mesh(bandGeo, bandMat);
    firstCut.receiveShadow = true;
    scene.add(firstCut);

    // Water discs (shimmer via an animated ripple normal map) + sand bunkers.
    // Both follow the ORGANIC feature outline (edgeRadius + the feature's own
    // featureSeed, the SAME wobble surfaceAt/heightAt use), so the drawn sand/
    // water edge is exactly the wavy shape the ball plays and the baked map
    // classifies — no more circle-vs-organic mismatch. Radial UV for the disc
    // textures. Ground-height (heightAt) sampled per vertex so a bunker cap sits
    // ON the basin bowl; water is a flat surface at its rim height.
    // Shared animated water material (scenery.makeWater) — the SAME multi-wave
    // scrolling normal + sun glint the Range uses, replacing the old static teal
    // disc. Created lazily on the first water hazard and shared across all of a
    // hole's water meshes (one material, one per-frame update). The geometry
    // stays terrain-following + organic (buildOrganicDisc), so only the material
    // is single-sourced.
    let waterKit: ReturnType<typeof makeWater> | null = null;
    const sandTex = track(makeSand());
    sandTex.repeat.set(3, 3);
    const radialUV: UVFn = (_wx, _wd, ang, frac) => [
      0.5 + Math.cos(ang) * frac * 0.5,
      0.5 + Math.sin(ang) * frac * 0.5,
    ];
    for (const hz of hole.hazards) {
      const hzSeed = featureSeed(hz.d, hz.x);
      if (hz.kind === 'water') {
        // The water surface must COVER the ENTIRE baked-water footprint (which
        // surfaceAt classifies out to edgeRadius(hzSeed, angle, hz.r)) with no
        // exposed baked crescent. A single flat plane at one rim height failed:
        // the rolling hills are NOT erased under a hazard, so the basin rim rides
        // several yards higher on the far side than a lone rimY sample — the baked
        // water there poked ABOVE the flat plane, leaving the dark crescent under
        // a hard seam. Fix: sample heightAt PER VERTEX (like the sand cap) so the
        // water skin sits a hair proud of the ground at every point it covers, and
        // OVERFILL the wobbled radius slightly (WATER_OVER) so the sub-segment
        // chord + the wave both fully reach the classified edge on ALL sides. 72
        // segments kill the faceting. The shoreline then just laps the edge.
        const groundY = (d: number, x: number) => heightAt(hole, d, x);
        const WATER_OVER = 1.03;
        const wGeo = track(
          buildOrganicDisc(hzSeed, hz.d, hz.x, hz.r * WATER_OVER, groundY, 0.12, radialUV, 8, 72),
        );
        waterKit ??= makeWater(track);
        const water = new THREE.Mesh(wGeo, waterKit.material);
        scene.add(water);
        // A thin pale shoreline (organic annulus, SAME seed → hugs the water's
        // wave) that laps JUST outside the water edge. Its inner base sits under
        // the water overfill (so no gap) and it lifts a hair LESS than the water,
        // so the water wins the overlap; the narrow 0.98→1.06·r band keeps it from
        // spilling deep into the fringe/rough (old 1.08 base bulged to ~1.24·r).
        const shoreGeo = track(
          buildOrganicAnnulus(hzSeed, hz.d, hz.x, hz.r * 0.98, hz.r * 1.06, groundY, 0.07, radialUV, 2, 72),
        );
        const shoreMat = track(
          new THREE.MeshBasicMaterial({
            color: 0xdaf0f2,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
          }),
        );
        const shore = new THREE.Mesh(shoreGeo, shoreMat);
        scene.add(shore);
      } else if (hz.kind === 'bunker') {
        // A DISHED sand cap that samples the heightfield (the basin bowl) along
        // the ORGANIC outline, so a ball — which rests on the terrain height —
        // sits ON the sand, and the sand's wavy edge matches the played bunker.
        const sGeo = track(
          buildOrganicDisc(
            hzSeed,
            hz.d,
            hz.x,
            hz.r,
            (d, x) => heightAt(hole, d, x),
            0.05,
            radialUV,
            6,
            48,
          ),
        );
        // DoubleSide so a downward-facing fan normal can't cull the sand away.
        const sMat = track(
          new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1, side: THREE.DoubleSide }),
        );
        const sand = new THREE.Mesh(sGeo, sMat);
        sand.receiveShadow = true;
        scene.add(sand);
      }
    }

    // --- Fringe collar + green cap -------------------------------------
    // Two concentric, terrain-FOLLOWING pads with ORGANIC (wavy) outlines sized
    // straight from the model (greenPadRadius = green.r + fringeW) so they scale
    // to any hole. Both step edgeRadius(gSeed, angle, ·) — the SAME seeded wobble
    // surfaceAt/heightAt use — so the drawn edge is exactly the played/baked edge:
    //   • the FRINGE COLLAR — an organic annulus from green.r out to the pad
    //     radius, a distinct duller/darker collar band. It ALWAYS rings the green,
    //     so the putting surface never visually bleeds into the bordering sand/
    //     water — there is always a fringe edge (the "green mixes with sand" fix).
    //   • the GREEN CAP — the putting surface out to edgeRadius(gSeed,angle,
    //     green.r), a brighter, finely grained mown material distinct from both the
    //     fringe and the fairway.
    // Both hug heightAt (tilt + undulation) with REAL computed normals so the
    // contour shades as a sculpted green from any angle, not flat paint.
    // The green CAP is punched at the pin (cup aperture); `capCoverR` records how
    // far the removed cap triangles reach so the cup collar hides them (shared with
    // the cup block below).
    let capCoverR = 0;
    {
      const gDef = hole.green;
      const padR = greenPadRadius(hole); // green.r + fringeW (BASE pad radius)
      // The green + fringe SHARE the green's featureSeed (terrain.ts convention),
      // so the cap's outer wavy edge and the fringe's inner wavy edge are the SAME
      // curve — the collar nests perfectly and the whole organic pad matches the
      // baked map + physics exactly.
      const gSeed = featureSeed(gDef.d, gDef.x);
      const grain = track(makeGreenGrain());
      const SEG = 64; // enough segments for a smooth wavy edge
      const groundY = (d: number, x: number) => heightAt(hole, d, x);

      // Fringe collar + first-cut APRON: an ORGANIC annulus from the green edge
      // (green.r, pulled in 0.25 yd so the cap overlaps it → no seam gap) out
      // PAST the pad radius by a short apron. The inner band (green.r→padR) is
      // the collar; the apron (padR→padR+APRON) FEATHERS the collar green into
      // the rough colour via per-vertex colours, so the collar no longer ends on
      // a hard bright/dark line into the rough — it grades in like the fairway↔
      // rough first cut. It's terrain-FOLLOWING (yAt = heightAt) so it hugs the
      // pad skirt with no z-step, and sits a hair BELOW the cap (fLift < LIFT)
      // so the cap wins the overlap. This is render-only (surfaceAt unchanged).
      const APRON = 3; // yd of collar→rough feather beyond the pad edge (tightened
      // from 4 so the collar reads as a crisp band, not a broad pale ring)
      // Collar tone. These albedo values are authored in sRGB (the SAME space as
      // the baked surface map and every material.color); per-vertex 'color'
      // attributes, however, are consumed by three in the LINEAR working space
      // with NO sRGB→linear conversion, so we pre-convert here. Skipping that
      // made the collar render ~3× too bright (the "pale wash" bug) — the earlier
      // single-material collar looked right precisely because material.color DID
      // get the conversion. 0x3a6e30 == SURFACE_RGB.fringe, so the overlay mesh
      // and the baked patch are ONE coherent dark collar green.
      const fringeLin = new THREE.Color(0x3a6e30); // rich, dark collar green (sRGB)
      const rr = SURFACE_RGB.rough;
      const roughLin = new THREE.Color().setRGB(rr[0], rr[1], rr[2], THREE.SRGBColorSpace);
      const fringeColorAt: ColorFn = (_frac, base) => {
        if (base <= padR) return [fringeLin.r, fringeLin.g, fringeLin.b];
        let t = (base - padR) / APRON;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const s = t * t * (3 - 2 * t); // smoothstep collar → rough (linear space)
        return [
          fringeLin.r + (roughLin.r - fringeLin.r) * s,
          fringeLin.g + (roughLin.g - fringeLin.g) * s,
          fringeLin.b + (roughLin.b - fringeLin.b) * s,
        ];
      };
      const fGeo = track(
        buildOrganicAnnulus(
          gSeed,
          gDef.d,
          gDef.x,
          gDef.r - 0.25,
          padR + APRON,
          groundY,
          0.01, // fringe lift — lowered so the ball's contact shadow (heightAt+0.03)
          // pokes above the green stack and anchors the ball (was 0.035)
          radialUV,
          8, // more rings so the collar band + apron feather are both smooth
          SEG,
          fringeColorAt,
        ),
      );
      const fNorm = track(makeTurfNormalMap());
      fNorm.repeat.set(10, 10);
      const fMat = track(
        new THREE.MeshStandardMaterial({
          // White base so the per-vertex collar/apron colours show directly (the
          // collar green → rough feather is baked into the vertex colours above).
          color: 0xffffff,
          vertexColors: true,
          roughness: 0.82,
          metalness: 0,
          normalMap: fNorm,
          side: THREE.DoubleSide,
        }),
      );
      fMat.normalScale.set(0.4, 0.4);
      const fringe = new THREE.Mesh(fGeo, fMat);
      fringe.receiveShadow = true;
      scene.add(fringe);

      // Green cap: an ORGANIC filled disc out to edgeRadius(gSeed, angle, green.r)
      // — the SAME wavy putting-surface outline surfaceAt classifies. Every vertex
      // samples heightAt (tilt + undulation) with real computed normals, so the
      // contour still shades as a sculpted green. World-scaled grain UV (~6 yd
      // tile) for an even mow.
      const grainUV: UVFn = (wx, wd) => [wx / 6, wd / 6];
      const capGeo = track(
        buildOrganicDisc(gSeed, gDef.d, gDef.x, gDef.r, groundY, 0.02, grainUV, 10, SEG, {
          pd: hole.pin.d,
          px: hole.pin.x,
          r: CUP_APERTURE_R,
          onPunched: (r) => {
            capCoverR = r;
          },
        }),
      );
      const capNorm = track(makeTurfNormalMap());
      capNorm.repeat.set(16, 16);
      const capMat = track(
        new THREE.MeshStandardMaterial({
          color: GREEN_COLOR, // shared bright putting green — matches the range island green
          roughness: 0.6,
          metalness: 0,
          map: grain, // fine mow grain → textured, not flat paint
          normalMap: capNorm,
        }),
      );
      capMat.normalScale.set(0.22, 0.22);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.receiveShadow = true;
      scene.add(cap);
    }

    // --- Tee box -------------------------------------------------------
    // A mown, rectangular teeing ground at hole.tee so the opening view reads
    // like a real tee, not a spot on the fairway. Built like the green cap: a
    // terrain-FOLLOWING grid (samples heightAt so it hugs the ground) lifted a
    // hair above the terrain, with flat up-normals to avoid a shading crease,
    // and a darker/tidier mown green distinct from the fairway. Two blue tee
    // markers flank the ball, and (only on the tee shot) a subtle peg tees it up.
    // The pad is built in a local frame aligned to the aim line (tee→pin): u runs
    // forward down that line, v runs perpendicular. It's set BACK from the ball so
    // the ball sits on the front third.
    let teePeg: THREE.Mesh | null = null;
    // The tee box (pad + markers + peg) lives in a GROUP centred at the tee, with
    // children in tee-local coords, baked to the DRIVE-LINE heading (first fairway
    // leg). It stays FIXED there in world space — a teeing ground is a physical
    // object and does not move. At address (aimRad = 0, camera looking down the
    // drive line) it reads square to the screen; as the player steers, only the
    // CAMERA yaws while the box stays put (a golfer turning to a new line — the tee
    // markers don't move). The group carries no aim rotation (rotation.y stays 0 =
    // the baked drive-line orientation).
    {
      const teeD = hole.tee.d;
      const teeX = hole.tee.x;
      const teeGrp = new THREE.Group();
      teeGrp.position.set(teeX, 0, -teeD); // fixed at the tee; children are tee-local
      // Forward unit = the DRIVE LINE (first fairway leg, centerline[0]→[1]) — the
      // tee-shot aim base (sim.aimHeading() at aimRad 0), so the address camera and
      // this box are square to the fairway, not twisted at the pin on a dogleg. The
      // group rotation (−aimRad) in the loop then tracks the camera as you steer.
      // On a straight hole / par-3 the first leg is collinear tee→pin, so this is
      // the old tee→pin heading (byte-identical box). Its right-perpendicular is
      // (fx, −fd).
      const c0 = hole.centerline[0] ?? hole.tee;
      const c1 = hole.centerline[1] ?? hole.pin;
      let fd = c1.d - c0.d;
      let fx = c1.x - c0.x;
      const flen = Math.hypot(fd, fx) || 1;
      fd /= flen;
      fx /= flen;
      const rd = fx; // right = perpendicular of forward: (fx, -fd)
      const rx = -fd;
      const heading = Math.atan2(fx, fd); // world yaw of the drive line

      const PAD_HALF_W = 4.5; // ~9 yd wide
      const PAD_FRONT = 3.5; // yd ahead of the ball
      const PAD_BACK = 7.5; // yd behind the ball → ball on the front third of ~11 yd
      const NU = 12;
      const NV = 10;
      const LIFT = 0.05;
      const padDepth = PAD_FRONT + PAD_BACK;
      const rowV = NV + 1;
      const vcount = (NU + 1) * rowV;
      const ppos = new Float32Array(vcount * 3);
      const puv = new Float32Array(vcount * 2);
      let pp = 0;
      let pu = 0;
      for (let a = 0; a <= NU; a++) {
        const u = -PAD_BACK + (a / NU) * padDepth;
        for (let c = 0; c <= NV; c++) {
          const v = -PAD_HALF_W + (c / NV) * (PAD_HALF_W * 2);
          const wd = teeD + fd * u + rd * v;
          const wx = teeX + fx * u + rx * v;
          // Tee-LOCAL x/z (offset from the group origin at the tee) so the group can
          // rotate the box about the tee; Y stays the absolute sampled ground height.
          ppos[pp] = wx - teeX;
          ppos[pp + 1] = heightAt(hole, wd, wx) + LIFT;
          ppos[pp + 2] = -(wd - teeD);
          puv[pu] = c / NV;
          puv[pu + 1] = a / NU;
          pp += 3;
          pu += 2;
        }
      }
      const pidx: number[] = [];
      for (let a = 0; a < NU; a++) {
        for (let c = 0; c < NV; c++) {
          const base = a * rowV + c;
          // Wound front-face UP for this aim frame (the right vector flips the
          // handedness vs the main terrain grid, so the up-facing order is
          // base → base+row → base+1). Up-normals are set explicitly below, so
          // this only governs which side survives back-face culling.
          pidx.push(base, base + rowV, base + 1, base + 1, base + rowV, base + rowV + 1);
        }
      }
      const padGeo = track(new THREE.BufferGeometry());
      padGeo.setAttribute('position', new THREE.BufferAttribute(ppos, 3));
      padGeo.setAttribute('uv', new THREE.BufferAttribute(puv, 2));
      padGeo.setIndex(pidx);
      // Flat up-normals (like the green cap) so the pad reads as a clean, level
      // mown surface with no center shading crease.
      const pnorm = new Float32Array(vcount * 3);
      for (let i = 0; i < vcount; i++) pnorm[i * 3 + 1] = 1;
      padGeo.setAttribute('normal', new THREE.BufferAttribute(pnorm, 3));
      const padNorm = track(makeTurfNormalMap());
      padNorm.repeat.set(6, 8);
      // Tightly-mown tee turf (colour baked into the map, so the pad reads as
      // grass — not flat paint). Colour left white so the map shows through; the
      // blade normal map still rakes a soft sun sheen. A distinct, tidier mow
      // than the fairway stripes, consistent with the green/fairway grass kit.
      const teeTex = track(makeTeeTurf());
      teeTex.repeat.set(3, 5);
      const padMat = track(
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          map: teeTex,
          roughness: 0.72,
          metalness: 0,
          normalMap: padNorm,
        }),
      );
      padMat.normalScale.set(0.3, 0.3);
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.receiveShadow = true;
      teeGrp.add(pad);

      // Two tee markers flanking the ball, perpendicular to the aim line. Low
      // blue blocks; they cast shadows onto the pad. Geometry/material shared.
      const markGeo = track(new THREE.BoxGeometry(0.7, 0.5, 1.0));
      const markMat = track(
        new THREE.MeshStandardMaterial({ color: 0x2f6fe0, roughness: 0.5, metalness: 0 }),
      );
      const markU = 0.4; // just ahead of the ball
      const markV = 3.7;
      for (const sgn of [-1, 1]) {
        const wd = teeD + fd * markU + rd * sgn * markV;
        const wx = teeX + fx * markU + rx * sgn * markV;
        const mk = new THREE.Mesh(markGeo, markMat);
        // Tee-local position (Y absolute); the box's small yaw stays the baked
        // heading — cosmetically irrelevant for a low block, exact at aimRad = 0.
        mk.position.set(wx - teeX, heightAt(hole, wd, wx) + 0.25, -(wd - teeD));
        mk.rotation.y = heading;
        mk.castShadow = true;
        mk.receiveShadow = true;
        teeGrp.add(mk);
      }

      // Subtle tee peg under the ball (tee shot only — toggled in the loop by
      // stroke count). A thin short cylinder rising from the pad to the ball.
      const pegH = 0.42;
      const pegGeo = track(new THREE.CylinderGeometry(0.05, 0.07, pegH, 8));
      const pegMat = track(new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.55 }));
      teePeg = new THREE.Mesh(pegGeo, pegMat);
      const pegY = heightAt(hole, teeD, teeX) + LIFT;
      // At the tee centre → the group's local origin (Y absolute).
      teePeg.position.set(0, pegY + pegH / 2, 0);
      teePeg.castShadow = true;
      teeGrp.add(teePeg);
      scene.add(teeGrp);
    }

    // NOTE: the in-scene green-reading overlay (slope heat tint + contour grid +
    // fall-line arrows) was REMOVED here by design (locked with the user) — the
    // green now renders as a clean putting surface. The concise "downhill · breaks
    // left" read still lives in the CourseGame HUD, driven by sim.slopeUnder() /
    // getState(), which are untouched.

    // Flagstick — normalized to the REGULATION height (2.13 m) from the Course
    // data layer. The scene is yard-space, so the metric constants convert with
    // YD_PER_M; the old pole was a hard-coded 8 yd (24 ft), 3.4× too tall.
    const pinY = heightAt(hole, hole.pin.d, hole.pin.x);
    const floorY = pinY - CUP_DEPTH; // liner base sits here (ball rests at floorY + BALL_R)
    const poleH = FLAGSTICK_HEIGHT_M * YD_PER_M; // 2.13 m ≈ 2.33 yd
    // The stick now seats on the cup FLOOR (regulation — the flagstick rests in the
    // hole), so it's extended by CUP_DEPTH and centred lower; the flag stays put.
    const poleLen = poleH + CUP_DEPTH;
    const poleGeo = track(new THREE.CylinderGeometry(0.06, 0.06, poleLen, 6));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 }));
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(hole.pin.x, floorY + poleLen / 2, -hole.pin.d);
    pole.castShadow = true;
    scene.add(pole);
    const flagW = poleH * 0.42;
    const flagH = poleH * 0.28;
    const flagGeo = track(new THREE.PlaneGeometry(flagW, flagH));
    const flagMat = track(
      new THREE.MeshStandardMaterial({ color: 0xe8402c, roughness: 0.7, side: THREE.DoubleSide }),
    );
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(hole.pin.x + flagW / 2, pinY + poleH - flagH / 2, -hole.pin.d);
    flag.castShadow = true;
    scene.add(flag);
    // The cup — a REGULATION LINER (a real sunken 3D hole). The regulation hole
    // (HOLE_DIAMETER_M = 0.108 m ≈ 0.06 yd radius, the data-model truth) is sub-
    // pixel, so — like the ball — it's drawn OVERSIZED for readability at the sim's
    // capture radius (greenPhysics.CUP_R); the ball (BALL_R ≈ 0.4× CUP_R) drops in
    // and nestles at the bottom. Built ONCE (static), no per-frame geometry, no new
    // shadow map. Course scene only.
    //
    // SEE-INTO-THE-CUP: the green cap AND the coarse base grid were PUNCHED at the
    // pin (above) — a cylinder below a continuous opaque cap is otherwise occluded.
    // A terrain-following COLLAR patch then restores the green from the clean CUP_R
    // lip out past both apertures (max coverR + margin), so the only mouth you see
    // is a crisp circle, and everything inside it is the liner interior. Depth-
    // correct (real depthTest), so the near rim occludes the far wall + the settled
    // ball — it reads as a true hole from the low in-game camera.
    void HOLE_DIAMETER_M;
    const cupR = CUP_R;
    {
      const groundY = (d: number, x: number) => heightAt(hole, d, x);
      const LIP_W = 0.05; // width of the bright cut-rim band around the mouth
      // Collar: green from just outside the bright lip out past the widest punched
      // triangle so the ragged coarse-grid/cap aperture is fully hidden. Same grain
      // + colour as the cap → seamless (a hair above the cap so it wins the overlap).
      const collarR = Math.max(gridCoverR, capCoverR, cupR + 0.4) + 0.3;
      const collarGeo = track(buildCupCollar(hole.pin.d, hole.pin.x, cupR + LIP_W, collarR, groundY, 0.03, 4, 48));
      const collarNorm = track(makeTurfNormalMap());
      collarNorm.repeat.set(16, 16);
      const collarMat = track(
        new THREE.MeshStandardMaterial({
          color: GREEN_COLOR,
          roughness: 0.6,
          metalness: 0,
          map: track(makeGreenGrain()),
          normalMap: collarNorm,
        }),
      );
      collarMat.normalScale.set(0.22, 0.22);
      const collar = new THREE.Mesh(collarGeo, collarMat);
      collar.receiveShadow = true;
      scene.add(collar);

      // A thin bright LIP (cut rim) between the mouth and the collar, sitting a
      // hair proud of the green — the crisp white edge you putt at.
      const lipGeo = track(new THREE.RingGeometry(cupR, cupR + LIP_W, 40));
      const lipMat = track(new THREE.MeshStandardMaterial({ color: 0xf4faf4, roughness: 0.5, side: THREE.DoubleSide }));
      const lip = new THREE.Mesh(lipGeo, lipMat);
      lip.rotation.x = -Math.PI / 2;
      lip.position.set(hole.pin.x, pinY + 0.03, -hole.pin.d);
      scene.add(lip);

      // Cut-soil shoulder: a short DARK collar at the very top of the wall (the
      // sliver of earth between the turf and the plastic liner).
      const soilH = 0.14;
      const soilGeo = track(new THREE.CylinderGeometry(cupR, cupR, soilH, 40, 1, true));
      const soilMat = track(new THREE.MeshStandardMaterial({ color: 0x2a2418, roughness: 1, side: THREE.DoubleSide }));
      const soil = new THREE.Mesh(soilGeo, soilMat);
      soil.position.set(hole.pin.x, pinY - soilH / 2, -hole.pin.d);
      scene.add(soil);

      // White plastic liner wall (open cylinder), from just under the soil rim down
      // to the base. High roughness matte plastic; DoubleSide so the inner face
      // reads from the shallow camera.
      const wallH = CUP_DEPTH - soilH;
      const wallGeo = track(new THREE.CylinderGeometry(cupR, cupR, wallH, 40, 1, true));
      const wallMat = track(new THREE.MeshStandardMaterial({ color: 0xeef3ee, roughness: 0.85, metalness: 0, side: THREE.DoubleSide }));
      const wall = new THREE.Mesh(wallGeo, wallMat);
      wall.position.set(hole.pin.x, pinY - soilH - wallH / 2, -hole.pin.d);
      scene.add(wall);

      // White base disc the ball rests on (a touch darker than the wall for depth).
      const baseGeo = track(new THREE.CircleGeometry(cupR, 40));
      const baseMat = track(new THREE.MeshStandardMaterial({ color: 0xdbe3db, roughness: 0.9, side: THREE.DoubleSide }));
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.rotation.x = -Math.PI / 2;
      base.position.set(hole.pin.x, floorY + 0.006, -hole.pin.d);
      scene.add(base);
    }

    // --- Hole-out celebration (the payoff) -----------------------------
    // A ground ring that pulses outward + a burst of confetti points from the
    // cup, fired once when the ball drops. Hidden until then; animated in the
    // loop off `celebrate` (seconds since hole-out).
    const PCOUNT = 60;
    const celebRingGeo = track(new THREE.RingGeometry(0.35, 0.7, 40));
    const celebRingMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xffe66a,
        transparent: true,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const celebRing = new THREE.Mesh(celebRingGeo, celebRingMat);
    celebRing.rotation.x = -Math.PI / 2;
    celebRing.renderOrder = 11;
    celebRing.visible = false;
    scene.add(celebRing);
    const confColors = [0xff5a5a, 0xffd34e, 0x5ad0ff, 0x6ef07a, 0xff8ad0];
    const confGeo = track(new THREE.BufferGeometry());
    const confPos = new Float32Array(PCOUNT * 3);
    const confCol = new Float32Array(PCOUNT * 3);
    const confVel: { x: number; y: number; z: number }[] = [];
    const tcol = new THREE.Color();
    for (let i = 0; i < PCOUNT; i++) {
      // Deterministic spread (no Math.random in scene setup elsewhere; here it's
      // fine — confetti needn't be reproducible).
      const ang = (i / PCOUNT) * Math.PI * 2 + (i % 5);
      const sp = 4 + (i % 7);
      confVel.push({ x: Math.cos(ang) * sp * 0.5, y: 8 + (i % 5) * 1.6, z: Math.sin(ang) * sp * 0.5 });
      tcol.set(confColors[i % confColors.length]!);
      confCol[i * 3] = tcol.r;
      confCol[i * 3 + 1] = tcol.g;
      confCol[i * 3 + 2] = tcol.b;
    }
    confGeo.setAttribute('position', new THREE.BufferAttribute(confPos, 3));
    confGeo.setAttribute('color', new THREE.BufferAttribute(confCol, 3));
    const confMat = track(
      new THREE.PointsMaterial({
        size: 9,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const confetti = new THREE.Points(confGeo, confMat);
    confetti.renderOrder = 12;
    confetti.visible = false;
    scene.add(confetti);
    let celebrate = -1; // seconds since hole-out; <0 = not celebrating

    // Clean-DROP animation (render-only — the sim has already stopped at rest near
    // the cup centre when holed, so we OVERRIDE the ball mesh position while holed:
    // ease x/z to the exact cup centre and drop Y from the surface to the cup floor
    // with an accelerating fall + one soft settle, THEN fire the celebration on the
    // landing beat). No CourseSim state added — this is purely the render.
    const DROP_FALL = 0.32; // s: accelerating fall to the base
    const DROP_SETTLE = 0.12; // s: one soft damped bounce off the base
    let dropT = -1; // seconds into the drop; <0 = not dropping
    // Fire-once latch: the ring+confetti celebration plays EXACTLY ONCE per hole-
    // out (it used to re-fire every ~1.6 s while holed, pulsing over the cup-drop
    // moment). Independent of dropT (never gates the drop); cleared on hole reset.
    let celebrated = false;
    const dropStart = new THREE.Vector3();
    // The ball rests with its underside exactly ON the base disc (which sits at
    // floorY + 0.006), so centre = floorY + 0.006 + BALL_R (no intersection).
    const cupCenter = new THREE.Vector3(hole.pin.x, floorY + 0.006 + BALL_R, -hole.pin.d);

    // Ball. BALL_R is a VISUAL radius: the regulation ball (BALL_DIAMETER_M =
    // 0.0427 m ≈ 0.023 yd radius) is sub-pixel under the yard-tuned follow camera,
    // so it's drawn oversized for readability. True-metric ball sizing lands when
    // the scene converts to meters (that phase also owns the camera). Referenced
    // so the intent is explicit and the constant is a single source of truth.
    void BALL_DIAMETER_M;
    const ballGeo = track(new THREE.SphereGeometry(BALL_R, 32, 24));
    // Dimpled ball material shared with the range (ballTexture.ts) — a dimple
    // normal map so the sun catches the surface, instead of a plain smooth sphere.
    const ballMat = track(makeBallMaterial(track(makeDimpleNormalMap())));
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);

    // Contact shadow: a soft dark disc that ALWAYS sits on the ground directly
    // under the ball (at heightAt beneath it, whatever lie it's on), so the ball
    // reads as SEATED on the turf rather than floating. It complements the sun's
    // cast shadow (which the grazing camera + low-contrast turf can wash out) and
    // fades/grows with the ball's altitude while it's in the air. The ball's
    // centre is drawn at b.h + BALL_R, i.e. its underside exactly on b.h — the
    // same heightAt the physics rests on — so seated, this disc kisses the base
    // of the ball.
    const shadowTex = track(makeContactShadowTexture());
    const ballShadowMat = track(
      new THREE.MeshBasicMaterial({
        map: shadowTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.9,
      }),
    );
    const ballShadowGeo = track(new THREE.PlaneGeometry(BALL_R * 3.2, BALL_R * 3.2));
    const ballShadow = new THREE.Mesh(ballShadowGeo, ballShadowMat);
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.renderOrder = 2;
    scene.add(ballShadow);

    // Tracer (ball flight/roll trail).
    const tracerMat = track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    const tracerGeo = track(new THREE.BufferGeometry());
    const tracerBuf = new Float32Array(70 * 3);
    tracerGeo.setAttribute('position', new THREE.BufferAttribute(tracerBuf, 3));
    tracerGeo.setDrawRange(0, 0);
    const tracer = new THREE.Line(tracerGeo, tracerMat);
    scene.add(tracer);

    // --- Predicted-shot aim aid (the arc + reticles + dispersion) -------
    // A bright centre arc to a landing reticle + a roll-out marker at the rest
    // point, plus two faded edge arcs (worst hook ↔ worst slice) for dispersion.
    // Fed by sim.predict() — the SAME integrator as the live shot, on the
    // terrain — so what it draws is where the ball actually goes.
    //
    // ROOT CAUSE of the long-standing "the arc doesn't appear" bug (fixed here):
    // these line/points objects reuse a FIXED BufferGeometry whose vertices are
    // rewritten every drag (fillArc). three.js computes geometry.boundingSphere
    // LAZILY once, on the first render the object is visible, and NEVER recomputes
    // it when the buffer changes. So the sphere froze around the FIRST aim's arc
    // (near the tee); on every later shot the ball + camera moved downrange, the
    // stale sphere fell outside the frustum, and three CULLED the whole object
    // before drawing — so predict() and fillArc ran fine but nothing was ever
    // submitted to the GPU. Every prior "fix" (dots↔lines, depthTest off,
    // renderOrder) acted AFTER culling, so none could help. The committed
    // screenshot harness only ever aims ONCE per fresh sim, so it never triggered
    // it. The fix: these are dynamic UI overlays whose extent changes every frame,
    // so a cached bounding sphere is meaningless — disable frustum culling
    // (`frustumCulled = false`, applied by aimAid below) and they always draw.
    // ARC_MAX comfortably exceeds the longest predicted path for a real shot (a
    // full carry + long fairway roll samples ~800 points at stride 2), so the
    // centre line is effectively never truncated; fillArc still caps n at ARC_MAX,
    // so a pathological creep that sampled more would just clip harmlessly.
    const ARC_MAX = 2048;
    const arcGeo = track(new THREE.BufferGeometry());
    arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
    arcGeo.setDrawRange(0, 0);
    // Aim aids are UI overlays: depthTest OFF + a high renderOrder so a low
    // wedge/approach arc that hugs the ground isn't occluded by the terrain mesh.
    const overlay = (m: THREE.Material) => {
      m.depthTest = false;
      m.depthWrite = false;
      return m;
    };
    const AIM_ORDER = 10;
    // Register an aim-aid object: hidden until an aim, drawn on top, and — the
    // fix above — NEVER frustum-culled (its geometry's extent is rewritten each
    // drag, so the cached bounding sphere three would cull against is stale).
    const aimAid = <T extends THREE.Object3D>(o: T): T => {
      o.visible = false;
      o.renderOrder = AIM_ORDER;
      o.frustumCulled = false;
      scene.add(o);
      return o;
    };
    // The centre trajectory is drawn as DOTS (constant screen size, clear at any
    // distance) AND a connected line through the same path — the line is the
    // reliable baseline for every club/GPU; the points add emphasis.
    const arcMat = track(
      overlay(new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, transparent: true, opacity: 0.95 })),
    ) as THREE.PointsMaterial;
    const arcPts = aimAid(new THREE.Points(arcGeo, arcMat));
    const arcLineMat = track(
      overlay(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })),
    );
    const arcLine = aimAid(new THREE.Line(arcGeo, arcLineMat));
    const arc = { g: arcGeo, l: arcPts, line: arcLine };
    const makeLine = (color: number, opacity: number) => {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
      g.setDrawRange(0, 0);
      const m = track(overlay(new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
      const l = aimAid(new THREE.Line(g, m));
      return { g, l };
    };
    const edgeL = makeLine(0xffe08a, 0.45);
    const edgeR = makeLine(0xffe08a, 0.45);
    const ringMat = track(
      overlay(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })),
    );
    const landRingGeo = track(new THREE.RingGeometry(2.4, 3.6, 32));
    const landRing = aimAid(new THREE.Mesh(landRingGeo, ringMat));
    landRing.rotation.x = -Math.PI / 2;
    const restRingGeo = track(new THREE.RingGeometry(1.6, 2.4, 28));
    const restRingMat = track(
      overlay(new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })),
    );
    const restRing = aimAid(new THREE.Mesh(restRingGeo, restRingMat));
    restRing.rotation.x = -Math.PI / 2;

    // Pre-wind (intended) reticle — a hollow amber ring at where the shot WOULD
    // land with no wind. The gap between it and the wind-adjusted landing ring
    // reads the wind push, exactly like the Range. Shown only when it visibly
    // differs from the wind landing.
    const preRingGeo = track(new THREE.RingGeometry(2.8, 3.3, 32));
    const preRingMat = track(
      overlay(
        new THREE.MeshBasicMaterial({
          color: 0xffd54a,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
        }),
      ),
    );
    const preRing = aimAid(new THREE.Mesh(preRingGeo, preRingMat));
    preRing.rotation.x = -Math.PI / 2;

    // --- On-turf aim guide (arrow + tip reticle + steer chevrons) ------------
    // Lifted from the Range for a matched feel: a tapering arrow on the turf from
    // the ball along the shot line, growing + reddening with power. Oriented in
    // updateAim toward the intended (pre-wind) landing and shown only while
    // addressing a shot. depthTest off (overlay) so a sloped fairway can't
    // occlude it, and frustumCulled off like every other aim aid.
    const AIM_LEN = 42; // yards to the tip reticle at rest
    const aimGuide = new THREE.Group();
    aimGuide.frustumCulled = false;
    // Continuous power feedback across the WHOLE range: GREEN (low) → AMBER (mid)
    // → RED (max), matched to RangeGL so the two scenes read identically.
    const aimColLow = new THREE.Color(0x46d66b); // green — soft
    const aimColMid = new THREE.Color(0xffd54a); // amber — half power
    const aimColHigh = new THREE.Color(0xff4326); // red — near max (straining)
    const aw = 0.42; // shaft half-width
    const awh = 1.7; // head half-width
    const ahl = 6; // head length
    const az0 = -2.4; // start just ahead of the ball
    const azHead = -(AIM_LEN - ahl);
    const azTip = -AIM_LEN;
    const arrowVerts = new Float32Array([
      -aw, 0, az0, aw, 0, az0, aw, 0, azHead, // shaft tri 1
      -aw, 0, az0, aw, 0, azHead, -aw, 0, azHead, // shaft tri 2
      -awh, 0, azHead, awh, 0, azHead, 0, 0, azTip, // head
    ]);
    const arrowGeo = track(new THREE.BufferGeometry());
    arrowGeo.setAttribute('position', new THREE.BufferAttribute(arrowVerts, 3));
    const aimMat = track(
      overlay(
        new THREE.MeshBasicMaterial({
          color: aimColLow.clone(),
          transparent: true,
          opacity: 0.6,
          side: THREE.DoubleSide,
        }),
      ),
    ) as THREE.MeshBasicMaterial;
    const arrowMesh = new THREE.Mesh(arrowGeo, aimMat);
    arrowMesh.renderOrder = AIM_ORDER;
    arrowMesh.frustumCulled = false;
    aimGuide.add(arrowMesh);
    const aimReticleGeo = track(new THREE.RingGeometry(1.7, 2.3, 24));
    const aimReticle = new THREE.Mesh(aimReticleGeo, aimMat);
    aimReticle.rotation.x = -Math.PI / 2;
    aimReticle.position.set(0, 0, azTip);
    aimReticle.renderOrder = AIM_ORDER;
    aimReticle.frustumCulled = false;
    aimGuide.add(aimReticle);
    const chevGeo = track(new THREE.BufferGeometry());
    const acs = 1.1;
    chevGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([0, 0, acs, acs * 1.4, 0, 0, 0, 0, -acs]), 3),
    );
    const chevMat = track(
      overlay(
        new THREE.MeshBasicMaterial({
          color: aimColLow.clone(),
          transparent: true,
          opacity: 0.42,
          side: THREE.DoubleSide,
        }),
      ),
    ) as THREE.MeshBasicMaterial;
    const chevL = new THREE.Mesh(chevGeo, chevMat);
    chevL.position.set(-4.4, 0, -15);
    chevL.rotation.y = Math.PI; // point left (−X)
    chevL.renderOrder = AIM_ORDER;
    chevL.frustumCulled = false;
    aimGuide.add(chevL);
    const chevR = new THREE.Mesh(chevGeo, chevMat);
    chevR.position.set(4.4, 0, -15); // point right (+X)
    chevR.renderOrder = AIM_ORDER;
    chevR.frustumCulled = false;
    aimGuide.add(chevR);
    aimGuide.visible = false;
    scene.add(aimGuide);
    const aimCol = new THREE.Color();

    const fillArc = (
      buf: THREE.BufferGeometry,
      path: { d: number; x: number; h: number }[],
    ) => {
      const attr = buf.attributes.position as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      const n = Math.min(path.length, ARC_MAX);
      for (let i = 0; i < n; i++) {
        const p = path[i]!;
        arr[i * 3] = p.x;
        arr[i * 3 + 1] = p.h + 0.5;
        arr[i * 3 + 2] = -p.d;
      }
      buf.setDrawRange(0, n);
      attr.needsUpdate = true;
    };
    // "Bang on target" feedback: when the predicted shot will actually HOLE OUT
    // (sim.predict(0).result === 'holed' — the real integrator, break included, so
    // it's true for a dead-centre putt or a holing chip), the aim line + reticle
    // light up gold/green and pulse. Otherwise the normal white aim. Set here, run
    // in the frame loop so the pulse animates.
    let aimHoling = false;
    const showAim = (on: boolean) => {
      arc.l.visible = on;
      arc.line.visible = on;
      edgeL.l.visible = on;
      edgeR.l.visible = on;
      landRing.visible = on;
      restRing.visible = on;
      aimGuide.visible = on;
      if (!on) preRing.visible = false; // gap ring re-decided by updateAim when on
    };
    // Draw a predicted path but, for a FULL SWING, only up to the FIRST bounce —
    // everything past the carry endpoint (bounces + roll-out) is left for the
    // player to judge (landingIndex marks that slot). A PUTT never goes airborne
    // (landingIndex null), so its full roll line to the cup is drawn unchanged.
    const arcPathOf = (p: CoursePrediction): CourseTrailPt[] =>
      p.landingIndex != null ? p.path.slice(0, p.landingIndex + 1) : p.path;
    const updateAim = () => {
      // Wind-adjusted centre line + landing/rest, plus the two tap-timing edges.
      const c = sim.predict({ includeWind: true });
      aimHoling = c.result === 'holed';
      // Full swing → arcs stop at the first bounce; putt → full roll line.
      const fullSwing = c.landingIndex != null;
      fillArc(arc.g, arcPathOf(c));
      fillArc(edgeL.g, arcPathOf(sim.predict({ accuracy: -1, includeWind: true })));
      fillArc(edgeR.g, arcPathOf(sim.predict({ accuracy: 1, includeWind: true })));
      const land = c.landing ?? c.rest;
      if (c.landing) {
        landRing.position.set(c.landing.x, c.landing.h + 0.12, -c.landing.d);
        landRing.visible = true;
      } else {
        landRing.visible = false;
      }
      // Roll-out rest marker: only a putt shows it (the post-bounce roll guess is
      // removed for full swings). Position is still set for the putt case.
      restRing.position.set(c.rest.x, c.rest.h + 0.12, -c.rest.d);
      restRing.visible = !fullSwing;

      // Pre-wind (intended) reticle — the gap to the landing ring shows the wind
      // push. Only drawn when it visibly differs.
      const intended = sim.predict({ includeWind: false, stride: 12 });
      const iLand = intended.landing ?? intended.rest;
      preRing.position.set(iLand.x, iLand.h + 0.12, -iLand.d);
      preRing.visible = Math.hypot(iLand.d - land.d, iLand.x - land.x) > 3;

      // On-turf aim guide: seat it at the ball on the terrain, point it toward
      // the intended (pre-wind) landing, grow + redden it with power.
      const gb = sim.ball;
      aimGuide.position.set(gb.x, heightAt(hole, gb.d, gb.x) + 0.16, -gb.d);
      aimGuide.rotation.y = Math.atan2(gb.x - iLand.x, iLand.d - gb.d);
      aimGuide.scale.z = 1 + sim.power * 0.85; // clearer length delta across range
      // 3-stop green→amber→red ramp (colour is refreshed per-frame by
      // applyAimStrain too, so the strain throb animates even while armed/idle).
      const pw = sim.power;
      if (pw < 0.5) aimCol.copy(aimColLow).lerp(aimColMid, pw * 2);
      else aimCol.copy(aimColMid).lerp(aimColHigh, (pw - 0.5) * 2);
      aimMat.color.copy(aimCol);
      chevMat.color.copy(aimCol);
      aimMat.opacity = 0.42 + pw * 0.45;
      chevMat.opacity = 0.42;

      // restRing visibility is decided above (putt only); don't force it on here.
      arc.l.visible = arc.line.visible = edgeL.l.visible = edgeR.l.visible = true;
      aimGuide.visible = true;
    };
    // Default (not-holing) aim colours, restored whenever the on-target pulse ends.
    const AIM_WHITE = 0xffffff;
    const REST_CYAN = 0x66e0ff;
    const gold = new THREE.Color(0xffd23f);
    const holeGreen = new THREE.Color(0x53ff8a);
    const pulseCol = new THREE.Color();
    const arcLineM = arcLineMat as THREE.LineBasicMaterial;
    const restRingM = restRingMat as THREE.MeshBasicMaterial;
    const landRingM = ringMat as THREE.MeshBasicMaterial;
    // Animate the aim colours each frame while an aim is showing.
    const applyAimColor = (now: number) => {
      if (!arc.line.visible) return;
      if (aimHoling) {
        const t = 0.5 + 0.5 * Math.sin(now * 0.007);
        pulseCol.copy(gold).lerp(holeGreen, t);
        arcMat.color.copy(pulseCol);
        arcLineM.color.copy(pulseCol);
        restRingM.color.copy(pulseCol);
        landRingM.color.copy(pulseCol);
        arcMat.opacity = 1;
        arcLineM.opacity = 1;
        restRingM.opacity = 0.7 + 0.3 * t;
        landRingM.opacity = 0.7 + 0.3 * t;
      } else {
        arcMat.color.setHex(AIM_WHITE);
        arcLineM.color.setHex(AIM_WHITE);
        restRingM.color.setHex(REST_CYAN);
        landRingM.color.setHex(AIM_WHITE);
        arcMat.opacity = 0.95;
        arcLineM.opacity = 0.85;
        restRingM.opacity = 0.85;
        landRingM.opacity = 0.9;
      }
    };


    // Trees — the range's two-species grove (broadleaf + pine, 5-tone palette),
    // shared from scenery.ts. Placement stays course-specific: a line down each
    // side of the corridor, each tree lifted onto the terrain (heightAt) and, for
    // depth, a pine woven in behind. World z = −d.
    const trees = createTreeKit(scene, track);
    const clX = (d: number): number => {
      const cl = hole.centerline;
      for (let s = 0; s < cl.length - 1; s++) {
        const a = cl[s]!;
        const b = cl[s + 1]!;
        if (d >= a.d && d <= b.d) return a.x + ((b.x - a.x) * (d - a.d)) / (b.d - a.d || 1);
      }
      return cl[cl.length - 1]!.x;
    };
    for (let d = 20; d < dMax - 20; d += 26) {
      const cx = clX(d);
      const off = hole.roughHalf + 8;
      const lx = cx - off - (d % 3) * 2;
      const ld = d + (d % 7) - 3;
      const rx = cx + off + (d % 4) * 2;
      const rd = d + (d % 5) - 2;
      // Front line: broadleaves. Every third step swap to a pine for variety.
      const leftPine = d % 3 === 0;
      const rightPine = d % 3 === 1;
      // Bigger trees (~1.6×) so the tree line reads with presence, not toy shrubs.
      (leftPine ? trees.addPine : trees.addBroadleaf)(
        lx, -ld, 1.7 + (d % 5) * 0.12, 5000 + d, heightAt(hole, ld, lx),
      );
      (rightPine ? trees.addPine : trees.addBroadleaf)(
        rx, -rd, 1.65 + (d % 4) * 0.14, 9000 + d, heightAt(hole, rd, rx),
      );
      // A receding, still-sizable pine further out each side for a layered line.
      if (d % 2 === 0) {
        const ox = off + 14;
        trees.addPine(cx - ox, -(ld - 6), 1.35, 3000 + d, heightAt(hole, ld - 6, cx - ox));
        trees.addPine(cx + ox, -(rd + 6), 1.4, 4000 + d, heightAt(hole, rd + 6, cx + ox));
      }
    }

    // --- Camera ---------------------------------------------------------
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.5, 2000);
    const camPos = new THREE.Vector3();
    const camLook = new THREE.Vector3();
    const tmpB = new THREE.Vector3();
    const tmpDir = new THREE.Vector3();
    const desiredPos = new THREE.Vector3();
    const desiredLook = new THREE.Vector3();
    const pinV = new THREE.Vector3(hole.pin.x, pinY + 2, -hole.pin.d);
    const UP = new THREE.Vector3(0, 1, 0);
    const wvec = new THREE.Vector3();

    const ballWorld = (out: THREE.Vector3) => out.set(sim.ball.x, sim.ball.h + BALL_R, -sim.ball.d);

    // The ADDRESS view faces down the AIMED line, not the raw pin direction: the
    // horizontal heading is sim.aimHeading() (bearing-to-pin + the slingshot
    // steer), so steering left/right turns the view down the intended line — key
    // now that fairways dogleg. At aimRad = 0 this equals the pin direction, so
    // the default framing is unchanged. Writes the unit (d,x)→world(x,−z) dir into
    // `tmpDir` for the same downrange/offset maths the pin-vector used.
    const aimDir = (out: THREE.Vector3) => {
      const a = sim.aimHeading(); // rad off +d, +x = right
      return out.set(Math.sin(a), 0, -Math.cos(a)).normalize();
    };

    // Initialise camera at the address position. Framed so the ball sits ~64%
    // down the screen (was ~83%), leaving a generous downward slingshot travel
    // below it — see the ADDRESS-CAMERA note on the camera-follow tee branch.
    ballWorld(tmpB);
    aimDir(tmpDir);
    camPos.copy(tmpB).addScaledVector(tmpDir, -21);
    camPos.y = tmpB.y + 7.5;
    camLook.copy(tmpB).addScaledVector(tmpDir, 38);
    camLook.y = tmpB.y - 3.5;
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    // --- Input (slingshot) ---------------------------------------------
    // Full-power pull distance = the ACTUAL screen room below the ball, so a
    // downward slingshot can reach 100% power even when the ball renders LOW (the
    // reported bug: a low ball capped the pull at the bottom controls before
    // maxPull). Project the ball to screen, measure the gap down to the bottom
    // control/safe zone, and make that the maxPull. The elastic powerCurve() then
    // means ~65% of even a short pull already yields ~90% power. Clamped to a sane
    // band; falls back to a fraction of height only if the projection is
    // degenerate. Recomputed at each address (onDown) since the lie/camera — and
    // thus the ball's on-screen height — change shot to shot.
    // The drag uses pointer capture, so the finger can travel over the HUD to the
    // very bottom of the screen; a small MARGIN (below) just keeps 100% off the
    // extreme edge (awkward to hit + iOS edge gestures).
    const pullVec = new THREE.Vector3();
    const applyPull = () => {
      camera.updateMatrixWorld();
      // A PUTT never needs 100% power, and the on-green camera leaves little room
      // below the ball — a room-derived (small) maxPull would make even the
      // minimum arm-able tap too hot and overshoot short putts. So on the green
      // use a GENEROUS finesse maxPull (NOT room-limited) to keep soft taps
      // feather-able. A FULL SWING instead uses the room-derived REACHABLE maxPull
      // so a low ball can still reach full power.
      if (sim.getState().putting) {
        sim.setMaxPull(Math.max(120, h * 0.3));
        return;
      }
      ballWorld(pullVec);
      pullVec.project(camera);
      const ballY = ((1 - pullVec.y) / 2) * h; // px from the top of the canvas
      const ok = Number.isFinite(ballY) && ballY > 0 && ballY < h;
      if (!ok) {
        // Degenerate projection: no reliable ballY to cap against, so use a
        // modest, definitely-reachable pull rather than a room-derived guess.
        sim.setMaxPull(Math.max(44, h * 0.22));
        return;
      }
      // Pointer capture makes the WHOLE gap down to the bottom edge usable
      // (INCLUDING the HUD/safe-area zone), so base the full-power pull on the
      // physical `travel` below the ball (less a small bottom MARGIN) rather than
      // on `room` (which subtracted the 96px BOTTOM_ZONE and needlessly shrank
      // maxPull, making 100% arrive with too little finger travel). With the ball
      // framed ~64% down this yields a longer, more deliberate full pull (~268px
      // on a typical phone vs the old 196px) while scaling the whole 0→100% range
      // up together, so the dialable middle is preserved. The band is a sanity
      // clamp: a floor so a well-framed ball always gets a generous pull, and a
      // cap so a very tall viewport doesn't demand an arm-length drag.
      const travel = h - ballY;
      const MARGIN = 24; // keep a little room above the bottom edge
      const desired = Math.max(140, Math.min(travel - MARGIN, h * 0.55));
      // CRITICAL: never let maxPull exceed the physical drag travel below the ball,
      // or 100% becomes unreachable — the exact regression this guard prevents on
      // SHORT viewports (landscape/split-screen/small desktop windows) where the
      // floor (140) exceeds the travel. On a normal portrait phone `desired` wins
      // (~268px); on a short viewport it caps to the reachable travel, so 100% is
      // ALWAYS reachable within the screen.
      sim.setMaxPull(Math.max(44, Math.min(desired, travel - 8)));
    };
    applyPull();
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // Ramping haptics (view-only, guarded): a short buzz that intensifies as the
    // pull nears 100%, fired sparingly — only when the power crosses a new 10%
    // bucket at/above 50% — so it reads as the slingshot "straining", never a
    // per-frame rattle. Deterministic sim is untouched (this reads sim.power).
    let lastPulseBucket = -1;
    const haptic = (power: number) => {
      if (typeof navigator === 'undefined' || !navigator.vibrate) return;
      if (power < 0.5) {
        lastPulseBucket = -1;
        return;
      }
      const bucket = Math.min(10, Math.floor(power * 10)); // 5..10
      if (bucket <= lastPulseBucket) return; // ramp UP only — easing off won't re-buzz
      lastPulseBucket = bucket;
      navigator.vibrate(6 + (bucket - 5) * 6); // 6ms @50% → 36ms @100%
    };
    const onDown = (e: PointerEvent) => {
      if (pausedRef.current) return;
      canvas.setPointerCapture?.(e.pointerId);
      applyPull(); // re-measure the room for THIS lie/camera before aiming
      lastPulseBucket = -1;
      sim.onPointerDown(local(e));
      showAim(false); // hidden until the first drag gives it a power/aim
    };
    const onMove = (e: PointerEvent) => {
      if (pausedRef.current) return;
      sim.onPointerMove(local(e));
      if (sim.getState().aiming && sim.power > 0.02) updateAim();
      if (sim.getState().aiming) haptic(sim.power);
    };
    const onUp = (e: PointerEvent) => {
      if (pausedRef.current) return;
      if (sim.arm(local(e))) {
        updateAim(); // lock the arc for the accuracy phase
        onArmRef.current?.();
      } else {
        showAim(false);
      }
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    const onResize = () => {
      w = host.clientWidth || window.innerWidth;
      h = host.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      applyPull();
    };
    window.addEventListener('resize', onResize);

    // --- Loop -----------------------------------------------------------
    const fixed = FIXED_MS / 1000;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      let dt = (now - last) / 1000;
      last = now;
      if (dt > 0.1) dt = 0.1;
      if (!pausedRef.current) {
        acc += dt;
        while (acc >= fixed) {
          sim.substep(fixed);
          acc -= fixed;
        }
      }
      const b = sim.ball;
      // Normal positioning: the ball sits on its lie. When holed, the clean-DROP
      // block below OVERRIDES this (later write wins) to sink it into the cup.
      ball.position.set(b.x, b.h + BALL_R, -b.d);

      // Contact shadow: pin it to the GROUND under the ball (heightAt), and fade +
      // grow it with the ball's altitude so it reads as a seated ball at rest and
      // a rising blob in flight. groundY is the same height the physics rests on,
      // so a resting ball's shadow sits exactly at its base.
      const groundY = heightAt(hole, b.d, b.x);
      const alt = Math.max(0, b.h - groundY);
      ballShadow.position.set(b.x, groundY + 0.03, -b.d);
      const shScale = 1 + Math.min(2.5, alt * 0.12);
      ballShadow.scale.set(shScale, shScale, shScale);
      ballShadowMat.opacity = 0.9 * Math.max(0.12, 1 - alt / 8);

      // Water shimmer: shared per-frame hook scrolls the colour + ripple normal
      // maps (multi-wave + sun glint), matching the range.
      if (waterKit) waterKit.update(now / 1000);

      // Sim state (used for the tracer gate below and the aim-hide logic).
      const st = sim.getState();

      // Tracer from the sim trail. Drawn ONLY while the ball is moving (in flight
      // or rolling); once it comes to rest we clear it. A spent trail left rising
      // out of a seated ball reads as the ball "floating" in the low putt camera.
      const tr = sim.trail;
      const n = Math.min(tr.length, 70);
      for (let i = 0; i < n; i++) {
        const p = tr[tr.length - n + i]!;
        tracerBuf[i * 3] = p.x;
        tracerBuf[i * 3 + 1] = p.h + 0.2;
        tracerBuf[i * 3 + 2] = -p.d;
      }
      const showTrace = !st.resting && !st.holed && n > 1;
      tracerGeo.setDrawRange(0, showTrace ? n : 0);
      (tracerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      // The predicted aim arc is refreshed in the pointer handlers (on drag /
      // arm); here we only hide it once the shot is away or the address ends, and
      // animate its colour (gold/green pulse when the shot will hole out).
      if (st.inFlight || (!st.aiming && !st.armed)) showAim(false);
      applyAimColor(now);
      // Elastic strain near max: the tip reticle throbs/stretches as power → 1, a
      // visual "straining against the band" cue (no haptics needed on iOS). Runs
      // per-frame so it animates while dragging AND while the shot is armed/idle.
      if (aimGuide.visible) {
        const strain = Math.max(0, (sim.power - 0.72) / 0.28);
        const throb = 1 + strain * (0.28 + 0.16 * Math.sin(now * 0.02));
        aimReticle.scale.set(throb, throb, 1);
      }

      // Tee peg: only for the tee shot (stroke 0), and hidden once the ball is
      // away so it doesn't linger under a mid-flight/rolling ball.
      if (teePeg) teePeg.visible = st.strokes === 0 && !st.inFlight;

      // Clean-DROP: when holed, override the ball to roll to the exact cup centre
      // and tip in — an accelerating fall to the base then ONE soft settle. The
      // celebration is SEQUENCED to fire as the ball LANDS (not instantly), so the
      // drop reads first. Reset cleanly when the hole resets (st.holed → false).
      if (st.holed) {
        if (dropT < 0) {
          dropT = 0;
          dropStart.set(b.x, b.h + BALL_R, -b.d); // where it came to rest on the green
        } else {
          dropT += dt;
        }
        if (dropT <= DROP_FALL) {
          // Ease x/z to centre (ease-out) while Y accelerates DOWN (ease-in) into
          // the hole.
          const q = dropT / DROP_FALL;
          const ez = 1 - (1 - q) * (1 - q);
          const dx = dropStart.x + (cupCenter.x - dropStart.x) * ez;
          const dz = dropStart.z + (cupCenter.z - dropStart.z) * ez;
          const dy = dropStart.y + (cupCenter.y - dropStart.y) * (q * q);
          ball.position.set(dx, dy, dz);
        } else {
          // One soft damped bounce off the base, then rest at the floor.
          const t = Math.min(1, (dropT - DROP_FALL) / DROP_SETTLE);
          const bounce = Math.sin(t * Math.PI) * (0.4 * BALL_R) * (1 - t);
          ball.position.set(cupCenter.x, cupCenter.y + bounce, cupCenter.z);
        }
        ballShadow.visible = false; // in the hole → no on-turf contact shadow
        // Fire the celebration ONCE on the landing beat (drop completes ~DROP_FALL);
        // the latch keeps it from re-triggering for the rest of this hole-out.
        if (dropT >= DROP_FALL && celebrate < 0 && !celebrated) {
          celebrate = 0;
          celebrated = true;
          celebRing.position.set(hole.pin.x, pinY + 0.06, -hole.pin.d);
          for (let i = 0; i < PCOUNT; i++) {
            confPos[i * 3] = hole.pin.x;
            confPos[i * 3 + 1] = pinY + 0.2;
            confPos[i * 3 + 2] = -hole.pin.d;
          }
        }
      } else {
        // Hole reset / next hole / replay: drop the override so normal ballWorld
        // positioning resumes and the cup is ready again (no leftover drop-state).
        if (dropT >= 0) {
          dropT = -1;
          celebrate = -1;
          celebrated = false; // re-arm so the NEXT hole-out celebrates again
          celebRing.visible = false;
          confetti.visible = false;
        }
        ballShadow.visible = true;
      }
      if (celebrate >= 0) {
        celebrate += dt;
        const T = 1.6;
        const p = Math.min(1, celebrate / T);
        // Ring: expand and fade.
        const rs = 1 + p * 9;
        celebRing.scale.set(rs, rs, rs);
        celebRingMat.opacity = 0.8 * (1 - p);
        celebRing.visible = true;
        // Confetti: ballistic rise + fall, fading out.
        for (let i = 0; i < PCOUNT; i++) {
          const v = confVel[i]!;
          confPos[i * 3]! += v.x * dt;
          confPos[i * 3 + 1]! += (v.y - 16 * celebrate) * dt;
          confPos[i * 3 + 2]! += v.z * dt;
        }
        (confGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
        confMat.opacity = 1 - p;
        confetti.visible = true;
        if (p >= 1) {
          celebrate = -1;
          celebRing.visible = false;
          confetti.visible = false;
        }
      }

      // Camera: chase the ball while it's in the AIR along its travel direction.
      ballWorld(tmpB);
      if (b.inFlight && !b.grounded) {
        tmpDir.set(b.vx, 0, -b.vd); // horizontal travel dir in world (d→−z)
        if (tmpDir.lengthSq() < 1e-4) tmpDir.subVectors(pinV, tmpB).setY(0);
        tmpDir.setY(0).normalize();
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -22);
        desiredPos.y = tmpB.y + 13;
        desiredLook.copy(tmpB).addScaledVector(tmpDir, 24);
        desiredLook.y = tmpB.y - 1.5;
      } else if (b.inFlight) {
        // Rolling on the ground: follow the ball but keep the camera facing the
        // PIN. Using the ball's velocity here made the camera swing around and
        // reverse whenever the ball trickled backward/sideways down a slope.
        tmpDir.subVectors(pinV, tmpB).setY(0);
        if (tmpDir.lengthSq() < 1e-4) tmpDir.set(0, 0, -1);
        tmpDir.normalize();
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -20);
        desiredPos.y = tmpB.y + 12;
        desiredLook.copy(tmpB).addScaledVector(tmpDir, 26);
        desiredLook.y = tmpB.y - 1;
      } else if (st.lie === 'green' || st.putting || st.distToPin < 28) {
        // Putts + short approaches: zoom IN. Sit low just behind the ball and
        // look toward the cup so the ball AND the hole frame together, instead of
        // the wide tee view that made the ball look huge and the green tiny.
        tmpDir.subVectors(pinV, tmpB).setY(0).normalize();
        const R = st.distToPin;
        const back = Math.max(6, Math.min(11, R * 0.5 + 5));
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -back);
        desiredPos.y = tmpB.y + Math.max(3.5, back * 0.5);
        desiredLook.copy(tmpB).addScaledVector(tmpDir, Math.min(R + 3, 24));
        desiredLook.y = tmpB.y - 0.2;
      } else {
        // ADDRESS CAMERA (full swing). Sit lower + further back and tilt down a
        // touch more than the old (−17, +10 → look +46/−0.5) frame, which put the
        // ball ~83% down the screen and left only ~28px of pull room below it (the
        // 44px-floor bug: 0→100% power lived in a ~7mm drag). This frames the ball
        // ~64% down, so applyPull() measures ~180–240px of room → a dialable pull,
        // while the pin/green and the upward arc preview stay in frame (horizon
        // ~34% down). Keep in sync with the initial address frame + RangeGL's tee.
        // Faces the AIMED line (aimDir), so steering yaws the view; the desiredPos/
        // Look below are still smoothly lerped, so the turn eases (never snaps).
        aimDir(tmpDir);
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -21);
        desiredPos.y = tmpB.y + 7.5;
        desiredLook.copy(tmpB).addScaledVector(tmpDir, 38);
        desiredLook.y = tmpB.y - 3.5;
      }
      const k = 1 - Math.pow(0.001, dt);
      camPos.lerp(desiredPos, k);
      camLook.lerp(desiredLook, k);
      camera.position.copy(camPos);
      camera.lookAt(camLook);

      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, [sim]);

  return <div ref={hostRef} style={{ position: 'fixed', inset: 0 }} />;
}
