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
// permanent parity tax and there will not be one. The placements and the ease
// between them live in `stadium/camera.ts` — the machinery existed and nothing
// used it, and the follow camera the owner asked for is that machinery being
// switched on rather than a parallel system beside it.
//
// ⚠ NO GAMEPLAY IS COMPUTED HERE. Layer discipline: the sim owns state, GL
// renders, the HUD polls. The park is read from `parks.ts` — the SAME module
// `resolveFence` reads, which is what makes "the fence you see is the fence you
// clear" a structural fact instead of a hope — and the ball's flight arrives
// already integrated, as a `PitchTrack` / `BattedTrack`. This file converts
// frames, interpolates between the sim's own samples and scales a clock. It
// does not integrate anything, and there is no seam here through which a
// second, prettier trajectory could be introduced: the screenshot harness reads
// the DRAWN tracer's vertices back out of the GPU buffer and fails the run if
// they disagree with the sim's track or bend by a different amount.
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
  Vector3,
  WebGLRenderer,
} from 'three';
import { HARBOURFRONT } from '../../lib/baseball/parks';
import type { Park } from '../../lib/baseball/parks';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';
import { ZONE_CENTER } from '../../lib/baseball/zone';
import { sceneNow, tickSceneClock } from '../../lib/scene3d/clock';
import { buildBoard } from './stadium/board';
import type { BoardPanelRect } from './stadium/board';
import type { BoardGeometry } from './stadium/boardAtlas';
import type { BoardArray } from './stadium/scoreboard';
import { buildCameraRig } from './stadium/camera';
import type { CameraMode } from './stadium/camera';
import { daylightOf } from './stadium/daylight';
import type { DaylightId } from './stadium/daylight';
import { buildField } from './stadium/field';
import { buildCentrefield } from './stadium/centrefield';
import { buildFence } from './stadium/fence';
import { buildFlight } from './stadium/flight';
import type { FlightPaths } from './stadium/flight';
import { buildMound } from './stadium/mound';
import { buildReticle } from './stadium/reticle';
import { buildRoof } from './stadium/roof';
import { buildScaleReference } from './stadium/scale';
import { buildSky } from './stadium/sky';
import { buildSkyline } from './stadium/skyline';
import { buildStands } from './stadium/stands';
import { pickStadiumQuality } from './stadium/quality';
import type { StadiumQuality } from './stadium/quality';
import type { Disposable, StadiumCtx, Track } from './stadium/geom';

// The camera modes, their placements and the rig that moves between them live in
// `stadium/camera.ts` — re-exported here because this file is the module every
// consumer already imports, and because a HUD asking for a camera mode has no
// business knowing which builder owns the table. See that file for why the
// placements moved out: they acquired STATE (an ease, a follow point), and a
// table with state in it is a subsystem.
export { CAMERA_MODES, isCameraMode } from './stadium/camera';
export type { CameraMode } from './stadium/camera';

/**
 * ⚠ THE SUN, THE FILL AND THE SKY ARE A ROW OF `stadium/daylight.ts` NOW.
 *
 * They used to be three constants in this file: `SUN_POS` on the positive-z side
 * (behind home, so that the inward face of the outfield wall — the surface
 * `batter`, `flight` and `wide` all look at — is lit), a hemisphere fill doing
 * real work rather than adding a wash, and a `SKY` clear colour behind the dome.
 * All three still exist and none of the day values moved; they are `DAYLIGHT.day`.
 *
 * They moved out because NIGHT IS A SECOND ROW OF THE SAME TABLE and not a
 * second scene — the same argument the camera MODES make against a second GL
 * file. The budget is unchanged and is the thing to watch: ONE shadow-casting
 * directional, ONE hemisphere fill, and emissive geometry doing the rest. There
 * are no floodlights, and `daylight.ts` says at length why there will not be.
 *
 * ⚠ AND IT IS COSMETIC. Nothing in that table reaches `lib/baseball`; the air a
 * ball flies through is `parkConditions`' and does not know what time it is.
 * `shared/prefs.test.ts` runs the carry ladder in both modes and requires the
 * two byte-identical.
 *
 * The clear colour survives only as what the dome is drawn OVER, so a frame in
 * which the dome somehow fails to build is a plausible sky rather than black.
 */

