import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { PuttSim } from '../../lib/golf/puttSim';
import type { Green, Hole, PuttEvent, Wall } from '../../lib/golf/puttSim';
import {
  windmillBladeAngle,
  pendulumAngle,
  mouthNormal,
  type TunnelMouth,
} from '../../lib/golf/puttObstacles';
import { puttHeightAt, puttGradientAt } from '../../lib/golf/puttField';
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
import { FIXED_MS, MAX_LAUNCH_SPEED } from '../../lib/golf/tuning';
import { play, unlockAudio } from '../../lib/audio';

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

    // Largest distance the aim indicator may reach from (vx,vy) along a UNIT
    // direction (ax,ay) before it leaves the playfield — a ray/box exit against
    // the play bounds inset by a rail margin. Keeps the full-power aim tip on the
    // board instead of out over the dark rough surround (cosmetic; the shot power
    // mapping is untouched — see the aim overlay below).
    const AIM_MARGIN = 4;
    const reachToBounds = (vx: number, vy: number, ax: number, ay: number): number => {
      let t = Infinity;
      if (ax > 1e-6) t = Math.min(t, (maxX - AIM_MARGIN - vx) / ax);
      else if (ax < -1e-6) t = Math.min(t, (minX + AIM_MARGIN - vx) / ax);
      if (ay > 1e-6) t = Math.min(t, (maxY - AIM_MARGIN - vy) / ay);
      else if (ay < -1e-6) t = Math.min(t, (minY + AIM_MARGIN - vy) / ay);
      return Math.max(0, t === Infinity ? 0 : t);
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
      let gMax = -Infinity;
      for (let j = 0; j <= nyi; j++) {
        for (let i = 0; i <= nxi; i++) {
          const vxx = px(i);
          const vyy = py(j);
          const yy = heightAtV(vxx, vyy);
          if (yy < fieldMin) fieldMin = yy;
          if (yy > gMax) gMax = yy;
          verts[vi] = wx(vxx);
          verts[vi + 1] = yy;
          verts[vi + 2] = wz(vyy);
          uvs[ui] = i / nxi;
          uvs[ui + 1] = j / nyi;
          vi += 3;
          ui += 2;
        }
      }
      // Contour SHADING (slope-read aid #1): darken the green by how far each
      // vertex sits BELOW this green's high point — a subtle elevation gradient
      // that MULTIPLIES the striped turf so a sub-3° tilt the angled camera
      // otherwise swallows reads as shading, not just silhouette. Keyed straight
      // to puttHeightAt (the field the sim breaks on), scaled by ABSOLUTE height
      // delta so a gentle slope shades less than a steep one and a flat green
      // (delta 0) stays uniform — no clutter. Floor at 0.7 so it never muddies.
      const shade = new Float32Array((nyi + 1) * cols * 3);
      for (let k = 0; k < shade.length / 3; k++) {
        const f = Math.max(0.7, 1 - 0.06 * (gMax - (verts[k * 3 + 1] ?? gMax)));
        shade[k * 3] = f;
        shade[k * 3 + 1] = f;
        shade[k * 3 + 2] = f;
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
      geo.setAttribute('color', new THREE.BufferAttribute(shade, 3));
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
          vertexColors: true,
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

    // --- Slope-read aid #2: downhill fall-line arrows -------------------------
    // Flat triangular chevrons laid on the green, each pointing DOWNHILL — the
    // direction the ball will break — so a pure 3–5% tilt (a sub-3° macro slope
    // the striped turf + angled camera swallow) is legible as a directional cue.
    // Derived straight from the physics field: puttGradientAt() is the local
    // uphill slope vector, so downhill = -gradient (exactly the sense of
    // puttSlopeAccel = -g·gradient the sim adds each substep). The arrow LENGTH
    // and its cool→warm colour scale with the local GRADE, and anything below
    // ~1.3% is skipped — so a flat green shows nothing and a steep break pops.
    {
      // Sparser + lighter than Phase 1 (folds the visual-QA arrow-density nit):
      // a wider sample grid, a higher draw threshold and lower opacity so a
      // uniform-grade green shows a READABLE-but-light field instead of a full
      // edge-to-edge cover that dominates the turf. The physics-derived direction
      // (downhill = -gradient) and cool→warm grade colour mapping are unchanged.
      const ARROW_STEP = 17; // virtual units between samples (was 11 — sparser)
      const MIN_GRADE = 0.02; // ~2% grade — below this we skip (was 1.3%)
      const HOT_GRADE = 0.06; // grade at which the arrow is fully "warm"
      const gcLo = new THREE.Color(0xdaf0ff); // gentle: pale cool
      const gcHi = new THREE.Color(0xffb347); // steep: warm amber (bank-rail hue)
      const gc = new THREE.Color();
      const aPos: number[] = [];
      const aCol: number[] = [];
      const aIdx: number[] = [];
      const pushV = (vx: number, vy: number) => {
        aPos.push(wx(vx), heightAtV(vx, vy) + 0.5, wz(vy));
      };
      for (const gr of hole.greens) {
        for (let vy = gr.y + ARROW_STEP / 2; vy < gr.y + gr.h; vy += ARROW_STEP) {
          for (let vx = gr.x + ARROW_STEP / 2; vx < gr.x + gr.w; vx += ARROW_STEP) {
            if (!inRoundRect(gr, vx, vy)) continue;
            // Keep clear of the cup aperture so an arrow never sits in the hole.
            if (Math.hypot(vx - hole.cup.c.x, vy - hole.cup.c.y) < hole.cup.r * 2.2) continue;
            const { gx, gy } = puttGradientAt(hole, vx, vy);
            const grade = Math.hypot(gx, gy);
            if (grade < MIN_GRADE) continue;
            const inv = 1 / grade;
            const dx = -gx * inv; // downhill unit direction (world XZ == virtual)
            const dy = -gy * inv;
            const px = -dy; // in-plane perpendicular (unit)
            const py = dx;
            const L = 4 + Math.min(grade, 0.08) * 90; // ~5 (gentle) → ~11 (steep)
            const W = L * 0.4;
            const base = aPos.length / 3;
            pushV(vx + dx * L * 0.6, vy + dy * L * 0.6); // tip (downhill)
            pushV(vx - dx * L * 0.4 + px * W, vy - dy * L * 0.4 + py * W); // back L
            pushV(vx - dx * L * 0.4 - px * W, vy - dy * L * 0.4 - py * W); // back R
            gc.copy(gcLo).lerp(gcHi, Math.min(1, (grade - MIN_GRADE) / (HOT_GRADE - MIN_GRADE)));
            for (let k = 0; k < 3; k++) aCol.push(gc.r, gc.g, gc.b);
            aIdx.push(base, base + 1, base + 2);
          }
        }
      }
      if (aIdx.length) {
        const aGeo = track(new THREE.BufferGeometry());
        aGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(aPos), 3));
        aGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(aCol), 3));
        aGeo.setIndex(aIdx);
        const aMat = track(
          new THREE.MeshBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.5,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        const arrows = new THREE.Mesh(aGeo, aMat);
        arrows.frustumCulled = false;
        scene.add(arrows);
      }
    }

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

    // --- Moving obstacles (windmills / swinging gates / portal tunnels) ------
    // Meshes are built ONCE here; only their transform is updated per frame, and
    // ALWAYS from the sim's deterministic simTime via the SAME puttObstacles
    // helpers the physics uses (windmillBladeAngle / pendulumAngle / mouthNormal)
    // — never a private wall-clock — so what you SEE is exactly what the ball
    // collides with. No per-frame allocation (transforms only). Blades/arms sweep
    // in the board plane (horizontal, rotating about world +Y), matching their
    // physics colliders (segments through the pivot in the flat board), so they
    // ride just above the ball. A little tower/roof (windmill) or post (pendulum)
    // adds the classic mini-put read without changing the collider.
    const spinUpdaters: ((t: number) => void)[] = [];
    const obstacles = hole.obstacles ?? [];
    if (obstacles.length) {
      const BLADE_Y = BALL_R + 1.6; // sweep height — just over the ball
      const towerMat = track(new THREE.MeshStandardMaterial({ color: 0xf3ede2, roughness: 0.85 }));
      const roofMat = track(new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 }));
      const bladeMat = track(new THREE.MeshStandardMaterial({ color: 0xfbfbf7, roughness: 0.55 }));
      const hubMat = track(new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 }));
      const armMat = track(new THREE.MeshStandardMaterial({ color: 0xb5732e, roughness: 0.7 }));
      const holeDiscMat = track(new THREE.MeshBasicMaterial({ color: 0x0b0d12, side: THREE.DoubleSide }));
      // Barrel-mouth hues, cycled per tunnel so the two mouths of ONE tunnel share
      // a colour and read as connected ent/exit.
      const TUNNEL_COLORS = [0x9c6b3f, 0x2e8b6b, 0x8455a8];
      let tunnelIdx = 0;

      for (const ob of obstacles) {
        if (ob.kind === 'windmill') {
          const baseY = heightAtV(ob.pivot.x, ob.pivot.y);
          const px = wx(ob.pivot.x);
          const pz = wz(ob.pivot.y);
          // Iconic mill silhouette (flavour; the sweeping blades are the actual
          // collider). Three stacked pieces STRADDLE the horizontal blade band so
          // the rotor never clips the tower: a tapered mill HOUSE that stops just
          // UNDER the blades (houseTop < blade bottom), a slim axle HUB at blade
          // height (inside the rotor), and a tall peaked red CAP that starts just
          // ABOVE the blades — a proper little windmill under the sails instead of
          // the old stub-that-pokes-through-the-blades.
          //
          // The sails ride a touch higher than the general BLADE_Y (still "just
          // over the ball", ball top ≈ BALL_R·2) so a readable house fits beneath
          // — the blade sweep is purely cosmetic (the collider is a 2-D board
          // segment; only windmillBladeAngle's yaw is authoritative), so lifting
          // the mesh doesn't change physics. The lane under the mill stays clear.
          const millY = BALL_R + 3.4; // ~1 unit over the ball top; house has room
          const houseTop = millY - 0.9; // stops below the blade box (millY-0.7)
          const houseGeo = track(new THREE.CylinderGeometry(3.6, 5.2, houseTop, 14));
          const house = new THREE.Mesh(houseGeo, towerMat);
          house.position.set(px, baseY + houseTop / 2, pz);
          house.castShadow = true;
          house.receiveShadow = true;
          scene.add(house);
          const capBase = millY + 0.9; // starts above the blade box (millY+0.7)
          const capH = 7.5;
          const roofGeo = track(new THREE.ConeGeometry(4, capH, 14));
          const roof = new THREE.Mesh(roofGeo, roofMat);
          roof.position.set(px, baseY + capBase + capH / 2, pz);
          roof.castShadow = true;
          scene.add(roof);
          // Sweeping blades just over the lane. Each blade i is baked at local yaw
          // -(i·2π/n) with a box offset +bladeLen/2 along its arm; the group yaw
          // carries the time-varying phase, so blade i's world bearing equals
          // windmillBladeAngle(ob, t, i) exactly (board angle = -three yaw).
          const spin = new THREE.Group();
          spin.position.set(px, baseY + millY, pz);
          // Slim axle hub bridging the house→cap gap; narrower than either so the
          // blades read cleanly past it (its inner ends hide inside the hub).
          const hubGeo = track(new THREE.CylinderGeometry(1.9, 1.9, 2, 12));
          spin.add(new THREE.Mesh(hubGeo, hubMat));
          const bladeGeo = track(new THREE.BoxGeometry(ob.bladeLen, 1.4, 2.6));
          for (let i = 0; i < ob.bladeCount; i++) {
            const bg = new THREE.Group();
            bg.rotation.y = -(i * 2 * Math.PI) / ob.bladeCount;
            const box = new THREE.Mesh(bladeGeo, bladeMat);
            box.position.x = ob.bladeLen / 2;
            box.castShadow = true;
            bg.add(box);
            spin.add(bg);
          }
          scene.add(spin);
          spinUpdaters.push((t) => {
            spin.rotation.y = -windmillBladeAngle(ob, t, 0);
          });
        } else if (ob.kind === 'pendulum') {
          const baseY = heightAtV(ob.pivot.x, ob.pivot.y);
          const postH = BLADE_Y + 4;
          const postGeo = track(new THREE.CylinderGeometry(1.4, 1.8, postH, 10));
          const post = new THREE.Mesh(postGeo, towerMat);
          post.position.set(wx(ob.pivot.x), baseY + postH / 2, wz(ob.pivot.y));
          post.castShadow = true;
          scene.add(post);
          const swing = new THREE.Group();
          swing.position.set(wx(ob.pivot.x), baseY + BLADE_Y, wz(ob.pivot.y));
          const armGeo = track(new THREE.BoxGeometry(ob.length, 1.8, 2.2));
          const addArm = (flip: boolean) => {
            const bg = new THREE.Group();
            if (flip) bg.rotation.y = Math.PI; // opposed arm for a `gate`
            const box = new THREE.Mesh(armGeo, armMat);
            box.position.x = ob.length / 2;
            box.castShadow = true;
            bg.add(box);
            swing.add(bg);
          };
          addArm(false);
          if (ob.gate) addArm(true);
          scene.add(swing);
          spinUpdaters.push((t) => {
            swing.rotation.y = -pendulumAngle(ob, t);
          });
        } else {
          // Tunnel: each mouth is a short forward-facing BARREL (an open pipe)
          // whose bore points along mouthNormal — the SAME outward direction the
          // sim maps the crossing to — so an opening you putt INTO reads clearly
          // (the old flat torus+disc faced the camera and looked like a ground
          // PIT). Both mouths of one tunnel share a colour so the pair reads as
          // one connected ent/exit.
          const color = TUNNEL_COLORS[tunnelIdx % TUNNEL_COLORS.length]!;
          tunnelIdx++;
          const barrelMat = track(
            new THREE.MeshStandardMaterial({ color, roughness: 0.75, side: THREE.DoubleSide }),
          );
          const lipMat = track(new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
          const drawMouth = (m: TunnelMouth) => {
            const mx = (m.a.x + m.b.x) / 2;
            const my = (m.a.y + m.b.y) / 2;
            const half = Math.hypot(m.b.x - m.a.x, m.b.y - m.a.y) / 2;
            const n = mouthNormal(m);
            const yaw = Math.atan2(n.x, n.y); // group local +Z → outward normal
            const gy = heightAtV(mx, my);
            const depth = Math.max(6, half * 1.6); // pipe length behind the opening
            // A group carries the yaw so local +Z is the OUTWARD bore direction;
            // raise it by the bore radius so the barrel sits ON the turf. The body
            // extends BACK (−Z, into the mound); the rim opens flush at the front.
            const g = new THREE.Group();
            g.position.set(wx(mx), gy + half, wz(my));
            g.rotation.y = yaw;
            scene.add(g);
            // Barrel wall — an open cylinder whose axis is the bore (+Y → +Z).
            const wallGeo = track(new THREE.CylinderGeometry(half, half, depth, 24, 1, true));
            const wall = new THREE.Mesh(wallGeo, barrelMat);
            wall.rotation.x = Math.PI / 2;
            wall.position.z = -depth / 2; // front rim at the mouth, body recedes
            wall.castShadow = true;
            wall.receiveShadow = true;
            g.add(wall);
            // Front lip ring (torus plane ⟂ bore) so the opening reads as a pipe.
            const lipGeo = track(new THREE.TorusGeometry(half, Math.max(0.9, half * 0.16), 10, 24));
            const lip = new THREE.Mesh(lipGeo, lipMat);
            lip.castShadow = true;
            g.add(lip);
            // Dark cap deep in the bore so you look INTO darkness (reads as a hole
            // to putt into), facing outward toward the opening.
            const capGeo = track(new THREE.CircleGeometry(half * 0.96, 24));
            const cap = new THREE.Mesh(capGeo, holeDiscMat);
            cap.position.z = -depth + 0.2;
            g.add(cap);
          };
          drawMouth(ob.mouthA);
          drawMouth(ob.mouthB);
        }
      }
    }

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
      // First user gesture in the mode — unlock audio for the autoplay policy.
      unlockAudio();
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
    // Render-side rolling SFX: subtle, throttled ticks while the ball rolls. No
    // discrete sim event — read from the snapshot state we already render.
    let lastRollAt = 0;

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
          play('sink');
        } else if (ev.type === 'stroke') {
          // Putter contact, brightened by stroke power. Power is reset to 0 on
          // launch, so read it from the launch speed the sim set on the ball.
          const spd = Math.hypot(sim.ball.vel.x, sim.ball.vel.y);
          const p01 = Math.max(0, Math.min(1, spd / MAX_LAUNCH_SPEED));
          play('strike', { rate: 0.8 + 0.4 * p01, gain: 0.4 + 0.4 * p01 });
        } else if (ev.type === 'penalty') {
          play('penalty');
        } else if (ev.type === 'rest') {
          play('rest');
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
        // Rolling turf tick — throttled, gain/rate scale with roll speed. Render
        // layer only; the sim is untouched.
        if (!b.resting) {
          const spd = Math.hypot(b.vel.x, b.vel.y);
          if (spd > 4 && now - lastRollAt > 100) {
            lastRollAt = now;
            const s01 = Math.min(1, spd / MAX_LAUNCH_SPEED);
            play('roll', { gain: 0.05 + 0.12 * s01, rate: 0.9 + 0.4 * s01 });
          }
        }
      }

      // Aim overlay while dragging — lifted just above the sloped turf.
      const st = sim.getState();
      if (st.aiming && st.power > 0.001) {
        // Grows with power, but clamped so the dashed line + red tip stay on the
        // board (never out past the rail on the rough). Power→shot mapping is in
        // the sim and is NOT touched by this cosmetic cap.
        const reach = Math.min(4 + st.power * 34, reachToBounds(b.pos.x, b.pos.y, st.aimX, st.aimY));
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

      // Moving obstacles: drive every spinner/swing from the sim's DETERMINISTIC
      // simTime (never `now`) so the rendered blade/arm angle is byte-for-byte the
      // one the physics collided against this substep.
      for (let i = 0; i < spinUpdaters.length; i++) spinUpdaters[i]!(sim.simTime);

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
