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
import { heightAt, surfaceAt, type CourseHole, type Surface } from '../../lib/golf/terrain';
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

// Mow-stripe turf detail (multiplies the per-lie vertex colour): soft light/dark
// bands running down the hole + faint blade speckle, so the grass reads mown
// rather than flat. Near-white so it only gently darkens the vertex colour.
function makeTurf(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const bands = 6;
  for (let i = 0; i < bands; i++) {
    const up = i % 2 === 0;
    // Clear light/dark mow contrast so the stripes actually read at distance
    // (this multiplies the per-lie vertex colour, so it only darkens).
    g.fillStyle = up ? '#ffffff' : '#adc19c';
    g.fillRect(0, (i * S) / bands, S, S / bands);
  }
  for (let i = 0; i < 4000; i++) {
    const a = 0.05 + Math.random() * 0.06;
    g.strokeStyle = Math.random() < 0.5 ? `rgba(120,150,110,${a})` : `rgba(255,255,255,${a})`;
    const x = Math.random() * S;
    const y = Math.random() * S;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 2, y - 2 - Math.random() * 3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

// A fine blade-relief NORMAL map so the sun catches the turf and it reads as
// grass, not flat paint. Short near-vertical bluish streaks on a neutral normal
// base — the same idea as the range's turf, kept cheap (one small tile, tiled).
function makeGrassNormal(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = '#8080ff'; // flat normal (points straight up)
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 5000; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    const len = 2 + Math.random() * 4;
    // Tilt the normal left/right along each blade so light rakes across it.
    g.strokeStyle = Math.random() < 0.5 ? 'rgba(150,120,255,0.5)' : 'rgba(90,150,255,0.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 1.5, y - len);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
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

    // Visible ball radius (yards). Small enough not to dominate the frame, big
    // enough to read when the camera follows it downrange.
    const BALL_R = 0.55;

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
    scene.fog = new THREE.Fog(0xd6ecf4, 220, 900);

    const skyC = document.createElement('canvas');
    skyC.width = 16;
    skyC.height = 256;
    const sg = skyC.getContext('2d')!;
    const grad = sg.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#2f86d6');
    grad.addColorStop(0.55, '#8ac6ea');
    grad.addColorStop(1, '#dceff8');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, 16, 256);
    const skyTex = track(new THREE.CanvasTexture(skyC));
    skyTex.colorSpace = THREE.SRGBColorSpace;
    scene.background = skyTex;

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

    // --- Base fill + terrain mesh --------------------------------------
    const baseY = Math.min(hole.terrain.teeElev, hole.terrain.greenElev) - 0.6;
    const fillGeo = track(new THREE.PlaneGeometry(2600, 2600));
    const fillMat = track(new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 1 }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(hole.pin.x, baseY, -hole.pin.d / 2);
    fill.receiveShadow = true;
    scene.add(fill);

    const dMin = -20;
    const dMax = hole.pin.d + 110;
    const xHalf = 120;
    const nd = 224;
    const nx = 128;
    const geo = track(new THREE.BufferGeometry());
    const verts = new Float32Array((nd + 1) * (nx + 1) * 3);
    const cols = new Float32Array((nd + 1) * (nx + 1) * 3);
    const uvs = new Float32Array((nd + 1) * (nx + 1) * 2);
    let vi = 0;
    let ui = 0;
    for (let j = 0; j <= nd; j++) {
      const d = dMin + (j / nd) * (dMax - dMin);
      for (let i = 0; i <= nx; i++) {
        const x = -xHalf + (i / nx) * (xHalf * 2);
        verts[vi] = x;
        verts[vi + 1] = heightAt(hole, d, x);
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
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const turfTex = track(makeTurf());
    // Tile the turf MANY times over the big terrain so blades/mow read as grass
    // — the old 2×6 stretched one 512px tile over ~120yd and looked like flat
    // plastic. ~13yd tiles show detail without shimmering.
    turfTex.repeat.set(18, 50);
    const turfNorm = track(makeGrassNormal());
    turfNorm.repeat.set(48, 140); // finer than the colour tile so blades read
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: turfTex,
        normalMap: turfNorm,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    groundMat.normalScale.set(0.6, 0.6);
    const ground = new THREE.Mesh(geo, groundMat);
    ground.receiveShadow = true;
    scene.add(ground);

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
            color: 0x1d5a86, // deeper teal-blue reads as water, not flat paint
            roughness: 0.12,
            metalness: 0.6,
            transparent: true,
            opacity: 0.92,
            normalMap: waterNormal,
          }),
        );
        wMat.normalScale.set(0.9, 0.9); // stronger ripple so the sheen catches
        const water = new THREE.Mesh(wGeo, wMat);
        water.rotation.x = -Math.PI / 2;
        water.position.set(hz.x, rimY, -hz.d);
        scene.add(water);
        // A pale shoreline ring so the edge isn't a hard oval cut-out.
        const shoreGeo = track(new THREE.RingGeometry(hz.r * 0.93, hz.r * 1.06, 48));
        const shoreMat = track(
          new THREE.MeshBasicMaterial({ color: 0xcfe6ea, transparent: true, opacity: 0.5 }),
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

    // Flagstick.
    const pinY = heightAt(hole, hole.pin.d, hole.pin.x);
    const poleGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 8, 6));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.6 }));
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(hole.pin.x, pinY + 4, -hole.pin.d);
    pole.castShadow = true;
    scene.add(pole);
    const flagGeo = track(new THREE.PlaneGeometry(3, 1.8));
    const flagMat = track(
      new THREE.MeshStandardMaterial({ color: 0xe8402c, roughness: 0.7, side: THREE.DoubleSide }),
    );
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(hole.pin.x + 1.5, pinY + 7, -hole.pin.d);
    flag.castShadow = true;
    scene.add(flag);

    // Ball.
    const ballGeo = track(new THREE.SphereGeometry(BALL_R, 20, 16));
    const ballMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
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
    const arcMat = track(
      new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, transparent: true, opacity: 0.95 }),
    );
    const arcPts = new THREE.Points(arcGeo, arcMat);
    arcPts.visible = false;
    scene.add(arcPts);
    const arc = { g: arcGeo, l: arcPts };
    const makeLine = (color: number, opacity: number) => {
      const g = track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARC_MAX * 3), 3));
      g.setDrawRange(0, 0);
      const m = track(new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
      const l = new THREE.Line(g, m);
      l.visible = false;
      scene.add(l);
      return { g, l };
    };
    const edgeL = makeLine(0xffe08a, 0.45);
    const edgeR = makeLine(0xffe08a, 0.45);
    const ringMat = track(
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    const landRingGeo = track(new THREE.RingGeometry(2.4, 3.6, 32));
    const landRing = new THREE.Mesh(landRingGeo, ringMat);
    landRing.rotation.x = -Math.PI / 2;
    landRing.visible = false;
    scene.add(landRing);
    const restRingGeo = track(new THREE.RingGeometry(1.6, 2.4, 28));
    const restRingMat = track(
      new THREE.MeshBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    const restRing = new THREE.Mesh(restRingGeo, restRingMat);
    restRing.rotation.x = -Math.PI / 2;
    restRing.visible = false;
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
      arc.l.visible = edgeL.l.visible = edgeR.l.visible = restRing.visible = true;
    };

    // --- Putt-read break arrow (shown on the green) --------------------
    const arrowMat = track(new THREE.MeshBasicMaterial({ color: 0x1b6fff, transparent: true, opacity: 0.85 }));
    const arrowGeo = track(new THREE.ConeGeometry(1.1, 3, 12));
    const putt = new THREE.Mesh(arrowGeo, arrowMat);
    putt.visible = false;
    scene.add(putt);

    // Trees.
    const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }));
    const leafMats = [0x2f7d3a, 0x3c8f44, 0x276b34, 0x4f9a52].map((c) =>
      track(new THREE.MeshStandardMaterial({ color: c, roughness: 0.95, flatShading: true })),
    );
    const blobGeo = track(new THREE.IcosahedronGeometry(1, 0));
    const tTrunkGeo = track(new THREE.CylinderGeometry(0.4, 0.75, 5, 6));
    const treeRng = (seed: number) => {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const addTree = (x: number, d: number, s: number, seed: number) => {
      const r = treeRng(seed);
      const g = new THREE.Group();
      const y = heightAt(hole, d, x);
      const trunk = new THREE.Mesh(tTrunkGeo, trunkMat);
      trunk.position.y = 2.3;
      trunk.castShadow = true;
      g.add(trunk);
      const blobs = 4 + Math.floor(r() * 3);
      const cr = 2.6 + r() * 0.9;
      for (let k = 0; k < blobs; k++) {
        const b = new THREE.Mesh(blobGeo, leafMats[Math.floor(r() * leafMats.length)] ?? leafMats[0]!);
        const ang = r() * Math.PI * 2;
        const rad = r() * cr * 0.8;
        b.position.set(Math.cos(ang) * rad, 5.5 + (r() - 0.5) * cr, Math.sin(ang) * rad);
        const bs = cr * (0.55 + r() * 0.45);
        b.scale.set(bs, bs * (0.8 + r() * 0.2), bs);
        b.rotation.set(r() * 3, r() * 3, r() * 3);
        b.castShadow = true;
        g.add(b);
      }
      g.position.set(x, y, -d);
      g.scale.setScalar(s);
      scene.add(g);
    };
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
      addTree(cx - off - (d % 3) * 2, d + (d % 7) - 3, 1.1 + (d % 5) * 0.08, 5000 + d);
      addTree(cx + off + (d % 4) * 2, d + (d % 5) - 2, 1.05 + (d % 4) * 0.09, 9000 + d);
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

      // Putt-read break arrow: on the green, point downhill (the fall line), its
      // size scaling with the slope so a steep tilt reads as a bigger break.
      if (!st.inFlight && st.lie === 'green') {
        const gr = sim.slopeUnder(b.d, b.x); // uphill gradient (∂h/∂d, ∂h/∂x)
        const mag = Math.hypot(gr.gd, gr.gx);
        if (mag > 1.5e-3) {
          // World downhill vector: (d,x) downhill = (−gd,−gx) → world (x, −d).
          wvec.set(-gr.gx, 0, gr.gd).normalize();
          putt.quaternion.setFromUnitVectors(UP, wvec);
          putt.position.set(b.x, b.h + 1.3, -b.d);
          const sc = Math.min(1.7, 0.7 + mag * 12);
          putt.scale.set(sc, sc * 1.5, sc);
          putt.visible = true;
        } else putt.visible = false;
      } else putt.visible = false;

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
