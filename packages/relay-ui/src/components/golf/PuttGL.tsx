import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PuttSim } from '../../lib/golf/puttSim';
import type { Hole, PuttEvent } from '../../lib/golf/puttSim';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import { FIXED_MS } from '../../lib/golf/tuning';

// Real-time 3D mini-golf (Three.js). Owns the WebGL renderer, scene and
// camera; drives the headless PuttSim on a fixed-timestep loop; renders the
// hole laid flat on the ground plane (mowing-stripe turf + rough, extruded
// wall baffles, a recessed cup with a flag, a glossy ball with a soft
// shadow) and an in-scene dashed aim line + power tip while dragging.
//
// Mirrors RangeGL's discipline exactly: DPR<=2, one shadow-casting light
// (map <=1024) + a hemisphere fill, a fixed-timestep substep loop that
// pauses on `paused`/document.hidden, no per-frame allocations in the loop,
// and full GPU teardown (dispose every tracked resource +
// renderer.forceContextLoss()) on unmount. The HUD (hole/par/strokes) is
// DOM, drawn by GolfGame OVER this canvas — nothing here draws UI chrome.
//
// Coordinate mapping: the course authors holes in a 100x125 virtual TOP-DOWN
// space (x right, y down). We lay it flat: world X = x - CX, world Z =
// y - CZ, Y up. Being a pure translation, virtual directions map straight to
// world directions, so the pointer->ground raycast feeds PuttSim exact aim.

const FIXED_S = FIXED_MS / 1000;
const MAX_SUBSTEPS = 5;
const BALL_R = 1.6;

// Virtual-space centre of the play area (border inset 8..92 x 8..117), so
// the laid-flat hole is centred on the world origin.
const CX = 50;
const CZ = 62.5;

// Wall extrusion.
const WALL_H = 3;
const WALL_T = 2.2;

interface Props {
  sim: PuttSim;
  hole: Hole;
  paused?: boolean;
  onEvent?: (e: PuttEvent) => void;
}

// Virtual (x,y) -> world (x,z) on the ground plane (translation only).
function wx(vx: number): number {
  return vx - CX;
}
function wz(vy: number): number {
  return vy - CZ;
}

// --- Procedural canvas textures (no binary assets) ------------------------

