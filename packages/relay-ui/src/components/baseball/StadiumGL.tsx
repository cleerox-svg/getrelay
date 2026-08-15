// StadiumGL — the baseball scene's COMPOSER.
//
// ⚠ WHAT THIS FILE IS ALLOWED TO OWN: the renderer, the lights, the camera
// modes and the loop. Nothing else. Every piece of geometry in the park is built
// by a single-purpose module under `stadium/` that takes a scene and a `track`
// and returns a handle. `CourseGL.tsx` is 2630 lines because it owned the
// renderer AND the terrain AND the water AND the trees AND the aim aids, and it
// got there one reasonable-looking hundred at a time. The cap here is 900 lines
// and the fix at the cap is extraction.
//
// ⚠ ONE SCENE, CAMERA MODES — not four scenes. `batter` / `pitcher` / `flight` /
// `wide` are four camera placements over one built park. GOLF.md's rendering
// chapter records what happened when Course and Range were separate scenes: they
// drifted and a shared kit had to be retrofitted. A second GL file is a
// permanent parity tax and there will not be one.
//
// ⚠ NO GAMEPLAY IS COMPUTED HERE. Layer discipline: the sim owns state, GL
// renders, the HUD polls. M1 has no sim to render yet, so this file reads
// `parks.ts` and draws it — and `parks.ts` is the SAME module `resolveFence`
// reads, which is what makes "the fence you see is the fence you clear" a
// structural fact instead of a hope.
//
// ⚠ `three` STAYS LAZY. This is a default export so callers reach it through
// `lazy(() => import('./StadiumGL'))`. Nothing outside this file and its
// `stadium/*` builders may import `three`, and `lib/baseball/*` is asserted
// three-free by `budget.test.ts`.

import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import { HARBOURFRONT } from '../../lib/baseball/parks';
import type { Park } from '../../lib/baseball/parks';
import { buildField } from './stadium/field';
import { buildFence } from './stadium/fence';
import { buildMound } from './stadium/mound';
import { buildRoof } from './stadium/roof';
import { buildScaleReference } from './stadium/scale';
import { buildStands } from './stadium/stands';
import { pickStadiumQuality } from './stadium/quality';
import type { StadiumQuality } from './stadium/quality';
import type { Disposable, StadiumCtx, Track } from './stadium/geom';

export type CameraMode = 'batter' | 'pitcher' | 'flight' | 'wide';

export const CAMERA_MODES: CameraMode[] = ['batter', 'pitcher', 'flight', 'wide'];

export const isCameraMode = (v: unknown): v is CameraMode =>
  CAMERA_MODES.includes(v as CameraMode);

/**
 * The four camera placements, in SCENE feet: `x` lateral (+ = first-base side),
 * `y` up, `z` negative toward centre field. See `stadium/geom.ts` for the frame.
 *
 * These are FRAMING, the one honestly subjective thing in this file — every
 * other number in the scene is data. They are written as a table so that
 * re-framing a shot is an edit to five numbers and not to a render path.
 */
/**
 * ⚠ `near` IS PER MODE, AND THAT IS A BUG FIX, NOT A FLOURISH. A stadium spans
 * three orders of magnitude — a 0.05 ft gap between the grass and the warning
 * track, read from 1200 ft away in the `wide` shot. With one 0.5 ft near plane
 * and a 6000 ft far plane the depth buffer could not separate them: the first
 * `wide` render showed the seating bowl as TRANSLUCENT and the turf striped with
 * radial spokes, both of which are z-fighting and neither of which is a material
 * problem. The near plane is therefore pushed out to just inside the nearest
 * geometry each camera can actually see.
 */
const CAMERAS: Record<
  CameraMode,
  { pos: [number, number, number]; look: [number, number, number]; fov: number; near: number }
