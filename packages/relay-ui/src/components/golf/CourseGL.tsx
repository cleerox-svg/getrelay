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
  type CourseHole,
  type Surface,
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
  makeFog,
  makeTurfColor,
  makeTurfNormalMap,
} from '../../lib/golf/scenery';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import { BALL_R, CUP_R } from '../../lib/golf/greenPhysics';
import type { CourseSim } from '../../lib/golf/courseSim';

interface Props {
  sim: CourseSim;
  // Raised when a drag is released into a valid shot (armed) — the HUD then runs
  // the accuracy bar and calls sim.fireArmed().
  onArm?: () => void;
  paused?: boolean;
}

// Base albedo per lie, painted into the top-down surface map below. Fairway and
// rough are deliberately far apart in hue+value (rough is darker, more olive) so
// the corridor edge reads as a hard material change, not a shade of the same
// grass. Green/fringe/tee/bunker/water are refined by their own overlay meshes;
// these are the values that show if an overlay ever leaves a sliver.
const SURFACE_RGB: Record<Surface, [number, number, number]> = {
  fairway: [0.40, 0.66, 0.28],
  green: [0.49, 0.79, 0.38],
  fringe: [0.45, 0.72, 0.33],
  rough: [0.19, 0.37, 0.16], // darker + more olive → clearly not fairway
  bunker: [0.9, 0.82, 0.6],
  water: [0.14, 0.42, 0.66],
  cartpath: [0.74, 0.71, 0.66],
  tee: [0.34, 0.55, 0.26],
  ob: [0.13, 0.28, 0.12],
};

