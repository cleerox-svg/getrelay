// THE BALL AND ITS FLIGHT — the ball mesh, its contact shadow, and the two
// tracers that draw where it has been.
//
// ⚠ ONE SOURCE. Everything drawn here is a frame conversion of a `PitchTrack`
// or a `BattedTrack` that a `lib/baseball` integrator produced. There is no
// smoothing, no spline, no re-integration and no "prettier" curve: the tracer's
// vertices ARE the sim's samples, and the ball is placed by `sampleTrack`, the
// function `pitchSim.ts` exports for exactly this purpose. A separate visual
// spline that disagrees with the sim is the single bug class the visual gate
// exists to catch, so it is designed out rather than tested for.
//
// ⚠ NO CLOCK LIVES HERE. `setTime` takes TRUE PHYSICAL seconds since release.
// `StadiumGL` owns the clock and is the one place `PITCH_TEMPO` is applied; a
// frozen `?t=` from the screenshot harness and a live rAF loop reach this file
// through the same call, which is what makes a shot reproducible.
//
// ⚠ THE BALL'S SIZE IS A LIE AND ITS POSITION IS NOT. See `MIN_BALL_PX`.

import {
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  SphereGeometry,
} from 'three';
import type { PerspectiveCamera } from 'three';
import { BALL_RADIUS_FT } from '../../../lib/baseball/airPhysics';
import { sampleTrack } from '../../../lib/baseball/pitchSim';
import type { PitchTrack } from '../../../lib/baseball/pitchSim';
import type { BattedTrack } from '../../../lib/baseball/battedBallSim';
import { buildTracer } from './tracer';
import type { TracerHandle } from './tracer';
import type { StadiumCtx, StadiumPart } from './geom';

/**
 * Tracer colours. FEEL KNOBS — nothing physical, chosen to read against turf
 * (green), dirt (brown) and sky (blue) in a 1 px line.
 */
const PITCH_TRACER_COLOR = 0xffe14d;
const BATTED_TRACER_COLOR = 0xff5533;

/** Ball albedo. FEEL KNOB — off-white leather, no seams at this milestone. */
const BALL_COLOR = 0xf7f4ea;

/**
 * Buffer sizes, DERIVED from the substep and the sims' own flight bounds so a
 * long flight cannot silently truncate:
 *   pitch  — ~0.42 s at `FIXED_MS` = 1/120 s is 51 samples + the plate sample.
 *   batted — `battedBallSim.MAX_FLIGHT_S` is 12 s ⇒ 1440 + the ground sample.
 * Rounded up to leave headroom for a slower pitch and an off-the-roof pop-up.
 */
const PITCH_MAX_POINTS = 128;
const BATTED_MAX_POINTS = 1536;

/**
 * ⚠ THE BALL-VISIBILITY DECISION, AND IT IS A DELIBERATE LIE ABOUT SIZE.
 *
 * The physics radius is 0.1210237 ft (`airPhysics.BALL_RADIUS_FT`, derived from
 * the 9.125 in circumference). Its projected radius in pixels is
 *
 *     px = (r / dist) · H / (2·tan(fov/2))
 *
 * so in this harness's 1600 px-tall portrait frame the ball falls under one
 * pixel — i.e. becomes INVISIBLE — beyond:
 *
 *     camera   fov    r = 0.121 ft is 2.5 px at        …and 1 px at
 *     batter   40°    106 ft                           266 ft
 *     pitcher  26°    168 ft                           419 ft
 *     flight   55°     74 ft                           186 ft
 *     wide     56°     72 ft                           181 ft
 *
 * A 400 ft home run is therefore sub-pixel for ~80 % of its flight from the
 * `flight` camera. Every baseball game solves this; the options are a constant
 * render scale, a trail, or a minimum screen-space size.
 *
 * WHAT IS SHIPPED: a MINIMUM SCREEN-SPACE SIZE and nothing else — no constant
 * scale factor. That ordering is the point. A constant scale (say 3×) would
 * inflate the ball in `batter` and `pitcher`, which are the two shots the scale
 * reference exists to police, and where the true-size ball is already 13 px and
 * 7 px and needs no help. The floor only ever engages where the truth is
 * literally unrenderable, so wherever a human can judge the ball's size against
 * the plate or the wall, it is the real size.
 *
 * 2.5 px is a FEEL KNOB: below ~2 px an antialiased sphere is a grey smudge, and
 * above ~4 px a ball at the wall starts reading as a beach ball in `wide`.
 *
 * ⚠ THE BALL'S POSITION IS NEVER SCALED. Only `Mesh.scale` moves; the mesh
 * centre stays on the sim's sampled point to the last float. The trail (both
 * tracers) is drawn at true positions too, so what the gate measures is the
 * physics regardless of what the sphere's radius is doing.
 */