> = {
  // Over the batter, inside the backstop (which stands at `foulTerritoryFt`, so
  // the camera has to sit nearer than that or it shoots through the stands).
  batter: { pos: [0, 8.5, 20], look: [0, 4, -55], fov: 40, near: 1 },
  // From the mound, looking in at the plate. Narrow, because a pitcher's view of
  // a 17 in plate 55 ft away IS narrow and pretending otherwise flatters the aim.
  pitcher: { pos: [0, 6, -55], look: [0, 2.6, 0], fov: 26, near: 1 },
  // Upper deck behind home, a little to the third-base side, looking out over
  // the whole outfield — the frame a batted ball is watched in. Two earlier
  // framings put the camera beside or behind the bowl and photographed the back
  // of the seating rake; a camera ABOVE the rake looking down its axis is what
  // clears it. It is also the only mode that gets the 282 ft roof and the 10 ft
  // wall into one frame, so the ceiling reads as a height against something.
  flight: { pos: [-40, 120, 90], look: [-40, 60, -380], fov: 55, near: 4 },
  // The whole park. High enough to clear the back of the bowl behind home
  // (deck top 130 ft at r ≈ 160 ft), which the first framing did not and so
  // photographed the outside of the backstop instead of the field. Nearest
  // geometry is the roof rim at ~780 ft, so a 200 ft near plane is generous.
  wide: { pos: [0, 1000, 470], look: [0, 0, -200], fov: 56, near: 200 },
};

/**
 * Sun, scene ft. It sits on the POSITIVE-z side (behind home) on purpose: that
 * lights the inward face of the outfield wall, which is the surface `batter`,
 * `flight` and `wide` are all looking at. One sun cannot also light the
 * backstop's inward face — those two normals are opposed — so the backstop is
 * lifted by the hemisphere fill instead. Stated because it is a CHOICE, and the
 * alternative is visible in the `pitcher` shot.
 */
const SUN_POS: [number, number, number] = [-520, 700, 260];
const SUN_TARGET: [number, number, number] = [0, 0, -170];

/** Sky, and the scene background. A day game; night is an `exposure` + sun change. */
const SKY = 0x8fb6dd;

/**
 * Half-extent of the shadow camera, ft. DERIVED at build time from the bowl's
 * own outer radius rather than typed, so a deeper park does not silently lose
 * its shadows off the edge of the map.
 */
const SHADOW_MARGIN_FT = 60;

export interface StadiumStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  tier: StadiumQuality['tier'];
  shadowMapSize: number;
  qualityReason: string;
}

export interface StadiumApi {
  stats(): StadiumStats;
  /** Distance and height of the DRAWN wall at a bearing, read out of geometry. */
  measureFence(bearingDeg: number): { distFt: number; heightFt: number } | null;
  setMode(mode: CameraMode): void;
  setExposure(exposure: number): void;
}

export interface StadiumGLProps {
  park?: Park;
  mode?: CameraMode;
  /**
   * Tone-mapping exposure. A PARAMETER, not a baked constant: night games are
   * coming and a night park is the same geometry under a different exposure and
   * a different sun, not a second scene.
   */
  exposure?: number;
  /** `?quality=` override, plumbed from the URL — see `stadium/quality.ts`. */
  qualityOverride?: string | null;
  /** Fired once, after a real frame has been rendered. */
  onReady?: (api: StadiumApi) => void;
}

