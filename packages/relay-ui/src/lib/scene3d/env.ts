/**
 * scene3d/env — a procedural sky environment for image-based lighting.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/GRAPHICS.md` §1 names scene-wide IBL as one of the four things that actually
 * close the fidelity gap, and §5 says the environment is **procedural**: paint a
 * gradient, run it through `PMREMGenerator`. A 2k `.hdr` is 3–8 MB in a repo that
 * justifies a 300 KB mp3, so there is no shipped HDRI and there will not be one.
 *
 * `lib/golf/scenery.ts` `makeSkyEnvMap` already proved the pattern, but it paints
 * an 8×128 vertical ramp — and `PMREMGenerator` derives its cube size from
 * `image.width / 4`, so that is a **2×2 cube**: a flat wash with no direction in
 * it at all, which is exactly why it was only ever worth attaching to a mirror
 * ball. Three's own documented minimum equirect is 64×32. This module paints a
 * real one: a sun disc at a true angular size, a circumsolar halo, a horizon band
 * and a ground-bounce hemisphere, so the prefiltered result carries DIRECTION.
 *
 * ⚠ WHAT A SUN DISC IN AN ENV MAP CAN AND CANNOT DO. The sun subtends 0.53°, i.e.
 * a solid angle of ~6.7e-5 sr. Even at a large radiance its contribution to
 * DIFFUSE irradiance is ~1e-3 — nothing. That is deliberate and it is the point:
 * the scene's key light is a real `DirectionalLight`, and an env sun carrying the
 * key's energy would double-count it and wash the scene out. The disc buys a
 * specular glint on smooth materials; the **halo** is what puts directional bias
 * into the diffuse term. Tune the halo, not the disc.
 *
 * CONTRACT (see README.md). Config in, no game constants; unit-agnostic (nothing
 * here has a world scale — it is all angles and colours); game-neutral names.
 * Golf passes turf green for the ground bounce, baseball will pass infield brown.
 */

import * as THREE from 'three';

/** Angles describing where the sun is, in the caller's world. */
export interface SunAngles {
  /** Degrees above the horizon. 0 = on the horizon, 90 = straight up (+Y). */
  elevationDeg: number;
  /**
   * Degrees around +Y, measured `atan2(z, x)` — so 0 points down +X, +90 down
   * +Z. This is the convention three's own `equirectUv` uses, which is why it is
   * the one taken here rather than a compass bearing: the painter and the
   * sampler then agree by construction.
   */
  azimuthDeg: number;
}

/**
 * Everything the painter needs. No defaults are golf's or baseball's — the two
 * optional fields are shape parameters of the gradient itself, not a look.
 */
export interface SkyEnvConfig extends SunAngles {
  /** Angular DIAMETER of the sun disc, degrees. Earth's sun is 0.53. */
  sunAngularDiameterDeg: number;
  /** Sun colour. Interpreted as sRGB, converted to linear working space. */
  sunColor: THREE.ColorRepresentation;
  /**
   * Radiance of the TRUE-SIZED disc, in the same linear units as the sky
   * colours. Energy is conserved when the disc is smaller than a texel, so this
   * number means the same thing at any `width`.
   */
  sunIntensity: number;
  /** Angular RADIUS of the circumsolar glow, degrees. This is the useful knob. */
  haloRadiusDeg: number;
  /** Peak radiance ADDED at the halo's centre, falling to 0 at its edge. */
  haloIntensity: number;

  /** Sky colour straight up. */
  zenithColor: THREE.ColorRepresentation;
  /** Sky colour at the horizon — the haze band. */
  horizonColor: THREE.ColorRepresentation;
  /**
   * Optional third stop between the two. A real sky is not a linear ramp: the
   * haze is a narrow band a few degrees deep and the blue takes over fast, so a
   * pure horizon→zenith blend leaves the whole upper hemisphere pale and the IBL
   * washes out. Omit it and the gradient is a plain two-stop.
   */
  skyMidColor?: THREE.ColorRepresentation;
  /** Elevation of `skyMidColor`, degrees. Default 8 — a shallow haze band. */
  skyMidElevationDeg?: number;
  /** Ground bounce below the horizon. Golf: turf green. Baseball: infield brown. */
  groundColor: THREE.ColorRepresentation;
  /** Overall multiplier on the sky hemisphere. Default 1. */
  skyIntensity?: number;
  /** Overall multiplier on the ground hemisphere. Default 1. */
  groundIntensity?: number;
  /** Elevation, degrees, at which the sky has fully reached `zenithColor`. */
  zenithBlendDeg?: number;
  /** Depression, degrees, at which the ground has fully reached `groundColor`. */
  groundBlendDeg?: number;

  /**
   * Equirect width in px; height is half. The PMREM cube edge is `width / 4`
   * (three's rule), so this is the ONLY memory dial — see `skyEnvBytes`.
   * Default 512 → a 128 cube → 1.5 MiB. Three's docs call 1024 "ideal", which
   * buys a 256 cube at 6 MiB; on a fleet that lost a WebView GPU process to a
   * 16 MB shadow map, a smooth procedural sky does not justify the extra 4.5 MiB.
   */
  width?: number;
}

