// Shared scene ingredients for the golf 3D renderers (RangeGL + CourseGL). The
// two scenes drifted — the range grew a rich lit turf, a cloud/hill sky dome and
// a two-species tree grove while the course stayed on flat paint — so the visual
// "kit" now lives HERE and both import it. Change the look once, both scenes move
// together. Only ingredients that are genuinely shared live here; each scene
// keeps its own layout-specific props (range water/net/targets, course
// bunkers/water/flag/cup).
//
// `three` stays in the lazy chunk: this module is only imported by the already
// lazy-loaded *GL.tsx, never by the app entry.
//
// The one wrinkle: the COURSE terrain is multi-surface (fairway/green/rough/
// bunker… as per-vertex colours), while the RANGE is one fairway. So the turf
// colour map comes in two modes — 'green' bakes the fairway green (range, no
// vertex colours) and 'neutral' is a near-white luminance detail meant to
// MULTIPLY the course's per-surface vertex colours (keeping each lie's hue while
// adding mown texture + mottle). The blade/mottle/stripe GEOMETRY is identical
// across modes, so the two scenes can't diverge on grass detail again.

import * as THREE from 'three';
import type { Surface } from './terrain';

export interface Disposable {
  dispose: () => void;
}
export type Track = <T extends Disposable>(o: T) => T;

// --- Fog -------------------------------------------------------------------
// Denser, warm distance haze (aerial perspective). ONE shared near/far so the
// two scenes can't drift: reconciled to the Course's wider values (the long
// corridor's green sits ~512 yd out), which read fine on the shorter range too.
// Both scenes call makeFog() with no args.
export const FOG_COLOR = 0xd6ecf4;
export const FOG_NEAR = 170;
export const FOG_FAR = 780;
export function makeFog(near = FOG_NEAR, far = FOG_FAR): THREE.Fog {
  return new THREE.Fog(FOG_COLOR, near, far);
}

// --- Shared grass palette + stripe/turf constants --------------------------
// The Course terrain is multi-surface: each lie has a base albedo. This table
// (0..1 linear-ish RGB, authored in sRGB) is the SINGLE source of truth for the
// per-lie colours — the Course's baked makeSurfaceMap keys off it and the Range
// pulls the fairway hue + green from it, so the two scenes render the same grass.
// (NOTE: distinct from courseData.ts's SURFACE_RGB, which is a 0..255 mask
// encoding keyed by the CourseSurface ENUM — this one is keyed by the terrain
// `Surface` string union and is a render albedo.)
export const SURFACE_RGB: Record<Surface, [number, number, number]> = {
  fairway: [0.4, 0.66, 0.28],
  green: [0.373, 0.686, 0.337], // darker, lusher putting green (0x5faf56) — matches GREEN_COLOR
  fringe: [0.227, 0.431, 0.188], // rich, dark collar green (0x3a6e30) — matches the overlay
  rough: [0.19, 0.37, 0.16], // darker + more olive → clearly not fairway
  bunker: [0.9, 0.82, 0.6],
  // The pond BED, not the water. The surface is its own lit, reflective mesh
  // now (water.ts), and it is semi-transparent in the shallows — so what this
  // colour paints is the silt you see THROUGH the water at the margin, and the
  // damp bank in the sliver above the waterline. A bright blue here was the
  // single biggest reason the hazard read as "an inset with blue": the ground
  // itself was painted pond-coloured, so the illusion never depended on the
  // water at all. Dark wet silt reads correctly in both roles.
  water: [0.44, 0.43, 0.33],
  cartpath: [0.74, 0.71, 0.66],
  tee: [0.34, 0.55, 0.26],
  ob: [0.13, 0.28, 0.12],
};