const MIN_BALL_PX = 2.5;

/**
 * The contact shadow: a flat disc projected along the sun onto the ground.
 *
 * ⚠ THIS EXISTS BECAUSE THE SHADOW MAP CANNOT DO IT, and that is measured, not
 * assumed — see the `normalBias` note in `StadiumGL.tsx`. The sun's shadow
 * volume is ~630 ft half-extent at 1024², i.e. ~1.23 ft per texel, which is
 * 10× the whole ball; its `normalBias` is 6 ft, ~50×. A ball in the
 * shadow-casting set at that budget produces a shadow that is detached or
 * absent, and the symptom a human reports is "the ball floats". So the ball is
 * explicitly NOT a shadow caster and its contact shadow is computed here
 * instead: exact in POSITION (the true ray from the sun through the ball's true
 * centre to y = 0), approximate in softness.
 *
 * `PENUMBRA_PER_FT` and `FADE_HEIGHT_FT` are FEEL KNOBS: a real penumbra grows
 * with the source's angular size, which a directional light does not have.
 */
const SHADOW_COLOR = 0x1d2a18;
const SHADOW_OPACITY = 0.4;
const SHADOW_PENUMBRA_PER_FT = 0.05;
const SHADOW_FADE_HEIGHT_FT = 80;
/** Above the tallest ground layer (`field.ts` puts home plate at y = 0.3). */
const SHADOW_Y_FT = 0.32;

export interface FlightPaths {
  /** The pitch, REPORT frame, exactly as `simulatePitch` returned it. */
  pitch: PitchTrack | null;
  /** The batted ball, WORLD frame (plate-centred), from `simulateBattedBall`. */
  batted: BattedTrack | null;
  /**
   * TRUE physical seconds from release to contact — where the batted ball's own
   * clock starts. `setTime` runs on one release-relative timeline so a single
   * `?t=` can freeze either half of the play.
   */
  contactTS: number;
}

export interface FlightHandle extends StadiumPart {
  setPaths(paths: FlightPaths): void;
  /** Place the ball at TRUE PHYSICAL seconds since release. */
  setTime(tS: number): void;
  /** Apply the screen-space size floor. Call AFTER `setTime`, before render. */
  sizeFor(camera: PerspectiveCamera, viewportHeightPx: number): void;
  /** The drawn ball's scene position, or null when it is not in flight. */
  ballScene(): [number, number, number] | null;
  /** Is the ball mesh actually being rendered? */
  ballVisible(): boolean;
  /** The ball's DRAWN radius, scene ft. `BALL_RADIUS_FT` unless the floor bit. */
  ballScale(): number;
  /** The tracer vertices AS DRAWN — the visual gate reads this. */
  tracer(which: 'pitch' | 'batted'): number[];
  /** Is that tracer actually being rendered? */
  tracerVisible(which: 'pitch' | 'batted'): boolean;
  /** Total length of the play, true physical seconds. */
  durationS(): number;
}

export interface FlightOptions {
  /** Direction the sunlight TRAVELS, scene space. Not normalised on input. */
  sunDir: [number, number, number];
}

/**
 * REPORT (d, x, h) → scene. `zone.ts`: `d` is + toward centre field, `x` is +
 * to the umpire's right = the first-base side, `h` is height. `geom.ts`: scene
 * `+x` is the first-base side, `+y` is up, `−z` is toward centre field.
 */
