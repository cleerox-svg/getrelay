// Shared procedural golf-ball look for the 3D golf modes. Instead of adding
// dimple geometry to the sphere (expensive, and pointless at these ball sizes)
// we bake a tileable DIMPLE NORMAL MAP on a canvas and hang it off a plain
// MeshStandardMaterial. Under the scenes' single directional sun the per-dimple
// normals catch a highlight and shade a shadow, so a smooth sphere reads as a
// real dimpled golf ball. Used by both RangeGL and PuttGL so the ball matches.
//
// The map is a hex lattice of concave dimples encoded in tangent space: a flat
// blue-ish field (0,0,+1 → rgb 128,128,255) with, inside each dimple, normals
// tilted toward the dimple centre (a bowl), peaking mid-wall and easing to flat
// at centre and rim. Centres use toroidal distance so the tile repeats
// seamlessly (RepeatWrapping), and it's generated once per scene and disposed
// via the scene's track()/disposables pattern.

import * as THREE from 'three';

// Build the tileable dimple normal map. `size` is the canvas edge (POT).
export function makeDimpleNormalMap(size = 256): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const data = img.data;

  // Hex lattice of dimple centres (odd rows offset by half a cell).
  const cols = 7;
  const rows = 8;
  const cw = size / cols;
  const rh = size / rows;
  const R = cw * 0.52; // dimple radius in px (slight gaps between dimples)
  const STRENGTH = 0.7; // peak horizontal normal tilt on the dimple wall
  const centers: { x: number; y: number }[] = [];
  for (let j = 0; j < rows; j++) {
    const cy = (j + 0.5) * rh;
    const off = (j % 2) * 0.5;
    for (let i = 0; i < cols; i++) centers.push({ x: (i + 0.5 + off) * cw, y: cy });
  }

  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Nearest dimple centre using wrapped (toroidal) deltas for a seamless tile.
      let bestD2 = Infinity;
      let bdx = 0;
      let bdy = 0;
      for (const ctr of centers) {
        let dx = x - ctr.x;
        let dy = y - ctr.y;
        if (dx > half) dx -= size;
        else if (dx < -half) dx += size;
        if (dy > half) dy -= size;
        else if (dy < -half) dy += size;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          bdx = dx;
          bdy = dy;
        }
      }
      let nx = 0;
      let ny = 0;
      let nz = 1;
      const dist = Math.sqrt(bestD2);
      if (dist < R && dist > 1e-3) {
        const t = dist / R; // 0 at centre → 1 at rim
        const slope = Math.sin(t * Math.PI) * STRENGTH; // 0 at centre & rim, peak mid-wall
        nx = -(bdx / dist) * slope; // concave: normals lean toward the centre
        ny = -(bdy / dist) * slope;
        nz = Math.sqrt(Math.max(1e-4, 1 - nx * nx - ny * ny));
      }
      const idx = (y * size + x) * 4;
      data[idx] = (nx * 0.5 + 0.5) * 255;
      data[idx + 1] = (ny * 0.5 + 0.5) * 255;
      data[idx + 2] = (nz * 0.5 + 0.5) * 255;
      data[idx + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace; // a normal map is linear data, never sRGB
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // ~28 dimples around the equator / ~24 rows top-to-bottom on the sphere.
  tex.repeat.set(4, 3);
  tex.anisotropy = 4;
  return tex;
}

// White ball material with a slight sheen (low roughness) and the dimple normal
// map applied at a modest scale. Caller owns disposal of BOTH the returned
// material and the passed-in normal map.
export function makeBallMaterial(normalMap: THREE.Texture): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0.02,
    normalMap,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
}