// Bold world-locked fairway mow stripes: the band period is STRIPE_YD yards
// downrange, alternating a brighter (STRIPE_HI) and darker (STRIPE_LO) multiply
// of the fairway hue. Shared so the Course's baked map and the Range's tiled
// fairway texture cut the SAME stripes.
export const STRIPE_YD = 7;
export const STRIPE_HI = 1.16;
export const STRIPE_LO = 0.82;
// Width (yd) of the distinct intermediate-cut / "first cut" band that sits
// between the mown fairway and the long-grass rough — a tightly-mown step-cut
// collar with CRISP lines at both edges (fairway | first cut | rough), NOT a
// smooth gradient. Kept very narrow (a real step cut is ~a mower-width wide).
// Render-only: surfaceAt classification is unchanged (see makeSurfaceMap).
export const FRINGE_BAND = 2.75;
// Shared turf material tuning so both scenes catch the same sun sheen.
export const TURF_ROUGHNESS = 0.85;
export const TURF_NORMAL_SCALE = 0.45;

// One putting-green colour so the Course putting green and the Range island
// green read the same. Leans to the brighter Course green.
export const GREEN_COLOR = 0x5faf56;

// --- Sky -------------------------------------------------------------------
// Deep-blue → hazy-horizon gradient with puffy cumulus clusters and two layers
// of distant hills. Rendered as a BackSide dome by addSkyDome().
export function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#1f6ec8');
  grad.addColorStop(0.42, '#3d8ed9');
  grad.addColorStop(0.7, '#8ac6ea');
  grad.addColorStop(0.85, '#cde8f6');
  grad.addColorStop(1, '#e8f4fb');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const cloud = (cx: number, cy: number, s: number, seed: number) => {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < 7; i++) {
      const bx = cx + (rnd() - 0.5) * s * 1.9;
      const by = cy - Math.abs(rnd() - 0.5) * s * 0.5;
      const br = s * (0.42 + rnd() * 0.5);
      const rg = g.createRadialGradient(bx, by - br * 0.2, 0, bx, by, br);
      rg.addColorStop(0, 'rgba(255,255,255,0.98)');
      rg.addColorStop(0.5, 'rgba(248,251,255,0.72)');
      rg.addColorStop(0.82, 'rgba(214,232,246,0.28)');
      rg.addColorStop(1, 'rgba(214,232,246,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(bx, by, br, 0, Math.PI * 2);
      g.fill();
    }
  };
  const N = 30;
  for (let i = 0; i < N; i++) {
    const cx = ((i + 0.5) / N) * c.width + ((i * 13) % 17) - 8;
    const cy = 250 + ((i * 5) % 4) * 54 + ((i * 3) % 2) * 24;
    cloud(cx, cy, 22 + ((i * 7) % 4) * 9, i * 2654435761);
  }
  g.fillStyle = 'rgba(150,190,175,0.55)';
  g.beginPath();
  g.moveTo(0, 760);
  for (let x = 0; x <= c.width; x += 64) {
    g.lineTo(x, 720 + Math.sin(x * 0.012) * 26 + Math.sin(x * 0.03) * 12);
  }
  g.lineTo(c.width, 820);
  g.lineTo(0, 820);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(120,170,150,0.4)';
  g.beginPath();
  g.moveTo(0, 790);
  for (let x = 0; x <= c.width; x += 48) {
    g.lineTo(x, 770 + Math.sin(x * 0.02 + 2) * 18);
  }
  g.lineTo(c.width, 830);
  g.lineTo(0, 830);
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Add the cloud/hill sky dome to a scene, tracking its resources for disposal. */
export function addSkyDome(scene: THREE.Scene, track: Track): void {
  const tex = track(makeSkyTexture());
  const geo = track(new THREE.SphereGeometry(900, 32, 16));
  const mat = track(new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }));
  scene.add(new THREE.Mesh(geo, mat));
}

// --- Reflection environment (cheap PMREM) ----------------------------------
// A high-metalness MeshStandardMaterial (the gold/chrome ball skins) has no
// diffuse term and reflects its env map; with none set it reflects BLACK. This
// builds a CHEAP prefiltered environment ONCE per scene so metals read as
// reflecting the sky instead of near-black. It is assigned to the BALL MATERIAL
// ONLY (ballMat.envMap = …) — NOT scene.environment — so ONLY the ball samples
// the PMREM: turf/trees/water/sand pay no per-frame env cost (visual-QA confirmed
// those non-ball materials look identical with the env off, so scene-wide IBL
// bought nothing there — scoping to the ball is the on-device GPU win). The sky
// dome / background visuals are untouched.
//
// Source is a TINY vertical-gradient equirect (sky above the horizon, a muted
// lit-turf tone below) that matches the sky-dome palette; PMREM prefilters it at
// low resolution. Both the generator and its source texture are disposed
// immediately after generation (one-time cost); the resulting render target is
// tracked so its GPU memory is released on scene teardown.

