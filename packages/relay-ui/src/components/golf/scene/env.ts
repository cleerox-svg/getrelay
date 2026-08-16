/**
 * Golf's sky environment — the NUMBERS behind `lib/scene3d/env.ts`'s painter,
 * and the one place scene-wide IBL is switched on.
 *
 * WHAT CHANGED, AND WHY IT IS A REVERSAL
 * --------------------------------------
 * `lib/golf/scenery.ts` `makeSkyEnvMap` has always built a PMREM, and all three
 * scenes carried the same comment explaining that it was attached to the BALL's
 * `envMap` only — never `scene.environment` — "so turf/trees/water pay no
 * per-frame env cost". That was a considered decision, not an oversight.
 *
 * It is reversed here at `medium`/`high` because `/GRAPHICS.md` §1 names
 * scene-wide IBL as one of the four things that actually close the fidelity gap,
 * and because the env it was measured against was not an environment at all: an
 * 8×128 gradient makes a **2×2 cube** under three's `width / 4` rule, i.e. a flat
 * wash. "Scene-wide IBL bought nothing" was true of THAT texture. `low` keeps the
 * old path exactly, so the original reasoning still governs the hardware it was
 * written for.
 *
 * ⚠ THE TRAP, WRITTEN DOWN. IBL on top of the existing hemisphere fill
 * double-counts the ambient term and flattens the scene to grey — which looks
 * exactly like "the IBL did not work" and sends you tuning the wrong knob. The
 * fill is therefore cut IN THE SAME CALL: `hemiFill()` is the only way a scene
 * sets its hemisphere intensity, and it reads the same `quality.ibl` flag that
 * decides whether `scene.environment` is set at all. Do not set one without the
 * other.
 *
 * THE PALETTE IS THE SKY DOME'S. Every colour below is a stop lifted from
 * `scenery.ts` `makeSkyTexture` / `makeSkyGradientTexture`. The pond reflects
 * that same gradient (`water.ts`), so if the three drift the water reflects one
 * sky, the ball another, and the dome shows a third.
 */

import * as THREE from 'three';
import { buildSkyEnv, sunAnglesFromDirection, type SkyEnvConfig } from '../../../lib/scene3d/env';
import type { SceneQuality } from '../../../lib/scene3d/quality';
import { makeSkyEnvMap, type Track } from '../../../lib/golf/scenery';

/** Sky-dome zenith (`makeSkyTexture` stop 0). */
const ZENITH = 0x1f6ec8;
/** The pale band just above the horizon (`makeSkyGradientTexture` stop 0.46). */
const SKY_MID = 0x8ac6ea;
/** Horizon haze — the same value the fog and the dome's horizon stop use. */
const HORIZON = 0xdceff8;
/**
 * Ground bounce. Sits between `makeSkyGradientTexture`'s sub-horizon `#7fa06a`
 * and its nadir `#40592f`: the light a golf scene gets from BELOW is mown turf,
 * and getting that wrong is what makes undersides of foliage read as dead grey.
 * (This is the value baseball will swap for infield brown.)
 */
const GROUND_BOUNCE = 0x5c7a4a;
/**
 * Sun tint for the env. One value for all three scenes even though Putt's key
 * light is a hair warmer (`0xfff4e0` vs `0xfff1d6`) — this paints the SKY, and
 * three scenes under three skies is exactly the drift the shared kit exists to
 * stop.
 */
const SUN_TINT = 0xfff1d6;

/**
 * Sky geometry + energy. Elevation/azimuth are filled in per scene from that
 * scene's own `DirectionalLight`, so the env's sun and the key light can never
 * point in different directions.
 *
 * ⚠ `sunIntensity` is the radiance of a TRUE-SIZED 0.53° disc, so it looks
 * enormous and is not: 60 × 6.7e-5 sr ≈ 0.004 of diffuse irradiance, i.e.
 * nothing. That is the intent — the `DirectionalLight` is the key, and an env
 * sun carrying the key's energy would double it. The disc exists for the glint
 * on the ball and the water. The HALO is the knob that puts directional bias
 * into the diffuse term, and it is deliberately gentle for the same reason.
 */
