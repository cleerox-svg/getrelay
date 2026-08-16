// Dev/CI-only preview harness for the baseball stadium scene. Mounts exactly one
// `StadiumGL` standalone — no <App>, no auth, no store — so the renderer can be
// screenshotted headlessly (`scripts/shoot-baseball.mjs`) for visual QA. It is
// never imported by the app and is not a production build input.
//
// URL query:
//   ?scene=batter|pitcher|flight|wide   camera MODE (one scene, four cameras)
//   ?park=harbourfront|alpine           which row of PARKS to build
//   ?quality=low|medium|high            forced tier — see stadium/quality.ts
//   ?exposure=<number>                  tone-mapping exposure (night games)
//   ?pitch=ff|si|fc|sl|st|cu|ch|fs      which row of PITCHES to throw
//   ?t=<seconds>                        FREEZE the ball at true physical
//                                       seconds since release
//   ?hit=1                              also simulate the batted ball
//   ?bt=<seconds>                       freeze at seconds since CONTACT
//                                       (implies hit=1)
//   ?seed=<int>                         DerbySim seed
//   ?aim=<u>,<v>                        SHOW the zone frame + reticle, placed
//                                       at reticle (u, v) ∈ [−1, 1] (zone.ts).
//                                       Omit and neither is built into a shot.
//
// ⚠ THE READY BEACON WAITS FOR A REAL FRAME. `window.__baseballReady` is set
// from StadiumGL's `onReady`, which fires after three rendered frames — not on
// DOMContentLoaded and not on a timer. A screenshot taken before the first
// render is a black PNG that passes every check a human is not looking at.
//
// ⚠ EVERYTHING HERE IS SEEDED OR FROZEN. With `?t=` or `?bt=` present the
// renderer never reads `performance.now()`, the pitch is `simulatePitch` on a
// named row of `PITCHES` at a fixed target, and the batted ball is one
// `launchFromAngles` + `simulateBattedBall` with the roof shut. Two runs of the
// harness are byte-identical because there is nothing left in the loop to vary.