/**
 * Half-extent of the shadow camera, ft. DERIVED at build time from the bowl's
 * own outer radius rather than typed, so a deeper park does not silently lose
 * its shadows off the edge of the map.
 */
const SHADOW_MARGIN_FT = 60;

/**
 * Dead air after a play before the live loop replays it, PLAYBACK seconds.
 *
 * ⚠ FEEL KNOB, and it is applied to the PLAYBACK clock, never to `dt`. It exists
 * only so a looping preview does not snap the ball from the outfield back to the
 * pitcher's hand with no beat between. It cannot reach a sim: `setTime` is only
 * ever called with true physical seconds inside `[0, durationS]`.
 */
const REPLAY_GAP_S = 0.8;

/**
 * Session seed when a caller does not supply one. FIXED, never a clock: this is
 * read by the tower's LED programme, and the harness's byte-identical guarantee
 * rests on the standalone scene having one tower rather than a nightly one.
 */
const DEFAULT_SEED = 20260816;

export interface StadiumStats {
  drawCalls: number;
  triangles: number;
  programs: number;
  geometries: number;
  textures: number;
  tier: StadiumQuality['tier'];
  shadowMapSize: number;
  qualityReason: string;
  /** Half-extent of the sun's ortho shadow volume, ft — DERIVED from geometry. */
  shadowHalfFt: number;
  /** ft per shadow texel. The number the ball's contact shadow founders on. */
  shadowTexelFt: number;
  /** Which row of `daylight.ts` was built. Cosmetic — see that file. */
  daylight: DaylightId;
}

/**
 * What the HUD hands the board, and WHEN THAT SCREEN APPEARED.
 *
 * ⚠ `sinceS` IS A SCENE-CLOCK TIMESTAMP, NOT A `dt` AND NOT AN ELAPSED TIME, and
 * the split is what keeps the HUD off the render loop. The board's animation
 * needs `tS` sixty times a second; a HUD that computed it would have to re-render
 * sixty times a second, which the layer rules forbid. So the HUD — which is the
 * thing that KNOWS when a screen appeared, because it caused it — latches
 * `sceneNow() / 1000` once per screen, and this file subtracts it from `now`
 * every frame. Freezing the scene clock therefore freezes `tS`, which is what
 * makes a celebration frame photographable.
 */
export interface BoardFeed {
  array: BoardArray;
  sinceS: number;
}