// Small equirectangular gradient whose colours match the sky dome (deep blue →
// hazy horizon) with a muted ground half below the horizon so downward metal
// reflections read as turf, not white. Width is small (a pure vertical
// gradient); height caps the prefilter resolution — kept low for low-end GPUs.
// Exported because water.ts reflects this SAME gradient: the pond's sky
// reflection and the ball's PMREM environment are then guaranteed to agree with
// the sky dome's palette — if the sky is ever retuned, the water follows.
export function makeSkyGradientTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  // Upper hemisphere (zenith → horizon) — the sky-dome palette.
  grad.addColorStop(0.0, '#1f6ec8'); // zenith
  grad.addColorStop(0.32, '#3d8ed9');
  grad.addColorStop(0.46, '#8ac6ea');
  grad.addColorStop(0.5, '#dceff8'); // horizon haze
  // Lower hemisphere (horizon → nadir) — muted, sunlit turf so metals reflect a
  // plausible ground below, not a white void.
  grad.addColorStop(0.54, '#7fa06a');
  grad.addColorStop(1.0, '#40592f'); // nadir turf
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Callers set `mapping` for their own use: makeSkyEnvMap marks it as an
  // equirect for the PMREM, water.ts samples it directly as a 2D latitude ramp.
  return tex;
}

/**
 * Generate a cheap PMREM reflection environment from a tiny sky/ground gradient
 * and RETURN its prefiltered texture (does NOT set scene.environment — the caller
 * assigns it to the BALL material's envMap so only the ball reflects the sky).
 * The prefiltered render target is registered via `track()` so it's disposed on
 * teardown; the PMREM generator + its source texture are one-time and disposed
 * here. Call ONCE at scene build, after the renderer exists. Shared by all three
 * golf scenes so metallic ball skins reflect the same sky.
 */
export function makeSkyEnvMap(
  renderer: THREE.WebGLRenderer,
  track: Track,
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const src = makeSkyGradientTexture();
  src.mapping = THREE.EquirectangularReflectionMapping;
  const rt = pmrem.fromEquirectangular(src);
  // The source gradient + the generator's internal resources are one-time; free
  // them now. The returned render target stays valid and holds the env texture,
  // so it is the only thing tracked for teardown disposal.
  src.dispose();
  pmrem.dispose();
  track(rt);
  return rt.texture;
}

// --- Turf ------------------------------------------------------------------

