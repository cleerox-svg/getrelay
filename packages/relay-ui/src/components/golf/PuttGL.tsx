import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PuttSim } from '../../lib/golf/puttSim';
import type { Green, Hole, PuttEvent, Wall } from '../../lib/golf/puttSim';
import { puttHeightAt } from '../../lib/golf/puttField';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import {
  addSkyDome,
  makeTurfColor,
  makeTurfNormalMap,
  makeWater,
  SURFACE_RGB,
  TURF_NORMAL_SCALE,
  TURF_ROUGHNESS,
  type WaterKit,
} from '../../lib/golf/scenery';
import { FIXED_MS } from '../../lib/golf/tuning';

// Real-time 3D mini-golf (Three.js). Owns the WebGL renderer, scene and
// camera; drives the headless PuttSim on a fixed-timestep loop; renders the
// hole laid flat on the ground plane.
//
// SEE-WHAT-YOU-PLAY: the green is a DISPLACED BufferGeometry whose vertices
// sample puttHeightAt(hole, x, y) — the SAME field the sim breaks/runs the putt
// on — so tilt planes, ramps (their riseHeight) and undulation are VISIBLE (the
// sun rakes the real slopes) and match physics exactly. The ball rides that
// surface (its Y = puttHeightAt + BALL_R). Ramps therefore need no separate mesh
// — the displacement already raises the turf. Banked rails (Wall.bank) get a
// distinct amber rail leaned toward the board centre so the player can read the
// bank line; plain walls stay white barriers. Hazards (Phase-2 data today) draw
// with the shared scenery water/sand kit for parity with Course.
//
// Mirrors RangeGL/CourseGL discipline: DPR<=2, one shadow-casting light
// (map <=1024) + a hemisphere fill, a fixed-timestep substep loop that pauses on
// `paused`/document.hidden, no per-frame allocations in the loop, and full GPU
// teardown (dispose every tracked resource + renderer.forceContextLoss()) on
// unmount. The HUD (hole/par/strokes) is DOM, drawn by GolfGame OVER this canvas.
//
// Coordinate mapping: holes are authored in a 100x125 virtual TOP-DOWN space
// (x right, y down). We lay it flat: world X = x - CX, world Z = y - CZ, Y up
// (the displacement). CX/CZ are the play-area CENTRE (derived from the hole's
// greens/walls/tee/cup) so the laid-flat hole is centred on the world origin and
// the camera frame is model-driven. Being a pure XZ translation, virtual
// directions map straight to world directions, so the pointer->ground raycast
// feeds PuttSim exact aim.

const FIXED_S = FIXED_MS / 1000;
const MAX_SUBSTEPS = 5;
const BALL_R = 1.6;

// Wall extrusion.
const WALL_H = 3;
const WALL_T = 2.2;
// A banked rail leans this far (rad) toward the board centre so its bank line
// reads from the angled camera. Purely visual — the collider is the same segment.
const BANK_LEAN = 0.34;

// Base camera offset (world units) from the look target, tuned for a full 100x125
// board (its play-area diagonal ~= REF_DIAG). Scaled by the actual hole's
// diagonal so a smaller hole zooms in — the frame is derived from the hole.
const CAM_OFFSET = new THREE.Vector3(0, 158, 116);
const REF_DIAG = Math.hypot(84, 109);

interface Props {
  sim: PuttSim;
  hole: Hole;
  paused?: boolean;
  onEvent?: (e: PuttEvent) => void;
}

// --- Procedural canvas textures (no binary assets) ------------------------

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

function makeSandTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d')!;
  const [r, gg, b] = SURFACE_RGB.bunker;
  g.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(gg * 255)},${Math.round(b * 255)})`;
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 2200; i++) {
    const light = Math.random() < 0.5;
    g.fillStyle = light ? `rgba(255,255,255,${Math.random() * 0.06})` : `rgba(120,90,50,${Math.random() * 0.08})`;
    g.fillRect(Math.random() * c.width, Math.random() * c.height, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
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

// Point-in-rounded-rect for a green footprint (matches the builder's ptOnGreen
// and the validator), so the drawn green, the played surface and the validated
// surface are one shape.
function inRoundRect(g: Green, x: number, y: number): boolean {
  if (x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return false;
  const r = Math.min(g.r, g.w / 2, g.h / 2);
  if (r <= 0) return true;
  const cx = x < g.x + r ? g.x + r : x > g.x + g.w - r ? g.x + g.w - r : x;
  const cy = y < g.y + r ? g.y + r : y > g.y + g.h - r ? g.y + g.h - r : y;
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r;
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

    // --- Play-area bounds (virtual) → centre for the flat-lay + camera frame --
    // Union of the greens, extra walls, tee and cup so the frame fits whatever a
    // hole spells out (mirrors CourseGL deriving its frame from the model).
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (const gr of hole.greens) {
      grow(gr.x, gr.y);
      grow(gr.x + gr.w, gr.y + gr.h);
    }
    for (const wl of hole.walls) {
      grow(wl.a.x, wl.a.y);
      grow(wl.b.x, wl.b.y);
    }
    grow(hole.tee.x, hole.tee.y);
    grow(hole.cup.c.x, hole.cup.c.y);
    const CX = (minX + maxX) / 2;
    const CZ = (minY + maxY) / 2;
    const wx = (vx: number): number => vx - CX;
    const wz = (vy: number): number => vy - CZ;
    const heightAtV = (vx: number, vy: number): number => puttHeightAt(hole, vx, vy);

    // --- Renderer / scene / camera --------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    let w = host.clientWidth || window.innerWidth;
    let h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    // Shared cloud/hill sky dome (deterministic, seeded) — parity with the other
    // golf scenes and reproducible for the screenshot harness.
    addSkyDome(scene, track);

    // Angled overhead camera framing the WHOLE hole from the model: the tee (high
    // virtual y) sits toward +Z near the camera, the cup (low y) toward -Z far, so
    // the player can aim in any direction. Distance derived from the hole diagonal.
    const spanX = maxX - minX;
    const spanY = maxY - minY;
    const frameScale = Math.hypot(spanX, spanY) / REF_DIAG || 1;
    const camera = new THREE.PerspectiveCamera(54, w / h, 1, 1600);
    const lookTarget = new THREE.Vector3(0, 0, 0);
    camera.position.set(
      CAM_OFFSET.x * frameScale,
      CAM_OFFSET.y * frameScale,
      CAM_OFFSET.z * frameScale,
    );
    camera.lookAt(lookTarget);

    // --- Lights (range budget: one shadow light + a hemi fill) ----------
    const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a7a3a, 0.95);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.set(-70, 150, 60);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 40;
    sun.shadow.camera.far = 380;
    const shadowHalf = Math.max(70, Math.max(spanX, spanY) * 0.62);
    sun.shadow.camera.left = -shadowHalf;
    sun.shadow.camera.right = shadowHalf;
    sun.shadow.camera.top = shadowHalf;
    sun.shadow.camera.bottom = -shadowHalf;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.05;
    sun.target.position.set(0, 0, 0);
    scene.add(sun);
    scene.add(sun.target);

    // --- Displaced green (the mown putting surface = the physics field) --
    // One shared turf colour + blade-normal from the scene kit; each green clones
    // the colour for its own stripe repeat (each disposes its own GPU upload).
    const turfColor = track(makeTurfColor());
    const turfNormal = track(makeTurfNormalMap());
    let fieldMin = Infinity;
    for (const gr of hole.greens) {
      // Grid over the green rect, displaced by puttHeightAt so slopes/ramps show.
      const step = 2.4; // virtual units per cell — fine enough to read a ramp edge
      const nxi = Math.max(2, Math.ceil(gr.w / step));
      const nyi = Math.max(2, Math.ceil(gr.h / step));
      const cols = nxi + 1;
      const verts = new Float32Array((nyi + 1) * cols * 3);
      const uvs = new Float32Array((nyi + 1) * cols * 2);
      const px = (i: number) => gr.x + (i / nxi) * gr.w;
      const py = (j: number) => gr.y + (j / nyi) * gr.h;
      let vi = 0;
      let ui = 0;
      for (let j = 0; j <= nyi; j++) {
        for (let i = 0; i <= nxi; i++) {
          const vxx = px(i);
          const vyy = py(j);
          const yy = heightAtV(vxx, vyy);
          if (yy < fieldMin) fieldMin = yy;
          verts[vi] = wx(vxx);
          verts[vi + 1] = yy;
          verts[vi + 2] = wz(vyy);
          uvs[ui] = i / nxi;
          uvs[ui + 1] = j / nyi;
          vi += 3;
          ui += 2;
        }
      }
      // Cup aperture: drop the few triangles over the hole so the recessed liner
      // shows (the grid is coarse vs the small cup, so open a touch past the rim).
      const apR = hole.cup.r * 1.35;
      const cvx = hole.cup.c.x;
      const cvy = hole.cup.c.y;
      const keep = (
        ia: number, ja: number, ib: number, jb: number, ic: number, jc: number,
      ): boolean => {
        const ax = px(ia), ay = py(ja);
        const bx = px(ib), by = py(jb);
        const ccx = px(ic), ccy = py(jc);
        const mx = (ax + bx + ccx) / 3;
        const my = (ay + by + ccy) / 3;
        if (!inRoundRect(gr, mx, my)) return false; // rounded footprint
        if (Math.hypot(mx - cvx, my - cvy) < apR) return false; // cup aperture
        return true;
      };
      // Wind so the top surface FRONT-faces up (world Z grows with j; +Y normal
      // needs the (a, a+cols, a+1) order — a downward winding would be back-face
      // culled and the green would vanish; see CourseGL's terrain gotcha).
      const idx: number[] = [];
      for (let j = 0; j < nyi; j++) {
        for (let i = 0; i < nxi; i++) {
          const a = j * cols + i;
          if (keep(i, j, i, j + 1, i + 1, j)) idx.push(a, a + cols, a + 1);
          if (keep(i + 1, j, i, j + 1, i + 1, j + 1)) idx.push(a + 1, a + cols, a + cols + 1);
        }
      }
      const geo = track(new THREE.BufferGeometry());
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const col = track(turfColor.clone());
      col.wrapS = col.wrapT = THREE.RepeatWrapping;
      col.repeat.set(Math.max(2, Math.round(gr.w / 12)), Math.max(2, Math.round(gr.h / 12)));
      const nrm = track(turfNormal.clone());
      nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping;
      nrm.repeat.set(Math.max(3, Math.round(gr.w / 8)), Math.max(3, Math.round(gr.h / 8)));
      const mat = track(
        new THREE.MeshStandardMaterial({
          map: col,
          normalMap: nrm,
          normalScale: new THREE.Vector2(TURF_NORMAL_SCALE, TURF_NORMAL_SCALE),
          roughness: TURF_ROUGHNESS,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      scene.add(mesh);
    }
    if (!Number.isFinite(fieldMin)) fieldMin = 0;

    // --- Rough base (backdrop; sits below the green so it never pokes through) --
    const roughTex = track(makeRoughTexture());
    const roughGeo = track(new THREE.PlaneGeometry(700, 700));
    const roughMat = track(new THREE.MeshStandardMaterial({ map: roughTex, roughness: 1 }));
    const rough = new THREE.Mesh(roughGeo, roughMat);
    rough.rotation.x = -Math.PI / 2;
    rough.position.y = Math.min(0, fieldMin) - 2;
    rough.receiveShadow = true;
    scene.add(rough);

    // --- Hazards (water/sand) — data-only in Phase 1 but drawn for parity ----
    let waterKit: WaterKit | null = null;
    for (const hz of hole.hazards ?? []) {
      const r = hz.region;
      const rw = r.x1 - r.x0;
      const rh = r.y1 - r.y0;
      const cx = (r.x0 + r.x1) / 2;
      const cy = (r.y0 + r.y1) / 2;
      const y = heightAtV(cx, cy);
      const geo = track(new THREE.PlaneGeometry(rw, rh));
      let mat: THREE.Material;
      if (hz.kind === 'water') {
        if (!waterKit) waterKit = makeWater(track);
        mat = waterKit.material;
      } else {
        const sandTex = track(makeSandTexture());
        mat = track(new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 }));
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(wx(cx), y + 0.06, wz(cy));
      mesh.receiveShadow = hz.kind === 'sand';
      scene.add(mesh);
    }

    // --- Walls / obstacles (extruded barriers; banked rails distinct) --------
    const wallMat = track(new THREE.MeshStandardMaterial({ color: 0xe9edf0, roughness: 0.85 }));
    const capMat = track(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 }));
    // Banked rails read as a warm, leaned rail so the player can pick the bank line.
    const bankMat = track(new THREE.MeshStandardMaterial({ color: 0xf0a52e, roughness: 0.6 }));
    const bankCapMat = track(new THREE.MeshStandardMaterial({ color: 0xffcf6b, roughness: 0.4 }));
    const addWall = (wall: Wall) => {
      const ax = wall.a.x;
      const ay = wall.a.y;
      const bx = wall.b.x;
      const by = wall.b.y;
      const dx = bx - ax;
      const dz = by - ay;
      const L = Math.hypot(dx, dz);
      if (L < 1e-3) return;
      const angle = Math.atan2(-dz, dx);
      const midVX = (ax + bx) / 2;
      const midVY = (ay + by) / 2;
      const baseY = heightAtV(midVX, midVY);
      const banked = wall.bank === true;
      // A group carries the yaw; the box leans about its length axis (local X) for
      // a banked rail. Lean toward the board centre so the bank faces the play.
      const group = new THREE.Group();
      group.position.set(wx(midVX), baseY, wz(midVY));
      group.rotation.y = angle;
      scene.add(group);
      let lean = 0;
      if (banked) {
        // World dir of the box's local +Z (thickness) after yaw = (sinθ, 0, cosθ).
        // Lean top toward the centre (inward): +rot.x tilts the top toward local +Z.
        const inwardX = CX - midVX;
        const inwardZ = CZ - midVY;
        const dotZ = Math.sin(angle) * inwardX + Math.cos(angle) * inwardZ;
        lean = dotZ >= 0 ? BANK_LEAN : -BANK_LEAN;
      }
      const wallH = banked ? WALL_H * 1.35 : WALL_H;
      const boxGeo = track(new THREE.BoxGeometry(L + WALL_T, wallH, WALL_T));
      const box = new THREE.Mesh(boxGeo, banked ? bankMat : wallMat);
      box.position.y = wallH / 2;
      box.rotation.x = lean;
      box.castShadow = true;
      box.receiveShadow = true;
      group.add(box);
      const capGeo = track(new THREE.BoxGeometry(L + WALL_T, 0.5, WALL_T * (banked ? 1.15 : 1.02)));
      const cap = new THREE.Mesh(capGeo, banked ? bankCapMat : capMat);
      cap.position.y = wallH + 0.1;
      cap.rotation.x = lean;
      group.add(cap);
    };
    for (const wall of hole.walls) addWall(wall);

    // --- Cup (recessed at its terrain height) + flag --------------------
    const cupX = wx(hole.cup.c.x);
    const cupZ = wz(hole.cup.c.y);
    const cupTopY = heightAtV(hole.cup.c.x, hole.cup.c.y);
    const cupR = hole.cup.r;
    const holeMat = track(new THREE.MeshStandardMaterial({ color: 0x14201a, roughness: 1 }));
    const cupGeo = track(new THREE.CylinderGeometry(cupR, cupR, 3, 24, 1, true));
    const cupWall = new THREE.Mesh(cupGeo, holeMat);
    cupWall.position.set(cupX, cupTopY - 1.5, cupZ);
    scene.add(cupWall);
    const cupFloorGeo = track(new THREE.CircleGeometry(cupR, 24));
    const cupFloor = new THREE.Mesh(cupFloorGeo, holeMat);
    cupFloor.rotation.x = -Math.PI / 2;
    cupFloor.position.set(cupX, cupTopY - 3, cupZ);
    scene.add(cupFloor);
    const rimGeo = track(new THREE.RingGeometry(cupR, cupR + 0.5, 24));
    const rimMat = track(new THREE.MeshBasicMaterial({ color: 0x0b1410, side: THREE.DoubleSide }));
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = -Math.PI / 2;
    rim.position.set(cupX, cupTopY + 0.05, cupZ);
    scene.add(rim);

    // Flag: pole + accent cloth.
    const poleH = 15;
    const poleGeo = track(new THREE.CylinderGeometry(0.28, 0.28, poleH, 8));
    const poleMat = track(new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.6 }));
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(cupX, cupTopY + poleH / 2, cupZ);
    pole.castShadow = true;
    scene.add(pole);
    const flagGeo = track(new THREE.PlaneGeometry(7, 4));
    const flagMat = track(
      new THREE.MeshStandardMaterial({ color: 0xe23b3b, roughness: 0.7, side: THREE.DoubleSide }),
    );
    const flag = new THREE.Mesh(flagGeo, flagMat);
    const flagBaseX = cupX + 3.5;
    const flagY = cupTopY + poleH - 2.4;
    flag.position.set(flagBaseX, flagY, cupZ);
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
    const spawnBurst = (x: number, yBase: number, z: number, color: number) => {
      partMat.color.setHex(color);
      pActive = PMAX;
      for (let i = 0; i < PMAX; i++) {
        partPos[i * 3] = x;
        partPos[i * 3 + 1] = yBase + 1;
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
    // Raycast against a flat plane at the ball's CURRENT height so the aim point
    // is faithful on a sloped/ramped lie (the field is shallow vs the board, so a
    // horizontal plane at the ball's height is an exact enough inverse).
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ndc = new THREE.Vector2();
    const hitPoint = new THREE.Vector3();
    const ballProj = new THREE.Vector3();

    const pointerToVirtual = (px: number, py: number): { x: number; y: number } | null => {
      groundPlane.constant = -(heightAtV(sim.ball.pos.x, sim.ball.pos.y));
      ndc.set((px / w) * 2 - 1, -(py / h) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.ray.intersectPlane(groundPlane, hitPoint);
      if (!hit) return null;
      return { x: hitPoint.x + CX, y: hitPoint.z + CZ };
    };
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
    let sinkY = cupTopY + BALL_R;

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
          spawnBurst(cupX, cupTopY, cupZ, 0xffe27a);
        }
        onEventRef.current?.(ev);
      }

      // Ball transform — rides the displaced surface (Y = puttHeightAt + BALL_R).
      // On sink, drop it into the cup.
      const b = sim.ball;
      if (sunk) {
        sinkY = Math.max(cupTopY - 2.4, sinkY - dt * 22);
        ball.position.set(cupX, sinkY, cupZ);
      } else {
        ball.position.set(wx(b.pos.x), heightAtV(b.pos.x, b.pos.y) + BALL_R, wz(b.pos.y));
      }

      // Aim overlay while dragging — lifted just above the sloped turf.
      const st = sim.getState();
      if (st.aiming && st.power > 0.001) {
        const reach = 4 + st.power * 34;
        const tvx = b.pos.x + st.aimX * reach;
        const tvy = b.pos.y + st.aimY * reach;
        aimPos[0] = wx(b.pos.x);
        aimPos[1] = heightAtV(b.pos.x, b.pos.y) + 1.2;
        aimPos[2] = wz(b.pos.y);
        aimPos[3] = wx(tvx);
        aimPos[4] = heightAtV(tvx, tvy) + 1.2;
        aimPos[5] = wz(tvy);
        aimAttr.needsUpdate = true;
        aimLine.computeLineDistances();
        aimCol.copy(aimColLow).lerp(aimColHigh, st.power);
        aimMat.color.copy(aimCol);
        tipMat.color.copy(aimCol);
        tip.position.set(aimPos[3]!, aimPos[4]!, aimPos[5]!);
        aimLine.visible = true;
        tip.visible = true;
      } else {
        aimLine.visible = false;
        tip.visible = false;
      }

      // Flag sway + water shimmer.
      const t = now / 1000;
      flag.rotation.z = Math.sin(t * 2) * 0.12;
      flag.position.x = flagBaseX + Math.sin(t * 3) * 0.2;
      if (waterKit) waterKit.update(t);

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
            partPos[j + 1] = (partPos[j + 1] ?? 0) + vy * dt;
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