function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#2f7fd0');
  grad.addColorStop(0.5, '#5aa3e0');
  grad.addColorStop(0.8, '#bfe0f2');
  grad.addColorStop(1, '#e6f3fb');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const cloud = (cx: number, cy: number, s: number) => {
    for (let i = 0; i < 6; i++) {
      const bx = cx + (Math.random() - 0.5) * s * 2.2;
      const by = cy + (Math.random() - 0.5) * s * 0.6;
      const br = s * (0.5 + Math.random() * 0.6);
      const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
      rg.addColorStop(0, 'rgba(255,255,255,0.8)');
      rg.addColorStop(0.6, 'rgba(255,255,255,0.3)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(bx, by, br, 0, Math.PI * 2);
      g.fill();
    }
  };
  for (let i = 0; i < 6; i++) cloud(Math.random() * c.width, 90 + Math.random() * 150, 26 + Math.random() * 18);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeTurfTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 === 0 ? '#4ea043' : '#438c39';
    g.fillRect((i * c.width) / stripes, 0, c.width / stripes, c.height);
  }
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeRoughTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2f6b34';
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 1400; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5 ? `rgba(255,255,255,${Math.random() * 0.05})` : `rgba(0,0,0,${Math.random() * 0.08})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(24, 24);
  return tex;
}

function makeSoftDotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

export default function PuttGL({ sim, hole, paused = false, onEvent }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const ctlRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(o: T): T => {
      disposables.push(o);
      return o;
    };

    // --- Renderer / scene / camera --------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    let w = host.clientWidth || window.innerWidth;
    let h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const skyTex = track(makeSkyTexture());
    scene.background = skyTex;

    // Angled overhead camera framing the WHOLE hole: the tee (high virtual
    // y) sits toward +Z near the camera, the cup (low y) toward -Z far, so
    // the player can aim in any direction. Pitched ~55 deg from horizontal.
    const camera = new THREE.PerspectiveCamera(54, w / h, 1, 1200);
    const CAM_POS = new THREE.Vector3(0, 158, 112);
    const LOOK = new THREE.Vector3(0, 0, -4);
    camera.position.copy(CAM_POS);
    camera.lookAt(LOOK);

    // --- Lights (range budget: one shadow light + a hemi fill) ----------
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a7a3a, 0.9);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(-70, 150, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 360;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0006;
    sun.target.position.set(0, 0, 0);
    scene.add(sun);
    scene.add(sun.target);

    // --- Rough base -----------------------------------------------------
    const roughTex = track(makeRoughTexture());
    const roughGeo = track(new THREE.PlaneGeometry(600, 600));
    const roughMat = track(new THREE.MeshStandardMaterial({ map: roughTex, roughness: 1 }));
    const rough = new THREE.Mesh(roughGeo, roughMat);
    rough.rotation.x = -Math.PI / 2;
    rough.position.y = -0.05;
    rough.receiveShadow = true;
    scene.add(rough);

    // --- Green turf (mown putting surface) ------------------------------
    const turfTex = track(makeTurfTexture());
    for (const gr of hole.greens) {
      const geo = track(new THREE.PlaneGeometry(gr.w, gr.h));
      // Per-green texture clone so each panel repeats its own stripe count
      // (clones share the source canvas; each disposes its own GPU upload).
      const t = track(turfTex.clone());
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(Math.max(2, Math.round(gr.w / 12)), Math.max(2, Math.round(gr.h / 12)));
      const mat = track(new THREE.MeshStandardMaterial({ map: t, roughness: 1 }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(wx(gr.x + gr.w / 2), 0.03, wz(gr.y + gr.h / 2));
      mesh.receiveShadow = true;
      scene.add(mesh);
    }

    // --- Walls / obstacles (extruded low barriers) ----------------------
    const wallMat = track(new THREE.MeshStandardMaterial({ color: 0xe9edf0, roughness: 0.85 }));
    const capMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    for (const wall of hole.walls) {
      const ax = wall.a.x;
      const ay = wall.a.y;
      const bx = wall.b.x;
      const by = wall.b.y;
      const dx = bx - ax;
      const dz = by - ay;
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) continue;
      const angle = Math.atan2(-dz, dx);
      const mxWorld = wx((ax + bx) / 2);
      const mzWorld = wz((ay + by) / 2);
      // Overlap the ends by the thickness so corners meet cleanly.
      const boxGeo = track(new THREE.BoxGeometry(L + WALL_T, WALL_H, WALL_T));
      const box = new THREE.Mesh(boxGeo, wallMat);
      box.position.set(mxWorld, WALL_H / 2, mzWorld);
      box.rotation.y = angle;
      box.castShadow = true;
      box.receiveShadow = true;
      scene.add(box);
      // Subtle lighter top highlight.
      const capGeo = track(new THREE.BoxGeometry(L + WALL_T, 0.4, WALL_T * 1.02));
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.set(mxWorld, WALL_H + 0.1, mzWorld);
      cap.rotation.y = angle;
      scene.add(cap);
    }

    // --- Cup (recessed) + flag ------------------------------------------
    const cupX = wx(hole.cup.c.x);
    const cupZ = wz(hole.cup.c.y);
    const cupR = hole.cup.r;
    const holeMat = track(new THREE.MeshStandardMaterial({ color: 0x14201a, roughness: 1 }));
    const cupGeo = track(new THREE.CylinderGeometry(cupR, cupR, 3, 24, 1, true));
    const cupWall = new THREE.Mesh(cupGeo, holeMat);
    cupWall.position.set(cupX, -1.5, cupZ);
    scene.add(cupWall);
    const cupFloorGeo = track(new THREE.CircleGeometry(cupR, 24));
    const cupFloor = new THREE.Mesh(cupFloorGeo, holeMat);
    cupFloor.rotation.x = -Math.PI / 2;
    cupFloor.position.set(cupX, -3, cupZ);
    scene.add(cupFloor);
    // Dark rim ring at ground level so the hole reads from above.
    const rimGeo = track(new THREE.RingGeometry(cupR, cupR + 0.5, 24));
    const rimMat = track(new THREE.MeshBasicMaterial({ color: 0x0b1410, side: THREE.DoubleSide }));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(cupX, 0.02, cupZ);
    scene.add(rim);

    // Flag: pole + accent cloth.
    const poleH = 15;
    const poleGeo = track(new THREE.CylinderGeometry(0.28, 0.28, poleH, 8));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(cupX, poleH / 2, cupZ);
    pole.castShadow = true;
    scene.add(pole);
    const flagGeo = track(new THREE.PlaneGeometry(7, 4));
    const flagMat = track(
      new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.7, side: THREE.DoubleSide }),
    );
    const flag = new THREE.Mesh(flagGeo, flagMat);
    const flagBaseX = cupX + 3.5;
    flag.position.set(flagBaseX, poleH - 2.4, cupZ);
    flag.castShadow = true;
    scene.add(flag);

    // --- Ball -----------------------------------------------------------
    const ballGeo = track(new THREE.SphereGeometry(BALL_R, 32, 24));
    const dimpleTex = track(makeDimpleNormalMap());
    const ballMat = track(makeBallMaterial(dimpleTex));
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);

    // --- In-scene aim line + power tip ----------------------------------
    const aimPos = new Float32Array(6);
    const aimGeo = track(new THREE.BufferGeometry());
    const aimAttr = new THREE.BufferAttribute(aimPos, 3);
    aimGeo.setAttribute('position', aimAttr);
    const aimMat = track(
      new THREE.LineDashedMaterial({ color: 0x3ddc84, dashSize: 2.4, gapSize: 1.8, transparent: true, opacity: 0.95 }),
    );
    const aimLine = new THREE.Line(aimGeo, aimMat);
    aimLine.frustumCulled = false;
    aimLine.visible = false;
    scene.add(aimLine);
    const tipGeo = track(new THREE.SphereGeometry(1.1, 12, 10));
    const tipMat = track(new THREE.MeshBasicMaterial({ color: 0x3ddc84 }));
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.visible = false;
    scene.add(tip);
    const aimColLow = new THREE.Color(0x3ddc84);
    const aimColHigh = new THREE.Color(0xff4d4d);
    const aimCol = new THREE.Color();

    // --- Sink burst -----------------------------------------------------
    const PMAX = 40;
    const dotTex = track(makeSoftDotTexture());
    const partPos = new Float32Array(PMAX * 3);
    const partGeo = track(new THREE.BufferGeometry());
    const partAttr = new THREE.BufferAttribute(partPos, 3);
    partGeo.setAttribute('position', partAttr);
    const partMat = track(
      new THREE.PointsMaterial({
        size: 2.6,
        map: dotTex,
        color: 0xffffff,
        transparent: true,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    const particles = new THREE.Points(partGeo, partMat);
    particles.frustumCulled = false;
    particles.visible = false;
    scene.add(particles);
    const pVel = new Float32Array(PMAX * 3);
    let pLife = 0;
    let pActive = 0;
    const spawnBurst = (x: number, z: number, color: number) => {
      partMat.color.setHex(color);
      pActive = PMAX;
      for (let i = 0; i < PMAX; i++) {
        partPos[i * 3] = x;
        partPos[i * 3 + 1] = 1;
        partPos[i * 3 + 2] = z;
        const ang = Math.random() * Math.PI * 2;
        const sp = 8 + Math.random() * 14;
        pVel[i * 3] = Math.cos(ang) * sp * 0.5;
        pVel[i * 3 + 1] = 14 + Math.random() * 16;
        pVel[i * 3 + 2] = Math.sin(ang) * sp * 0.5;
      }
      pLife = 0.7;
      particles.visible = true;
      partAttr.needsUpdate = true;
    };

    // --- Pointer input (raycast to ground -> virtual point) -------------
    const raycaster = new THREE.Raycaster();
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const ballProj = new THREE.Vector3();

    // Returns the virtual (x,y) point under the pointer, or null if the ray
    // misses the ground plane.
    const pointerToVirtual = (px: number, py: number): { x: number; y: number } | null => {
      ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);
      if (!hit) return null;
      return { x: hitPoint.x + CX, y: hitPoint.z + CZ };
    };
    // Ball's projected screen position, for the grab test.
    const ballScreen = (): { x: number; y: number } => {
      ballProj.copy(ball.position).project(camera);
      return { x: ((ballProj.x + 1) / 2) * w, y: ((-ballProj.y + 1) / 2) * h };
    };

    let activePointer: number | null = null;
    const dragStartScreen = { x: 0, y: 0 };
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const grabRadius = () => Math.max(70, Math.min(w, h) * 0.16);

    const onDown = (e: PointerEvent) => {
      if (pausedRef.current || activePointer != null) return;
      if (!sim.ball.resting) return;
      const p = local(e);
      const bs = ballScreen();
      if (Math.hypot(p.x - bs.x, p.y - bs.y) > grabRadius()) return;
      const vp = pointerToVirtual(p.x, p.y);
      if (!vp) return;
      if (!sim.onPointerDown(vp)) return;
      activePointer = e.pointerId;
      dragStartScreen.x = p.x;
      dragStartScreen.y = p.y;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointer || pausedRef.current) return;
      const p = local(e);
      const vp = pointerToVirtual(p.x, p.y);
      if (!vp) return;
      const pullPx = Math.hypot(dragStartScreen.x - p.x, dragStartScreen.y - p.y);
      sim.onPointerMove(vp, pullPx);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      if (pausedRef.current) {
        sim.cancelAim();
        return;
      }
      const p = local(e);
      const vp = pointerToVirtual(p.x, p.y);
      if (!vp) {
        sim.cancelAim();
        return;
      }
      const pullPx = Math.hypot(dragStartScreen.x - p.x, dragStartScreen.y - p.y);
      sim.onPointerUp(vp, pullPx);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // --- Fixed-timestep loop --------------------------------------------
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let running = false;
    let sunk = false;
    let sinkY = BALL_R;

    const frame = (now: number) => {
      const dtMs = Math.min(now - last, 100);
      last = now;
      const dt = dtMs / 1000;

      acc += dtMs;
      let n = 0;
      while (acc >= FIXED_MS && n < MAX_SUBSTEPS) {
        sim.substep(FIXED_S);
        acc -= FIXED_MS;
        n++;
      }
      if (n >= MAX_SUBSTEPS && acc >= FIXED_MS) acc = 0;

      const events = sim.drainEvents();
      for (const ev of events) {
        if (ev.type === 'sink') {
          sunk = true;
          spawnBurst(cupX, cupZ, 0xffe27a);
        }
        onEventRef.current?.(ev);
      }

      // Ball transform. On sink, drop it into the cup.
      const b = sim.ball;
      if (sunk) {
        sinkY = Math.max(-2.4, sinkY - dt * 22);
        ball.position.set(cupX, sinkY, cupZ);
      } else {
        ball.position.set(wx(b.pos.x), BALL_R, wz(b.pos.y));
      }

      // Aim overlay while dragging.
      const st = sim.getState();
      if (st.aiming && st.power > 0.001) {
        const reach = 4 + st.power * 34;
        const bx = wx(b.pos.x);
        const bz = wz(b.pos.y);
        const tx = bx + st.aimX * reach;
        const tz = bz + st.aimY * reach;
        aimPos[0] = bx;
        aimPos[1] = 0.6;
        aimPos[2] = bz;
        aimPos[3] = tx;
        aimPos[4] = 0.6;
        aimPos[5] = tz;
        aimAttr.needsUpdate = true;
        aimLine.computeLineDistances();
        aimCol.copy(aimColLow).lerp(aimColHigh, st.power);
        aimMat.color.copy(aimCol);
        tipMat.color.copy(aimCol);
        tip.position.set(tx, 0.6, tz);
        aimLine.visible = true;
        tip.visible = true;
      } else {
        aimLine.visible = false;
        tip.visible = false;
      }

      // Flag sway.
      const t = now / 1000;
      flag.rotation.z = Math.sin(t * 2) * 0.12;
      flag.position.x = flagBaseX + Math.sin(t * 3) * 0.2;

      // Sink burst integration.
      if (particles.visible) {
        pLife -= dt;
        if (pLife <= 0) {
          particles.visible = false;
        } else {
          for (let i = 0; i < pActive; i++) {
            const j = i * 3;
            const vy = (pVel[j + 1] ?? 0) - 40 * dt;
            pVel[j + 1] = vy;
            partPos[j] = (partPos[j] ?? 0) + (pVel[j] ?? 0) * dt;
            partPos[j + 1] = Math.max(0, (partPos[j + 1] ?? 0) + vy * dt);
            partPos[j + 2] = (partPos[j + 2] ?? 0) + (pVel[j + 2] ?? 0) * dt;
          }
          partMat.opacity = Math.max(0, pLife / 0.7);
          partAttr.needsUpdate = true;
        }
      }

      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVis = () => {
      if (document.hidden) stop();
      else if (!pausedRef.current) start();
    };
    document.addEventListener('visibilitychange', onVis);

    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const nw = e.contentRect.width;
      const nh = e.contentRect.height;
      if (nw <= 0 || nh <= 0 || (nw === w && nh === h)) return;
      w = nw;
      h = nh;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    ctlRef.current = { start, stop };
    if (!pausedRef.current) start();

    return () => {
      stop();
      ctlRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      for (const d of disposables) d.dispose();
      // dispose() frees GL programs/targets but NOT the context itself;
      // forceContextLoss() releases it now so repeatedly entering/leaving a
      // round can't accumulate live contexts and hit the browser's cap.
      renderer.forceContextLoss();
      renderer.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
    // Mount-once: sim/hole are stable for a hole (GolfGame remounts by key);
    // live props flow via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start/stop from the paused prop (mirrors RangeGL).
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    if (paused) ctl.stop();
    else if (!document.hidden) ctl.start();
  }, [paused]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