const sceneFromReport = (d: number, x: number, h: number): [number, number, number] => [x, h, -d];

/**
 * WORLD (x, y, z) → scene, for the batted ball. `geom.ts` declares the cyclic
 * permutation `scene = (world.y, world.z, world.x)`; the batted-ball WORLD
 * origin is the contact point at the plate, which is the scene origin too.
 */
const sceneFromWorld = (x: number, y: number, z: number): [number, number, number] => [y, z, x];

export function buildFlight(ctx: StadiumCtx, opts: FlightOptions): FlightHandle {
  const { scene, track } = ctx;
  const group = new Group();
  group.name = 'flight';

  // A UNIT sphere, scaled per frame. One geometry, whatever the render radius
  // does — rebuilding a SphereGeometry to change a radius is the allocation
  // pattern `tracer.ts` exists to avoid, applied to the ball.
  const ball = new Mesh(
    track(new SphereGeometry(1, 16, 12)),
    track(new MeshLambertMaterial({ color: BALL_COLOR })),
  );
  ball.name = 'ball';
  // See SHADOW_COLOR's note: the ball is deliberately not in the shadow set.
  ball.castShadow = false;
  ball.receiveShadow = false;
  ball.visible = false;
  group.add(ball);

  const shadow = new Mesh(
    track(new CircleGeometry(1, 20)),
    track(
      new MeshBasicMaterial({
        color: SHADOW_COLOR,
        transparent: true,
        opacity: SHADOW_OPACITY,
        depthWrite: false,
      }),
    ),
  );
  shadow.name = 'ballContactShadow';
  shadow.rotation.x = -Math.PI / 2;
  shadow.visible = false;
  group.add(shadow);

  scene.add(group);

  const tracers: Record<'pitch' | 'batted', TracerHandle> = {
    pitch: buildTracer(ctx, {
      name: 'pitchTracer',
      color: PITCH_TRACER_COLOR,
      maxPoints: PITCH_MAX_POINTS,
    }),
    batted: buildTracer(ctx, {
      name: 'battedTracer',
      color: BATTED_TRACER_COLOR,
      maxPoints: BATTED_MAX_POINTS,
    }),
  };

  const sun = (() => {
    const [x, y, z] = opts.sunDir;
    const len = Math.hypot(x, y, z) || 1;
    return { x: x / len, y: y / len, z: z / len };
  })();

  let paths: FlightPaths = { pitch: null, batted: null, contactTS: 0 };
  let battedScene: number[] = [];
  let ballPos: [number, number, number] | null = null;

  const setPaths = (next: FlightPaths) => {
    paths = next;
    if (next.pitch && next.pitch.t.length > 1) {
      const pts: number[] = [];
      for (let i = 0; i < next.pitch.t.length; i++) {
        const p = sceneFromReport(next.pitch.d[i] ?? 0, next.pitch.x[i] ?? 0, next.pitch.h[i] ?? 0);
        pts.push(p[0], p[1], p[2]);
      }
      tracers.pitch.set(pts);
    } else tracers.pitch.clear();

    battedScene = [];
    if (next.batted && next.batted.t.length > 1) {
      for (let i = 0; i < next.batted.t.length; i++) {
        const p = sceneFromWorld(
          next.batted.x[i] ?? 0,
          next.batted.y[i] ?? 0,
          next.batted.z[i] ?? 0,
        );
        battedScene.push(p[0], p[1], p[2]);
      }
      tracers.batted.set(battedScene);
    } else tracers.batted.clear();
  };

  /**
   * Linear interpolation along the batted track's SCENE samples.
   *
   * ⚠ Identical by construction to what `sampleTrack` does for the pitch: the
   * REPORT/WORLD → scene maps above are linear, so interpolating converted
   * samples equals converting an interpolated sample. It is written out here
   * only because `battedBallSim` exports no sampler of its own — see the note in
   * `StadiumGL.tsx` about what the sim still owes the render layer.
   */
  const sampleBatted = (t: number): [number, number, number] | null => {
    const times = paths.batted?.t;
    if (!times || times.length === 0) return null;
    const last = times.length - 1;
    const at = (i: number): [number, number, number] => [
      battedScene[i * 3] ?? 0,
      battedScene[i * 3 + 1] ?? 0,
      battedScene[i * 3 + 2] ?? 0,
    ];
    if (t <= (times[0] ?? 0)) return at(0);
    if (t >= (times[last] ?? 0)) return at(last);
    let hi = 1;
    while (hi < last && (times[hi] ?? 0) < t) hi++;
    const t0 = times[hi - 1] ?? 0;
    const t1 = times[hi] ?? 0;
    const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
    const a = at(hi - 1);
    const b = at(hi);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };

  const setTime = (tS: number) => {
    const pitchEnd = paths.pitch?.t[paths.pitch.t.length - 1] ?? 0;
    let p: [number, number, number] | null = null;
    if (paths.batted && tS >= paths.contactTS) {
      p = sampleBatted(tS - paths.contactTS);
    } else if (paths.pitch && paths.pitch.t.length > 1 && tS >= 0 && tS <= pitchEnd) {
      // The SAME sampler the swing resolves against — pitchSim exports it for
      // this call, so what is drawn and what is hit cannot disagree.
      const s = sampleTrack(paths.pitch, tS);
      p = sceneFromReport(s.d, s.x, s.h);
    }
    ballPos = p;
    ball.visible = p !== null;
    shadow.visible = p !== null;
    if (!p) return;
    ball.position.set(p[0], p[1], p[2]);
    // The true ray from the sun through the ball's true centre to the ground.
    const drop = sun.y < -1e-6 ? p[1] / -sun.y : 0;
    shadow.position.set(p[0] + sun.x * drop, SHADOW_Y_FT, p[2] + sun.z * drop);
  };

  const sizeFor = (camera: PerspectiveCamera, viewportHeightPx: number) => {
    if (!ballPos) return;
    const dx = ballPos[0] - camera.position.x;
    const dy = ballPos[1] - camera.position.y;
    const dz = ballPos[2] - camera.position.z;
    const dist = Math.hypot(dx, dy, dz);
    const h = Math.max(1, viewportHeightPx);
    const halfFov = ((camera.fov * Math.PI) / 180) / 2;
    // Invert px = (r/dist)·H/(2·tan(fov/2)) for the radius that yields MIN_BALL_PX.
    const rFloor = (MIN_BALL_PX * dist * 2 * Math.tan(halfFov)) / h;
    const r = Math.max(BALL_RADIUS_FT, rFloor);
    ball.scale.setScalar(r);
    const height = Math.max(0, ballPos[1]);
    shadow.scale.setScalar(r * (1 + height * SHADOW_PENUMBRA_PER_FT));
    const mat = shadow.material as MeshBasicMaterial;
    mat.opacity = SHADOW_OPACITY * Math.max(0, 1 - height / SHADOW_FADE_HEIGHT_FT);
  };

  return {
    group,
    setPaths,
    setTime,
    sizeFor,
    // ⚠ READ THE MESH, NOT THE CLOSURE. This used to return `ballPos` — the
    // variable `setTime` had just computed — which made it a TAUTOLOGY: delete
    // the `ball.position.set(...)` above and it still answered correctly, so the
    // gate could not tell a drawn ball from an undrawn one. `tracer.ts` is
    // explicit that a read-back must come out of the object the GPU consumes,
    // and this is the same rule applied to the ball. `null` still means "not in
    // flight", which is a state of the SETTER, so that part stays with `ballPos`.
    ballScene: () => (ballPos ? (ball.position.toArray() as [number, number, number]) : null),
    ballVisible: () => ball.visible && group.visible,
    ballScale: () => ball.scale.x,
    tracer: (which) => tracers[which].read(),
    tracerVisible: (which) => tracers[which].visible(),
    durationS: () => {
      const pitchEnd = paths.pitch?.t[paths.pitch.t.length - 1] ?? 0;
      const battedEnd = paths.batted?.t[paths.batted.t.length - 1] ?? 0;
      return Math.max(pitchEnd, paths.batted ? paths.contactTS + battedEnd : 0);
    },
  };
}