// Shared blade-streak + sun/shade-mottle detail painted over an existing turf
// base (used by both makeTurfColor and makeFairwayTurf so the grass grain can't
// diverge). `S` is the canvas edge in px.
function paintTurfDetail(g: CanvasRenderingContext2D, S: number): void {
  const blade = (n: number, alpha: number, light: boolean) => {
    for (let i = 0; i < n; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const len = 3 + Math.random() * 7;
      const lean = (Math.random() - 0.5) * 2.2;
      const hue = 95 + Math.random() * 30;
      const lum = light ? 46 + Math.random() * 20 : 22 + Math.random() * 12;
      g.strokeStyle = `hsla(${hue},46%,${lum}%,${alpha})`;
      g.lineWidth = Math.random() < 0.25 ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + lean, y - len);
      g.stroke();
    }
  };
  blade(5200, 0.16, false);
  blade(4200, 0.16, true);
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 20 + Math.random() * 70;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    rg.addColorStop(0, dark ? 'rgba(30,60,25,0.06)' : 'rgba(150,200,120,0.06)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

/**
 * Plain mown-turf colour map (fairway green + blade/mottle grain). Used for the
 * distant fill/backdrop plane where the bold fairway stripes aren't wanted. Drop
 * material roughness to ~TURF_ROUGHNESS so the blade normal map catches sun.
 */
export function makeTurfColor(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const stripes = 8;
  const sw = S / stripes;
  for (let i = 0; i < stripes; i++) {
    const up = i % 2 === 0;
    const grad = g.createLinearGradient(i * sw, 0, (i + 1) * sw, 0);
    if (up) {
      grad.addColorStop(0, '#5db152');
      grad.addColorStop(0.5, '#66ba5a');
      grad.addColorStop(1, '#5db152');
    } else {
      grad.addColorStop(0, '#54a648');
      grad.addColorStop(0.5, '#5cae50');
      grad.addColorStop(1, '#54a648');
    }
    g.fillStyle = grad;
    g.fillRect(i * sw, 0, sw, S);
  }
  paintTurfDetail(g, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Bold world-locked fairway mow stripes on the shared fairway hue. Two CROSSING
 * bands per tile (STRIPE_HI then STRIPE_LO multiply of SURFACE_RGB.fairway) so
 * the caller sets the texture repeat to land the band period near STRIPE_YD; the
 * bands vary down the canvas V axis, which the scenes map to downrange, so they
 * read as crossing mow stripes. Blade streaks + mottle add the lit-grass grain.
 * This is the RANGE counterpart to the Course's baked makeSurfaceMap fairway —
 * both cut the same STRIPE_HI/LO stripes on the same hue.
 */
export function makeFairwayTurf(): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const [fr, fg, fb] = SURFACE_RGB.fairway;
  const band = (m: number) => {
    const r = Math.min(255, Math.round(fr * 255 * m));
    const gg = Math.min(255, Math.round(fg * 255 * m));
    const b = Math.min(255, Math.round(fb * 255 * m));
    return `rgb(${r},${gg},${b})`;
  };
  g.fillStyle = band(STRIPE_HI);
  g.fillRect(0, 0, S, S / 2);
  g.fillStyle = band(STRIPE_LO);
  g.fillRect(0, S / 2, S, S / 2);
  paintTurfDetail(g, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Value-noise blade-ridge normal map so the sun rakes a soft sheen across turf. */
export function makeTurfNormalMap(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const data = img.data;
  const hash = (x: number, y: number) => {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const height = (x: number, y: number) => {
    const xi = ((x % S) + S) % S;
    const yi = ((y % S) + S) % S;
    const blade = hash(Math.floor(xi * 0.9), Math.floor(yi * 0.18));
    const fine = hash(Math.floor(xi), Math.floor(yi * 0.5));
    const coarse = Math.sin(xi * 0.05) * 0.5 + Math.sin(yi * 0.017 + xi * 0.01) * 0.5;
    return blade * 0.7 + fine * 0.2 + coarse * 0.25;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = height(x + 1, y) - height(x - 1, y);
      const hy = height(x, y + 1) - height(x, y - 1);
      let nx = -hx * 1.6;
      let ny = -hy * 1.6;
      let nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv;
      ny *= inv;
      nz *= inv;
      const idx = (y * S + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// --- Trees -----------------------------------------------------------------

export interface TreeKit {
  // (x, z) world position, scale s, RNG seed, and optional ground height y (the
  // range ground is flat at 0; the course passes heightAt so trees sit on the
  // undulating terrain rather than floating).
  addBroadleaf: (x: number, z: number, s: number, seed: number, y?: number) => void;
  addPine: (x: number, z: number, s: number, seed: number, y?: number) => void;
}

/**
 * Two-species low-poly tree builders sharing one trunk material, a 5-tone leaf
 * palette and pooled geometries (all disposal-tracked). Each scene keeps its own
 * PLACEMENT; this only builds a tree at (x, z). Faceted real meshes so the sun
 * casts a proper shadow. A seeded mulberry32 RNG jitters every tree so the grove
 * varies and screenshots stay deterministic.
 */
export function createTreeKit(scene: THREE.Scene, track: Track): TreeKit {
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }));
  const leafMats = [0x2f7d3a, 0x3c8f44, 0x59a24a, 0x276b34, 0x4f9a52].map((col) =>
    track(new THREE.MeshStandardMaterial({ color: col, roughness: 0.95, flatShading: true })),
  );
  const blobGeo = track(new THREE.IcosahedronGeometry(1, 0));
  const bTrunkGeo = track(new THREE.CylinderGeometry(0.45, 0.85, 5.5, 6));
  const pTrunkGeo = track(new THREE.CylinderGeometry(0.32, 0.6, 5, 6));
  const pineGeo = track(new THREE.ConeGeometry(1, 1, 7));

  const treeRng = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pickLeaf = (r: number) => leafMats[Math.floor(r * leafMats.length)] ?? leafMats[0]!;

  const addBroadleaf = (x: number, z: number, s: number, seed: number, y = 0) => {
    const r = treeRng(seed);
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(bTrunkGeo, trunkMat);
    trunk.position.y = 2.5;
    trunk.rotation.z = (r() - 0.5) * 0.12;
    trunk.castShadow = true;
    g.add(trunk);
    const blobs = 5 + Math.floor(r() * 3);
    const crownR = 3 + r() * 0.8;
    const crownY = 6 + r() * 1.2;
    for (let i = 0; i < blobs; i++) {
      const b = new THREE.Mesh(blobGeo, pickLeaf(r()));
      const ang = r() * Math.PI * 2;
      const rad = r() * crownR * 0.8;
      b.position.set(Math.cos(ang) * rad, crownY + (r() - 0.5) * crownR * 0.9, Math.sin(ang) * rad);
      const bs = crownR * (0.55 + r() * 0.45);
      b.scale.set(bs, bs * (0.8 + r() * 0.25), bs);
      b.rotation.set(r() * 3, r() * 3, r() * 3);
      b.castShadow = true;
      g.add(b);
    }
    g.position.set(x, y, z);
    g.rotation.y = r() * Math.PI * 2;
    g.scale.setScalar(s);
    scene.add(g);
  };

  const addPine = (x: number, z: number, s: number, seed: number, y = 0) => {
    const r = treeRng(seed);
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(pTrunkGeo, trunkMat);
    trunk.position.y = 2.5;
    trunk.castShadow = true;
    g.add(trunk);
    const tiers = 4 + Math.floor(r() * 2);
    const mat = pickLeaf(r() * 0.5);
    let ty = 4.2;
    let rad = 2.6 + r() * 0.7;
    for (let i = 0; i < tiers; i++) {
      const t = new THREE.Mesh(pineGeo, mat);
      const hgt = 2.6 + r() * 0.6;
      t.scale.set(rad, hgt, rad);
      t.position.y = ty;
      t.rotation.y = r() * Math.PI;
      t.castShadow = true;
      g.add(t);
      ty += hgt * 0.62;
      rad *= 0.74 + r() * 0.06;
    }
    g.position.set(x, y, z);
    g.scale.setScalar(s);
    scene.add(g);
  };

  return { addBroadleaf, addPine };
}

// --- Water -----------------------------------------------------------------
// Water moved to its own module (lib/golf/water.ts) when it grew from a tinted
// texture into a real surface: level geometry with per-vertex depth, Gerstner
// waves, Fresnel + sky/planar reflection, wave-driven foam and a shared splash.
// It imports the sky gradient from here (one palette), so the dependency runs
// scenery -> water and NOT back. The three scenes import makeWater/makeWaterFX
// from './water' directly.

// --- Ball contact shadow ---------------------------------------------------
/**
 * Soft radial-gradient disc texture for the ball's contact shadow — a dark blob
 * that sits on the ground directly under the ball so it reads as SEATED, not
 * floating (complements the sun's cast shadow, which the grazing camera can wash
 * out). Each scene builds its own plane (sized to its BALL_R) and fades/scales it
 * with the ball's altitude; this only supplies the shared texture.
 */
export function makeContactShadowTexture(): THREE.Texture {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const gx = cv.getContext('2d')!;
  const rg = gx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, 'rgba(0,0,0,0.5)');
  rg.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  gx.fillStyle = rg;
  gx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}