/** A built environment: the prefiltered texture plus what it cost. */
export interface SkyEnv {
  /** Assign to `scene.environment` and/or a material's `envMap`. */
  texture: THREE.Texture;
  /** Cube edge three chose, px. */
  cubeSize: number;
  /** Bytes of GPU memory the prefiltered target holds. */
  bytes: number;
  /** Releases the prefiltered render target. */
  dispose: () => void;
}

/** Painted equirect pixels, before they reach the GPU. Exported for tests. */
export interface SkyEquirect {
  /** RGBA half-float, row 0 = nadir (`flipY` is false on a `DataTexture`). */
  data: Uint16Array;
  width: number;
  height: number;
}

const DEFAULT_WIDTH = 512;
/** Three's `_allocateTargets`: `width = 3 * max(cubeSize, 16 * 7)`. */
const CUBEUV_MIN_WIDTH_UNITS = 16 * 7;
/** `HalfFloatType` + `RGBAFormat` = 4 channels × 2 bytes. */
const BYTES_PER_TEXEL = 8;

const DEG = Math.PI / 180;

/**
 * Elevation/azimuth for a direction vector — so a caller that already owns a
 * `DirectionalLight.position` can derive the env's sun from it instead of
 * writing the angles down twice and letting them drift.
 */
export function sunAnglesFromDirection(x: number, y: number, z: number): SunAngles {
  const len = Math.hypot(x, y, z) || 1;
  return {
    elevationDeg: Math.asin(Math.max(-1, Math.min(1, y / len))) / DEG,
    azimuthDeg: Math.atan2(z, x) / DEG,
  };
}

/**
 * The cube edge `PMREMGenerator` will pick for an equirect of this width, and
 * the bytes its cubeUV target will hold. Written out rather than measured
 * because "confirm what you allocate" should not require a GPU: three's
 * `_setSize` is `2 ** floor(log2(width / 4))` and `_allocateTargets` is
 * `3 * max(cube, 112) × 4 * cube`, half-float RGBA, no mips (the cubeUV layout
 * packs every roughness level into that one target).
 */
export function skyEnvBytes(width = DEFAULT_WIDTH): { cubeSize: number; bytes: number } {
  const cubeSize = 2 ** Math.floor(Math.log2(Math.max(4, width) / 4));
  const rtW = 3 * Math.max(cubeSize, CUBEUV_MIN_WIDTH_UNITS);
  const rtH = 4 * cubeSize;
  return { cubeSize, bytes: rtW * rtH * BYTES_PER_TEXEL };
}

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Paint the equirectangular sky.
 *
 * Pure and deterministic — no RNG at all, so it satisfies `/GRAPHICS.md` §7
 * trivially and is unit-testable in node. Row j is latitude, column i longitude,
 * matching three's `equirectUv`:
 *   `u = atan2(z, x) / 2π + 0.5`, `v = asin(y) / π + 0.5`
 * and a `DataTexture` has `flipY === false`, so row 0 is v = 0, i.e. the nadir.
 */
