import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { RangeSim } from '../../lib/golf/rangeSim';
import type { RangeEvent } from '../../lib/golf/rangeSim';
import { play, unlockAudio } from '../../lib/audio';
import { makeBallMaterial, makeDimpleNormalMap } from '../../lib/golf/ballTexture';
import { useGolfSkin, type GolfCosmetics } from './scene/skin';
import {
  addSkyDome,
  makeContactShadowTexture,
  makeFairwayTurf,
  makeFog,
  makeTurfNormalMap,
  GREEN_COLOR,
  TURF_NORMAL_SCALE,
  TURF_ROUGHNESS,
} from '../../lib/golf/scenery';
import {
  makeWater,
  makeWaterFX,
  makeWaterPlane,
  pickWaterQuality,
  readWaterQualityOverride,
} from '../../lib/golf/water';
import { mulberry32, windBearing, windMph } from '../../lib/golf/wind';
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
import { MAX_CLUB_SPEED } from '../../lib/golf/clubs';
import { FIXED_MS } from '../../lib/golf/tuning';
import { sceneNow, tickSceneClock } from '../../lib/scene3d/clock';
import {
  makeFrameProbe,
  sampleSceneStats,
  shouldSampleStats,
  type SceneStats,
} from '../../lib/scene3d/stats';
import { resolveGolfQuality } from './scene/quality';
import { attachSkyEnv, hemiFill } from './scene/env';
import { buildGrove, type TreePlacement } from './scene/foliage';

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
  // Equipped ball skin + tracer colour (golf economy). Read once at scene
  // build; default equip → stock white ball + red Toptracer, unchanged.
  cosmetics?: GolfCosmetics;
  /**
   * GPU instrumentation — `renderer.info` plus the resolved tier, roughly every
   * 30 frames (see lib/scene3d/stats.ts). Undefined in the app; the preview
   * harness passes it and publishes the sample as `window.__golfStats`.
   */
  onStats?: (s: SceneStats) => void;
}