export interface StadiumApi {
  stats(): StadiumStats;
  /** Distance and height of the DRAWN wall at a bearing, read out of geometry. */
  measureFence(bearingDeg: number): { distFt: number; heightFt: number } | null;
  /**
   * Peak height and the two radii of the DRAWN roof at a bearing. `null` for a
   * park with no roof. See `stadium/roof.ts`'s `RoofPart.sample` for why this
   * exists beside `measureFence` rather than the harness trusting `parks.ts`.
   */
  measureRoof(bearingDeg: number): { peakFt: number; innerFt: number; outerFt: number } | null;
  /**
   * Change camera mode. EASES, it does not cut — see `stadium/camera.ts`. The
   * transition is driven by the scene clock, so a frozen clock holds it exactly
   * where it is and two harness runs capture the same frame.
   */
  setMode(mode: CameraMode): void;
  /** The camera's current aim point, scene ft, and how settled the ease is. */
  cameraAim(): { target: [number, number, number]; progress: number; mode: CameraMode };
  setExposure(exposure: number): void;
  /** Hand the renderer a precomputed flight. Nothing here computes gameplay. */
  setFlight(paths: FlightPaths | null): void;
  /**
   * Freeze the ball at a TRUE PHYSICAL time, s, or pass `null` to play the wall
   * clock at `PITCH_TEMPO`. The screenshot harness always freezes: a ball driven
   * by a wall clock is the obvious way to make two runs disagree.
   */
  setBallTime(tS: number | null): void;
  /**
   * The tracer's vertices AS DRAWN, scene ft — i.e. only as far as the ball has
   * actually travelled. The gate's leak seam: if this reaches past the ball, the
   * player can read the outcome before it happens.
   */
  tracer(which: 'pitch' | 'batted'): number[];
  /**
   * The WHOLE built path, revealed or not — the gate's GEOMETRY seam, and the
   * one the 0.002 ft drawn-vs-sim comparison must use. Pointing that comparison
   * at `tracer()` would silently narrow it to a prefix.
   */
  tracerFull(which: 'pitch' | 'batted'): number[];
  /** Is that tracer being rendered? Vertices nobody draws prove nothing. */
  tracerVisible(which: 'pitch' | 'batted'): boolean;
  /**
   * Move the aiming reticle to REPORT (x, h), ft.
   *
   * ⚠ IMPERATIVE ON PURPOSE, and it is the ONLY path — there is deliberately no
   * `reticle` prop beside it. This is called from a `pointermove` handler, and a
   * prop would mean a React render per move event; the reticle's own charter
   * note (`stadium/reticle.ts`) is that it is two writes to a Vector3, which is
   * only true if nothing above it re-renders to deliver them. Visibility IS a
   * prop (`aiming`), because that changes once per pitch.
   */
  setReticle(x: number, h: number): void;
  setAiming(on: boolean): void;
  /** Where the reticle is DRAWN, scene ft. */
  reticleScene(): [number, number, number];
  /** The drawn ball's scene position, or null when it is not in flight. */
  ballScene(): [number, number, number] | null;
  /**
   * The drawn ball projected into the viewport: `[x, y]` in 0…1 with y DOWN, or
   * null when the ball is not drawn or is behind the camera.
   *
   * ⚠ THIS IS PROJECTION, NOT GAMEPLAY. It exists so `ExitVeloTag` can fly with
   * the ball by writing a transform under its own rAF instead of the HUD
   * re-rendering at 60 Hz. The camera and its matrices live here and nowhere
   * else, so a second copy of this maths in the HUD would be a second camera
   * model to keep in step — the exact "state mirrored across layers" the layer
   * rule forbids.
   */
  ballScreen(): [number, number] | null;
  /** Is the ball mesh being rendered? */
  ballVisible(): boolean;
  /** The ball's DRAWN radius, scene ft — `MIN_BALL_PX`'s claim, measurable. */
  ballScale(): number;
  /**
   * The board array AS BUILT and AS PAINTED — the gate's read-back seam for the
   * biggest object in the batter's view.
   *
   * ⚠ IT REPORTS WHAT WAS PAINTED, NOT WHAT WAS PASSED IN. `current()` returns
   * the keys the paint was actually keyed on, `uploads()` is the module's own
   * count beside `texture.version`, and `panels` is read off the rects the
   * geometry was built from. A read-back that echoes the setter's argument
   * cannot fail — `checkBall`'s note records that exact tautology shipping once.
   */
  board(): {
    panels: BoardPanelRect[];
    geometry: BoardGeometry;
    current: { key: string; frame: number; ribbon: string; offsetU: number } | null;
    uploads: number;
    ribbonUploads: number;
    /** The atlas's own version counter, incremented by three on `needsUpdate`. */
    textureVersion: number;
    tS: number;
  } | null;
}