export function paintSkyEquirect(cfg: SkyEnvConfig): SkyEquirect {
  const width = Math.max(64, Math.round(cfg.width ?? DEFAULT_WIDTH));
  const height = width >> 1;
  const data = new Uint16Array(width * height * 4);

  // `new THREE.Color(hex)` decodes sRGB into the linear working space when
  // ColorManagement is enabled (three's default since r155), so every value
  // below is already linear radiance and can be scaled arithmetically.
  const zenith = new THREE.Color(cfg.zenithColor);
  const horizon = new THREE.Color(cfg.horizonColor);
  const mid = cfg.skyMidColor === undefined ? null : new THREE.Color(cfg.skyMidColor);
  const ground = new THREE.Color(cfg.groundColor);
  const sun = new THREE.Color(cfg.sunColor);
  const skyK = cfg.skyIntensity ?? 1;
  const gndK = cfg.groundIntensity ?? 1;
  const midEl = (cfg.skyMidElevationDeg ?? 8) * DEG;
  const zenithBlend = Math.max(midEl + 1e-3, (cfg.zenithBlendDeg ?? 70) * DEG);
  const groundBlend = (cfg.groundBlendDeg ?? 25) * DEG;

  const sunEl = cfg.elevationDeg * DEG;
  const sunAz = cfg.azimuthDeg * DEG;
  const sx = Math.cos(sunEl) * Math.cos(sunAz);
  const sy = Math.sin(sunEl);
  const sz = Math.cos(sunEl) * Math.sin(sunAz);

  // Energy-conserving disc. The true half-angle is usually far below one texel,
  // and a sub-texel disc painted at full radiance is a coin flip on whether it
  // lands in a texel centre at all — so widen it to a texel and scale the
  // radiance by the solid-angle ratio. Ω = 2π(1 − cos θ), exactly, not the
  // small-angle square: it stays right if a caller asks for a stylised 10° sun.
  const trueHalf = Math.max(1e-5, (cfg.sunAngularDiameterDeg * DEG) / 2);
  const texelAngle = Math.PI / height;
  const drawHalf = Math.max(trueHalf, texelAngle);
  const discScale = (1 - Math.cos(trueHalf)) / (1 - Math.cos(drawHalf));
  const discR = sun.r * cfg.sunIntensity * discScale;
  const discG = sun.g * cfg.sunIntensity * discScale;
  const discB = sun.b * cfg.sunIntensity * discScale;

  const halo = Math.max(1e-4, cfg.haloRadiusDeg * DEG);
  const toHalf = THREE.DataUtils.toHalfFloat;

  for (let j = 0; j < height; j++) {
    const v = (j + 0.5) / height;
    const el = (v - 0.5) * Math.PI;
    const cy = Math.cos(el);
    const dy = Math.sin(el);

    // Base gradient depends only on elevation, so compute the row once.
    let baseR: number;
    let baseG: number;
    let baseB: number;
    if (el >= 0) {
      // horizon → (optional mid) → zenith. Two smoothsteps, not one, so the
      // haze band can be shallow while the blue still arrives smoothly.
      const lo = mid !== null && el < midEl ? horizon : (mid ?? horizon);
      const hi = mid !== null && el < midEl ? mid : zenith;
      const t =
        mid !== null && el < midEl
          ? smoothstep(0, midEl, el)
          : smoothstep(mid !== null ? midEl : 0, zenithBlend, el);
      baseR = (lo.r + (hi.r - lo.r) * t) * skyK;
      baseG = (lo.g + (hi.g - lo.g) * t) * skyK;
      baseB = (lo.b + (hi.b - lo.b) * t) * skyK;
    } else {
      // The horizon haze wraps a little way BELOW the horizon before the ground
      // bounce takes over; a hard cut at el = 0 reads as a painted line in any
      // reflection that straddles it.
      const t = smoothstep(0, groundBlend, -el);
      baseR = (horizon.r * skyK) + (ground.r * gndK - horizon.r * skyK) * t;
      baseG = (horizon.g * skyK) + (ground.g * gndK - horizon.g * skyK) * t;
      baseB = (horizon.b * skyK) + (ground.b * gndK - horizon.b * skyK) * t;
    }

    // The sky glows toward the sun; the ground does not. Fade the halo out
    // across the horizon rather than clipping it, for the same reason.
    const haloMask = smoothstep(-4 * DEG, 1 * DEG, el);

    for (let i = 0; i < width; i++) {
      const u = (i + 0.5) / width;
      const az = (u - 0.5) * Math.PI * 2;
      const dx = cy * Math.cos(az);
      const dz = cy * Math.sin(az);

      const cosA = Math.max(-1, Math.min(1, dx * sx + dy * sy + dz * sz));
      const ang = Math.acos(cosA);

      // Quadratic falloff — a linear aureole reads as a flat cone edge.
      const g = 1 - smoothstep(0, halo, ang);
      const add = cfg.haloIntensity * g * g * haloMask;
      let r = baseR + sun.r * add;
      let gg = baseG + sun.g * add;
      let b = baseB + sun.b * add;
      if (ang <= drawHalf) {
        r += discR;
        gg += discG;
        b += discB;
      }

      const o = (j * width + i) * 4;
      data[o] = toHalf(r);
      data[o + 1] = toHalf(gg);
      data[o + 2] = toHalf(b);
      data[o + 3] = toHalf(1);
    }
  }

  return { data, width, height };
}

/**
 * Build the prefiltered environment.
 *
 * Call ONCE per scene, right after the renderer exists. The half-float source is
 * uploaded, prefiltered and disposed immediately; only the cubeUV render target
 * survives, and `dispose()` frees it.
 *
 * ⚠ HALF-FLOAT, NOT A CANVAS. `PMREMGenerator`'s equirect shader samples the
 * source raw — an 8-bit canvas clamps at 1.0, which caps the sun and the halo at
 * sky brightness and makes the whole exercise pointless. `HalfFloatType` +
 * `LinearSRGBColorSpace` gives real radiance, is core-filterable on WebGL2, and
 * costs nothing at runtime because the source does not survive the call.
 */
export function buildSkyEnv(renderer: THREE.WebGLRenderer, cfg: SkyEnvConfig): SkyEnv {
  const { data, width, height } = paintSkyEquirect(cfg);

  const src = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.HalfFloatType);
  src.mapping = THREE.EquirectangularReflectionMapping;
  src.colorSpace = THREE.LinearSRGBColorSpace;
  src.minFilter = THREE.LinearFilter;
  src.magFilter = THREE.LinearFilter;
  // Longitude wraps; latitude must NOT, or the poles bleed into each other.
  src.wrapS = THREE.RepeatWrapping;
  src.wrapT = THREE.ClampToEdgeWrapping;
  src.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(src);
  src.dispose();
  pmrem.dispose();

  const { cubeSize, bytes } = skyEnvBytes(width);
  return { texture: rt.texture, cubeSize, bytes, dispose: () => rt.dispose() };
}