// Cheap deterministic hash noise in [0,1) for the baked surface texture.
function hashNoise(ix: number, iy: number): number {
  let h = (Math.floor(ix) * 73856093) ^ (Math.floor(iy) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Bake a TOP-DOWN albedo map of the whole hole from the surface model. Every
// texel is classified with surfaceAt() (which itself reads corridorHalfAt /
// greenPadRadius / the hazards) so the material boundaries are the SAME lines the
// ball plays and they scale to any hole with no code change. Seams are crisp at
// texel resolution (far finer than the mesh vertices the old per-vertex colour
// multiply was limited to). Fairway gets bold alternating MOW STRIPES down the
// hole; rough gets a coarse, darker, un-manicured speckle; the rest carry their
// base tint (their overlay meshes add the fine texture). Mapped planar over the
// mesh's (x,d) domain via the mesh UVs, so it lines up with the physics exactly.
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
  const STRIPE_YD = 7; // mow band period downrange
  for (let py = 0; py < H; py++) {
    // Canvas row 0 is the TOP; CanvasTexture samples with flipY, so V=1 (d=dMax)
    // maps to the top row — invert to recover the world d for this row.
    const d = dMin + (1 - py / (H - 1)) * (dMax - dMin);
    for (let px = 0; px < W; px++) {
      const x = -xHalf + (px / (W - 1)) * (xHalf * 2);
      const surf = surfaceAt(hole, d, x);
      let [r, gg, b] = SURFACE_RGB[surf];
      if (surf === 'fairway') {
        // Bold mow stripes: alternate light/dark bands with strong contrast so
        // the "fairway lines" clearly read (user: they weren't dark enough).
        const band = Math.floor(d / STRIPE_YD) % 2 === 0 ? 1.16 : 0.82;
        const blade = 0.94 + hashNoise(x * 3.1, d * 3.1) * 0.12;
        r *= band * blade;
        gg *= band * blade;
        b *= band * blade;
      } else if (surf === 'rough' || surf === 'ob') {
        // Coarse, patchy, un-mown: big low-frequency clumps + fine speckle.
        const clump = 0.82 + hashNoise(Math.floor(x / 2.5), Math.floor(d / 2.5)) * 0.34;
        const fleck = 0.9 + hashNoise(x * 5.7, d * 5.7) * 0.2;
        r *= clump * fleck;
        gg *= clump * fleck;
        b *= clump * fleck;
      } else if (surf === 'cartpath') {
        const spec = 0.92 + hashNoise(x * 4, d * 4) * 0.16;
        r *= spec;
        gg *= spec;
        b *= spec;
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

// Fine putting-green grain: a subtle light/dark mow so the green reads as a real
// textured surface, not flat paint — but far gentler than the fairway stripes.
function makeGreenGrain(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  const bands = 14; // finer than the fairway → a smoother, more manicured mow
  const bw = S / bands;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,1)' : 'rgba(232,238,228,1)';
    g.fillRect(i * bw, 0, bw, S);
  }
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

// Sand: warm base with fine grain speckle + soft rake arcs.
function makeSand(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#e6d6a8';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const a = 0.06 + Math.random() * 0.08;
    g.fillStyle = Math.random() < 0.5 ? `rgba(150,130,90,${a})` : `rgba(255,250,230,${a})`;
    g.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4);
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

// Water ripple normal-ish map (animated by offsetting in the loop) for shimmer.
function makeWaterNormal(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8080ff';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 60; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const r = 6 + Math.random() * 18;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(150,150,255,0.9)');
    rg.addColorStop(1, 'rgba(128,128,255,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
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
    // Warm distance haze (shared with the range). The course corridor is long —
    // the green sits ~512 yd out — so the far plane is pushed past the pin, but
    // the near/feel matches the range so distant fairway/trees fade with depth.
    scene.fog = makeFog(170, 780);

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
    for (let j = 0; j < nd; j++)
      for (let i = 0; i < nx; i++) {
        const a = j * row + i;
        // Wind triangles so the top surface FRONT-faces up. The original winding
        // faced them down, so the whole top was back-face culled and only a flat
        // fill plane showed in the foreground — the "flat grass" bug. Now the
        // displaced, textured terrain renders directly (single-sided, cheap).
        idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
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
        roughness: 0.85,
        metalness: 0,
      }),
    );
    groundMat.normalScale.set(0.45, 0.45);
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
    const fillTex = track(makeTurfColor('green'));
    fillTex.repeat.set(120, 120);
    const fillMat = track(new THREE.MeshStandardMaterial({ map: fillTex, roughness: 0.95 }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(hole.pin.x, baseY, -hole.pin.d / 2);
    fill.receiveShadow = true;
    scene.add(fill);

    // Water discs (shimmer via an animated ripple normal map) + sand bunkers.
    const waterNormal = track(makeWaterNormal());
    const sandTex = track(makeSand());
    sandTex.repeat.set(3, 3);
    for (const hz of hole.hazards) {
      if (hz.kind === 'water') {
        const rimY = heightAt(hole, hz.d + hz.r, hz.x) + 0.06;
        const wGeo = track(new THREE.CircleGeometry(hz.r, 48));
        const wMat = track(
          new THREE.MeshStandardMaterial({
            // A brighter sky-teal with LOW metalness reads as sunlit water; the
            // old dark navy + high metalness reflected the dim scene and looked
            // like a black pit. Semi-transparent so it reads as a water surface.
            color: 0x4aa3d8,
            roughness: 0.28,
            metalness: 0.1,
            transparent: true,
            opacity: 0.82,
            normalMap: waterNormal,
          }),
        );
        wMat.normalScale.set(0.5, 0.5);
        const water = new THREE.Mesh(wGeo, wMat);
        water.rotation.x = -Math.PI / 2;
        water.position.set(hz.x, rimY, -hz.d);
        scene.add(water);
        // A soft pale shoreline so the edge isn't a hard oval cut-out.
        const shoreGeo = track(new THREE.RingGeometry(hz.r * 0.9, hz.r * 1.08, 48));
        const shoreMat = track(
          new THREE.MeshBasicMaterial({ color: 0xdaf0f2, transparent: true, opacity: 0.55 }),
        );
        const shore = new THREE.Mesh(shoreGeo, shoreMat);
        shore.rotation.x = -Math.PI / 2;
        shore.position.set(hz.x, rimY - 0.02, -hz.d);
        scene.add(shore);
      } else if (hz.kind === 'bunker') {
        // A DISHED sand mesh that samples the heightfield (the basin bowl), so a
        // ball — which rests on the terrain height — sits ON the sand instead of
        // floating above a flat disc laid at the basin's low centre.
        const RINGS = 6;
        const SEG = 40;
        const LIFT = 0.05;
        const vcount = 1 + RINGS * SEG;
        const spos = new Float32Array(vcount * 3);
        const suv = new Float32Array(vcount * 2);
        spos[0] = hz.x;
        spos[1] = heightAt(hole, hz.d, hz.x) + LIFT;
        spos[2] = -hz.d;
        suv[0] = 0.5;
        suv[1] = 0.5;
        let sp = 3;
        let su = 2;
        for (let ri = 1; ri <= RINGS; ri++) {
          const frac = ri / RINGS;
          const rad = hz.r * frac;
          for (let s = 0; s < SEG; s++) {
            const ang = (s / SEG) * Math.PI * 2;
            const wx = hz.x + Math.cos(ang) * rad;
            const wd = hz.d + Math.sin(ang) * rad;
            spos[sp] = wx;
            spos[sp + 1] = heightAt(hole, wd, wx) + LIFT;
            spos[sp + 2] = -wd;
            suv[su] = 0.5 + Math.cos(ang) * frac * 0.5;
            suv[su + 1] = 0.5 + Math.sin(ang) * frac * 0.5;
            sp += 3;
            su += 2;
          }
        }
        const sidx: number[] = [];
        for (let s = 0; s < SEG; s++) sidx.push(0, 1 + s, 1 + ((s + 1) % SEG));
        for (let ri = 1; ri < RINGS; ri++) {
          const b0 = 1 + (ri - 1) * SEG;
          const b1 = 1 + ri * SEG;
          for (let s = 0; s < SEG; s++) {
            const s1 = (s + 1) % SEG;
            sidx.push(b0 + s, b1 + s, b0 + s1, b0 + s1, b1 + s, b1 + s1);
          }
        }
        const sGeo = track(new THREE.BufferGeometry());
        sGeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
        sGeo.setAttribute('uv', new THREE.BufferAttribute(suv, 2));
        sGeo.setIndex(sidx);
        sGeo.computeVertexNormals();
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
    // Two concentric, terrain-FOLLOWING pads sized straight from the model
    // (greenPadRadius = green.r + fringeW) so they scale to any hole:
    //   • the FRINGE COLLAR — an annulus from green.r out to the pad radius,
    //     a distinct duller/darker collar band. It ALWAYS rings the green, so the
    //     putting surface never visually bleeds into the bordering sand/water —
    //     there is always a fringe edge (the "green mixes with sand/water" fix).
    //   • the GREEN CAP — the putting surface out to green.r, a brighter, finely
    //     grained mown material distinct from both the fringe and the fairway.
    // Both hug heightAt (tilt + undulation) with REAL computed normals so the
    // contour shades as a sculpted green from any angle, not flat paint.
    {
      const gDef = hole.green;
      const padR = greenPadRadius(hole); // green.r + fringeW
      const grain = track(makeGreenGrain());

      // Fringe collar: a polar annulus (rings × segments — no degenerate hub) so
      // its normals stay clean. Sits a hair BELOW the cap so the cap wins on the
      // tiny inward overlap that guarantees no seam gap.
      const RINGS = 5;
      const SEG = 56;
      const rIn = gDef.r - 0.25; // slight inward overlap under the cap
      const fLift = 0.035;
      const fcount = (RINGS + 1) * SEG;
      const fpos = new Float32Array(fcount * 3);
      const fuv = new Float32Array(fcount * 2);
      let fp = 0;
      let fu = 0;
      for (let ri = 0; ri <= RINGS; ri++) {
        const rad = rIn + (ri / RINGS) * (padR - rIn);
        for (let s = 0; s < SEG; s++) {
          const ang = (s / SEG) * Math.PI * 2;
          const wx = gDef.x + Math.cos(ang) * rad;
          const wd = gDef.d + Math.sin(ang) * rad;
          fpos[fp] = wx;
          fpos[fp + 1] = heightAt(hole, wd, wx) + fLift;
          fpos[fp + 2] = -wd;
          fuv[fu] = 0.5 + Math.cos(ang) * (ri / RINGS) * 0.5;
          fuv[fu + 1] = 0.5 + Math.sin(ang) * (ri / RINGS) * 0.5;
          fp += 3;
          fu += 2;
        }
      }
      const fidx: number[] = [];
      for (let ri = 0; ri < RINGS; ri++) {
        const b0 = ri * SEG;
        const b1 = (ri + 1) * SEG;
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          fidx.push(b0 + s, b1 + s, b0 + s1, b0 + s1, b1 + s, b1 + s1);
        }
      }
      const fGeo = track(new THREE.BufferGeometry());
      fGeo.setAttribute('position', new THREE.BufferAttribute(fpos, 3));
      fGeo.setAttribute('uv', new THREE.BufferAttribute(fuv, 2));
      fGeo.setIndex(fidx);
      fGeo.computeVertexNormals();
      const fNorm = track(makeTurfNormalMap());
      fNorm.repeat.set(10, 10);
      const fMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x5aa24a, // duller, slightly darker collar — distinct from green
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

      // Green cap: circle-clipped square grid (no centre fan → no dark hub ring).
      const capR = gDef.r;
      const N = 30; // grid cells across the diameter → smooth contour shading
      const step = (2 * capR) / N;
      const vxn = N + 1;
      const LIFT = 0.05;
      const cpos: number[] = [];
      const cuv: number[] = [];
      const idxOf: number[] = new Array(vxn * vxn).fill(-1);
      let vc = 0;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const x = gDef.x - capR + i * step;
          const d = gDef.d - capR + j * step;
          if (Math.hypot(x - gDef.x, d - gDef.d) > capR) continue; // clip to disc
          cpos.push(x, heightAt(hole, d, x) + LIFT, -d);
          // Grain UV in world yards / 6 → ~6 yd grain tile, gentle and even.
          cuv.push(x / 6, d / 6);
          idxOf[j * vxn + i] = vc++;
        }
      }
      const cidx: number[] = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = idxOf[j * vxn + i]!;
          const b = idxOf[j * vxn + i + 1]!;
          const c = idxOf[(j + 1) * vxn + i]!;
          const e = idxOf[(j + 1) * vxn + i + 1]!;
          if (a < 0 || b < 0 || c < 0 || e < 0) continue; // whole cells only
          // Same winding as the main terrain grid → top surface front-faces up.
          cidx.push(a, b, c, b, e, c);
        }
      }
      const capGeo = track(new THREE.BufferGeometry());
      capGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cpos), 3));
      capGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(cuv), 2));
      capGeo.setIndex(cidx);
      capGeo.computeVertexNormals(); // real normals → the contour shades
      const capNorm = track(makeTurfNormalMap());
      capNorm.repeat.set(16, 16);
      const capMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x86d06f, // bright putting green — distinct from fringe + fairway
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
    {
      const teeD = hole.tee.d;
      const teeX = hole.tee.x;
      // Forward unit (tee→pin) and its right-perpendicular, in (d,x) space.
      let fd = hole.pin.d - teeD;
      let fx = hole.pin.x - teeX;
      const flen = Math.hypot(fd, fx) || 1;
      fd /= flen;
      fx /= flen;
      const rd = fx; // right = perpendicular of forward: (fx, -fd)
      const rx = -fd;
      const heading = Math.atan2(fx, fd); // world yaw of the aim line (small here)

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
          ppos[pp] = wx;
          ppos[pp + 1] = heightAt(hole, wd, wx) + LIFT;
          ppos[pp + 2] = -wd;
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
      const padMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x40873a, // darker, tidier mown green — distinct from the fairway
          roughness: 0.72,
          metalness: 0,
          normalMap: padNorm,
        }),
      );
      padMat.normalScale.set(0.3, 0.3);
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.receiveShadow = true;
      scene.add(pad);

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
        mk.position.set(wx, heightAt(hole, wd, wx) + 0.25, -wd);
        mk.rotation.y = heading;
        mk.castShadow = true;
        mk.receiveShadow = true;
        scene.add(mk);
      }

      // Subtle tee peg under the ball (tee shot only — toggled in the loop by
      // stroke count). A thin short cylinder rising from the pad to the ball.
      const pegH = 0.42;
      const pegGeo = track(new THREE.CylinderGeometry(0.05, 0.07, pegH, 8));
      const pegMat = track(new THREE.MeshStandardMaterial({ color: 0xf2f2f0, roughness: 0.55 }));
      teePeg = new THREE.Mesh(pegGeo, pegMat);
      const pegY = heightAt(hole, teeD, teeX) + LIFT;
      teePeg.position.set(teeX, pegY + pegH / 2, -teeD);
      teePeg.castShadow = true;
      scene.add(teePeg);
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
    const poleH = FLAGSTICK_HEIGHT_M * YD_PER_M; // 2.13 m ≈ 2.33 yd
    const poleGeo = track(new THREE.CylinderGeometry(0.06, 0.06, poleH, 6));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 }));
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(hole.pin.x, pinY + poleH / 2, -hole.pin.d);
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
    // The cup. The regulation hole (HOLE_DIAMETER_M = 0.108 m ≈ 0.06 yd radius,
    // the data-model truth) is sub-pixel to look at, so — like the ball — it's
    // drawn OVERSIZED for readability: a dark hole with a white rim ring so you
    // can actually see where to putt. The visible hole is drawn at the sim's
    // speed-dependent capture radius (greenPhysics.CUP_R), so what you aim at is
    // exactly what drops, and the ball (BALL_R ≈ 0.4× CUP_R) visibly fits it.
    const cupR = CUP_R;
    const cupGeo = track(new THREE.CircleGeometry(cupR, 24));
    const cupMat = track(new THREE.MeshBasicMaterial({ color: 0x0a0f0a }));
    const cup = new THREE.Mesh(cupGeo, cupMat);
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(hole.pin.x, pinY + 0.09, -hole.pin.d);
    scene.add(cup);
    const rimGeo = track(new THREE.RingGeometry(cupR, cupR + 0.16, 24));
    const rimMat = track(new THREE.MeshBasicMaterial({ color: 0xf4faf4, side: THREE.DoubleSide }));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(hole.pin.x, pinY + 0.085, -hole.pin.d);
    scene.add(rim);

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
    const shadowTex = (() => {
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
      const t = new THREE.CanvasTexture(cv);
      return t;
    })();
    track(shadowTex);
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
    };
    const updateAim = () => {
      const c = sim.predict(0);
      aimHoling = c.result === 'holed';
      fillArc(arc.g, c.path);
      fillArc(edgeL.g, sim.predict(-1).path);
      fillArc(edgeR.g, sim.predict(1).path);
      if (c.landing) {
        landRing.position.set(c.landing.x, c.landing.h + 0.12, -c.landing.d);
        landRing.visible = true;
      } else {
        landRing.visible = false;
      }
      restRing.position.set(c.rest.x, c.rest.h + 0.12, -c.rest.d);
      arc.l.visible = arc.line.visible = edgeL.l.visible = edgeR.l.visible = restRing.visible = true;
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

    // Initialise camera at the address position.
    ballWorld(tmpB);
    tmpDir.subVectors(pinV, tmpB).setY(0).normalize();
    camPos.copy(tmpB).addScaledVector(tmpDir, -17);
    camPos.y = tmpB.y + 10;
    camLook.copy(tmpB).addScaledVector(tmpDir, 46);
    camLook.y = tmpB.y - 0.5;
    camera.position.copy(camPos);
    camera.lookAt(camLook);

    // --- Input (slingshot) ---------------------------------------------
    const applyPull = () => sim.setMaxPull(Math.max(90, h * 0.17));
    applyPull();
    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onDown = (e: PointerEvent) => {
      if (pausedRef.current) return;
      canvas.setPointerCapture?.(e.pointerId);
      sim.onPointerDown(local(e));
      showAim(false); // hidden until the first drag gives it a power/aim
    };
    const onMove = (e: PointerEvent) => {
      if (pausedRef.current) return;
      sim.onPointerMove(local(e));
      if (sim.getState().aiming && sim.power > 0.02) updateAim();
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

      // Water shimmer: drift the ripple normal map.
      waterNormal.offset.x += dt * 0.014;
      waterNormal.offset.y += dt * 0.009;

      // Tracer from the sim trail.
      const tr = sim.trail;
      const n = Math.min(tr.length, 70);
      for (let i = 0; i < n; i++) {
        const p = tr[tr.length - n + i]!;
        tracerBuf[i * 3] = p.x;
        tracerBuf[i * 3 + 1] = p.h + 0.2;
        tracerBuf[i * 3 + 2] = -p.d;
      }
      tracerGeo.setDrawRange(0, b.inFlight || tr.length > 1 ? n : 0);
      (tracerGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;

      // The predicted aim arc is refreshed in the pointer handlers (on drag /
      // arm); here we only hide it once the shot is away or the address ends, and
      // animate its colour (gold/green pulse when the shot will hole out).
      const st = sim.getState();
      if (st.inFlight || (!st.aiming && !st.armed)) showAim(false);
      applyAimColor(now);

      // Tee peg: only for the tee shot (stroke 0), and hidden once the ball is
      // away so it doesn't linger under a mid-flight/rolling ball.
      if (teePeg) teePeg.visible = st.strokes === 0 && !st.inFlight;

      // Hole-out celebration: fire once when the ball drops, then animate the
      // ring pulse + confetti for ~1.6 s.
      if (st.holed && celebrate < 0) {
        celebrate = 0;
        celebRing.position.set(hole.pin.x, pinY + 0.06, -hole.pin.d);
        for (let i = 0; i < PCOUNT; i++) {
          confPos[i * 3] = hole.pin.x;
          confPos[i * 3 + 1] = pinY + 0.2;
          confPos[i * 3 + 2] = -hole.pin.d;
        }
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
        tmpDir.subVectors(pinV, tmpB).setY(0).normalize();
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -17);
        desiredPos.y = tmpB.y + 10;
        desiredLook.copy(tmpB).addScaledVector(tmpDir, 46);
        desiredLook.y = tmpB.y - 0.5;
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