export default function StadiumGL({
  park = HARBOURFRONT,
  mode = 'wide',
  exposure = 1,
  qualityOverride = null,
  onReady,
}: StadiumGLProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<StadiumApi | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const initialRef = useRef({ mode, exposure });
  initialRef.current = { mode, exposure };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // --- disposal ledger. EVERY geometry, material and texture goes through
    // `track`; the unmount path below walks it. A leaked BufferGeometry is
    // invisible until the fifth remount, which is exactly why this is a ledger
    // and not a hand-written list of dispose calls at the bottom.
    const owned: Disposable[] = [];
    const track: Track = (r) => {
      owned.push(r);
      return r;
    };

    const renderer = new WebGLRenderer({ antialias: true, alpha: false });
    const quality = pickStadiumQuality(renderer, qualityOverride);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = initialRef.current.exposure;
    renderer.shadowMap.enabled = quality.shadows;
    renderer.shadowMap.type = PCFSoftShadowMap;
    // ⚠ NOTHING IN THIS SCENE MOVES. The bowl, wall, roof and mound are static,
    // so re-rendering their shadow map every frame is pure waste. One update is
    // requested after the build; flip this back on the day something in the
    // shadow set actually animates, and not before.
    renderer.shadowMap.autoUpdate = false;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';

    const scene = new Scene();
    scene.background = new Color(SKY);
    const camera = new PerspectiveCamera(45, 1, 0.5, 6000);

    // --- lights. The whole budget: one shadow-casting sun, one hemisphere fill.
    const sun = new DirectionalLight(0xfff4e0, 2.1);
    sun.position.set(...SUN_POS);
    sun.target.position.set(...SUN_TARGET);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    // ⚠ THE NORMAL BIAS IS IN WORLD FEET AND IT HAS TO BE BIG. A 1024² map over
    // a ~1200 ft shadow volume is ~1.2 ft per texel, so a sub-foot bias leaves
    // the grass striped with self-shadow acne — measured, on the first render.
    // The honest fix at this budget is a bias of order one texel; raising the
    // map instead is the on-device bet stadium/quality.ts refuses to take.
    sun.shadow.bias = -0.001;
    sun.shadow.normalBias = 6;
    scene.add(sun, sun.target);
    // The fill carries every surface the one sun cannot reach — chiefly the
    // backstop, which faces the sun's back. It is doing real work here, not
    // adding a wash, so it is not a token 0.3.
    scene.add(new HemisphereLight(0xcfe4f8, 0x7c7264, 1.6));

    // --- the park. Six builders, each pure, each returning a handle.
    const ctx: StadiumCtx = { scene, track, park, quality };
    const field = buildField(ctx);
    const fence = buildFence(ctx);
    buildMound(ctx);
    const stands = buildStands(ctx);
    buildRoof(ctx, stands);
    buildScaleReference(ctx);

    // Shadow volume sized from the geometry that was actually built.
    const half = Math.max(field.apronRadiusFt, stands.outerRadiusFt(0)) + SHADOW_MARGIN_FT;
    const cam = sun.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 3000;
    cam.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;

    const applyMode = (m: CameraMode) => {
      const c = CAMERAS[m];
      camera.position.set(...c.pos);
      camera.fov = c.fov;
      camera.near = c.near;
      camera.lookAt(c.look[0], c.look[1], c.look[2]);
      camera.updateProjectionMatrix();
    };
    applyMode(initialRef.current.mode);

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // --- the loop. `renderer.info` is read AFTER the render, because three
    // resets its per-frame counters at the start of each `render()`.
    let raf = 0;
    let frames = 0;
    let last: StadiumStats = emptyStats(quality);
    const tick = () => {
      renderer.render(scene, camera);
      last = {
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        tier: quality.tier,
        shadowMapSize: quality.shadowMapSize,
        qualityReason: quality.reason,
      };
      frames++;
      if (frames === 3) onReadyRef.current?.(api);
      raf = requestAnimationFrame(tick);
    };

    const api: StadiumApi = {
      stats: () => last,
      measureFence: (deg) => fence.sample(deg),
      setMode: applyMode,
      setExposure: (e) => {
        renderer.toneMappingExposure = e;
      },
    };
    apiRef.current = api;
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      apiRef.current = null;
      // Detach the graph, then dispose the LEDGER. Not a traverse-and-clear:
      // `Object3D.traverse` walks `children` by index while `clear()` splices
      // it, so half the tree gets skipped. Every GPU resource is in `owned`
      // regardless of where its Object3D ended up, which is the point of a
      // ledger over a walk.
      scene.clear();
      for (const r of owned) r.dispose();
      owned.length = 0;
      renderer.dispose();
      // ⚠ WebGL contexts are a scarce browser resource (~16 live). Golf learned
      // this remounting a scene per hole; drop it explicitly, do not wait for GC.
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
  }, [park, qualityOverride]);

  useEffect(() => {
    apiRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    apiRef.current?.setExposure(exposure);
  }, [exposure]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}

function emptyStats(q: StadiumQuality): StadiumStats {
  return {
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    geometries: 0,
    textures: 0,
    tier: q.tier,
    shadowMapSize: q.shadowMapSize,
    qualityReason: q.reason,
  };
}
