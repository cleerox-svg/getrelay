// 3D render of a course hole (GOLF.md roadmap step 3). It visualises the SAME
// data the physics reads: the ground is a displaced mesh sampled from
// terrain.heightAt() and vertex-COLOURED per lie from terrain.surfaceAt(), so
// the fairway corridor, green, bunkers, rough, cart path and water you see are
// exactly the surfaces the ball plays (CourseSim). One source of truth — the
// look can't drift from the physics. Lighting/tone-mapping mirror the range's
// tuned rig (ACES + warm sun + soft shadows + sky/haze). Trees frame it.
//
// World→scene mapping: d (downrange) → −Z, x (lateral) → X, h (elevation) → Y.
// This v1 renders a hole statically (ball on the tee); the aim UI + camera
// follow + HUD that drive CourseSim come next.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { heightAt, surfaceAt, type CourseHole, type Surface } from '../../lib/golf/terrain';

interface Props {
  hole: CourseHole;
}

// Per-lie base albedo (linear-ish sRGB), tuned to read under the ACES roll-off.
const SURFACE_RGB: Record<Surface, [number, number, number]> = {
  fairway: [0.4, 0.66, 0.3],
  green: [0.5, 0.78, 0.36],
  fringe: [0.56, 0.72, 0.36],
  rough: [0.22, 0.46, 0.22],
  bunker: [0.9, 0.82, 0.6],
  water: [0.14, 0.42, 0.66],
  cartpath: [0.76, 0.73, 0.68],
  tee: [0.46, 0.68, 0.36],
  ob: [0.16, 0.36, 0.18],
};

// Small deterministic hash for per-vertex colour jitter (mown-turf life).
function jitter(d: number, x: number): number {
  let h = (Math.floor(d) * 73856093) ^ (Math.floor(x) * 19349663);
  h = (h ^ (h >>> 13)) * 1274126177;
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * 0.08;
}