export const GOLF_SKY: Omit<SkyEnvConfig, 'elevationDeg' | 'azimuthDeg'> = {
  sunAngularDiameterDeg: 0.53,
  sunColor: SUN_TINT,
  sunIntensity: 60,
  haloRadiusDeg: 28,
  haloIntensity: 1.1,
  zenithColor: ZENITH,
  skyMidColor: SKY_MID,
  skyMidElevationDeg: 8,
  horizonColor: HORIZON,
  groundColor: GROUND_BOUNCE,
  // 512 → a 128 cube → 1.5 MiB (see `skyEnvBytes`). Three calls 1024 "ideal",
  // which is a 256 cube at 6 MiB; on the fleet that lost a WebView GPU process
  // to a 16 MB shadow map, a smooth procedural sky does not earn 4.5 MiB more.
  width: 512,
};

/**
 * `scene.environmentIntensity`. Set EXPLICITLY rather than left at three's
 * default of 1, because the number is the whole balance of the change.
 *
 * Derived, not guessed. The painted sky's cosine-weighted irradiance on an
 * up-facing normal is (0.44, 1.09, 2.18) at intensity 1; the hemisphere light it
 * replaces delivered (0.64, 0.86, 1.05) at intensity 1.05. At 0.5 here plus
 * `HEMI_IBL_FACTOR` below, total ambient luminance lands within ~10% of what the
 * scene had, but the colour moves: less red, considerably more blue. That is the
 * point — warm key, cool sky-lit shade is what a sunlit outdoor scene does, and
 * a desaturated hemisphere light cannot express it.
 */
export const ENV_INTENSITY = 0.5;

/**
 * What the hemisphere fill is multiplied by once IBL carries the ambient. Not
 * zero: the hemisphere light is cheap, it is neutral rather than sky-blue, and
 * leaving a little of it in stops the deepest shade going frankly cyan.
 */
export const HEMI_IBL_FACTOR = 0.28;

/** What a scene needs to put on its ball material. */
export interface GolfSkyEnv {
  /** The prefiltered environment. Also `scene.environment` when IBL is on. */
  ballEnvMap: THREE.Texture;
  /**
   * `ballMat.envMapIntensity`. Tracks `ENV_INTENSITY` when IBL is on so the ball
   * reflects the world at the same strength the world is lit by it (three uses
   * the MATERIAL's intensity whenever a material sets its own `envMap`, not
   * `scene.environmentIntensity`), and stays at the historical 1 at `low`.
   */
  ballEnvIntensity: number;
}

/**
 * Build the sky environment for one golf scene and attach it.
 *
 * Call ONCE at scene build, AFTER the scene's `DirectionalLight` exists — the
 * sun's elevation and azimuth are read off `sunPos` so the two cannot drift.
 *
 * At `medium`/`high` this sets `scene.environment` + `scene.environmentIntensity`
 * and returns the same texture for the ball. At `low` it returns the historical
 * ball-only PMREM and touches the scene not at all: `scene.environment` stays
 * null, so no lit fragment anywhere pays for a cubeUV sample, and the allocation
 * stays the 21 KB it has always been rather than 1.5 MiB.
 */
export function attachSkyEnv(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  quality: SceneQuality,
  sunPos: THREE.Vector3,
  track: Track,
): GolfSkyEnv {
  if (!quality.ibl) {
    return { ballEnvMap: makeSkyEnvMap(renderer, track), ballEnvIntensity: 1 };
  }
  const angles = sunAnglesFromDirection(sunPos.x, sunPos.y, sunPos.z);
  const env = track(buildSkyEnv(renderer, { ...GOLF_SKY, ...angles }));
  scene.environment = env.texture;
  scene.environmentIntensity = ENV_INTENSITY;
  return { ballEnvMap: env.texture, ballEnvIntensity: ENV_INTENSITY };
}

/**
 * A scene's hemisphere-light intensity, cut when IBL is carrying the ambient.
 *
 * Every golf scene routes its hemisphere intensity through this, so the "cut the
 * fill in the same change" rule is structural rather than remembered. `base` is
 * the intensity that scene shipped before IBL existed.
 */
export function hemiFill(quality: SceneQuality, base: number): number {
  return quality.ibl ? base * HEMI_IBL_FACTOR : base;
}
