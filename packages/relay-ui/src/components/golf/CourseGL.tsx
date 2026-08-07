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
  gradientAt,
  surfaceAt,
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
import type { CourseSim } from '../../lib/golf/courseSim';

interface Props {
  sim: CourseSim;
  // Raised when a drag is released into a valid shot (armed) — the HUD then runs
  // the accuracy bar and calls sim.fireArmed().
  onArm?: () => void;
  paused?: boolean;
}

const SURFACE_RGB: Record<Surface, [number, number, number]> = {
  fairway: [0.38, 0.63, 0.28],
  green: [0.6, 0.88, 0.44],
  fringe: [0.5, 0.75, 0.36],
  rough: [0.22, 0.46, 0.22],
  bunker: [0.9, 0.82, 0.6],
  water: [0.14, 0.42, 0.66],
  cartpath: [0.76, 0.73, 0.68],
  tee: [0.46, 0.68, 0.36],
  ob: [0.16, 0.36, 0.18],
};

function jitter(d: number, x: number): number {
  let h = (Math.floor(d) * 73856093) ^ (Math.floor(x) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * 0.08;
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

    // Visible ball radius (yards). Small enough not to dominate the frame, big
    // enough to read when the camera follows it downrange.
    const BALL_R = 0.4;

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
    const dMin = -20;
    const dMax = hole.pin.d + 110;
    const xHalf = 120;
    const nd = 224;
    const nx = 128;
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
    const cols = new Float32Array((nd + 1) * (nx + 1) * 3);
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
        const surf = surfaceAt(hole, d, x);
        const [r, g, b] = SURFACE_RGB[surf];
        const jt = surf === 'water' || surf === 'cartpath' || surf === 'bunker' ? 0 : jitter(d, x);
        cols[vi] = Math.max(0, r + jt);
        cols[vi + 1] = Math.max(0, g + jt);
        cols[vi + 2] = Math.max(0, b + jt);
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
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Turf: the range's rich blade/mow/mottle detail, shared from scenery.ts. The
    // 'neutral' mode is a near-white luminance map that MULTIPLIES the per-lie
    // vertex colour, so fairway/green/rough keep their hue but gain mown texture
    // instead of the old flat paint. Roughness drops to the range's 0.82 so the
    // blade normal map catches a soft sun sheen.
    const turfTex = track(makeTurfColor('neutral'));
    // Mow-stripe tiling: ~4 tiles across the 240 yd width → ~7.5 yd stripes
    // running downrange, which read cleanly at the tee camera's grazing angle.
    turfTex.repeat.set(4, 12);
    const turfNorm = track(makeTurfNormalMap());
    turfNorm.repeat.set(64, 180); // finer than the colour tile so blades read
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: turfTex,
        normalMap: turfNorm,
        roughness: 0.82,
        metalness: 0,
      }),
    );
    groundMat.normalScale.set(0.5, 0.5);
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

    // --- Green cap -----------------------------------------------------
    // A distinct, smoother PUTTING SURFACE laid over the green: a terrain-
    // following disc (samples heightAt so it hugs the green's tilt/undulation),
    // a uniform brighter green with only a fine relief — no mow stripes — so it
    // reads as a manicured green, not more fairway. Lifted a hair above the
    // terrain and drawn a touch inside the collar so the fringe still shows.
    {
      const gDef = hole.green;
      const capR = gDef.r + hole.fringeW * 0.5;
      const RINGS = 10;
      const SEG = 56;
      const LIFT = 0.04;
      const vcount = 1 + RINGS * SEG;
      const gpos = new Float32Array(vcount * 3);
      const guv = new Float32Array(vcount * 2);
      gpos[0] = gDef.x;
      gpos[1] = heightAt(hole, gDef.d, gDef.x) + LIFT;
      gpos[2] = -gDef.d;
      guv[0] = guv[1] = 0.5;
      let gp = 3;
      let gu = 2;
      for (let ri = 1; ri <= RINGS; ri++) {
        const frac = ri / RINGS;
        const rad = capR * frac;
        for (let s = 0; s < SEG; s++) {
          const ang = (s / SEG) * Math.PI * 2;
          const wx = gDef.x + Math.cos(ang) * rad;
          const wd = gDef.d + Math.sin(ang) * rad;
          gpos[gp] = wx;
          gpos[gp + 1] = heightAt(hole, wd, wx) + LIFT;
          gpos[gp + 2] = -wd;
          guv[gu] = 0.5 + Math.cos(ang) * frac * 0.5;
          guv[gu + 1] = 0.5 + Math.sin(ang) * frac * 0.5;
          gp += 3;
          gu += 2;
        }
      }
      const gidx: number[] = [];
      for (let s = 0; s < SEG; s++) gidx.push(0, 1 + s, 1 + ((s + 1) % SEG));
      for (let ri = 1; ri < RINGS; ri++) {
        const b0 = 1 + (ri - 1) * SEG;
        const b1 = 1 + ri * SEG;
        for (let s = 0; s < SEG; s++) {
          const s1 = (s + 1) % SEG;
          gidx.push(b0 + s, b0 + s1, b1 + s, b0 + s1, b1 + s1, b1 + s);
        }
      }
      const capGeo = track(new THREE.BufferGeometry());
      capGeo.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
      capGeo.setAttribute('uv', new THREE.BufferAttribute(guv, 2));
      capGeo.setIndex(gidx);
      // Uniform up-normals rather than computeVertexNormals: the center vertex
      // fan otherwise creases into a dark ring around the hole, and a putting
      // green is near-flat so flat-up shading reads clean.
      const cnorm = new Float32Array(vcount * 3);
      for (let i = 0; i < vcount; i++) cnorm[i * 3 + 1] = 1;
      capGeo.setAttribute('normal', new THREE.BufferAttribute(cnorm, 3));
      const capNorm = track(makeTurfNormalMap());
      capNorm.repeat.set(16, 16);
      const capMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x7ec96a, // bright, uniform putting green — distinct from fairway
          roughness: 0.68,
          metalness: 0,
          normalMap: capNorm,
        }),
      );
      capMat.normalScale.set(0.25, 0.25);
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.receiveShadow = true;
      scene.add(cap);
    }

    // --- Green-reading heat grid (shown while putting) -----------------
    // A contour grid over the green, HEAT-COLOURED by slope relative to the putt
    // to the hole: warm = uphill toward the cup (putt firmer), cool = downhill
    // (putt dies quick), neutral where it's flat. Built from gradientAt — the
    // same slope the ball physically breaks on — so what you read is what rolls.
    // Toggled visible only on the green (see the frame loop).
    let greenGrid: THREE.Object3D | null = null;
    {
      const gDef = hole.green;
      const R = gDef.r;
      const N = 24; // cells across the green diameter (~1.25 yd cells)
      const step = (2 * R) / N;
      const vx = N + 1;
      const gpos: number[] = [];
      const gcol: number[] = [];
      const idxOf: number[] = new Array(vx * vx).fill(-1);
      // Heat ramp: slope-toward-hole s (rise/run, +uphill) → colour. SMAX is low
      // so even a gentle break reads strongly (greens are subtly sloped); the
      // endpoints are punchy red (uphill) / blue (downhill) with a neutral green
      // at flat, so the grid POPS.
      const SMAX = 0.028;
      const heat = (s: number): [number, number, number] => {
        const t = Math.max(-1, Math.min(1, s / SMAX));
        if (t >= 0) return [0.95 * t + 0.3 * (1 - t), 0.85 - 0.6 * t, 0.35 - 0.2 * t]; // green→red
        const u = -t;
        return [0.3 - 0.15 * u, 0.85 - 0.35 * u, 0.35 + 0.6 * u]; // green→blue
      };
      let vcount = 0;
      for (let j = 0; j <= N; j++) {
        for (let i = 0; i <= N; i++) {
          const x = gDef.x - R + i * step;
          const d = gDef.d - R + j * step;
          if (Math.hypot(x - gDef.x, d - gDef.d) > R + 0.01) continue;
          const g = gradientAt(hole, d, x);
          const dnx = gDef.x - x;
          const dnd = gDef.d - d;
          const len = Math.hypot(dnx, dnd) || 1;
          const sTo = (g.gx * dnx + g.gd * dnd) / len; // slope toward hole
          const [cr, cg, cb] = heat(sTo);
          gpos.push(x, heightAt(hole, d, x) + 0.07, -d);
          gcol.push(cr, cg, cb);
          idxOf[j * vx + i] = vcount++;
        }
      }
      const gi: number[] = [];
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const a = idxOf[j * vx + i]!;
          const b = idxOf[j * vx + i + 1]!;
          const c = idxOf[(j + 1) * vx + i]!;
          const e = idxOf[(j + 1) * vx + i + 1]!;
          if (a < 0 || b < 0 || c < 0 || e < 0) continue; // keep cells fully inside
          gi.push(a, b, c, b, e, c);
        }
      }
      if (gi.length) {
        const group = new THREE.Group();
        // Heat fill: the slope colours, translucent, over the green.
        const gGeo = track(new THREE.BufferGeometry());
        gGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(gpos), 3));
        gGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(gcol), 3));
        gGeo.setIndex(gi);
        const gMat = track(
          new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.72,
            depthWrite: false,
          }),
        );
        const fill = new THREE.Mesh(gGeo, gMat);
        fill.renderOrder = 6;
        group.add(fill);
        // Grid LINES: connect in-disc neighbours (drawn as their own layer so the
        // lines read crisp white instead of being tinted/clipped by the fill).
        const lp: number[] = [];
        const at3 = (vi: number) => [gpos[vi * 3]!, gpos[vi * 3 + 1]!, gpos[vi * 3 + 2]!] as const;
        for (let j = 0; j <= N; j++) {
          for (let i = 0; i <= N; i++) {
            const a = idxOf[j * vx + i]!;
            if (a < 0) continue;
            const r = i < N ? idxOf[j * vx + i + 1]! : -1;
            const d2 = j < N ? idxOf[(j + 1) * vx + i]! : -1;
            if (r >= 0) lp.push(...at3(a), ...at3(r));
            if (d2 >= 0) lp.push(...at3(a), ...at3(d2));
          }
        }
        const lGeo = track(new THREE.BufferGeometry());
        lGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(lp), 3));
        const lMat = track(
          new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
        );
        const lines = new THREE.LineSegments(lGeo, lMat);
        lines.renderOrder = 7;
        group.add(lines);
        group.visible = false;
        greenGrid = group;
        scene.add(group);
      }
    }

    // Flagstick — normalized to the REGULATION height (2.13 m) from the Course
    // data layer. The scene is yard-space, so the metric constants convert with
    // YD_PER_M; the old pole was a hard-coded 8 yд (24 ft), 3.4× too tall.
    const pinY = heightAt(hole, hole.pin.d, hole.pin.x);
    const poleH = FLAGSTICK_HEIGHT_M * YD_PER_M; // 2.13 m ≈ 2.33 yд
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
    // the data-model truth used by the physics capture) is sub-pixel to look at,
    // so — like the ball — it's drawn OVERSIZED for readability: a dark hole with
    // a white rim ring so you can actually see where to putt.
    const cupR = 0.32;
    const cupGeo = track(new THREE.CircleGeometry(cupR, 24));
    const cupMat = track(new THREE.MeshBasicMaterial({ color: 0x0a0f0a }));
    const cup = new THREE.Mesh(cupGeo, cupMat);
    cup.rotation.x = -Math.PI / 2;
    cup.position.set(hole.pin.x, pinY + 0.09, -hole.pin.d);
    scene.add(cup);
    const rimGeo = track(new THREE.RingGeometry(cupR, cupR + 0.12, 24));
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
    // 0.0427 m ≈ 0.023 yд radius) is sub-pixel under the yard-tuned follow camera,
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
    const ARC_MAX = 700;
    // The centre trajectory is drawn as DOTS (constant screen size) so it reads
    // clearly at any distance — thin GL lines were nearly invisible. The two
    // dispersion edges stay as faint lines.
    const arcGeo = track(new THREE.BufferGeometry());
    arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
    arcGeo.setDrawRange(0, 0);
    // The aim aids are UI overlays: draw them with depthTest OFF and a high
    // renderOrder so they're ALWAYS visible, never occluded by the terrain. This
    // is what broke for short clubs after the terrain started rendering — a low
    // wedge/approach arc (only ~0.5 yd above the ground) was hidden behind the
    // mesh; only the high driver arc cleared it.
    const overlay = (m: THREE.Material) => {
      m.depthTest = false;
      m.depthWrite = false;
      return m;
    };
    const AIM_ORDER = 10;
    const arcMat = track(
      overlay(new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, transparent: true, opacity: 0.95 })),
    ) as THREE.PointsMaterial;
    const arcPts = new THREE.Points(arcGeo, arcMat);
    arcPts.visible = false;
    arcPts.renderOrder = AIM_ORDER;
    scene.add(arcPts);
    // A connected LINE through the same path, sharing arcGeo. GL point sprites
    // (arcPts) are unreliable on some mobile GPUs — a low iron/wedge arc rendered
    // fine in software GL but vanished on-device while the tall driver arc
    // survived. The line always renders, so the trajectory is guaranteed visible
    // for every club (and for the putt roll line on the green); the points just
    // add emphasis where they work.
    const arcLineMat = track(
      overlay(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })),
    );
    const arcLine = new THREE.Line(arcGeo, arcLineMat);
    arcLine.visible = false;
    arcLine.renderOrder = AIM_ORDER;
    scene.add(arcLine);
    const arc = { g: arcGeo, l: arcPts, line: arcLine };
    const makeLine = (color: number, opacity: number) => {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
      g.setDrawRange(0, 0);
      const m = track(overlay(new THREE.LineBasicMaterial({ color, transparent: true, opacity })));
      const l = new THREE.Line(g, m);
      l.visible = false;
      l.renderOrder = AIM_ORDER;
      scene.add(l);
      return { g, l };
    };
    const edgeL = makeLine(0xffe08a, 0.45);
    const edgeR = makeLine(0xffe08a, 0.45);
    const ringMat = track(
      overlay(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide })),
    );
    const landRingGeo = track(new THREE.RingGeometry(2.4, 3.6, 32));
    const landRing = new THREE.Mesh(landRingGeo, ringMat);
    landRing.rotation.x = -Math.PI / 2;
    landRing.visible = false;
    landRing.renderOrder = AIM_ORDER;
    scene.add(landRing);
    const restRingGeo = track(new THREE.RingGeometry(1.6, 2.4, 28));
    const restRingMat = track(
      overlay(new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide })),
    );
    const restRing = new THREE.Mesh(restRingGeo, restRingMat);
    restRing.rotation.x = -Math.PI / 2;
    restRing.visible = false;
    restRing.renderOrder = AIM_ORDER;
    scene.add(restRing);

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
      // arm); here we only hide it once the shot is away or the address ends.
      const st = sim.getState();
      if (st.inFlight || (!st.aiming && !st.armed)) showAim(false);

      // On the green (reading a putt): show the slope heat grid. It hides once
      // the putt is rolling or the ball is off the green. (The old chunky break-
      // arrow cone is gone — the heat grid + predicted roll line read the break.)
      const onGreen = !st.inFlight && st.lie === 'green';
      if (greenGrid) greenGrid.visible = onGreen && celebrate < 0;

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

      // Camera: chase the ball in flight, sit behind it toward the pin at rest.
      ballWorld(tmpB);
      if (b.inFlight) {
        tmpDir.set(b.vx, 0, -b.vd); // horizontal travel dir in world (d→−z)
        if (tmpDir.lengthSq() < 1e-4) tmpDir.subVectors(pinV, tmpB).setY(0);
        tmpDir.setY(0).normalize();
        desiredPos.copy(tmpB).addScaledVector(tmpDir, -22);
        desiredPos.y = tmpB.y + 13;
        desiredLook.copy(tmpB).addScaledVector(tmpDir, 24);
        desiredLook.y = tmpB.y - 1.5;
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