// --- Procedural canvas textures (no binary assets) ------------------------
// (Water + turf now come from the shared scenery.ts kit; only range-specific
// props — net, yardage labels, splash dots — stay local.)

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
  cosmetics,
  onStats,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  // The equipped skin. The mount effect REGISTERS the ball + tracer materials
  // with this seam, which applies the skin then and re-applies it whenever the
  // prop changes — no rebuild, so an equip mid-session lands on the live scene.
  const registerSkin = useGolfSkin(cosmetics);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
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
    // Quality tier — shared policy over golf's budget table (see
    // components/golf/scene/quality.ts). The Range and the Course share a row,
    // so their shadow maps can no longer drift apart the way they had.
    const quality = resolveGolfQuality(renderer, 'range');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    let w = host.clientWidth || window.innerWidth;
    let h = host.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    renderer.shadowMap.enabled = quality.shadows;
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
    // Warm distance haze from the shared kit (makeFog) — one near/far reconciled
    // with the Course so flags/trees/greens fade the same in both scenes.
    scene.fog = makeFog();

    const camera = new THREE.PerspectiveCamera(60, w / h, 0.5, 1400);
    // Sit lower + further back and tilt down a touch more (was pos y8.4 z18 →
    // look y4 z-68, which put the teed ball ~82% down the screen and left almost
    // no pull room). This frames the teed ball ~64% down the full-screen viewport,
    // giving the drag-back gesture a generous ~180–240px of travel below the ball
    // (matched to the Course address frame so the two scenes can't drift), while
    // the down-range targets/haze stay in view. Camera-follow lerps away and back.
    const teeCamPos = new THREE.Vector3(0, 7, 22);
    const teeLookAt = new THREE.Vector3(0, 1, -42);
    camera.position.copy(teeCamPos);
    const lookAt = teeLookAt.clone();
    camera.lookAt(lookAt);

    // --- Lights ---------------------------------------------------------
    // Sky/ground hemisphere fill for soft ambient, plus a strong warm key sun
    // that actually casts. Intensities are raised for the ACES roll-off so the
    // turf keeps its punch while the sky highlights stay controlled.
    // hemiFill(): the IBL below carries the ambient at medium/high (scene/env.ts).
    const hemi = new THREE.HemisphereLight(0xcdeaff, 0x4f7d3f, hemiFill(quality, 1.05));
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.7);
    sun.position.set(-52, 96, 40);
    sun.castShadow = quality.shadows;
    // Shadow map size is the TIER's call now, not this scene's — 1536² at the
    // default tier, down from the 2048² that crashed the Android WebView GPU
    // process (GOLF.md), and overridable per-load with ?shadow= so that crash can
    // finally be bisected on a handset. The Course carries the same row.
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
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

    // --- Sky dome (shared kit) -----------------------------------------
    addSkyDome(scene, track);
    // Sky IBL off the sun placed above so the two can't drift; medium/high set
    // scene.environment, `low` keeps the ball-only PMREM (scene/env.ts).
    const { ballEnvMap, ballEnvIntensity } = attachSkyEnv(renderer, scene, quality, sun.position, track);

    // --- Ground (bold fairway mow stripes, shared kit) -----------------
    // Shared makeFairwayTurf: the SAME bold world-locked STRIPE_HI/LO stripes on
    // the SURFACE_RGB.fairway hue the Course bakes, so the range fairway reads
    // like the course fairway. Two bands per tile × repeat.y 60 over 820 yd ≈
    // 6.8 yd bands (≈ STRIPE_YD), crossing the fairway.
    const turfTex = track(makeFairwayTurf());
    turfTex.repeat.set(10, 60);
    const turfNorm = track(makeTurfNormalMap());
    turfNorm.repeat.set(64, 180);
    const groundGeo = track(new THREE.PlaneGeometry(320, 820));
    const groundMat = track(
      new THREE.MeshStandardMaterial({
        map: turfTex,
        roughness: TURF_ROUGHNESS,
        metalness: 0,
        normalMap: turfNorm,
        normalScale: new THREE.Vector2(TURF_NORMAL_SCALE, TURF_NORMAL_SCALE),
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
    // Shared water (lib/golf/water.ts) — the SAME level surface, Gerstner waves,
    // Fresnel + sky/planar reflection, foam and splash the Course and Putt use.
    // The Range only supplies geometry and a nominal depth; every look/behaviour
    // decision lives in the kit, so the three scenes cannot drift again.
    //
    // makeWaterPlane tessellates from the plane's SIZE (the old geometry was a
    // single quad, with no vertices for wave crests to live on) and the ripple
    // scale is applied in the shader from world XZ — so this 150 yd lake and the
    // Course's ~26 yd pond get identically-sized wavelets instead of the
    // stretched, combed tile the one baked repeat used to give them both.
    const RANGE_WATER_DEPTH = 2.6; // open lake: no modeled bed, so a deep constant
    const waterKit = makeWater(track, {
      renderer,
      waterY: WATER_Y,
      sunDir: sun.position.clone(),
      quality: readWaterQualityOverride() ?? pickWaterQuality(renderer),
      // The lake is a plane floating just above the flat ground plane (which
      // sits at -0.05), so a wave trough has ~0.11 yd before it would clip
      // through. Clamp a hair inside that.
      clearance: 0.09,
    });
    const waterGeo = track(makeWaterPlane(150, waterFar - waterNear, RANGE_WATER_DEPTH));
    const water = new THREE.Mesh(waterGeo, waterKit.material);
    water.position.set(0, WATER_Y, -(waterNear + waterFar) / 2);
    scene.add(water);
    waterKit.addSurface(water);
    // Shared splash FX (droplet crown + ripple rings). This behaviour ORIGINATED
    // here; it now lives in the kit so the Course and Putt get it too.
    const waterFX = makeWaterFX(scene, track);

    // --- Grass fairway causeway (lane / practiceLane only) -------------
    // A turf lane laid over the water straight down the middle so an online
    // shot lands on grass and runs out (visuals match rangeTargets.surfaceAt's
    // central corridor). Present for 'lane' always, and for 'practiceLane' only
    // while practising — in the practiceLane CHALLENGE the causeway is gone
    // (full water), so it isn't drawn. 'fairway' has no causeway at all.
    const drawCauseway = layout === 'lane' || (layout === 'practiceLane' && !isChallenge);
    if (drawCauseway) {
      // Same bold shared fairway stripes as the main ground; repeat.y 21 over the
      // 290 yd causeway ≈ 6.9 yd bands (≈ STRIPE_YD), so its stripes line up in
      // scale with the ground it lies over.
      const fairwayTex = track(makeFairwayTurf());
      fairwayTex.repeat.set(2, 21);
      const fairwayNorm = track(makeTurfNormalMap());
      fairwayNorm.repeat.set(6, 140);
      const fairwayGeo = track(
        new THREE.PlaneGeometry(FAIRWAY_HALF_W * 2, WATER_END - GRASS_END),
      );
      const fairwayMat = track(
        new THREE.MeshStandardMaterial({
          map: fairwayTex,
          roughness: TURF_ROUGHNESS,
          normalMap: fairwayNorm,
          normalScale: new THREE.Vector2(TURF_NORMAL_SCALE, TURF_NORMAL_SCALE),
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
    const greenMat = track(new THREE.MeshStandardMaterial({ color: GREEN_COLOR, roughness: 1 }));
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

    // --- Framing trees (shared, INSTANCED grove) ------------------------
    // Two-species low-poly grove from scene/foliage.ts (broadleaf + pine, 5-tone
    // palette, faceted so the sun catches every plane and casts a real shadow),
    // committed as three InstancedMeshes instead of ~200 loose ones. Placement
    // stays range-specific; the range ground is flat so no y. Receding lines down
    // both banks of the hazard (just outside the ±60yd water) — the narrow
    // portrait FOV can't frame trees at the tee, so these flank the fairway/water
    // toward the horizon, broadleaves up front and pines woven in behind.
    const grove: TreePlacement[] = [];
    for (let i = 0; i < 11; i++) {
      const z = -56 - i * 32;
      const j = ((i * 37) % 11) - 5;
      const fade = 1.15 - i * 0.045;
      const kL = i % 3 === 1 ? 'pine' : 'broadleaf';
      const kR = i % 3 === 2 ? 'pine' : 'broadleaf';
      grove.push({ kind: kL, x: -62 - (i % 2) * 5, z: z + j, scale: fade, seed: 1000 + i });
      grove.push({ kind: kR, x: 62 + (i % 2) * 5, z: z - j, scale: fade * 0.97, seed: 2000 + i });
      // A second, staggered row further out for depth (smaller, mostly pines).
      if (i % 2 === 0) {
        grove.push({ kind: 'pine', x: -74 - (i % 3) * 4, z: z - 10 + j, scale: fade * 0.82, seed: 3000 + i });
        grove.push({ kind: 'broadleaf', x: 75 + (i % 3) * 4, z: z + 8 - j, scale: fade * 0.85, seed: 4000 + i });
      }
    }
    buildGrove(scene, track, grove);

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
    // The ball keeps its OWN envMap even when scene.environment is set — three
    // prefers the material's, and with it the material's envMapIntensity, which
    // is why attachSkyEnv hands back the matching value (scene/env.ts).
    ballMat.envMap = ballEnvMap;
    ballMat.envMapIntensity = ballEnvIntensity;
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);
    // Ball contact shadow (shared kit) — a soft dark disc on the turf under the
    // ball so it reads as SEATED, matching the Course. The range ground is flat
    // (~y 0), so it pins to a fixed y and fades/grows with the ball's altitude.
    const ballShadowTex = track(makeContactShadowTexture());
    const ballShadowMat = track(
      new THREE.MeshBasicMaterial({ map: ballShadowTex, transparent: true, depthWrite: false, opacity: 0.9 }),
    );
    const ballShadowGeo = track(new THREE.PlaneGeometry(BALL_R * 3.2, BALL_R * 3.2));
    const ballShadow = new THREE.Mesh(ballShadowGeo, ballShadowMat);
    ballShadow.rotation.x = -Math.PI / 2;
    ballShadow.renderOrder = 2;
    scene.add(ballShadow);
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
    // Continuous power feedback across the WHOLE range: the arrow ramps GREEN (low)
    // → AMBER (mid) → RED (max) as a 3-stop gradient, so every increment reads —
    // not just a redden near the top. `powerColor` writes into `aimCol`.
    const aimColLow = new THREE.Color(0x46d66b); // green — soft
    const aimColMid = new THREE.Color(0xffd54a); // amber — half power
    const aimColHigh = new THREE.Color(0xff4326); // red — near max (straining)
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
      // Wind-adjusted center line + landing/rest. The drawn line stops at the
      // FIRST bounce (landingIndex) — the carry only; the post-bounce roll guess
      // is left for the player to judge. (Every range shot goes airborne, so
      // landingIndex is set; the null branch is only the fly-out-of-bounds
      // fallback, where the whole line is drawn.)
      const wind = sim.predict({ accuracy: 0, includeWind: true, stride: 3 });
      const fullSwing = wind.landingIndex != null;
      const n = Math.min(
        fullSwing ? wind.landingIndex! + 1 : wind.path.length,
        wind.path.length,
        PRED_MAX,
      );
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
      // Roll-out rest marker: hidden for a full swing (its post-bounce roll is the
      // guess we're dropping); only the no-landing fly-out fallback still shows it.
      const rolled = Math.hypot(wind.rest.d - land.d, wind.rest.x - land.x);
      restRing.position.set(wind.rest.x, PRED_Y, -wind.rest.d);
      restRing.visible = !fullSwing && rolled > 4;

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
    const tracerMat = track(new THREE.LineBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.9, fog: false }));
    const tracer = new THREE.Line(tracerGeo, tracerMat);
    tracer.frustumCulled = false;
    tracer.visible = false;
    scene.add(tracer);
    registerSkin({ ball: ballMat, trail: tracerMat });
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

    // The splash rig (droplet crown + ripple rings) moved to the shared water
    // kit — see waterFX above. The turf-divot particles below stay local: they
    // are a GRASS effect, not a water one.
    // Kick a low turf divot: a few short green/brown flecks + a fading mark.
    // One seeded generator for the whole mount: successive divots still differ
    // from each other (the stream advances), but the sequence is identical on
    // every load, so a captured divot is reproducible.
    const divotRnd = mulberry32(0x64c3a1);
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
        const ang = divotRnd() * Math.PI * 2;
        const sp = 2.5 + divotRnd() * 5;
        pVel[j] = Math.cos(ang) * sp;
        pVel[j + 1] = 3 + divotRnd() * 6;
        pVel[j + 2] = Math.sin(ang) * sp;
        // Mix of grass-green flecks and darker soil-brown clumps.
        if (divotRnd() < 0.55) {
          partCol[j] = 0.32 + divotRnd() * 0.2;
          partCol[j + 1] = 0.55 + divotRnd() * 0.2;
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
      // Scene clock, not the platform: the fade below is `(now - divotStart)`,
      // and `now` comes from the same clock — mixing the two would make the
      // divot pop or vanish the instant the harness freezes time.
      divotStart = sceneNow();
    };

    // Water splash now comes from the shared kit (identical crown + rings in the
    // Course and Putt). Strength scales with the ball's descent speed.
    const spawnSplash = (x: number, z: number, strength = 1) => {
      waterFX.splash(x, WATER_Y, z, strength);
    };

    // --- Pointer input (drag back to swing) ----------------------------
    let activePointer: number | null = null;
    const local = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    // Ramping haptics (view-only, guarded): a short buzz that intensifies as the
    // pull nears 100%, fired sparingly — only when power crosses a new 10% bucket
    // at/above 50% — so it reads as the slingshot "straining", never a per-frame
    // rattle. IDENTICAL to the course. Deterministic sim untouched (reads power).
    let lastPulseBucket = -1;
    const haptic = (power: number) => {
      if (typeof navigator === 'undefined' || !navigator.vibrate) return;
      if (power < 0.5) {
        lastPulseBucket = -1;
        return;
      }
      const bucket = Math.min(10, Math.floor(power * 10)); // 5..10
      if (bucket <= lastPulseBucket) return; // ramp UP only — easing off won't re-buzz
      lastPulseBucket = bucket;
      navigator.vibrate(6 + (bucket - 5) * 6); // 6ms @50% → 36ms @100%
    };
    const onDown = (e: PointerEvent) => {
      // Ignore new drags while a shot is locked (accuracy phase) or in flight —
      // Step 2 is a tap on the DOM accuracy bar, not a canvas drag.
      if (pausedRef.current || activePointer != null || sim.ball.inFlight || sim.armed)
        return;
      // First user gesture in the mode — satisfies the autoplay policy so SFX
      // can play. Idempotent; safe to call on every pointer-down.
      unlockAudio();
      activePointer = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      lastPulseBucket = -1;
      sim.onPointerDown(local(e));
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== activePointer || pausedRef.current) return;
      sim.onPointerMove(local(e));
      if (sim.getState().aiming) haptic(sim.power);
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

    // Full-power drag = the ACTUAL screen room below the teed ball down to the
    // bottom control/safe zone, so a downward slingshot reaches 100% power within
    // a comfortable pull that FITS a phone from a low ball (the reported bug: a
    // low ball capped the pull at the controls before maxPull). Project the teed
    // ball to screen and measure the gap; the elastic powerCurve() then makes
    // ~65% of even a short pull yield ~90% power. Clamped; falls back to a
    // fraction of height if the projection is degenerate. The teed ball's address
    // position is fixed, so this holds for every shot (recomputed on resize). Kept
    // IDENTICAL in spirit to the course, so the two scenes' feel can't drift.
    const pullVec = new THREE.Vector3();
    const applyPull = () => {
      camera.updateMatrixWorld();
      pullVec.set(0, BALL_R + TEE_LIFT, 0).project(camera);
      const ballY = ((1 - pullVec.y) / 2) * h; // px from the top of the canvas
      const ok = Number.isFinite(ballY) && ballY > 0 && ballY < h;
      if (!ok) {
        // Degenerate projection: no reliable ballY to cap against — use a modest,
        // definitely-reachable pull.
        sim.setMaxPull(Math.max(44, h * 0.22));
        return;
      }
      // Pointer capture makes the WHOLE gap down to the bottom edge usable, so
      // base the full-power pull on the physical `travel` below the ball (less a
      // small bottom MARGIN) rather than on `room` (which subtracted the 96px
      // BOTTOM_ZONE and needlessly shrank maxPull, making 100% arrive too fast).
      // With the ball framed ~64% down this yields a longer, more deliberate full
      // pull (~268px on a typical phone vs the old 196px) while scaling the whole
      // 0→100% range up together, so the dialable middle is preserved. Band is a
      // sanity clamp (floor for a generous pull, cap for a very tall viewport).
      const travel = h - ballY;
      const MARGIN = 24; // keep a little room above the bottom edge
      const desired = Math.max(140, Math.min(travel - MARGIN, h * 0.55));
      // CRITICAL: never let maxPull exceed the physical drag travel below the ball,
      // or 100% becomes unreachable on SHORT viewports where the floor (140)
      // exceeds the travel. On a normal portrait phone `desired` wins (~268px); a
      // short viewport caps to the reachable travel, so 100% is ALWAYS reachable.
      // Kept IDENTICAL to the Course so feel can't drift. (The range never putts —
      // every shot is a full swing.)
      sim.setMaxPull(Math.max(44, Math.min(desired, travel - 8)));
    };
    applyPull();

    // --- Camera follow state -------------------------------------------
    let following = false;
    let revertAt = 0;
    // Last wind applied to the water, so setWind only runs when it changes.
    let lastWindAlong = Number.NaN;
    let lastWindCross = Number.NaN;
    const followTarget = new THREE.Vector3();
    const lookTarget = new THREE.Vector3();
    // Up axis for yawing the tee view about the tee (origin) by the aim steer.
    const camUp = new THREE.Vector3(0, 1, 0);

    // --- Fixed-timestep loop -------------------------------------------
    let raf = 0;
    let acc = 0;
    // Scene clock (lib/scene3d/clock.ts): the platform clock in the app, a
    // freezable virtual one under the screenshot harness.
    let last = sceneNow();
    let running = false;

    // Render-side bounce/roll SFX detection (no discrete sim events for these).
    // A bounce = the ball's vertical velocity flips from falling to rising while
    // airborne; rolling = grounded + moving above a speed floor, throttled. All
    // read from the snapshot state we already render — the sim is never touched.
    // The sim emits ONE 'land' event on first ground contact (voiced loud in the
    // drain); `suppressBounceSfx` swallows the detector's FIRST sign-flip so that
    // first contact isn't double-voiced — the detector then handles only the
    // SUBSEQUENT (quieter) bounces.
    let lastVh = 0;
    let lastRollAt = 0;
    let suppressBounceSfx = false;

    // GPU instrumentation (lib/scene3d/stats.ts) — wall-clock probe, nothing it
    // produces is rendered, so it cannot affect a screenshot.
    const frameProbe = makeFrameProbe();
    let statFrames = 0;

    const frame = (rafNow: number) => {
      const now = tickSceneClock(rafNow);
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
          // Swing SFX, brightened + loudened by shot power. Power resets to 0
          // on fire, so derive it from the launch speed the sim just set on the
          // ball (normalized by the fastest club, MAX_CLUB_SPEED). Render-layer
          // only — the sim is untouched. lastVh is seeded so the first bounce
          // reads clean.
          {
            const bb = sim.ball;
            const p01 = Math.max(0, Math.min(1, Math.hypot(bb.vd, bb.vx, bb.vh) / MAX_CLUB_SPEED));
            play('swing', { rate: 0.85 + 0.55 * p01, gain: 0.55 + 0.55 * p01 });
            lastVh = bb.vh;
            lastRollAt = 0;
            suppressBounceSfx = false;
          }
        } else if (ev.type === 'land') {
          // First ground contact: a subtle turf divot on grass/island only
          // (water landings are handled by the splash below).
          if (ev.d != null && ev.x != null) {
            const surf = surfaceAt(ev.d, ev.x, layout, isChallenge);
            if (surf !== 'water' && surf !== 'fence') {
              spawnDivot(ev.x, -ev.d, surf === 'island');
            }
          }
          // First ground contact thud. Arm the detector to swallow its matching
          // sign-flip so this contact isn't voiced twice (it handles later bounces).
          play('land', { gain: 0.7 });
          suppressBounceSfx = true;
        } else if (ev.type === 'splash') {
          if (ev.d != null && ev.x != null) {
            // Strength from the descent speed, matching the Course.
            spawnSplash(ev.x, -ev.d, Math.min(1.5, 0.55 + Math.abs(lastVh) / 28));
            sinking = true;
            sinkStart = now;
          }
          revertAt = now + 1600;
          play('splash');
        } else if (ev.type === 'rest') {
          revertAt = now + 1300;
          play('rest');
        } else if (ev.type === 'fence') {
          revertAt = now + 1100;
          play('fence');
        } else if (ev.type === 'arm') {
          play('ui-tick');
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

      // Bounce/roll SFX from the render snapshot only (no sim events for these).
      // Bounce: vertical velocity crosses from down (<0) to up (>0) mid-flight
      // and the ball is low to the ground — a subtle secondary thud, quieter
      // than the sim's first-contact 'land'. Roll: grounded + horizontal speed
      // above a floor, played as short throttled ticks that fade with speed.
      if (b.inFlight) {
        if (lastVh < -1 && b.vh > 0 && b.h < 2.5) {
          // The first sign-flip after the sim's 'land' event is that same first
          // contact — swallow it once; only later bounces get the quiet thud.
          if (suppressBounceSfx) suppressBounceSfx = false;
          else play('land', { gain: 0.28, rate: 1.15 });
        }
        lastVh = b.vh;
      } else if (b.grounded && !b.resting) {
        const hs = Math.hypot(b.vx, b.vd);
        if (hs > 3 && now - lastRollAt > 90) {
          lastRollAt = now;
          play('roll', { gain: Math.min(0.16, 0.03 + hs * 0.004), rate: 0.9 + Math.min(0.5, hs * 0.02) });
        }
      }

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

      // Ball contact shadow: pin under the ball on the flat turf, fade + grow
      // with altitude so it reads as a seated ball at rest and a soft blob aloft.
      // Hidden once the ball has sunk (over water there's no turf to shadow).
      const shAlt = Math.max(0, b.h);
      ballShadow.position.set(b.x, 0.04, -b.d);
      const shScale = 1 + Math.min(2.5, shAlt * 0.12);
      ballShadow.scale.set(shScale, shScale, shScale);
      ballShadowMat.opacity = 0.9 * Math.max(0.1, 1 - shAlt / 8);
      ballShadow.visible = ball.visible && !sinking;

      // Aim guide: visible only at the tee. Steer with aimRad; the arrow GROWS in
      // length and ramps GREEN→AMBER→RED continuously with power (feedback across
      // the whole range), and its head/tip reticle PULSE-STRETCH near max as an
      // elastic "straining against the band" cue (visual — no haptics needed on
      // iOS). Idle pulse invites a drag.
      aimGuide.visible = teed;
      if (teed) {
        const pw = sim.power;
        aimGuide.rotation.y = -sim.aimRad;
        aimGuide.scale.z = 1 + pw * 0.85; // clearer length delta across the range
        // 3-stop green→amber→red ramp.
        if (pw < 0.5) aimCol.copy(aimColLow).lerp(aimColMid, pw * 2);
        else aimCol.copy(aimColMid).lerp(aimColHigh, (pw - 0.5) * 2);
        aimMat.color.copy(aimCol);
        chevMat.color.copy(aimCol);
        const pulse = sim.aiming ? 1 : 0.82 + 0.18 * Math.sin(now / 320);
        aimMat.opacity = (0.42 + pw * 0.45) * pulse;
        chevMat.opacity = 0.42 * pulse;
        // Elastic strain near max: the tip reticle throbs/stretches as power → 1.
        const strain = Math.max(0, (pw - 0.72) / 0.28); // 0 below 72%, 1 at 100%
        const throb = 1 + strain * (0.28 + 0.16 * Math.sin(now * 0.02));
        reticle.scale.set(throb, throb, 1);
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

      // Splash droplets + ripple rings: integrated by the shared water kit.
      waterFX.update(now, dt);

      // Gentle flag sway.
      const t = now / 1000;
      for (let i = 0; i < flagCloths.length; i++) {
        const f = flagCloths[i]!;
        f.mesh.rotation.z = Math.sin(t * 2 + i) * 0.12;
        f.mesh.position.x = f.base + Math.sin(t * 3 + i) * 0.12;
      }
      // Water: advance the wave clock (Gerstner crests travel, detail normals
      // cross-scroll, the sun glint rides the crests). Same hook as the Course.
      waterKit.update(t);
      // Wind → waves, from the SAME numbers the HUD's WindChip reads, so the
      // readout and the lake agree. Re-applied only when the round wind changes.
      const wSt = sim.getState();
      if (wSt.windAlong !== lastWindAlong || wSt.windCross !== lastWindCross) {
        lastWindAlong = wSt.windAlong;
        lastWindCross = wSt.windCross;
        waterKit.setWind(
          windBearing(wSt.windAlong, wSt.windCross),
          windMph(wSt.windAlong, wSt.windCross),
        );
      }

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
        // Tee view faces down the AIMED line: yaw the static tee framing about the
        // tee (origin) by the slingshot steer, mirroring the Course address camera.
        // The −z forward maps to (sin aimRad, 0, −cos aimRad) under −aimRad, so
        // steering right turns the view right; aimRad = 0 is the unchanged tee view.
        // Still lerped below (k), so the turn eases and never snaps.
        followTarget.copy(teeCamPos).applyAxisAngle(camUp, -sim.aimRad);
        lookTarget.copy(teeLookAt).applyAxisAngle(camUp, -sim.aimRad);
      }
      // Snappier tracking in flight so the chase keeps up with the ball;
      // gentler on the ease back to the tee.
      const k = 1 - Math.exp(-dt * (following ? 5 : 3.2));
      camera.position.lerp(followTarget, k);
      lookAt.lerp(lookTarget, k);
      camera.lookAt(lookAt);

      // Tier 3: mirror the scene into the reflection target BEFORE the main
      // render, once the camera is final for this frame. No-op below 'high'.
      waterKit.renderReflection(renderer, scene, camera);

      renderer.render(scene, camera);

      // AFTER the render — three resets info.render at the start of render().
      frameProbe.sample();
      statFrames++;
      if (onStatsRef.current && shouldSampleStats(statFrames)) {
        onStatsRef.current(
          sampleSceneStats(renderer, quality, statFrames, frameProbe.medianMs()),
        );
      }
      raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (running) return;
      running = true;
      last = sceneNow();
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
      waterKit.setSize(w, h);
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
