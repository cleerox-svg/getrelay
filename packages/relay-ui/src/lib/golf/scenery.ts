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

export interface Disposable {
  dispose: () => void;
}
export type Track = <T extends Disposable>(o: T) => T;

// --- Fog -------------------------------------------------------------------
// Denser, warm distance haze (aerial perspective). The range uses the near/far
// directly; the long course corridor passes a larger `far` but the same feel.
export const FOG_COLOR = 0xd6ecf4;
export const FOG_NEAR = 130;
export const FOG_FAR = 500;
export function makeFog(near = FOG_NEAR, far = FOG_FAR): THREE.Fog {
  return new THREE.Fog(FOG_COLOR, near, far);
}

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

// --- Turf ------------------------------------------------------------------

export type TurfMode = 'green' | 'neutral';

/**
 * Mown-turf colour map. 'green' (range) bakes the fairway green directly. 'neutral'
 * (course) is a near-white luminance detail designed to MULTIPLY per-surface
 * vertex colours — same stripe/blade/mottle geometry, but drawn as light/dark
 * luminance around white so it reads as mown grass over ANY lie tint without
 * pushing the hue. Drop material roughness to ~0.82 in both scenes so the blade
 * normal map (makeTurfNormalMap) catches a soft sun sheen.
 */
export function makeTurfColor(mode: TurfMode = 'green'): THREE.Texture {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const neutral = mode === 'neutral';

  // Mow stripes down the width. Green mode uses real greens; neutral uses a
  // gentle light/near-white delta so the multiply only lightly darkens alternate
  // bands (the stripe still reads, the surface hue is preserved).
  const stripes = 8;
  const sw = S / stripes;
  for (let i = 0; i < stripes; i++) {
    const up = i % 2 === 0;
    const grad = g.createLinearGradient(i * sw, 0, (i + 1) * sw, 0);
    if (neutral) {
      // A near-white "up" band and a clearly darker "down" band. Because this
      // MULTIPLIES the surface vertex colour, only values below white add detail,
      // so the mow read comes from the darker alternate band — it needs real
      // contrast (~20%) to show through, not a whisper.
      if (up) {
        grad.addColorStop(0, '#f2f2f2');
        grad.addColorStop(0.5, '#ffffff');
        grad.addColorStop(1, '#f2f2f2');
      } else {
        grad.addColorStop(0, '#9aa890');
        grad.addColorStop(0.5, '#a6b39c');
        grad.addColorStop(1, '#9aa890');
      }
    } else if (up) {
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

  // Directional blade streaks (dark + light passes). Neutral draws them as grey
  // luminance so they read on any tint; green uses hue-varied greens.
  const blade = (n: number, alpha: number, light: boolean) => {
    for (let i = 0; i < n; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const len = 3 + Math.random() * 7;
      const lean = (Math.random() - 0.5) * 2.2;
      if (neutral) {
        // Multiply detail: light blades ride near white (near no-op), dark blades
        // dip enough to texture the surface. Only the darkening reads, so make it
        // count.
        const lum = light ? 92 + Math.random() * 6 : 48 + Math.random() * 20;
        g.strokeStyle = `hsla(100,12%,${lum}%,${alpha})`;
      } else {
        const hue = 95 + Math.random() * 30;
        const lum = light ? 46 + Math.random() * 20 : 22 + Math.random() * 12;
        g.strokeStyle = `hsla(${hue},46%,${lum}%,${alpha})`;
      }
      g.lineWidth = Math.random() < 0.25 ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + lean, y - len);
      g.stroke();
    }
  };
  blade(5200, 0.16, false);
  blade(4200, 0.16, true);

  // Broad sun/shade mottling.
  for (let i = 0; i < 120; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 20 + Math.random() * 70;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    if (neutral) {
      rg.addColorStop(0, dark ? 'rgba(55,65,50,0.1)' : 'rgba(255,255,255,0.05)');
    } else {
      rg.addColorStop(0, dark ? 'rgba(30,60,25,0.06)' : 'rgba(150,200,120,0.06)');
    }
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

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