export interface StadiumGLProps {
  park?: Park;
  mode?: CameraMode;
  /**
   * Day or night. A USER OPTION, and **cosmetic only** — see `stadium/daylight.ts`
   * for the whole argument and `shared/prefs.test.ts` for the assertion. It
   * changes one directional light's placement, one hemisphere fill, the dome's
   * palette and a handful of emissive levels. It does not change the air, so it
   * does not change the carry, so it cannot be a difficulty setting.
   *
   * ⚠ IT REBUILDS THE SCENE, and that is honest rather than lazy: the sky dome's
   * gradient is baked into a `CanvasTexture` at build time, so a live toggle
   * would either need a second texture kept alive or a re-generated one, and the
   * setting changes about as often as the park does. It is in the build effect's
   * dependency list beside `park` for exactly that reason.
   */
  daylight?: DaylightId;
  /**
   * Session seed. Only the tower's LED programme reads it (see `geom.StadiumCtx`),
   * and the harness passes a fixed one so the tower is the same tower twice.
   */
  seed?: number;
  /**
   * Tone-mapping exposure. A PARAMETER, not a baked constant.
   */
  exposure?: number;
  /** `?quality=` override, plumbed from the URL — see `stadium/quality.ts`. */
  qualityOverride?: string | null;
  /**
   * Build the magenta 6 ft scale reference (`stadium/scale.ts`).
   *
   * ⚠ DEFAULT OFF, AND THE DEFAULT IS THE POINT. It is a measuring stick for the
   * visual gate, not set dressing, and it was previously built unconditionally
   * with a comment promising to delete it "the milestone a real batter model
   * lands". Nothing imports this component yet, so that promise costs nothing
   * today and becomes a magenta slab in a shipped HUD the moment one does. The
   * preview harness — the only caller that wants it — asks for it explicitly.
   */
  scaleReference?: boolean;
  /**
   * Show the strike-zone frame and the aiming reticle (`stadium/reticle.ts`).
   * Changes once per pitch — between pitches the derby is aiming, during the
   * flight it is not — so unlike the reticle's POSITION this is a prop.
   */
  aiming?: boolean;
  /**
   * The precomputed flight to draw — a `PitchTrack` and/or a `BattedTrack`
   * exactly as `lib/baseball` produced them.
   *
   * ⚠ THE RENDERER DOES NOT SIMULATE. It converts frames and interpolates
   * between the sim's own samples, and that is the whole of it. A prettier curve
   * drawn beside a sim that disagrees with it is the defect the visual gate was
   * built to find, so there is no seam here through which one could be added.
   */
  flight?: FlightPaths | null;
  /**
   * Freeze the ball at this TRUE PHYSICAL time (s since release), or `null`/
   * omitted to play the wall clock back at `PITCH_TEMPO`.
   */
  ballTimeS?: number | null;
  /**
   * What the videoboard array is showing, and when that screen appeared.
   *
   * ⚠ A PROP RATHER THAN AN IMPERATIVE SETTER — unlike `setReticle`, and for the
   * opposite reason. The reticle moves on `pointermove`, so a prop would mean a
   * React render per move event. The board's screen changes a handful of times
   * per pitch, which is exactly what a prop is for; what changes per FRAME is
   * `tS`, and that is computed here from the scene clock rather than pushed.
   */
  board?: BoardFeed | null;
  /**
   * Freeze the board at this `tS`, seconds since the screen appeared, or
   * `null` to run it off the scene clock. The screenshot harness always freezes,
   * for the same reason it freezes the ball.
   */
  boardTimeS?: number | null;
  /** Fired once, after a real frame has been rendered. */
  onReady?: (api: StadiumApi) => void;
}