import { StrictMode, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import StadiumGL, { isCameraMode } from './components/baseball/StadiumGL';
import type { CameraMode, StadiumApi } from './components/baseball/StadiumGL';
import type { FlightPaths } from './components/baseball/stadium/flight';
import { vec3 } from './lib/baseball/airPhysics';
import { fenceAt, HARBOURFRONT, parkById, parkConditions } from './lib/baseball/parks';
import { PITCHES } from './lib/baseball/pitches';
import type { PitchId } from './lib/baseball/pitches';
import { GAME_AIR, measureBreak, simulatePitch } from './lib/baseball/pitchSim';
import { launchFromAngles, simulateBattedBall } from './lib/baseball/battedBallSim';
import { DerbySim } from './lib/baseball/derbySim';
import { BREAK_SEGMENT_FT } from './lib/baseball/tuning';
import { reticleToPlate, ZONE_CENTER } from './lib/baseball/zone';

/**
 * ⚠ ONE PER-GAME NAMESPACE, NOT `window.__sim`. `src/golfpreview.tsx` declares
 * `window.__sim` globally as `CourseSim | PuttSim`, and TypeScript requires
 * merged interface declarations to agree — so a second game hanging its own
 * shape off the same name either edits golf's file or casts around the collision
 * forever. Everything baseball exposes lives under `window.__baseball`, which
 * the unified screenshot driver can register per game without either game
 * knowing about the other. M1 used `__sim` + `__stadium` here; both are gone
 * rather than kept alongside (rule 10).
 */
interface BaseballHandle {
  sim: {
    parkId: string;
    roofPeakFt: number;
    foulTerritoryFt: number;
    /** What `parks.ts` says the wall is at a bearing (pchip, not the knots). */
    fenceAt(bearingDeg: number): { distFt: number; heightFt: number };
    /**
     * The live derby. Exposed so the harness — and later a HUD fixture — can
     * drive a deterministic session and read its numbers, rather than the
     * preview mirroring a copy of them.
     */
    derby: DerbySim;
    pitch: {
      id: PitchId;
      /** TRUE physical seconds from release to the plate crossing. */
      flightTimeS: number;
      plate: { x: number; h: number; speedMph: number; strike: boolean };
      /** Break on the PUBLISHED convention (ISA air, 50 ft segment), inches. */
      breakRefIn: { ivbIn: number; hbIn: number };
      /** Break measured in the air this pitch actually flew in, inches. */
      breakGameIn: { ivbIn: number; hbIn: number };
      segmentFt: number;
      /** The sim's own samples, REPORT frame. The gate's reference path. */
      track: { t: number[]; d: number[]; x: number[]; h: number[] };
    };
    batted: {
      evMph: number;
      laDeg: number;
      sprayDeg: number;
      carryFt: number;
      apexFt: number;
      hangS: number;
      track: { t: number[]; x: number[]; y: number[]; z: number[] };
    } | null;
    /** The FROZEN instant, true physical s since release, or null if live. */
    ballTimeS: number | null;
    /** True physical s from release to contact — the batted clock's origin. */
    contactTS: number;
  };
  stadium: {
    mode: CameraMode;
    stats(): ReturnType<StadiumApi['stats']>;
    /** What the BUILT GEOMETRY says the wall is at a bearing. */
    measureFence(bearingDeg: number): { distFt: number; heightFt: number } | null;
    /** The DRAWN tracer's vertices, flat scene `[x, y, z, …]` ft. */
    tracer(which: 'pitch' | 'batted'): number[];
    tracerVisible(which: 'pitch' | 'batted'): boolean;
    /** Where the ball is actually drawn, scene ft. */
    ballScene(): [number, number, number] | null;
    ballVisible(): boolean;
    ballScale(): number;
  };
}

interface PreviewWindow {
  __baseballReady?: boolean;
  __baseball?: BaseballHandle;
}

const w = window as unknown as PreviewWindow;

const params = new URLSearchParams(location.search);
const sceneParam = params.get('scene');
const mode: CameraMode = isCameraMode(sceneParam) ? sceneParam : 'wide';
const park = parkById(params.get('park') ?? '') ?? HARBOURFRONT;
const num = (key: string, fallback: number): number => {
  const v = Number.parseFloat(params.get(key) ?? '');
  return Number.isFinite(v) ? v : fallback;
};
const exposureParam = num('exposure', 0);
const exposure = exposureParam > 0 ? exposureParam : 1;
const seed = Math.trunc(num('seed', 20260816)) >>> 0;

const pitchId = (params.get('pitch') ?? 'ff') as PitchId;
const pitch = PITCHES.find((p) => p.id === pitchId) ?? PITCHES[0]!;

/**
 * The batted ball is a DESIGNED LAUNCH, not a derby swing, and that is a gap
 * rather than a preference.
 *
 * `DerbySim.swing()` resolves the collision and flies the ball, but
 * `SwingResult` reports only scalars — exit velocity, launch angle, spray,
 * carry, hang, apex. The `BattedFlight` (and with it the sampled track) is
 * dropped on the floor inside `resolveSwing`, so the renderer cannot draw the
 * derby's own batted ball without either re-deriving the launch from those
 * scalars (which loses the spin the solve produced — a visual approximation,
 * i.e. exactly the defect this milestone exists to prevent) or duplicating
 * `resolveSwing`. Neither is acceptable, and `lib/baseball` is out of scope for
 * M2b, so the flight drawn here is built from the sim's own public
 * `launchFromAngles` + `simulateBattedBall` at published reference numbers, and
 * the object drawn IS the object reported. Adding `flight: BattedFlight` to
 * `SwingResult` is the fix and is filed as a finding.
 *
 * 105 mph / 26.5° / 2200 rpm is the max-carry ladder's 105 rung (BASEBALL.md
 * § "The carry experiment"); −12° of spray puts it in the left-centre gap so it
 * clears a 375 ft alley rather than the 400 ft centre, and so that a mirrored
 * lateral axis would be visible in the shot.
 *
 * ⚠ AND IT LAUNCHES FROM THE PLATE-CROSSING POINT, NOT `CONTACT_HEIGHT_FT`.
 * Measured: the pitch tracer ended at `ZONE_CENTER.h` = 2.50 ft and the batted
 * tracer began at `launchFromAngles`'s default 3.00 ft, so the two drawn curves
 * were 0.5000 ft apart at the instant they both describe as the same event.
 * Neither tracer check could see it — each is internally consistent against its
 * own sim track — so `checkContactSeam` in the harness now asserts it, and the
 * gap is 1.28e-16 ft. Nothing in `lib/baseball` was wrong: `launchFromAngles`
 * has taken the contact point as its 6th argument all along and
 * `derbySim.resolveSwing` already passes `pr.plate.h`. Only this preview was out
 * of step.
 */
const battedEvMph = num('ev', 105);
const battedLaDeg = num('la', 26.5);
const battedSprayDeg = num('spray', -12);
const battedBackspinRpm = num('backspin', 2200);

const wantHit = params.get('hit') === '1' || params.has('bt');

const result = simulatePitch({ pitch, hand: 'R', target: ZONE_CENTER });
const conditions = parkConditions(park, true, seed);
const batted = wantHit
  ? simulateBattedBall(
      launchFromAngles(
        battedEvMph,
        battedLaDeg,
        battedSprayDeg,
        battedBackspinRpm,
        0,
        vec3(0, 0, result.plate.h),
      ),
      conditions.air,
      conditions.windFps,
    )
  : null;

/**
 * The frozen instant, TRUE physical seconds since release. `?bt=` is measured
 * from CONTACT, so it is offset by the pitch's own flight time — one timeline
 * for the whole play, which is what lets a single `ballTimeS` freeze either half.
 */
const contactTS = result.plate.t;
const frozenTS = params.has('bt')
  ? contactTS + num('bt', 0)
  : params.has('t')
    ? num('t', 0)
    : null;

const derby = new DerbySim({ seed, park });

/**
 * The aim aid, as the DERBY sees it. `?aim=u,v` goes through
 * `DerbySim.setReticle` — i.e. through the sim's own clamp — rather than being
 * handed to the renderer directly, so the shot photographs a reticle the game
 * could actually have produced. `reticleToPlate` is the same mapping `servePitch`
 * locates against, which is what makes "the reticle you see is the reticle the
 * bat swings at" true rather than hopeful.
 */
const aimParam = params.get('aim');
if (aimParam) {
  const [u, v] = aimParam.split(',').map((s) => Number.parseFloat(s));
  const p = reticleToPlate(Number.isFinite(u) ? u! : 0, Number.isFinite(v) ? v! : 0);
  derby.setReticle(p.x, p.h);
}

w.__baseball = {
  sim: {
    parkId: park.id,
    roofPeakFt: park.roofPeakFt,
    foulTerritoryFt: park.foulTerritoryFt,
    fenceAt: (deg) => fenceAt(park, deg),
    derby,
    pitch: {
      id: pitch.id,
      flightTimeS: result.flightTimeS,
      plate: {
        x: result.plate.x,
        h: result.plate.h,
        speedMph: result.plate.speedMph,
        strike: result.plate.strike,
      },
      breakRefIn: measureBreak({ pitch, hand: 'R', target: ZONE_CENTER }),
      breakGameIn: measureBreak(
        { pitch, hand: 'R', target: ZONE_CENTER },
        BREAK_SEGMENT_FT,
        GAME_AIR,
      ),
      segmentFt: BREAK_SEGMENT_FT,
      track: result.track,
    },
    batted: batted
      ? {
          evMph: batted.evMph,
          laDeg: batted.laDeg,
          sprayDeg: batted.sprayDeg,
          carryFt: batted.carryFt,
          apexFt: batted.apexFt,
          hangS: batted.hangS,
          track: batted.track,
        }
      : null,
    ballTimeS: frozenTS,
    contactTS,
  },
  // Filled in by `onReady`; the beacon below is what says it is safe to read.
  stadium: null as unknown as BaseballHandle['stadium'],
};

function Preview() {
  // No state: the beacon is a window flag, and re-rendering the tree to record
  // it would remount the scene. Layer discipline — GL renders, nothing mirrors.
  const flight = useMemo<FlightPaths>(
    () => ({ pitch: result.track, batted: batted?.track ?? null, contactTS }),
    [],
  );

  const onReady = useCallback((api: StadiumApi) => {
    const handle = w.__baseball;
    if (!handle) return;
    if (aimParam) api.setReticle(derby.reticleX, derby.reticleH);
    handle.stadium = {
      mode,
      stats: () => api.stats(),
      measureFence: (deg) => api.measureFence(deg),
      tracer: (which) => api.tracer(which),
      tracerVisible: (which) => api.tracerVisible(which),
      ballScene: () => api.ballScene(),
      ballVisible: () => api.ballVisible(),
      ballScale: () => api.ballScale(),
    };
    w.__baseballReady = true;
  }, []);

  return (
    <StadiumGL
      park={park}
      mode={mode}
      exposure={exposure}
      qualityOverride={params.get('quality')}
      // The magenta 6 ft measuring stick. OFF by default in the component so it
      // can never reach a HUD; ON here, because this preview IS the visual gate
      // and the scale check is one of the things it exists to photograph.
      scaleReference
      aiming={!!aimParam}
      flight={flight}
      ballTimeS={frozenTS}
      onReady={onReady}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