export default function CourseGL({ hole }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

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
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xd6ecf4, 220, 900);

    // Sky gradient backdrop.
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

    // --- Lights (mirror the range rig) ---------------------------------
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
    // Aim the sun's shadow frustum at the middle of the hole.
    const mid = hole.centerline[Math.floor(hole.centerline.length / 2)] ?? hole.pin;
    sun.target.position.set(mid.x, 0, -mid.d);
    scene.add(sun);
    scene.add(sun.target);

    // --- Base ground fill: a big plane so the world reaches the horizon --
    // beyond the detailed play corridor (otherwise the mesh edges fall to sky).
    const baseY = Math.min(hole.terrain.teeElev, hole.terrain.greenElev) - 0.6;
    const fillGeo = track(new THREE.PlaneGeometry(2600, 2600));
    const fillMat = track(new THREE.MeshStandardMaterial({ color: 0x3f7a3a, roughness: 1 }));
    const fill = new THREE.Mesh(fillGeo, fillMat);
    fill.rotation.x = -Math.PI / 2;
    fill.position.set(hole.pin.x, baseY, -hole.pin.d / 2);
    fill.receiveShadow = true;
    scene.add(fill);

    // --- Terrain mesh: displaced grid, vertex-coloured per lie ----------
    const dMin = -20;
    const dMax = hole.pin.d + 110;
    const xHalf = 120;
    const nd = 224; // downrange segments
    const nx = 128; // lateral segments
    const geo = track(new THREE.BufferGeometry());
    const verts = new Float32Array((nd + 1) * (nx + 1) * 3);
    const cols = new Float32Array((nd + 1) * (nx + 1) * 3);
    let vi = 0;
    for (let j = 0; j <= nd; j++) {
      const d = dMin + (j / nd) * (dMax - dMin);
      for (let i = 0; i <= nx; i++) {
        const x = -xHalf + (i / nx) * (xHalf * 2);
        const y = heightAt(hole, d, x);
        verts[vi] = x;
        verts[vi + 1] = y;
        verts[vi + 2] = -d;
        const surf = surfaceAt(hole, d, x);
        const [r, g, b] = SURFACE_RGB[surf];
        const jt = surf === 'water' || surf === 'cartpath' || surf === 'bunker' ? 0 : jitter(d, x);
        cols[vi] = Math.max(0, r + jt);
        cols[vi + 1] = Math.max(0, g + jt);
        cols[vi + 2] = Math.max(0, b + jt);
        vi += 3;
      }
    }
    const idx: number[] = [];
    const row = nx + 1;
    for (let j = 0; j < nd; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * row + i;
        idx.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const groundMat = track(
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
    );
    const ground = new THREE.Mesh(geo, groundMat);
    ground.receiveShadow = true;
    ground.castShadow = false;
    scene.add(ground);

    // --- Water surfaces: a translucent disc at each pond's rim level -----
    for (const hz of hole.hazards) {
      if (hz.kind !== 'water') continue;
      const rimY = heightAt(hole, hz.d + hz.r, hz.x) + 0.05;
      const wGeo = track(new THREE.CircleGeometry(hz.r, 40));
      const wMat = track(
        new THREE.MeshStandardMaterial({
          color: 0x2f6fb0,
          roughness: 0.25,
          metalness: 0.2,
          transparent: true,
          opacity: 0.85,
        }),
      );
      const water = new THREE.Mesh(wGeo, wMat);
      water.rotation.x = -Math.PI / 2;
      water.position.set(hz.x, rimY, -hz.d);
      scene.add(water);
    }

    // --- Flagstick at the pin ------------------------------------------
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

    // --- Ball on the tee ------------------------------------------------
    const teeY = heightAt(hole, hole.tee.d, hole.tee.x);
    const ballGeo = track(new THREE.SphereGeometry(0.7, 20, 16));
    const ballMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 }));
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.position.set(hole.tee.x, teeY + 0.7, -hole.tee.d);
    ball.castShadow = true;
    scene.add(ball);

    // --- Framing trees along the corridor edges (faceted, low-poly) -----
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
    // Line trees just outside the rough on both sides, along the centerline.
    for (let d = 20; d < dMax - 20; d += 26) {
      // Interpolate the centerline x at this d (linear over segments).
      let cx = 0;
      const cl = hole.centerline;
      for (let s = 0; s < cl.length - 1; s++) {
        const a = cl[s]!;
        const bb = cl[s + 1]!;
        if (d >= a.d && d <= bb.d) {
          cx = a.x + ((bb.x - a.x) * (d - a.d)) / (bb.d - a.d || 1);
          break;
        }
      }
      const off = hole.roughHalf + 8;
      addTree(cx - off - (d % 3) * 2, d + (d % 7) - 3, 1.1 + (d % 5) * 0.08, 5000 + d);
      addTree(cx + off + (d % 4) * 2, d + (d % 5) - 2, 1.05 + (d % 4) * 0.09, 9000 + d);
    }

    // --- Camera: a golfer's-eye view from behind the tee down the hole --
    const camera = new THREE.PerspectiveCamera(60, w / h, 0.5, 2000);
    // Centerline x a given distance down the hole (for aiming the look).
    const clX = (d: number): number => {
      const cl = hole.centerline;
      for (let s = 0; s < cl.length - 1; s++) {
        const a = cl[s]!;
        const b = cl[s + 1]!;
        if (d >= a.d && d <= b.d) return a.x + ((b.x - a.x) * (d - a.d)) / (b.d - a.d || 1);
      }
      return cl[cl.length - 1]!.x;
    };
    camera.position.set(hole.tee.x, teeY + 7.5, -hole.tee.d + 11);
    const lookD = 150;
    camera.lookAt(new THREE.Vector3(clX(lookD), heightAt(hole, lookD, clX(lookD)) + 4, -lookD));

    const onResize = () => {
      w = host.clientWidth || window.innerWidth;
      h = host.clientHeight || window.innerHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);

    let raf = 0;
    const frame = () => {
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      for (const d of disposables) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    };
  }, [hole]);

  return <div ref={hostRef} style={{ position: 'fixed', inset: 0 }} />;
}
