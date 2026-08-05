import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RangeSim } from '../../lib/golf/rangeSim';
import type { RangeEvent } from '../../lib/golf/rangeSim';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import { GRASS_END, RANGE_YD, WATER_END } from '../../lib/golf/rangeTargets';
import type { Pin } from '../../lib/golf/rangeTargets';
import { FIXED_MS } from '../../lib/golf/tuning';

// Real-time 3D driving range (Three.js). Owns the WebGL renderer, scene and
// camera; drives the headless RangeSim on a fixed-timestep loop; renders the
// stylized casual-golf scene (puffy-cloud sky, mowing-stripe turf, water with
// island greens + flags + floating yardage labels, framing low-poly trees and
// a back boundary net) and a Toptracer-style ball tracer with camera follow.
//
// The HUD (wind, clubs, readouts) is DOM, drawn by RangeGame OVER this canvas
// — nothing here draws UI. Pointer drag-back-to-swing feeds the sim. All GPU
// resources are disposed and the rAF loop cancelled on unmount; the loop
// pauses when `paused` or the document is hidden (critical on mobile WebView).
//
// World space (from rangeSim): d = downrange yards, x = lateral yards (+right),
// h = height yards. Scene space is 1 unit = 1 yard, mapped X = x, Y = h,
// Z = -d (camera sits behind the tee at +Z looking downrange toward -Z).

const FIXED_S = FIXED_MS / 1000;
const MAX_SUBSTEPS = 5;
const BALL_R = 0.62;
const TEE_LIFT = 0.5;
// Longest full-path tracer we retain (world samples) — bounds the buffer.
const TRACER_MAX = 900;

interface Props {
  sim: RangeSim;
  pins: Pin[];
  targetId?: string | null;
  paused?: boolean;
  onEvent?: (e: RangeEvent) => void;
}

// --- Procedural canvas textures (no binary assets) ------------------------

function makeSkyTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 1024;
  const g = c.getContext('2d')!;
  // Vertical gradient: deep blue up top fading to a hazy horizon.
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#2f7fd0');
  grad.addColorStop(0.45, '#4f9bde');
  grad.addColorStop(0.72, '#a9d4ef');
  grad.addColorStop(0.85, '#dceff8');
  grad.addColorStop(1, '#eaf5fb');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // Soft puffy clouds — each a cluster of translucent white blobs.
  const cloud = (cx: number, cy: number, s: number, seed: number) => {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < 7; i++) {
      const bx = cx + (rnd() - 0.5) * s * 2.4;
      const by = cy + (rnd() - 0.5) * s * 0.7;
      const br = s * (0.5 + rnd() * 0.6);
      const rg = g.createRadialGradient(bx, by, 0, bx, by, br);
      rg.addColorStop(0, 'rgba(255,255,255,0.82)');
      rg.addColorStop(0.55, 'rgba(255,255,255,0.36)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg;
      g.beginPath();
      g.arc(bx, by, br, 0, Math.PI * 2);
      g.fill();
    }
  };
  // Deterministic spread ACROSS THE FULL WIDTH (the sphere's azimuth) so the
  // camera's ~15%-wide window always frames a few, kept in the vertical band
  // (canvas y ~300..520 ≈ just above the viewing horizon) the tee camera sees.
  const N = 20;
  for (let i = 0; i < N; i++) {
    const cx = ((i + 0.5) / N) * c.width;
    const cy = 320 + ((i * 5) % 3) * 66 + ((i * 3) % 2) * 30;
    cloud(cx, cy, 40 + ((i * 7) % 4) * 12, i * 2654435761);
  }
  // Hazy distant hills sitting on the horizon band.
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

function makeTurfTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  // Alternating light/dark mowing stripes down the width (become downrange
  // bands once the plane is laid flat and the texture is repeated).
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 === 0 ? '#4e9f43' : '#438c39';
    g.fillRect((i * c.width) / stripes, 0, c.width / stripes, c.height);
  }
  // Faint grain so the turf isn't flat.
  for (let i = 0; i < 2200; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeWaterTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#1f7fc0');
  grad.addColorStop(1, '#155e94');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(255,255,255,0.14)';
  g.lineWidth = 2;
  for (let y = 0; y < c.height; y += 16) {
    g.beginPath();
    for (let x = 0; x <= c.width; x += 8) {
      const yy = y + Math.sin((x / c.width) * Math.PI * 4 + y) * 2.5;
      if (x === 0) g.moveTo(x, yy);
      else g.lineTo(x, yy);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 26);
  return tex;
}

function makeNetTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = 'rgba(30,45,40,0.5)';
  g.lineWidth = 2;
  for (let i = 0; i <= 64; i += 8) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 64);
    g.moveTo(0, i);
    g.lineTo(64, i);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeLabelTexture(text: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  // Rounded pill background + text — the floating yardage marker.
  g.fillStyle = 'rgba(20,28,40,0.82)';
  const r = 26;
  const w = c.width - 12;
  const h = 84;
  const x = 6;
  const y = 22;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 52px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, c.width / 2, y + h / 2 + 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
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
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

export default function RangeGL({ sim, pins, targetId, paused = false, onEvent }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Live target id for the flag-highlight effect below.
  const targetIdRef = useRef(targetId ?? null);
  // rAF start/stop handles, filled by the mount effect for the paused effect.
  const ctlRef = useRef<{ start: () => void; stop: () => void } | null>(null);
  // Flag materials + target rings, filled by the mount effect for the live
  // target-highlight effect (kept off the render loop).
  const flagStateRef = useRef<{
    flagMats: { id: string; mat: THREE.MeshStandardMaterial }[];
    rings: { id: string; ring: THREE.Mesh }[];
  } | null>(null);

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
    scene.fog = new THREE.Fog(0xcfe6f2, 140, 560);

    const camera = new THREE.PerspectiveCamera(56, w / h, 0.5, 1400);
    // Sit a touch lower and aim a touch higher than dead-level so the teed
    // ball (near the camera, low to the ground) frames in the lower-MIDDLE of
    // the now full-screen viewport with open turf below it for the drag-back
    // gesture — rather than sinking to the very bottom edge. Camera-follow on
    // the shot lerps away from these and back, unchanged.
    const teeCamPos = new THREE.Vector3(0, 8.4, 18);
    const teeLookAt = new THREE.Vector3(0, 4, -68);
    camera.position.copy(teeCamPos);
    const lookAt = teeLookAt.clone();
    camera.lookAt(lookAt);

    // --- Lights ---------------------------------------------------------
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x5a8a4a, 0.95);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sun.position.set(-46, 90, 34);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0006;
    sun.target.position.set(0, 0, -55);
    scene.add(sun);
    scene.add(sun.target);

    // --- Sky dome -------------------------------------------------------
    const skyTex = track(makeSkyTexture());
    const skyGeo = track(new THREE.SphereGeometry(900, 32, 16));
    const skyMat = track(
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
    );
    scene.add(new THREE.Mesh(skyGeo, skyMat));

    // --- Ground (mowing stripes) ---------------------------------------
    const turfTex = track(makeTurfTexture());
    turfTex.repeat.set(10, 60);
    const groundGeo = track(new THREE.PlaneGeometry(320, 820));
    const groundMat = track(new THREE.MeshStandardMaterial({ map: turfTex, roughness: 1 }));
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    // Centre so it spans from a little behind the tee out past the fence.
    ground.position.set(0, -0.05, -360);
    ground.receiveShadow = true;
    scene.add(ground);

    // Tee mat: a small darker patch under the tee.
    const matGeo = track(new THREE.CircleGeometry(4, 24));
    const matMat = track(new THREE.MeshStandardMaterial({ color: 0x3c7d33, roughness: 1 }));
    const teeMat = new THREE.Mesh(matGeo, matMat);
    teeMat.rotation.x = -Math.PI / 2;
    teeMat.position.set(0, 0.02, 0);
    teeMat.receiveShadow = true;
    scene.add(teeMat);

    // --- Water hazard ---------------------------------------------------
    const waterTex = track(makeWaterTexture());
    const waterGeo = track(new THREE.PlaneGeometry(150, WATER_END - GRASS_END));
    const waterMat = track(
      new THREE.MeshStandardMaterial({
        map: waterTex,
        color: 0x2a86c4,
        roughness: 0.28,
        metalness: 0.15,
        transparent: true,
        opacity: 0.92,
      }),
    );
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, 0.06, -(GRASS_END + WATER_END) / 2);
    scene.add(water);

    // --- Islands + flags + yardage labels ------------------------------
    const ISLAND_TOP = 0.85;
    const flagCloths: { mesh: THREE.Mesh; base: number }[] = [];
    const targetRings: { id: string; ring: THREE.Mesh }[] = [];
    const flagMats: { id: string; mat: THREE.MeshStandardMaterial }[] = [];
    const dirtMat = track(new THREE.MeshStandardMaterial({ color: 0x7a6a4a, roughness: 1 }));
    const greenMat = track(new THREE.MeshStandardMaterial({ color: 0x57ab4a, roughness: 1 }));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));

    for (const pin of pins) {
      const z = -pin.d;
      let topY = 0.05;
      if (pin.kind !== 'grass') {
        // Island poking out of the water: a green disc on a dirt base.
        topY = ISLAND_TOP;
        const baseGeo = track(new THREE.CylinderGeometry(pin.r * 1.25, pin.r * 1.4, 1.1, 20));
        const base = new THREE.Mesh(baseGeo, dirtMat);
        base.position.set(pin.x, 0.2, z);
        base.receiveShadow = true;
        base.castShadow = true;
        scene.add(base);
        const capGeo = track(new THREE.CylinderGeometry(pin.r * 1.2, pin.r * 1.25, 0.5, 20));
        const cap = new THREE.Mesh(capGeo, greenMat);
        cap.position.set(pin.x, topY, z);
        cap.receiveShadow = true;
        scene.add(cap);
      }

      const isTarget = (targetIdRef.current ?? null) === pin.id;

      // Pole.
      const poleGeo = track(new THREE.CylinderGeometry(0.11, 0.11, 6, 8));
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(pin.x, topY + 3, z);
      pole.castShadow = true;
      scene.add(pole);

      // Flag cloth.
      const flagGeo = track(new THREE.PlaneGeometry(2.4, 1.4));
      const flagMat = track(
        new THREE.MeshStandardMaterial({
          color: isTarget ? 0xe23b3b : 0x2f7fd0,
          roughness: 0.7,
          side: THREE.DoubleSide,
        }),
      );
      const flag = new THREE.Mesh(flagGeo, flagMat);
      flag.position.set(pin.x + 1.2, topY + 5.2, z);
      scene.add(flag);
      flagCloths.push({ mesh: flag, base: pin.x + 1.2 });
      flagMats.push({ id: pin.id, mat: flagMat });

      // Target ground ring.
      const ringGeo = track(new THREE.RingGeometry(pin.r * 0.9, pin.r * 1.15, 28));
      const ringMat = track(
        new THREE.MeshBasicMaterial({
          color: 0xff5a5a,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: isTarget ? 0.85 : 0,
        }),
      );
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pin.x, topY + 0.35, z);
      scene.add(ring);
      targetRings.push({ id: pin.id, ring });

      // Floating yardage label.
      const labelTex = track(makeLabelTexture(`${pin.d} yds`));
      const labelMat = track(new THREE.SpriteMaterial({ map: labelTex, depthTest: true }));
      const label = new THREE.Sprite(labelMat);
      label.position.set(pin.x, topY + 8.4, z);
      const lw = 7;
      label.scale.set(lw, lw * 0.5, 1);
      scene.add(label);
    }

    // --- Framing trees (low-poly) --------------------------------------
    const trunkMat = track(new THREE.MeshStandardMaterial({ color: 0x6f4a2a, roughness: 1 }));
    const leafMat = track(new THREE.MeshStandardMaterial({ color: 0x2f7d3a, roughness: 1 }));
    const leafMat2 = track(new THREE.MeshStandardMaterial({ color: 0x3c8f44, roughness: 1 }));
    const trunkGeo = track(new THREE.CylinderGeometry(0.5, 0.7, 4, 6));
    const coneGeoA = track(new THREE.ConeGeometry(3.4, 6, 7));
    const coneGeoB = track(new THREE.ConeGeometry(2.6, 5, 7));
    const addTree = (x: number, z: number, s: number) => {
      const g = new THREE.Group();
      const trunk = new THREE.Mesh(trunkGeo, trunkMat);
      trunk.position.y = 2;
      trunk.castShadow = true;
      g.add(trunk);
      const c1 = new THREE.Mesh(coneGeoA, leafMat);
      c1.position.y = 6;
      c1.castShadow = true;
      g.add(c1);
      const c2 = new THREE.Mesh(coneGeoB, leafMat2);
      c2.position.y = 9;
      c2.castShadow = true;
      g.add(c2);
      g.position.set(x, 0, z);
      g.scale.setScalar(s);
      scene.add(g);
    };
    // Receding tree lines down both banks of the hazard (just outside the
    // ±60yd water). The narrow portrait FOV can't frame trees at the tee, so
    // these flank the fairway/water toward the horizon for depth instead.
    for (let i = 0; i < 10; i++) {
      const z = -58 - i * 34;
      const jitter = ((i * 37) % 9) - 4;
      addTree(-63 - (i % 2) * 4, z + jitter, 1.15 - i * 0.05);
      addTree(63 + (i % 2) * 4, z - jitter, 1.1 - i * 0.045);
    }

    // --- Back boundary net + posts -------------------------------------
    const netTex = track(makeNetTexture());
    netTex.repeat.set(28, 2.2);
    const netGeo = track(new THREE.PlaneGeometry(140, 11));
    const netMat = track(
      new THREE.MeshBasicMaterial({
        map: netTex,
        transparent: true,
        opacity: 0.5,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const net = new THREE.Mesh(netGeo, netMat);
    net.position.set(0, 5.5, -RANGE_YD);
    scene.add(net);
    const postGeo = track(new THREE.CylinderGeometry(0.35, 0.35, 12, 6));
    const postMat = track(new THREE.MeshStandardMaterial({ color: 0x9aa3a0, roughness: 0.8 }));
    for (let i = -6; i <= 6; i++) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(i * 11, 6, -RANGE_YD);
      scene.add(post);
    }

    // --- Tee peg + ball -------------------------------------------------
    const pegGeo = track(new THREE.CylinderGeometry(0.09, 0.14, TEE_LIFT, 8));
    const pegMat = track(new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.7 }));
    const peg = new THREE.Mesh(pegGeo, pegMat);
    peg.position.set(0, TEE_LIFT / 2, 0);
    scene.add(peg);

    const ballGeo = track(new THREE.SphereGeometry(BALL_R, 32, 24));
    const dimpleTex = track(makeDimpleNormalMap());
    const ballMat = track(makeBallMaterial(dimpleTex));
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);

    // --- Persistent aim guide (at the tee, before & during a drag) ------
    // A flat tapering arrow lying on the turf from the ball down-range in the
    // current aim direction, tipped with a reticle and flanked by subtle L/R
    // chevrons, so it's obvious which way the shot goes and that the drag steers
    // it. Built pointing straight down-range (−Z); a Y-rotation applies aimRad,
    // a Z-scale grows it with power, and the colour ramps toward red near max.
    const AIM_LEN = 42; // yards to the reticle at rest
    const aimGuide = new THREE.Group();
    aimGuide.position.set(0, 0.16, 0);
    const aimColLow = new THREE.Color(0xffd54a);
    const aimColHigh = new THREE.Color(0xff5a3c);
    // Tapering arrow (shaft + head) as one flat, horizontal buffer geometry.
    const ws = 0.42; // shaft half-width
    const wh = 1.7; // head half-width
    const hl = 6; // head length
    const z0 = -2.4; // start just ahead of the ball
    const zHead = -(AIM_LEN - hl);
    const zTip = -AIM_LEN;
    const arrowVerts = new Float32Array([
      -ws, 0, z0, ws, 0, z0, ws, 0, zHead, // shaft tri 1
      -ws, 0, z0, ws, 0, zHead, -ws, 0, zHead, // shaft tri 2
      -wh, 0, zHead, wh, 0, zHead, 0, 0, zTip, // head
    ]);
    const arrowGeo = track(new THREE.BufferGeometry());
    arrowGeo.setAttribute('position', new THREE.BufferAttribute(arrowVerts, 3));
    const aimMat = track(
      new THREE.MeshBasicMaterial({
        color: aimColLow.clone(),
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
      }),
    );
    const arrow = new THREE.Mesh(arrowGeo, aimMat);
    aimGuide.add(arrow);
    // Reticle ring at the tip.
    const reticleGeo = track(new THREE.RingGeometry(1.7, 2.3, 24));
    const reticle = new THREE.Mesh(reticleGeo, aimMat);
    reticle.rotation.x = -Math.PI / 2;
    reticle.position.set(0, 0, zTip);
    aimGuide.add(reticle);
    // Subtle L/R steer chevrons flanking the shaft.
    const chevGeo = track(new THREE.BufferGeometry());
    const cs = 1.1;
    chevGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(
        new Float32Array([0, 0, cs, cs * 1.4, 0, 0, 0, 0, -cs]),
        3,
      ),
    );
    const chevMat = track(
      new THREE.MeshBasicMaterial({
        color: aimColLow.clone(),
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
        fog: false,
      }),
    );
    const chevL = new THREE.Mesh(chevGeo, chevMat);
    chevL.position.set(-4.4, 0, -15);
    chevL.rotation.y = Math.PI; // point left (−X)
    aimGuide.add(chevL);
    const chevR = new THREE.Mesh(chevGeo, chevMat);
    chevR.position.set(4.4, 0, -15); // point right (+X)
    aimGuide.add(chevR);
    scene.add(aimGuide);
    const aimCol = new THREE.Color();

    // --- Toptracer full-path line --------------------------------------
    const tracerPos = new Float32Array(TRACER_MAX * 3);
    const tracerGeo = track(new THREE.BufferGeometry());
    const tracerAttr = new THREE.BufferAttribute(tracerPos, 3);
    tracerGeo.setAttribute('position', tracerAttr);
    const tracerMat = track(
      new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.9, fog: false }),
    );
    const tracer = new THREE.Line(tracerGeo, tracerMat);
    tracer.frustumCulled = false;
    tracer.visible = false;
    scene.add(tracer);
    let tracerCount = 0;

    // --- Particle burst (splash / green) -------------------------------
    const PMAX = 60;
    const dotTex = track(makeSoftDotTexture());
    const partPos = new Float32Array(PMAX * 3);
    const partGeo = track(new THREE.BufferGeometry());
    const partAttr = new THREE.BufferAttribute(partPos, 3);
    partGeo.setAttribute('position', partAttr);
    const partMat = track(
      new THREE.PointsMaterial({
        size: 2.4,
        map: dotTex,
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

    const spawnBurst = (x: number, y: number, z: number, color: number, n: number) => {
      partMat.color.setHex(color);
      pActive = Math.min(PMAX, n);
      for (let i = 0; i < pActive; i++) {
        partPos[i * 3] = x;
        partPos[i * 3 + 1] = y;
        partPos[i * 3 + 2] = z;
        const ang = Math.random() * Math.PI * 2;
        const sp = 4 + Math.random() * 10;
        pVel[i * 3] = Math.cos(ang) * sp * 0.5;
        pVel[i * 3 + 1] = 6 + Math.random() * 12;
        pVel[i * 3 + 2] = Math.sin(ang) * sp * 0.5;
      }
      pLife = 0.7;
      particles.visible = true;
      partAttr.needsUpdate = true;
    };

    // --- Pointer input (drag back to swing) ----------------------------
    let activePointer: number | null = null;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      if (pausedRef.current || activePointer != null || sim.ball.inFlight) return;
      activePointer = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      sim.onPointerDown(local(e));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointer || pausedRef.current) return;
      sim.onPointerMove(local(e));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== activePointer) return;
      activePointer = null;
      // A drag started before a back-gesture pause still routes its pointerup
      // here (capture bypasses the pause sheet); don't queue a swing while paused.
      if (pausedRef.current) return;
      sim.onPointerUp(local(e));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // Full-power drag ≈ 38% of the canvas height.
    const applyPull = () => sim.setMaxPull(Math.max(120, h * 0.38));
    applyPull();

    // --- Camera follow state -------------------------------------------
    let following = false;
    let revertAt = 0;
    const followTarget = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();

    // --- Fixed-timestep loop -------------------------------------------
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    let running = false;

    const frame = (now: number) => {
      const dtMs = Math.min(now - last, 100);
      last = now;
      const dt = dtMs / 1000;

      // Physics substeps.
      acc += dtMs;
      let n = 0;
      while (acc >= FIXED_MS && n < MAX_SUBSTEPS) {
        sim.substep(FIXED_S);
        acc -= FIXED_MS;
        n++;
      }
      if (n >= MAX_SUBSTEPS && acc >= FIXED_MS) acc = 0;

      // Drain sim events → effects + parent callback.
      const events = sim.drainEvents();
      for (const ev of events) {
        if (ev.type === 'launch') {
          tracerCount = 0;
          tracer.visible = true;
          following = true;
          revertAt = 0;
        } else if (ev.type === 'splash') {
          if (ev.d != null && ev.x != null) spawnBurst(ev.x, 0.4, -ev.d, 0xdff2ff, 46);
          revertAt = now + 1300;
        } else if (ev.type === 'rest') {
          if (ev.d != null && ev.x != null) spawnBurst(ev.x, 0.4, -ev.d, 0x7ee08a, 26);
          revertAt = now + 1300;
        } else if (ev.type === 'fence') {
          revertAt = now + 1100;
        }
        onEventRef.current?.(ev);
      }

      // Ball transform.
      const b = sim.ball;
      const teed = !b.inFlight && b.d < 1;
      ball.position.set(b.x, b.h + BALL_R + (teed ? TEE_LIFT : 0), -b.d);
      peg.visible = teed;

      // Aim guide: visible only at the tee. Steer with aimRad, grow with power,
      // ramp toward red near max, and pulse gently when idle to invite a drag.
      aimGuide.visible = teed;
      if (teed) {
        aimGuide.rotation.y = -sim.aimRad;
        aimGuide.scale.z = 1 + sim.power * 0.5;
        aimCol.copy(aimColLow).lerp(aimColHigh, sim.power);
        aimMat.color.copy(aimCol);
        chevMat.color.copy(aimCol);
        const pulse = sim.aiming ? 1 : 0.82 + 0.18 * Math.sin(now / 320);
        aimMat.opacity = (0.42 + sim.power * 0.45) * pulse;
        chevMat.opacity = 0.42 * pulse;
      }

      // Tracer: append current ball position while in flight.
      if (b.inFlight && tracerCount < TRACER_MAX) {
        tracerPos[tracerCount * 3] = b.x;
        tracerPos[tracerCount * 3 + 1] = b.h + BALL_R;
        tracerPos[tracerCount * 3 + 2] = -b.d;
        tracerCount++;
        tracerGeo.setDrawRange(0, tracerCount);
        tracerAttr.needsUpdate = true;
        // tracer.frustumCulled = false, so the bounding sphere is never read —
        // skip recomputing it over the whole buffer every airborne frame.
      }
      if (teed) tracer.visible = false;

      // Particle integration.
      if (particles.visible) {
        pLife -= dt;
        if (pLife <= 0) {
          particles.visible = false;
        } else {
          for (let i = 0; i < pActive; i++) {
            const j = i * 3;
            const vy = (pVel[j + 1] ?? 0) - 22 * dt;
            pVel[j + 1] = vy;
            partPos[j] = (partPos[j] ?? 0) + (pVel[j] ?? 0) * dt;
            partPos[j + 1] = Math.max(0, (partPos[j + 1] ?? 0) + vy * dt);
            partPos[j + 2] = (partPos[j + 2] ?? 0) + (pVel[j + 2] ?? 0) * dt;
          }
          partMat.opacity = Math.max(0, pLife / 0.7);
          partAttr.needsUpdate = true;
        }
      }

      // Gentle flag sway.
      const t = now / 1000;
      for (let i = 0; i < flagCloths.length; i++) {
        const f = flagCloths[i]!;
        f.mesh.rotation.z = Math.sin(t * 2 + i) * 0.12;
        f.mesh.position.x = f.base + Math.sin(t * 3 + i) * 0.12;
      }
      // Water shimmer.
      waterTex.offset.y = (t * 0.03) % 1;

      // Camera: chase the ball down-range in flight, then ease back to the tee.
      if (following && revertAt !== 0 && now >= revertAt) following = false;
      if (following) {
        // Trail the ball at a fixed ~18yd back / above offset and look right
        // at it, so a long drive stays framed instead of receding to a dot.
        // (lookTarget uses full b.x, so the ball stays centred even though the
        // camera only tracks lateral drift partially — a slight over-shoulder
        // angle on off-line shots.)
        followTarget.set(b.x * 0.7, 8 + b.h * 0.35, -b.d + 18);
        lookTarget.set(b.x, b.h + BALL_R + 1, -b.d);
      } else {
        followTarget.copy(teeCamPos);
        lookTarget.copy(teeLookAt);
      }
      // Snappier tracking in flight so the chase keeps up with the ball;
      // gentler on the ease back to the tee.
      const k = 1 - Math.exp(-dt * (following ? 5 : 3.2));
      camera.position.lerp(followTarget, k);
      lookAt.lerp(lookTarget, k);
      camera.lookAt(lookAt);

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

    // Resize handling.
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
      applyPull();
    });
    ro.observe(host);

    // Expose start/stop + flag state for the live effects below.
    ctlRef.current = { start, stop };
    flagStateRef.current = { flagMats, rings: targetRings };
    if (!pausedRef.current) start();

    return () => {
      stop();
      ctlRef.current = null;
      flagStateRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      for (const d of disposables) d.dispose();
      // dispose() frees GL programs/targets but NOT the WebGL context itself;
      // forceContextLoss() releases it now so repeatedly entering/leaving the
      // range can't accumulate live contexts and hit the browser's cap.
      renderer.forceContextLoss();
      renderer.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
    // Mount-once: sim/pins are stable for a mode; live props flow via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start/stop from the paused prop.
  useEffect(() => {
    const ctl = ctlRef.current;
    if (!ctl) return;
    if (paused) ctl.stop();
    else if (!document.hidden) ctl.start();
  }, [paused]);

  // Live target highlight — recolor flags + toggle rings when the challenge
  // target changes. Kept off the render loop; runs only on target change.
  useEffect(() => {
    targetIdRef.current = targetId ?? null;
    const st = flagStateRef.current;
    if (!st) return;
    for (const f of st.flagMats) f.mat.color.setHex(f.id === targetId ? 0xe23b3b : 0x2f7fd0);
    for (const r of st.rings) {
      (r.ring.material as THREE.MeshBasicMaterial).opacity = r.id === targetId ? 0.85 : 0;
    }
  }, [targetId]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}
