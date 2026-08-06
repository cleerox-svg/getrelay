import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RangeSim } from '../../lib/golf/rangeSim';
import type { RangeEvent } from '../../lib/golf/rangeSim';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import {
  FAIRWAY_HALF_W,
  FAIRWAY_WATER_END,
  FAIRWAY_WATER_START,
  GRASS_END,
  ISLAND_SURFACE_SCALE,
  RANGE_YD,
  WATER_END,
  surfaceAt,
} from '../../lib/golf/rangeTargets';
import type { Pin, RangeLayout } from '../../lib/golf/rangeTargets';
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
// The true rolling rate (speed/radius) is ~200 rad/s at ball speed and would
// just strobe the dimples. Scale it to a legible spin that still reads fast on
// a bomb and slow on a trickle; the per-frame angle is also clamped in-loop.
const SPIN_VIS = 0.13;
// Longest full-path tracer we retain (world samples) — bounds the buffer.
const TRACER_MAX = 900;

interface Props {
  sim: RangeSim;
  pins: Pin[];
  // Active landing-area design + mode, so the scene draws the matching surfaces
  // (causeway vs crossing hazard) and classifies impacts like the sim. The
  // parent remounts this component (keyed on layout) when the picker changes.
  layout: RangeLayout;
  isChallenge: boolean;
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
  // Deeper, more saturated blue up top (survives the ACES roll-off) grading to
  // a clean pale horizon — a crisp sunny sky rather than a flat hazy wash.
  grad.addColorStop(0, '#1f6ec8');
  grad.addColorStop(0.42, '#3d8ed9');
  grad.addColorStop(0.7, '#8ac6ea');
  grad.addColorStop(0.85, '#cde8f6');
  grad.addColorStop(1, '#e8f4fb');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // Puffy cumulus clouds — a cluster of white blobs with a brighter, tighter
  // core and a flat shaded base, so they read as defined clouds, not fuzz.
  const cloud = (cx: number, cy: number, s: number, seed: number) => {
    let a = seed >>> 0;
    const rnd = () => {
      a = (a * 1664525 + 1013904223) >>> 0;
      return a / 4294967296;
    };
    for (let i = 0; i < 7; i++) {
      const bx = cx + (rnd() - 0.5) * s * 1.9;
      // Bias blobs upward so the cluster has a flatter base and a domed top.
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
  // Deterministic spread ACROSS THE FULL WIDTH (the sphere's azimuth) so the
  // camera's ~15%-wide window always frames a few, kept in the vertical band
  // (canvas y ~300..520 ≈ just above the viewing horizon) the tee camera sees.
  // More, smaller clusters spread across the full azimuth and higher up the
  // dome (the tee camera frames a narrow slice, so smaller reads as defined).
  const N = 30;
  for (let i = 0; i < N; i++) {
    const cx = ((i + 0.5) / N) * c.width + ((i * 13) % 17) - 8;
    const cy = 250 + ((i * 5) % 4) * 54 + ((i * 3) % 2) * 24;
    cloud(cx, cy, 22 + ((i * 7) % 4) * 9, i * 2654435761);
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
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  // Mowing stripes down the width (become downrange bands once the plane is
  // laid flat). Softened: a small light/dark delta on a common base green with
  // a faint within-stripe gradient so the bands read as mown grass, not blocks.
  const stripes = 8;
  const sw = S / stripes;
  for (let i = 0; i < stripes; i++) {
    const up = i % 2 === 0;
    const grad = g.createLinearGradient(i * sw, 0, (i + 1) * sw, 0);
    // Brighter, richer greens with a GENTLER light/dark delta between the two
    // mow directions, so the stripes read as mown grass rather than heavy blocks.
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
  // Directional blade streaks: short, near-vertical strokes in varied green
  // luminance so light catches individual "blades". Two passes (dark + light).
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
  // Broad, low-frequency hue/luminance mottling (sun/shade patches).
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// Cheap value-noise grass normal map: fine, near-vertical blade ridges so the
// single sun catches a soft directional sheen across the fairway. Tileable.
function makeTurfNormalMap(): THREE.Texture {
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
  // Height field: blades run in Y, so vary fast in X, slow in Y — plus a coarse
  // undulation. Sampled with toroidal wrap for a seamless tile.
  const height = (x: number, y: number) => {
    const xi = ((x % S) + S) % S;
    const yi = ((y % S) + S) % S;
    const blade = hash(Math.floor(xi * 0.9), Math.floor(yi * 0.18));
    const fine = hash(Math.floor(xi), Math.floor(yi * 0.5));
    const coarse =
      Math.sin(xi * 0.05) * 0.5 + Math.sin(yi * 0.017 + xi * 0.01) * 0.5;
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

function makeWaterTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, '#2183c2');
  grad.addColorStop(1, '#14608f');
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  // Soft mottled light patches instead of hard sine lines — the ripple movement
  // now comes from the animated normal map, so the colour map stays gentle.
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    const r = 8 + Math.random() * 26;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    const light = Math.random() < 0.6;
    rg.addColorStop(0, light ? 'rgba(180,220,240,0.10)' : 'rgba(10,40,70,0.10)');
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 26);
  return tex;
}

// Tileable ripple normal map: two crossing wave trains baked into a normal
// field. Scrolling its offset each frame makes the water visibly move, and the
// low roughness on the material turns the moving normals into a shifting sun
// glint. Frequencies are integer cycles across the tile so it wraps seamlessly.
function makeWaterNormalMap(): THREE.Texture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const data = img.data;
  const TAU = Math.PI * 2;
  const wave = (x: number, y: number) => {
    const u = (x / S) * TAU;
    const v = (y / S) * TAU;
    return (
      Math.sin(u * 3 + v * 1) * 0.5 +
      Math.sin(u * 1 - v * 4) * 0.35 +
      Math.sin((u + v) * 5) * 0.2
    );
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = wave(x + 1, y) - wave(x - 1, y);
      const hy = wave(x, y + 1) - wave(x, y - 1);
      let nx = -hx * 2.2;
      let ny = -hy * 2.2;
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
  tex.repeat.set(5, 12);
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

export default function RangeGL({
  sim,
  pins,
  layout,
  isChallenge,
  targetId,
  paused = false,
  onEvent,
}: Props) {
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
    // ACES filmic tone mapping + a touch of exposure: compresses the sky/sun
    // highlights and deepens the mid-greens so the scene reads like a lit
    // photograph rather than flat vertex colours. Light intensities below are
    // tuned UP to compensate for the filmic roll-off.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    // Warm, slightly denser distance haze so flags/trees/greens fade into the
    // horizon instead of ending on a hard line — reads as depth on a sunny day.
    scene.fog = new THREE.Fog(0xd6ecf4, 130, 500);

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
    // Sky/ground hemisphere fill for soft ambient, plus a strong warm key sun
    // that actually casts. Intensities are raised for the ACES roll-off so the
    // turf keeps its punch while the sky highlights stay controlled.
    const hemi = new THREE.HemisphereLight(0xcdeaff, 0x4f7d3f, 1.05);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.7);
    sun.position.set(-52, 96, 40);
    sun.castShadow = true;
    // Higher-res 2048² shadow map (re-enabled by request) so the trees, flags
    // and ball drop a crisper, cleaner-edged contact shadow. NOTE: a 2048² map
    // was previously reverted because it crashed the WebView GPU process on some
    // real Android devices (black screen needing an app restart) though it
    // rendered fine in desktop/software GL — VERIFY this build on a low-end
    // Android device before shipping the release AAB. If low-end GPUs strain,
    // 1536² is the first dial to turn down.
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 280;
    sun.shadow.camera.left = -80;
    sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80;
    sun.shadow.camera.bottom = -80;
    sun.shadow.bias = -0.0005;
    sun.shadow.normalBias = 0.02;
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
    const turfNorm = track(makeTurfNormalMap());
    turfNorm.repeat.set(64, 180);
    const groundGeo = track(new THREE.PlaneGeometry(320, 820));
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        map: turfTex,
        // A touch glossier so the sun rakes a soft directional sheen across the
        // fairway (the blade normal map now catches a highlight) instead of the
        // old dead-matte look. Stronger normals give the turf more relief.
        roughness: 0.82,
        metalness: 0,
        normalMap: turfNorm,
        normalScale: new THREE.Vector2(0.5, 0.5),
      }),
    );
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    // Centre so it spans from a little behind the tee out past the fence.
    ground.position.set(0, -0.05, -360);
    ground.receiveShadow = true;
    scene.add(ground);

    // No flat tee-mat disc: an untextured circle reads as an odd patch against
    // the striped turf. The tee peg + the ball's soft contact shadow ground the
    // ball on the fairway, which looks cleaner and more golf-like.

    // --- Water hazard ---------------------------------------------------
    // Layout selects the hazard footprint: lane / practiceLane flood the whole
    // 100..390 range; fairway is a single crossing band between the near and
    // far fairways. (The ground plane is grass everywhere underneath, so the
    // far/near fairway needs no extra mesh — just this water band on top.)
    const isFairway = layout === 'fairway';
    const waterNear = isFairway ? FAIRWAY_WATER_START : GRASS_END;
    const waterFar = isFairway ? FAIRWAY_WATER_END : WATER_END;
    const WATER_Y = 0.06;
    const waterTex = track(makeWaterTexture());
    const waterNorm = track(makeWaterNormalMap());
    const waterGeo = track(new THREE.PlaneGeometry(150, waterFar - waterNear));
    const waterMat = track(
      new THREE.MeshStandardMaterial({
        map: waterTex,
        color: 0x2a86c4,
        // Low roughness + a little metalness so the moving normal map produces a
        // shifting specular sun glint and a faint reflective sheen.
        roughness: 0.14,
        metalness: 0.2,
        normalMap: waterNorm,
        normalScale: new THREE.Vector2(0.55, 0.55),
        transparent: true,
        opacity: 0.9,
      }),
    );
    const water = new THREE.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.set(0, WATER_Y, -(waterNear + waterFar) / 2);
    scene.add(water);

    // --- Grass fairway causeway (lane / practiceLane only) -------------
    // A turf lane laid over the water straight down the middle so an online
    // shot lands on grass and runs out (visuals match rangeTargets.surfaceAt's
    // central corridor). Present for 'lane' always, and for 'practiceLane' only
    // while practising — in the practiceLane CHALLENGE the causeway is gone
    // (full water), so it isn't drawn. 'fairway' has no causeway at all.
    const drawCauseway = layout === 'lane' || (layout === 'practiceLane' && !isChallenge);
    if (drawCauseway) {
      const fairwayTex = track(makeTurfTexture());
      fairwayTex.repeat.set(2, 44);
      const fairwayNorm = track(makeTurfNormalMap());
      fairwayNorm.repeat.set(6, 140);
      const fairwayGeo = track(
        new THREE.PlaneGeometry(FAIRWAY_HALF_W * 2, WATER_END - GRASS_END),
      );
      const fairwayMat = track(
        new THREE.MeshStandardMaterial({
          map: fairwayTex,
          // Match the main ground's PBR so the causeway reads as the same lit
          // turf under the new sun (not a flatter, matte lane through the water).
          roughness: 0.82,
          normalMap: fairwayNorm,
          normalScale: new THREE.Vector2(0.5, 0.5),
        }),
      );
      const fairway = new THREE.Mesh(fairwayGeo, fairwayMat);
      fairway.rotation.x = -Math.PI / 2;
      fairway.position.set(0, WATER_Y + 0.04, -(GRASS_END + WATER_END) / 2);
      fairway.receiveShadow = true;
      scene.add(fairway);
    }

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
        // Green top radius == the physics surface radius (single source of
        // truth in rangeTargets) so a ball resting on the visible green is
        // classified 'island', never 'water', at the rim.
        const greenR = pin.r * ISLAND_SURFACE_SCALE;
        const baseGeo = track(new THREE.CylinderGeometry(greenR * 1.04, greenR * 1.16, 1.1, 20));
        const base = new THREE.Mesh(baseGeo, dirtMat);
        base.position.set(pin.x, 0.2, z);
        base.receiveShadow = true;
        base.castShadow = true;
        scene.add(base);
        const capGeo = track(new THREE.CylinderGeometry(greenR, greenR * 1.04, 0.5, 20));
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
    // Preallocated temporaries for per-frame ball-spin rotation (no allocs in
    // the render loop). spinAxis holds the world-space angular-velocity vector;
    // spinQuat the incremental rotation applied to ball.quaternion each frame.
    const spinAxis = new THREE.Vector3();
    const spinQuat = new THREE.Quaternion();
    // Ball-sink state (water): drop below the surface and fade out.
    let sinking = false;
    let sinkStart = 0;

    // --- Persistent aim guide (at the tee, before & during a drag) ------
    // A flat tapering arrow lying on the turf from the ball down-range in the
    // current aim direction, tipped with a reticle and flanked by subtle L/R
    // chevrons, so it's obvious which way the shot goes. It follows aimRad live
    // as the player works the dedicated aim control (the power pull no longer
    // steers). Built pointing straight down-range (−Z); a Y-rotation applies aimRad,
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

    // --- Predicted trajectory (the aim aid) ----------------------------
    // A live, non-committing preview of where THIS pull lands, drawn from the
    // real sim via sim.predict() (same physics as the shot, so it's true to the
    // yard). Four elements, PGA-app style: a wind-adjusted flight+roll arc, a
    // filled landing reticle at the carry point, a small rest marker after the
    // roll-out, a hollow pre-wind reticle (the gap to the landing ring shows how
    // far the wind pushes the ball), and a translucent dispersion cone spanning
    // the two tap-timing extremes (worst hook ↔ worst slice) so the risk reads.
    // Recomputed only when the inputs change (a cheap per-frame signature), and
    // shown only while setting up a shot at the tee.
    // Max samples in the drawn flight line. A normal shot is ~190 stride-3
    // samples; sized well above so a long tailwind roll (substep keeps nudging a
    // grounded ball) can't truncate the drawn arc before the rest marker. The
    // landing/rest reticles are placed from wind.landing/wind.rest regardless.
    const PRED_MAX = 512;
    const PRED_Y = 0.2; // lift the ground markers just above the turf
    const predColor = 0x46e0ff;
    const predGroup = new THREE.Group();
    predGroup.visible = false;

    const predPos = new Float32Array(PRED_MAX * 3);
    const predGeo = track(new THREE.BufferGeometry());
    const predAttr = new THREE.BufferAttribute(predPos, 3);
    predGeo.setAttribute('position', predAttr);
    const predMat = track(
      new THREE.LineBasicMaterial({
        color: predColor,
        transparent: true,
        opacity: 0.9,
        fog: false,
      }),
    );
    const predLine = new THREE.Line(predGeo, predMat);
    predLine.frustumCulled = false;
    predGroup.add(predLine);

    // Landing reticle (wind-adjusted carry point).
    const landRingGeo = track(new THREE.RingGeometry(1.5, 2.2, 28));
    const landRingMat = track(
      new THREE.MeshBasicMaterial({
        color: predColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        fog: false,
      }),
    );
    const landRing = new THREE.Mesh(landRingGeo, landRingMat);
    landRing.rotation.x = -Math.PI / 2;
    predGroup.add(landRing);

    // Rest marker (after the roll-out).
    const restRingGeo = track(new THREE.RingGeometry(0.7, 1.1, 20));
    const restRingMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        fog: false,
      }),
    );
    const restRing = new THREE.Mesh(restRingGeo, restRingMat);
    restRing.rotation.x = -Math.PI / 2;
    predGroup.add(restRing);

    // Pre-wind (intended) reticle — hollow amber; the gap to landRing = wind push.
    const aimRingGeo = track(new THREE.RingGeometry(2.4, 2.8, 28));
    const aimRingMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xffd54a,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        fog: false,
      }),
    );
    const aimRing = new THREE.Mesh(aimRingGeo, aimRingMat);
    aimRing.rotation.x = -Math.PI / 2;
    predGroup.add(aimRing);

    // Dispersion cone: a flat translucent triangle from the ball to the two
    // tap-timing edge landings (worst hook / worst slice).
    const coneVerts = new Float32Array(9);
    const coneGeo = track(new THREE.BufferGeometry());
    const coneAttr = new THREE.BufferAttribute(coneVerts, 3);
    coneGeo.setAttribute('position', coneAttr);
    const coneMat = track(
      new THREE.MeshBasicMaterial({
        color: predColor,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
        fog: false,
      }),
    );
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.frustumCulled = false;
    predGroup.add(cone);
    scene.add(predGroup);

    // Recompute the prediction, called only when the input signature changes.
    let predSig = '';
    const updatePrediction = () => {
      // Wind-adjusted center line + landing/rest.
      const wind = sim.predict({ accuracy: 0, includeWind: true, stride: 3 });
      const n = Math.min(wind.path.length, PRED_MAX);
      for (let k = 0; k < n; k++) {
        const p = wind.path[k]!;
        predPos[k * 3] = p.x;
        predPos[k * 3 + 1] = p.h + BALL_R;
        predPos[k * 3 + 2] = -p.d;
      }
      predGeo.setDrawRange(0, n);
      predAttr.needsUpdate = true;

      // Landing reticle (carry). If the shot flew out over the fence with no
      // landing, fall back to the rest point so the ring still reads.
      const land = wind.landing ?? wind.rest;
      landRing.position.set(land.x, PRED_Y, -land.d);
      const rolled = Math.hypot(wind.rest.d - land.d, wind.rest.x - land.x);
      restRing.position.set(wind.rest.x, PRED_Y, -wind.rest.d);
      restRing.visible = rolled > 4;

      // Pre-wind (intended) reticle — only when it visibly differs.
      const intended = sim.predict({ accuracy: 0, includeWind: false, stride: 12 });
      const iLand = intended.landing ?? intended.rest;
      aimRing.position.set(iLand.x, PRED_Y, -iLand.d);
      aimRing.visible = Math.hypot(iLand.d - land.d, iLand.x - land.x) > 3;

      // Dispersion cone from the two tap-timing extremes' landings.
      const missL = sim.predict({ accuracy: -1, includeWind: true, stride: 999 });
      const missR = sim.predict({ accuracy: 1, includeWind: true, stride: 999 });
      const lL = missL.landing ?? missL.rest;
      const lR = missR.landing ?? missR.rest;
      coneVerts[0] = 0;
      coneVerts[1] = PRED_Y;
      coneVerts[2] = 0;
      coneVerts[3] = lL.x;
      coneVerts[4] = PRED_Y;
      coneVerts[5] = -lL.d;
      coneVerts[6] = lR.x;
      coneVerts[7] = PRED_Y;
      coneVerts[8] = -lR.d;
      coneAttr.needsUpdate = true;
    };

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

    // --- Impact FX: surface-appropriate particles + decals -------------
    // One point cloud drives both the turf-divot flecks and the water droplets,
    // tinted per-particle via a vertex-colour attribute (green/brown for turf,
    // white for splash). Gravity is applied in the loop; particles land and hide.
    const PMAX = 60;
    const dotTex = track(makeSoftDotTexture());
    const partPos = new Float32Array(PMAX * 3);
    const partCol = new Float32Array(PMAX * 3);
    const partGeo = track(new THREE.BufferGeometry());
    const partAttr = new THREE.BufferAttribute(partPos, 3);
    const partColAttr = new THREE.BufferAttribute(partCol, 3);
    partGeo.setAttribute('position', partAttr);
    partGeo.setAttribute('color', partColAttr);
    const partMat = track(
      new THREE.PointsMaterial({
        size: 1.8,
        map: dotTex,
        vertexColors: true,
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
    let pLifeMax = 0.6;
    let pActive = 0;
    let pGround = 0; // y particles fall to (turf/water surface)

    // A quick dark divot mark on the ground that fades after a turf landing.
    const divotGeo = track(new THREE.CircleGeometry(1.5, 20));
    const divotMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x2f2416,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    const divotDecal = new THREE.Mesh(divotGeo, divotMat);
    divotDecal.rotation.x = -Math.PI / 2;
    divotDecal.visible = false;
    scene.add(divotDecal);
    let divotStart = -1;

    // Expanding concentric ripple rings on the water surface for a splash.
    const RIPPLES = 2;
    const rippleGeo = track(new THREE.RingGeometry(0.7, 1.0, 32));
    const rippleMeshes: THREE.Mesh[] = [];
    const rippleMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < RIPPLES; i++) {
      const m = track(
        new THREE.MeshBasicMaterial({
          color: 0xeaf7ff,
          transparent: true,
          opacity: 0,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      const mesh = new THREE.Mesh(rippleGeo, m);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      rippleMeshes.push(mesh);
      rippleMats.push(m);
    }
    let splashStart = -1;

    // Kick a low turf divot: a few short green/brown flecks + a fading mark.
    const spawnDivot = (x: number, z: number, island: boolean) => {
      const y = island ? ISLAND_TOP + 0.05 : 0.05;
      pActive = 14;
      pGround = y;
      pLifeMax = 0.55;
      partMat.size = 1.7;
      for (let i = 0; i < pActive; i++) {
        const j = i * 3;
        partPos[j] = x;
        partPos[j + 1] = y + 0.05;
        partPos[j + 2] = z;
        const ang = Math.random() * Math.PI * 2;
        const sp = 2.5 + Math.random() * 5;
        pVel[j] = Math.cos(ang) * sp;
        pVel[j + 1] = 3 + Math.random() * 6;
        pVel[j + 2] = Math.sin(ang) * sp;
        // Mix of grass-green flecks and darker soil-brown clumps.
        if (Math.random() < 0.55) {
          partCol[j] = 0.32 + Math.random() * 0.2;
          partCol[j + 1] = 0.55 + Math.random() * 0.2;
          partCol[j + 2] = 0.22;
        } else {
          partCol[j] = 0.36;
          partCol[j + 1] = 0.26;
          partCol[j + 2] = 0.15;
        }
      }
      pLife = pLifeMax;
      particles.visible = true;
      partAttr.needsUpdate = true;
      partColAttr.needsUpdate = true;
      // Divot mark on the ground.
      divotDecal.position.set(x, y + 0.01, z);
      divotDecal.scale.setScalar(0.8);
      divotDecal.visible = true;
      divotMat.opacity = 0.5;
      divotStart = performance.now();
    };

    // Kick a water splash: a white crown of droplets + expanding ripple rings.
    const spawnSplash = (x: number, z: number) => {
      pActive = 22;
      pGround = WATER_Y;
      pLifeMax = 0.7;
      partMat.size = 2.3;
      for (let i = 0; i < pActive; i++) {
        const j = i * 3;
        partPos[j] = x;
        partPos[j + 1] = WATER_Y + 0.2;
        partPos[j + 2] = z;
        const ang = Math.random() * Math.PI * 2;
        const sp = 2 + Math.random() * 5;
        pVel[j] = Math.cos(ang) * sp;
        pVel[j + 1] = 9 + Math.random() * 11;
        pVel[j + 2] = Math.sin(ang) * sp;
        const w = 0.85 + Math.random() * 0.15;
        partCol[j] = w;
        partCol[j + 1] = w;
        partCol[j + 2] = 1;
      }
      pLife = pLifeMax;
      particles.visible = true;
      partAttr.needsUpdate = true;
      partColAttr.needsUpdate = true;
      // Ripple rings.
      splashStart = performance.now();
      for (const m of rippleMeshes) {
        m.position.set(x, WATER_Y + 0.03, z);
        m.visible = true;
      }
    };

    // --- Pointer input (drag back to swing) ----------------------------
    let activePointer: number | null = null;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      // Ignore new drags while a shot is locked (accuracy phase) or in flight —
      // Step 2 is a tap on the DOM accuracy bar, not a canvas drag.
      if (pausedRef.current || activePointer != null || sim.ball.inFlight || sim.armed)
        return;
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
      // here (capture bypasses the pause sheet); don't lock a shot while paused.
      if (pausedRef.current) return;
      // Release LOCKS aim+power and enters the accuracy phase (does not launch);
      // a sub-min pull cancels back to the tee. RangeGame fires the armed shot.
      sim.arm(local(e));
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    // Full-power drag ≈ 17% of the canvas height (min 90px floor). On a phone a
    // natural thumb pull was only reaching ~60% power at the old 28%, so the
    // meter couldn't be maxed without dragging off the bottom edge; shortening
    // the full-power travel to ~60% of that (0.28→0.17) puts a genuine 100%
    // within an easy, comfortable pull. The ball sits low in the lower-middle of
    // the viewport, so this stays clear of the bottom edge.
    const applyPull = () => sim.setMaxPull(Math.max(90, h * 0.17));
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
          // A fresh shot un-sinks / restores the ball.
          sinking = false;
          ball.visible = true;
          ballMat.opacity = 1;
          ballMat.transparent = false;
        } else if (ev.type === 'land') {
          // First ground contact: a subtle turf divot on grass/island only
          // (water landings are handled by the splash below).
          if (ev.d != null && ev.x != null) {
            const surf = surfaceAt(ev.d, ev.x, layout, isChallenge);
            if (surf !== 'water' && surf !== 'fence') {
              spawnDivot(ev.x, -ev.d, surf === 'island');
            }
          }
        } else if (ev.type === 'splash') {
          if (ev.d != null && ev.x != null) {
            spawnSplash(ev.x, -ev.d);
            sinking = true;
            sinkStart = now;
          }
          revertAt = now + 1600;
        } else if (ev.type === 'rest') {
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

      // Re-teeing (new drag) restores a sunk ball.
      if (teed && sinking) {
        sinking = false;
        ballMat.opacity = 1;
        ballMat.transparent = false;
      }
      if (teed) ball.visible = true;

      // Ball spin: rotate the mesh to reflect motion. The rolling rate is
      // speed/radius; SPIN_VIS scales it down to a legible (non-strobing) rate.
      // Axis is (up × velocity) — the topspin/rolling sense. In flight the
      // player's back/top spin sets the SENSE (backspin → top toward the
      // player), on the ground it rolls forward with travel. Side spin adds a
      // small vertical-axis tilt. All via preallocated temporaries.
      if (b.inFlight || b.grounded) {
        const vx = b.vx;
        const vz = -b.vd; // scene z-velocity (Z = -d)
        const horiz = Math.hypot(vx, vz);
        if (horiz > 1e-3) {
          const speed = b.grounded ? horiz : Math.hypot(vx, b.vh, b.vd);
          const rate = (speed / BALL_R) * SPIN_VIS;
          // up × V = (vz, 0, -vx), normalized → pitch axis.
          const ax = vz / horiz;
          const az = -vx / horiz;
          // Sense: on the ground roll forward (topspin look); in flight a slight
          // default backspin plus the applied spinBack (back → top backward).
          const sense = b.grounded ? 1 : -(0.4 + sim.spinBack);
          const pitch = rate * sense;
          // Use the launch (net) side-spin so a hook/slice from an accuracy miss
          // is reflected in the ball's visible yaw, not just the player's puck.
          const yaw = b.grounded ? 0 : sim.launchSpinSide * rate * 0.35;
          spinAxis.set(ax * pitch, yaw, az * pitch);
          const angVel = spinAxis.length();
          if (angVel > 1e-4) {
            const ang = Math.min(angVel * dt, 0.5); // clamp per-frame to avoid strobing
            spinAxis.multiplyScalar(1 / angVel);
            spinQuat.setFromAxisAngle(spinAxis, ang);
            ball.quaternion.premultiply(spinQuat);
          }
        }
      }

      // Water sink: drop the ball below the surface and fade it out.
      if (sinking) {
        const st = (now - sinkStart) / 1400;
        if (st >= 1) {
          ball.visible = false;
        } else {
          ballMat.transparent = true;
          ball.position.y = WATER_Y - st * 2.4 * BALL_R;
          ballMat.opacity = Math.max(0, 1 - st * 1.3);
        }
      }

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

      // Predicted trajectory: shown while actively setting up a shot at the tee
      // (dragging back, or the locked accuracy phase). Recomputed only when the
      // inputs (club/power/aim/spin) change, so the 4 sim.predict() probes run
      // on input change, never every frame.
      const setup = teed && (sim.aiming || sim.armed || sim.power > 0.01);
      predGroup.visible = setup;
      if (setup) {
        const sig =
          sim.activeClubId +
          '|' +
          Math.round(sim.power * 50) +
          '|' +
          Math.round(sim.aimRad * 200) +
          '|' +
          Math.round(sim.spinBack * 20) +
          '|' +
          Math.round(sim.spinSide * 20);
        if (sig !== predSig) {
          predSig = sig;
          updatePrediction();
        }
      } else {
        predSig = '';
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

      // Particle integration (divot flecks / splash droplets).
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
            partPos[j + 1] = Math.max(pGround, (partPos[j + 1] ?? 0) + vy * dt);
            partPos[j + 2] = (partPos[j + 2] ?? 0) + (pVel[j + 2] ?? 0) * dt;
          }
          partMat.opacity = Math.max(0, pLife / pLifeMax);
          partAttr.needsUpdate = true;
        }
      }

      // Divot mark fade.
      if (divotStart >= 0) {
        const e = (now - divotStart) / 800;
        if (e >= 1) {
          divotDecal.visible = false;
          divotStart = -1;
        } else {
          divotMat.opacity = 0.5 * (1 - e);
          divotDecal.scale.setScalar(0.8 + e * 0.5);
        }
      }

      // Splash ripple rings: staggered expand + fade on the water surface.
      if (splashStart >= 0) {
        const elapsed = (now - splashStart) / 1000;
        let anyLive = false;
        for (let i = 0; i < rippleMeshes.length; i++) {
          const p = (elapsed - i * 0.22) / 1.0;
          const m = rippleMeshes[i]!;
          if (p < 0 || p >= 1) {
            m.visible = false;
            if (p < 1) anyLive = true;
            continue;
          }
          anyLive = true;
          m.visible = true;
          m.scale.setScalar(1 + p * 7);
          rippleMats[i]!.opacity = (1 - p) * 0.6;
        }
        if (!anyLive) splashStart = -1;
      }

      // Gentle flag sway.
      const t = now / 1000;
      for (let i = 0; i < flagCloths.length; i++) {
        const f = flagCloths[i]!;
        f.mesh.rotation.z = Math.sin(t * 2 + i) * 0.12;
        f.mesh.position.x = f.base + Math.sin(t * 3 + i) * 0.12;
      }
      // Water: scroll the colour map and the ripple normal map in different
      // directions so the surface visibly moves and the sun glint shimmers.
      waterTex.offset.y = (t * 0.03) % 1;
      waterNorm.offset.x = (t * 0.035) % 1;
      waterNorm.offset.y = (t * 0.06) % 1;

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