export default function StadiumGL({
  park = HARBOURFRONT,
  mode = 'wide',
  daylight = 'day',
  seed = DEFAULT_SEED,
  exposure = 1,
  qualityOverride = null,
  scaleReference = false,
  aiming = false,
  flight = null,
  ballTimeS = null,
  board = null,
  boardTimeS = null,
  onReady,
}: StadiumGLProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<StadiumApi | null>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  // ⚠ A LIVE REF, READ BY THE LOOP — not a dependency of the build effect. The
  // board's content changes several times a pitch and rebuilding a stadium for
  // it would be `CourseGL`'s remount-per-hole cost arriving per swing.
  const boardRef = useRef<{ feed: BoardFeed | null; frozen: number | null }>({
    feed: board,
    frozen: boardTimeS,
  });
  boardRef.current = { feed: board, frozen: boardTimeS };
  const initialRef = useRef({ mode, exposure, flight, ballTimeS, aiming });
  initialRef.current = { mode, exposure, flight, ballTimeS, aiming };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // --- disposal ledger. EVERY geometry, material and texture BUILT BY A
    // `stadium/*` BUILDER goes through `track`; the unmount path below walks it.
    // A leaked BufferGeometry is invisible until the fifth remount, which is
    // exactly why this is a ledger and not a hand-written list of dispose calls
    // at the bottom.
    //
    // ⚠ THE SCOPE CLAUSE ABOVE IS NOT PEDANTRY. This comment used to claim
    // "EVERY geometry, material and texture", full stop, and it was not true: the
    // sun's shadow map is a render target this file allocates directly, three's
    // `WebGLRenderer.dispose()` does not walk lights, and it is not in `owned`.
    // `forceContextLoss()` below makes that harmless for GPU memory, so it was a
    // COMMENT bug rather than a leak — but a ledger whose stated invariant is
    // false is a ledger the next remount bug hides behind. The unmount path now
    // disposes it explicitly and the claim is true as scoped.
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

    // ⚠ ONE ROW OF THE LIGHTING TABLE, READ ONCE. Everything below that differs
    // between a day game and a night game reads `light`, and nothing anywhere
    // branches on `daylight === 'night'` — a second row is data, never a branch.
    const light = daylightOf(daylight);

    const scene = new Scene();
    scene.background = new Color(light.clearHex);
    const camera = new PerspectiveCamera(45, 1, 0.5, 6000);

    // --- lights. The whole budget: one shadow-casting sun, one hemisphere fill.
    // ⚠ AT NIGHT IT IS THE SAME TWO. The sun becomes an overhead rig and the
    // fill goes dim; nothing is added. See `stadium/daylight.ts` for why four
    // floodlights are refused rather than merely not done yet.
    const sun = new DirectionalLight(light.sunHex, light.sunIntensity);
    sun.position.set(...light.sunPos);
    sun.target.position.set(...light.sunTarget);
    sun.castShadow = quality.shadows;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    // ⚠ THE NORMAL BIAS IS IN WORLD FEET AND IT HAS TO BE BIG. A 1024² map over
    // a ~1260 ft shadow volume is 1.23 ft per texel (measured by the M1 visual
    // gate), so a sub-foot bias leaves the grass striped with self-shadow acne —
    // measured, on the first render. The honest fix at this budget is a bias of
    // order one texel; raising the map instead is the on-device bet
    // stadium/quality.ts refuses to take.
    //
    // ⚠⚠ THE BALL LANDED IN M2b, AND THIS WARNING STANDS — WITH NUMBERS.
    // 6 ft is correct only because every object in this scene is enormous. A
    // baseball's radius is 0.1210237 ft (`airPhysics.ts`), so this bias is
    // 49.6× the whole ball. Measured by the visual gate, which now prints the
    // shadow row every run: the volume is ±630 ft at Harbourfront (±645 at
    // Alpine), i.e. 1.230 ft/texel at 1024² — the texel alone is 10.2× the ball.
    // A ball in this shadow-casting set therefore produces a shadow pushed clear
    // of it, and the symptom a human reports is "the ball floats" — a sentence
    // that points at the physics, the camera or the material, i.e. at three
    // subsystems that are all innocent. M1 already lost time to one of these: a
    // near/far depth bug that presented as a translucent seating bowl and read
    // as a material problem.
    //
    // WHAT M2b DID, and why it is not the recorded fix:
    //
    //   • The ball is NOT a shadow caster (`stadium/flight.ts` sets
    //     `castShadow = false`) and its contact shadow is COMPUTED — the true
    //     ray from this sun through the ball's true centre to y = 0, drawn as
    //     one disc. Exact in position, approximate in softness, one draw call,
    //     and it cannot detach because nothing samples a shadow map.
    //   • The recorded fix — a tighter cascade around the infield — was measured
    //     and does NOT solve it at this budget. ~6× texel density means a
    //     ±100 ft ortho volume: 0.195 ft/texel, still 1.6× the ball, so a normal
    //     bias "of order 0.2 ft" is still 1.6 ball radii and the shadow still
    //     detaches. Resolving a 0.121 ft ball needs texel ≲ its radius, i.e. a
    //     half-extent of ≤ 62 ft at 1024² — which the ball leaves 0.9 s into a
    //     434 ft fly, so the cascade would have to FOLLOW it. That is a real
    //     CSM: a second `DirectionalLight` splitting this sun's intensity
    //     (double-darkening wherever the volumes overlap) plus per-frame shadow
    //     updates for that light, which forfeits the `autoUpdate = false` above.
    //     Larger than M2b, and it buys a soft blob the disc already draws.
    //
    // The fix is still NOT a bigger map (see `stadium/quality.ts`: 1024² is a
    // hard ceiling until somebody runs a real Android handset) and still NOT a
    // smaller global bias (the acne comes straight back on 1260 ft of turf).
    sun.shadow.bias = -0.001;
    sun.shadow.normalBias = 6;
    scene.add(sun, sun.target);
    // The fill carries every surface the one sun cannot reach — chiefly the
    // backstop, which faces the sun's back. It is doing real work in daylight,
    // not adding a wash, so it is not a token 0.3; at night it drops to 0.45 and
    // the overhead rig takes over.
    scene.add(new HemisphereLight(light.hemiSkyHex, light.hemiGroundHex, light.hemiIntensity));

    // --- the park. Each builder pure, each returning a handle.
    const ctx: StadiumCtx = { scene, track, park, quality, seed, daylight: light };
    const field = buildField(ctx);
    const fence = buildFence(ctx);
    buildMound(ctx);
    // The sky, first, so it is behind everything. One BackSide dome, one map.
    buildSky(scene, track, quality.grainPx, light);
    const stands = buildStands(ctx);
    const roof = buildRoof(ctx, stands);
    // The centre-field structure — the frame, hotel window band, banners, flags
    // and the dark backing the array's panel gaps show through. It OWNS the
    // recess `buildStands` cut for it and the board's real geometry
    // (`CENTREFIELD_BOARD`); the array itself is `buildBoard` below.
    buildCentrefield(ctx, stands);
    // Outside the bowl, over the roof opening. One merged mesh, seeded, and it
    // deliberately does NOT enlarge the shadow volume below — see `skyline.ts`.
    // Its handle exists for one reason: the tower is the last link of the
    // home-run chain, and `buildBoard` drives it.
    const skyline = buildSkyline(ctx);
    // THE BOARD ARRAY — four quads reading four UV rects of one atlas, merged
    // into ONE draw call; the ribbon bands `buildStands` already drew, given a
    // map; and the tower's LED strips. One `update(array, tS)` moves all three,
    // which is what stops the celebration being half-wired.
    const boardPart = buildBoard(ctx, { stands, skyline });
    if (scaleReference) buildScaleReference(ctx);
    // The ball, its contact shadow and the two tracers. It takes the sun's
    // direction of travel because it projects the contact shadow itself — see
    // `stadium/flight.ts` and the `normalBias` note above.
    const ballFlight = buildFlight(ctx, {
      sunDir: [
        light.sunTarget[0] - light.sunPos[0],
        light.sunTarget[1] - light.sunPos[1],
        light.sunTarget[2] - light.sunPos[2],
      ],
    });
    if (initialRef.current.flight) ballFlight.setPaths(initialRef.current.flight);
    // The zone frame + aiming reticle, at the plate, in perspective. It owns no
    // gameplay: the HUD hands it a REPORT (x, h) that `DerbySim` already holds.
    const reticle = buildReticle(ctx);
    reticle.setReticle(ZONE_CENTER.x, ZONE_CENTER.h);
    reticle.setVisible(initialRef.current.aiming, initialRef.current.aiming);

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

    // The camera rig. It owns the placements, the ease between them and the
    // follow damping; this file owns the camera object and the loop that feeds
    // it. The MOUNT is a snap — an ease from nowhere is just a slower cut, and
    // the harness would then photograph a camera still in transit on frame 3.
    const rig = buildCameraRig();
    rig.snap(camera, initialRef.current.mode, null);

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
    const shadowTexelFt = (2 * half) / quality.shadowMapSize;
    let last: StadiumStats = emptyStats(quality, half, shadowTexelFt, light.id);
    // `ballTime` is a frozen TRUE PHYSICAL time when the screenshot harness (or
    // a paused HUD) sets one; the wall clock is then never consulted for the
    // BALL at all, which is what made two harness runs byte-identical before the
    // camera moved. The camera's own time now comes from the scene clock below,
    // which the harness freezes for the same reason.
    let ballTime: number | null = initialRef.current.ballTimeS ?? null;
    let playStartMs = 0;
    const projScratch = new Vector3();
    // ⚠ THE SCENE CLOCK, AND IT IS THE ONLY CLOCK THIS FILE READS. `sceneNow()`
    // and `tickSceneClock()` are `performance.now()` verbatim until a harness
    // calls `engageVirtualClock()`, so the shipped app is unchanged to the
    // millisecond — and with the clock engaged and FROZEN, `dt` is exactly 0,
    // the camera ease does not advance and the follow damping's factor is
    // `1 − e⁰ = 0`. That is what lets a moving camera coexist with the
    // byte-identical-PNG claim. Golf measured 23 of 25 scenes differing between
    // two identical runs before it did this; see `lib/scene3d/README.md`.
    let lastClockMs = sceneNow();
    let boardTS = 0;
    const tick = (rafNowMs?: number) => {
      const nowMs = tickSceneClock(rafNowMs);
      const dtS = (nowMs - lastClockMs) / 1000;
      lastClockMs = nowMs;
      // ⚠ THE BOARD'S CLOCK, AND IT IS A SUBTRACTION OF TWO `sceneNow()`S rather
      // than an accumulated `dt`. An accumulator drifts with the frame rate and
      // cannot be frozen without also freezing the camera; this reads the same
      // clock the camera ease reads, so a frozen scene gives a fixed `tS` and
      // the celebration's 12 Hz frame is the same frame on both harness runs.
      const feed = boardRef.current.feed;
      if (feed) {
        boardTS = boardRef.current.frozen ?? Math.max(0, nowMs / 1000 - feed.sinceS);
        boardPart.update(feed.array, boardTS);
      }
      if (ballTime !== null) {
        ballFlight.setTime(ballTime);
      } else {
        const dur = ballFlight.durationS();
        if (dur > 0) {
          if (playStartMs === 0) playStartMs = nowMs;
          // ⚠ THE TEMPO SCALES THE CLOCK, NEVER `dt`, AND IT IS A MULTIPLY.
          // `pitchSim` integrated this flight at true physical time and cannot
          // import `PITCH_TEMPO`; the render layer MULTIPLIES its own wall clock
          // by it (`trueS = wallS × PITCH_TEMPO`, so the flight takes `1/tempo`
          // as long to watch) and asks for a true physical instant. Time-scaling `dt`
          // instead would re-weight gravity against the v² aero terms and
          // silently move every break number. This branch is the STANDALONE
          // scene's replay; when a HUD is driving, `DerbyGame.trueTimeOf` owns
          // the same identity and `setBallTime` arrives already converted.
          const played = ((nowMs - playStartMs) / 1000) * PITCH_TEMPO;
          ballFlight.setTime(played % (dur + REPLAY_GAP_S));
        } else ballFlight.setTime(-1);
      }
      // ⚠ AFTER `setTime`, BEFORE `sizeFor` AND `render`. The rig follows the
      // ball's position for THIS frame, and `sizeFor` needs the camera the frame
      // is actually drawn with — get either order wrong and the ball's
      // screen-space size floor is computed against last frame's camera.
      rig.update(camera, dtS, ballFlight.followScene());
      // The screen-space size floor, against the DRAWING BUFFER's height —
      // real pixels, not CSS ones. See `MIN_BALL_PX` in stadium/flight.ts.
      ballFlight.sizeFor(camera, renderer.domElement.height);
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
        shadowHalfFt: half,
        shadowTexelFt,
        daylight: light.id,
      };
      frames++;
      if (frames === 3) onReadyRef.current?.(api);
      raf = requestAnimationFrame(tick);
    };

    const api: StadiumApi = {
      stats: () => last,
      measureFence: (deg) => fence.sample(deg),
      measureRoof: (deg) => roof.sample(deg),
      setMode: (m) => rig.setMode(m),
      cameraAim: () => ({ target: rig.target(), progress: rig.progress(), mode: rig.mode() }),
      setExposure: (e) => {
        renderer.toneMappingExposure = e;
      },
      // ⚠ A NEW FLIGHT RESTARTS THE PLAYBACK CLOCK, and that is a bug fix, not
      // symmetry for its own sake. `playStartMs` is latched on the first live
      // frame after it is zeroed; `setBallTime` zeroed it and this did not, and
      // the two are INDEPENDENT effects below. So a HUD serving pitch 2 in live
      // playback (no `?t=`) kept pitch 1's clock and pitch 2 opened at
      // `played % (dur + REPLAY_GAP_S)` — mid-flight, at whatever fraction the
      // previous play happened to be at. The screenshot harness cannot see this
      // because it always freezes, which is precisely why it had to be found by
      // reading rather than by a red run.
      setFlight: (paths) => {
        ballFlight.setPaths(paths ?? { pitch: null, batted: null, contactTS: 0 });
        playStartMs = 0;
      },
      setBallTime: (t) => {
        ballTime = t;
        playStartMs = 0;
      },
      setReticle: (x, h) => reticle.setReticle(x, h),
      setAiming: (on) => reticle.setVisible(on, on),
      reticleScene: () => reticle.reticleScene(),
      tracer: (which) => ballFlight.tracer(which),
      tracerFull: (which) => ballFlight.tracerFull(which),
      tracerVisible: (which) => ballFlight.tracerVisible(which),
      ballScene: () => ballFlight.ballScene(),
      ballScreen: () => {
        const p = ballFlight.ballVisible() ? ballFlight.ballScene() : null;
        if (!p) return null;
        // `project` mutates in place, so one scratch vector for the lifetime of
        // the scene — this is read every frame by the ExitVelo tag's rAF and a
        // fresh Vector3 per frame is the per-frame allocation the HUD rules ban.
        projScratch.set(p[0], p[1], p[2]).project(camera);
        // NDC z outside [-1, 1] is outside the frustum; behind the camera it is
        // > 1 AND x/y are mirrored, so returning a position there would fly the
        // tag to the wrong side of the screen.
        if (projScratch.z < -1 || projScratch.z > 1) return null;
        return [(projScratch.x + 1) / 2, (1 - projScratch.y) / 2];
      },
      ballVisible: () => ballFlight.ballVisible(),
      ballScale: () => ballFlight.ballScale(),
      board: () =>
        boardPart.scoreboard === null
          ? null
          : {
              panels: boardPart.panels,
              geometry: boardPart.geometry,
              current: boardPart.scoreboard.current(),
              uploads: boardPart.scoreboard.uploads(),
              ribbonUploads: boardPart.scoreboard.ribbonUploads(),
              // ⚠ THREE'S OWN COUNTER, BESIDE THE MODULE'S. `scoreboard.ts` says
              // in as many words that its `uploads()` is self-referential —
              // deleting `texture.needsUpdate = true` leaves it perfectly
              // correct and the board frozen. `version` is incremented inside
              // three's `needsUpdate` setter, so the PAIR is the measurement.
              textureVersion: boardPart.scoreboard.texture.version,
              tS: boardTS,
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
      // The one GPU resource this file allocates itself rather than through a
      // builder, and so the one that is not in the ledger. See the note above it.
      sun.shadow.dispose();
      renderer.dispose();
      // ⚠ WebGL contexts are a scarce browser resource (~16 live). Golf learned
      // this remounting a scene per hole; drop it explicitly, do not wait for GC.
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    };
    // `daylight` and `seed` are BUILD inputs — the sky's gradient is baked into a
    // canvas and the tower's programme into a vertex-colour attribute, so both
    // are decided once. See the `daylight` prop's note.
  }, [park, qualityOverride, scaleReference, daylight, seed]);

  useEffect(() => {
    apiRef.current?.setMode(mode);
  }, [mode]);

  useEffect(() => {
    apiRef.current?.setExposure(exposure);
  }, [exposure]);

  // ⚠ A NEW FLIGHT IS NOT A NEW SCENE. These two are separate effects from the
  // build above precisely so that serving a pitch does not tear down and rebuild
  // the park — which is `CourseGL`'s remount-per-hole cost, arriving here once
  // per pitch instead of once per hole.
  useEffect(() => {
    apiRef.current?.setFlight(flight ?? null);
  }, [flight]);

  useEffect(() => {
    apiRef.current?.setBallTime(ballTimeS ?? null);
  }, [ballTimeS]);

  useEffect(() => {
    apiRef.current?.setAiming(aiming);
  }, [aiming]);

  return <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />;
}

function emptyStats(
  q: StadiumQuality,
  shadowHalfFt: number,
  shadowTexelFt: number,
  daylight: DaylightId,
): StadiumStats {
  return {
    drawCalls: 0,
    triangles: 0,
    programs: 0,
    geometries: 0,
    textures: 0,
    tier: q.tier,
    shadowMapSize: q.shadowMapSize,
    qualityReason: q.reason,
    shadowHalfFt,
    shadowTexelFt,
    daylight,
  };
}
