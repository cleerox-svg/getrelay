// Shared water for every golf scene (Course, Range, Putt).
//
// This module is the SINGLE source of truth for how water looks, moves and
// reacts. It used to be ~60 lines inside scenery.ts — a MeshStandardMaterial
// with a mottled canvas colour map and a scrolling normal map — which read as
// "a blue lid" for four compounding reasons:
//
//   1. the Course surface FOLLOWED the dished terrain, so it was a bowl, and
//      water is the one surface in the world that is exactly level;
//   2. nothing reflected — no env map, and scene.environment is deliberately
//      unset — yet at a grazing camera angle real water is mostly mirror;
//   3. one flat opacity and one colour edge-to-edge, so no Fresnel, no depth;
//   4. the ripple repeats were BAKED into the shared texture, so the Range's
//      150 yd plane and the Course's 20 yd disc got the same anisotropic tile,
//      which combed the wave trains into horizontal stripes.
//
// What replaces it, in four tiers (all shared — the scenes only supply
// geometry and a water level, never look/behaviour):
//
//   Tier 0  Level surfaces + world-unit ripple scale. Geometry carries a per-
//           vertex `aDepth` (yd of water above the bed), so the shoreline is
//           wherever the level plane meets the rising bank — no painted annulus.
//   Tier 1  Sky reflection from the SAME gradient that feeds the ball's PMREM
//           (single-sourced with the sky dome), plus two cross-scrolled detail
//           normal layers so the tile rhythm disappears.
//   Tier 2  Gerstner waves in the vertex shader with analytic normals: crests
//           actually travel. Fresnel mix, sun glint, wave-driven foam, and a
//           depth-faded shoreline. Wave direction/amplitude follow the hole wind.
//   Tier 3  True planar reflection — the scene mirrored into a half-res render
//           target once per frame, sampled projectively. Gated by `quality`
//           (see pickWaterQuality) because it is a whole extra scene pass and
//           GOLF.md still has an open on-device GPU action for this scene.
//
// Everything degrades in ONE place: a 'low' device drops the planar pass and
// the detail normals but keeps level water, Fresnel and moving crests, so the
// three scenes always agree about what water is.

import * as THREE from 'three';
import { makeSkyGradientTexture, type Track } from './scenery';

// --- Tuning ----------------------------------------------------------------

/** World size (yd) of one detail-ripple tile. Scale is applied in the SHADER
 *  from world XZ, so a 150 yd range plane and a 20 yd pond get the same-sized
 *  wavelets — the anisotropy that combed the old baked repeat is gone. */
export const RIPPLE_TILE_YD = 9;

/** Longest side (px) of the planar-reflection target. A distorted reflection
 *  hides a low resolution well, so this is the cheapest quality dial there is. */
const REFLECT_MAX = 512;

/** Base Gerstner wavelength (yd). The four waves scale off this. */
const WAVE_BASE_YD = 13;

/** Wave amplitude (yd) at a dead calm and at a stiff breeze. Wind lerps between
 *  them, so the HUD's wind readout means something on the water. */
const AMP_CALM = 0.045;
const AMP_WINDY = 0.2;
/** Wind speed (mph) at which wave amplitude reaches AMP_WINDY. */
const WIND_FULL_MPH = 18;

/** Depth (yd) over which water goes from shoreline to fully deep — the colour
 *  ramp, the alpha ramp and the wave taper.
 *
 *  Sized against the BASIN PROFILE, not the basin's max depth. A hazard dish is
 *  a raised cosine, so it is shallow across most of its area: on a 13 yd pond
 *  2.2 yd deep, water is under a yard deep out to ~65% of the radius. A shore
 *  depth of a yard therefore paints two thirds of the pond as "shallow", which
 *  is what turned the surface into a wide grey ring on the first pass. */
const SHORE_DEPTH_YD = 0.6;

/** Depth (yd) of the foam band at the water's edge. Deliberately much smaller
 *  than SHORE_DEPTH_YD — foam is a few inches of lapping edge, not a shelf. */
const FOAM_DEPTH_YD = 0.14;

/** Default sun direction, matching the shared lighting rig (sun at
 *  (-160, 260, 120) in all three scenes). Normalized. */
const DEFAULT_SUN = new THREE.Vector3(-160, 260, 120).normalize();

// Palette. Shallow leans green-teal (silt + bottom showing through), deep leans
// a saturated lake blue. Both are deliberately DARKER than the old texture:
// with a real Fresnel reflection on top, the brightness now comes from the sky,
// not from the base colour, which is what stops it reading as flat paint.
const SHALLOW_COLOR = 0x4a8a76;
const DEEP_COLOR = 0x17506f;
const FOAM_COLOR = 0xe8f6f7;

// --- Quality tiers ---------------------------------------------------------

export type WaterQuality = 'high' | 'medium' | 'low';

/**
 * Pick a water quality for this device.
 *
 * 'high' adds the Tier 3 planar reflection pass — a SECOND full render of the
 * scene every frame. GOLF.md carries an open action that this scene's GPU
 * budget (notably the 2048² shadow map) still needs verifying on a low-end
 * Android device, so the planar pass is deliberately conservative: it is only
 * offered where the GPU reports plenty of texture headroom AND the device has
 * several cores. Everything else gets Tier 0–2, which costs a normal material.
 *
 * Callers may override with an explicit `quality` — `?water=high|medium|low`
 * on the golf preview page is handy when checking on a real handset.
 */
export function pickWaterQuality(renderer: THREE.WebGLRenderer): WaterQuality {
  const maxTex = renderer.capabilities.maxTextureSize;
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  // A device that can't hold a big texture, or is running on very few cores, is
  // exactly the class of hardware the shadow-map crash was seen on. Keep it off
  // the extra pass entirely.
  if (maxTex < 4096 || cores <= 2) return 'low';
  if (maxTex < 8192 || cores <= 4) return 'medium';
  return 'high';
}

/**
 * `?water=high|medium|low` override, or null when absent/invalid.
 *
 * Exists so the Tier 3 planar pass can be forced on or off on a real handset
 * without a rebuild — which is exactly what GOLF.md's outstanding low-end
 * Android GPU check needs. Shared by all three scenes so the override works
 * the same wherever water is drawn.
 */
export function readWaterQualityOverride(): WaterQuality | null {
  if (typeof window === 'undefined') return null;
  try {
    const q = new URLSearchParams(window.location.search).get('water');
    return q === 'high' || q === 'medium' || q === 'low' ? q : null;
  } catch {
    return null;
  }
}

// --- Detail ripple normal map ----------------------------------------------

// A tileable normal field of four crossing wave trains. This survives from the
// original implementation — it was never the problem, it was the baked repeat
// and the fact that it had no reflection to distort. Sampled TWICE in the
// shader at different scales/directions/speeds, which is what kills the visible
// tile rhythm. Deterministic (pure trig, no RNG), so screenshots are stable.
function makeRippleNormalMap(): THREE.Texture {
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
      Math.sin(u * 1 - v * 4) * 0.4 +
      Math.sin((u + v) * 5) * 0.28 +
      Math.sin(u * 2 - v * 3 + 1.7) * 0.2
    );
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const hx = wave(x + 1, y) - wave(x - 1, y);
      const hy = wave(x, y + 1) - wave(x, y - 1);
      let nx = -hx * 3.0;
      let ny = -hy * 3.0;
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
  // Repeat is NOT baked — the shader derives UV from world XZ / RIPPLE_TILE_YD.
  return tex;
}

// --- Geometry helpers ------------------------------------------------------

/**
 * Attach the per-vertex `aDepth` attribute (yards of water above the bed) that
 * the shader needs for its depth ramp, shoreline fade and wave taper.
 *
 * `depthAt` is given the vertex's WORLD x/z. The Course passes
 * `waterY - heightAt(...)`, so the visible waterline is exactly where the level
 * surface meets the rising bank — an organic shoreline derived from the terrain
 * the ball actually plays, with no painted annulus and no possibility of the
 * drawn edge disagreeing with the classified one. Flat-bedded scenes (Range,
 * Putt) pass a constant.
 */
export function attachWaterDepth(
  geo: THREE.BufferGeometry,
  depthAt: number | ((x: number, z: number) => number),
): THREE.BufferGeometry {
  const pos = geo.getAttribute('position');
  const n = pos.count;
  const depths = new Float32Array(n);
  if (typeof depthAt === 'number') {
    depths.fill(depthAt);
  } else {
    for (let i = 0; i < n; i++) depths[i] = depthAt(pos.getX(i), pos.getZ(i));
  }
  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  return geo;
}

/**
 * A level, tessellated water plane lying in XZ at y = 0, ready for the shared
 * material. Segment density is derived from the size (~1 vertex per
 * `ydPerSegment`) so a big range lake and a small putt pond both carry enough
 * vertices for the Gerstner crests to resolve without anyone hand-tuning
 * segment counts per scene.
 */
export function makeWaterPlane(
  width: number,
  depth: number,
  waterDepth: number,
  ydPerSegment = 3.5,
  edgeFade = 0,
): THREE.BufferGeometry {
  const wSeg = Math.max(1, Math.min(160, Math.round(width / ydPerSegment)));
  const dSeg = Math.max(1, Math.min(160, Math.round(depth / ydPerSegment)));
  const geo = new THREE.PlaneGeometry(width, depth, wSeg, dSeg);
  geo.rotateX(-Math.PI / 2);
  if (edgeFade <= 0) return attachWaterDepth(geo, waterDepth);
  // Ramp the depth down toward the plane's border so a pond with no modeled
  // bank still gets the shared shoreline treatment — shallow colour, foam and
  // the alpha fade — instead of ending on a hard rectangular cut.
  const hw = width / 2;
  const hd = depth / 2;
  return attachWaterDepth(geo, (x, z) => {
    const edge = Math.min(hw - Math.abs(x), hd - Math.abs(z));
    return waterDepth * Math.max(0, Math.min(1, edge / edgeFade));
  });
}

// --- Planar reflection (Tier 3) --------------------------------------------

interface Reflection {
  target: THREE.WebGLRenderTarget;
  matrix: THREE.Matrix4;
  /** Meshes hidden for the mirror pass (the water surfaces themselves). */
  hidden: THREE.Object3D[];
  render: (renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) => void;
  setSize: (w: number, h: number) => void;
  dispose: () => void;
}

/**
 * Mirror the scene about the water plane into a half-resolution render target.
 *
 * This is the honest version of a reflection — the real trees, bank, flagstick
 * and sky, not a gradient — and it is also the only part of this module that
 * costs a whole extra scene pass. Mitigations baked in:
 *   • half canvas resolution, hard-capped at 512² (a distorted reflection hides
 *     a low resolution well — this is the cheapest quality dial there is);
 *   • the water meshes themselves are hidden for the pass (else the mirror
 *     camera sees the back of the surface it is feeding);
 *   • a clipping plane at the waterline so nothing UNDER the water — the pond
 *     bed, a sunk ball — leaks into the reflection;
 *   • shadows are off for the pass: a reflected shadow map is invisible at this
 *     resolution and it is the single most expensive thing we can skip.
 */
function makeReflection(waterY: number, w: number, h: number): Reflection {
  const target = new THREE.WebGLRenderTarget(w, h, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  // LINEAR target, and the pass below runs with tone mapping OFF. Otherwise the
  // reflection is tone-mapped once into the target and AGAIN by the water
  // shader's own <tonemapping_fragment>, which visibly greys and desaturates it
  // — the classic washed-out planar reflection. One ACES pass, at the end.
  target.texture.colorSpace = THREE.LinearSRGBColorSpace;

  const reflCam = new THREE.PerspectiveCamera();
  const matrix = new THREE.Matrix4();
  const hidden: THREE.Object3D[] = [];
  // Oblique-frustum clipping scratch. Clipping at the waterline via
  // renderer.clippingPlanes would flip the renderer's clipping-plane COUNT every
  // frame, and three rebuilds every material's program when that count changes —
  // a full shader recompile per frame, which is far worse than the reflection
  // pass itself. Skewing the reflection camera's near plane onto the water plane
  // achieves the same clip for free, inside the projection matrix.
  const clipPlane = new THREE.Plane();
  const clipVec = new THREE.Vector4();
  const qVec = new THREE.Vector4();

  // Projective texture matrix: world position → reflection-target UV.
  const texMatrix = new THREE.Matrix4();

  const render = (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return;

    // Mirror the camera through the horizontal plane y = waterY. For a plane
    // this simple the reflection is just a y-flip about the waterline, so the
    // full householder-matrix dance the generic Reflector needs collapses to
    // negating y on the position and on the look target.
    reflCam.copy(camera);
    reflCam.position.set(camera.position.x, 2 * waterY - camera.position.y, camera.position.z);
    const look = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(camera.quaternion)
      .add(camera.position);
    reflCam.up.set(0, 1, 0);
    reflCam.lookAt(look.x, 2 * waterY - look.y, look.z);
    // Mirroring flips handedness; three renders it correctly as long as we let
    // it recompute the matrices from the mirrored transform.
    reflCam.updateMatrixWorld(true);
    reflCam.updateProjectionMatrix();

    // Skew the near plane onto the water surface so nothing below the waterline
    // (the pond bed, a sunk ball) leaks into the mirror.
    clipPlane.set(new THREE.Vector3(0, 1, 0), -waterY + 0.02);
    clipPlane.applyMatrix4(reflCam.matrixWorldInverse);
    clipVec.set(clipPlane.normal.x, clipPlane.normal.y, clipPlane.normal.z, clipPlane.constant);
    const proj = reflCam.projectionMatrix;
    qVec.x = (Math.sign(clipVec.x) + proj.elements[8]!) / proj.elements[0]!;
    qVec.y = (Math.sign(clipVec.y) + proj.elements[9]!) / proj.elements[5]!;
    qVec.z = -1.0;
    qVec.w = (1.0 + proj.elements[10]!) / proj.elements[14]!;
    clipVec.multiplyScalar(2.0 / clipVec.dot(qVec));
    proj.elements[2] = clipVec.x;
    proj.elements[6] = clipVec.y;
    proj.elements[10] = clipVec.z + 1.0;
    proj.elements[14] = clipVec.w;

    texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    texMatrix.multiply(reflCam.projectionMatrix);
    texMatrix.multiply(reflCam.matrixWorldInverse);
    matrix.copy(texMatrix);

    for (const o of hidden) o.visible = false;
    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.enabled;
    const prevXR = renderer.xr.enabled;
    const prevToneMapping = renderer.toneMapping;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = false;
    renderer.xr.enabled = false;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, reflCam);
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevToneMapping;
    renderer.shadowMap.enabled = prevShadow;
    renderer.xr.enabled = prevXR;
    for (const o of hidden) o.visible = true;
  };

  return {
    target,
    matrix,
    hidden,
    render,
    setSize: (cw: number, ch: number) => {
      // Half canvas resolution, long side capped at REFLECT_MAX. Keeping the
      // canvas ASPECT matters: the mirror camera inherits the main camera's
      // aspect, so a square target on a portrait canvas throws away half its
      // texels along the axis the pond actually spans.
      const scale = Math.min(0.5, REFLECT_MAX / Math.max(1, Math.max(cw, ch)));
      const tw = Math.max(128, Math.round(cw * scale));
      const th = Math.max(128, Math.round(ch * scale));
      if (target.width !== tw || target.height !== th) target.setSize(tw, th);
    },
    dispose: () => target.dispose(),
  };
}

// --- Shaders ---------------------------------------------------------------

const VERT = /* glsl */ `
  uniform float uTime;
  uniform vec2  uWindDir;
  uniform float uAmp;
  uniform float uWaveLen;
  uniform float uShoreDepth;
  uniform float uMaxDrop;

  attribute float aDepth;

  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying float vDepth;
  varying float vCrest;

  #include <common>
  #include <fog_pars_vertex>

  // Sum of the four waves' amplitude multipliers below — the peak displacement
  // a fully constructive interference can reach, used to normalize vCrest.
  const float WAVE_AMP_SUM = 2.01;

  // One Gerstner wave: circular particle motion, so crests sharpen and troughs
  // broaden the way real wind waves do. Accumulates its contribution to the
  // surface tangent + binormal so the normal is ANALYTIC — no normal map, no
  // finite differences, and it stays correct at any tessellation.
  //
  // Steepness is DERIVED from the amplitude (steepness = k·a), not passed in
  // alongside it. Passing both let them disagree: an early version scaled the
  // displacement down to a gentle ripple while the tangents kept accumulating a
  // full-steepness wave, so the surface was geometrically calm but SHADED as if
  // it were a metre of chop — which is what made the pond mottle like static.
  // Clamped below 1 because a Gerstner wave self-intersects past that.
  vec3 gerstner(
    vec2 dir, float wavelength, float amplitude, float t, vec2 p,
    inout vec3 tangent, inout vec3 binormal
  ) {
    float k = 2.0 * PI / wavelength;
    float steepness = clamp(k * amplitude, 0.0, 0.85);
    // Deep-water dispersion (c = sqrt(g/k)) in yards/second, so longer swells
    // genuinely travel faster than short wavelets instead of all sliding in
    // lockstep — that speed spread is a large part of reading as water.
    float c = sqrt(9.8 * 1.094 / k);
    vec2  d = normalize(dir);
    float f = k * (dot(d, p) - c * t);
    float a = steepness / k;
    float sf = sin(f);
    float cf = cos(f);

    tangent += vec3(
      -d.x * d.x * (steepness * sf),
       d.x * (steepness * cf),
      -d.x * d.y * (steepness * sf)
    );
    binormal += vec3(
      -d.x * d.y * (steepness * sf),
       d.y * (steepness * cf),
      -d.y * d.y * (steepness * sf)
    );
    return vec3(d.x * (a * cf), a * sf, d.y * (a * cf));
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vDepth = aDepth;

    // Waves taper to nothing in the shallows: a crest that kept full amplitude
    // at the shoreline would poke through the bank, and real water genuinely
    // flattens as it shoals. This is what lets the surface be level AND still
    // meet the terrain cleanly at every angle.
    float shoal = smoothstep(0.0, uShoreDepth, aDepth);
    float amp = uAmp * shoal;

    vec2 p = world.xz;
    vec3 tangent = vec3(1.0, 0.0, 0.0);
    vec3 binormal = vec3(0.0, 0.0, 1.0);
    vec3 disp = vec3(0.0);

    // Four trains fanned around the wind bearing: a long swell that carries the
    // shape, two mid wavelets, and a short cross-chop. The fan (not a single
    // direction) is what stops the surface looking corrugated.
    vec2 w0 = uWindDir;
    vec2 w1 = vec2(uWindDir.x * 0.94 - uWindDir.y * 0.34, uWindDir.x * 0.34 + uWindDir.y * 0.94);
    vec2 w2 = vec2(uWindDir.x * 0.77 + uWindDir.y * 0.64, -uWindDir.x * 0.64 + uWindDir.y * 0.77);
    vec2 w3 = vec2(-uWindDir.y, uWindDir.x);

    disp += gerstner(w0, uWaveLen,        amp,        uTime, p, tangent, binormal);
    disp += gerstner(w1, uWaveLen * 0.55, amp * 0.55, uTime, p, tangent, binormal);
    disp += gerstner(w2, uWaveLen * 0.31, amp * 0.30, uTime, p, tangent, binormal);
    disp += gerstner(w3, uWaveLen * 0.17, amp * 0.16, uTime, p, tangent, binormal);

    // Never let a trough sink further than the bed clearance beneath the
    // surface. On the Course the basin is yards deep so this never binds, but a
    // flat-bedded pond (the Range lake, a Putt board) sits only inches above its
    // bed — and an unclamped trough dropped BELOW it, so the ground punched
    // through the water in a marbled wave pattern. Flattened trough bottoms also
    // happen to be what shallow water really does.
    disp.y = max(disp.y, -uMaxDrop);
    world.xyz += disp;
    vWorld = world.xyz;
    // Height above the mean surface, normalized against the SUM of the four
    // waves' amplitudes (not wave 0's alone, which saturated to 1 across broad
    // areas and painted a regular lattice of whitecaps).
    vCrest = clamp(disp.y / max(amp * WAVE_AMP_SUM, 1e-4), -1.0, 1.0);
    vNormalW = normalize(cross(binormal, tangent));

    // Named mvPosition because three's <fog_vertex> chunk reads that symbol.
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uRipple;
  uniform sampler2D uSky;
  uniform sampler2D uReflection;
  uniform mat4  uReflectionMatrix;
  uniform float uUseReflection;
  uniform float uDetail;
  uniform float uTime;
  uniform float uTileYd;
  uniform vec2  uWindDir;
  uniform vec3  uSunDir;
  uniform vec3  uSunColor;
  uniform vec3  uShallow;
  uniform vec3  uDeep;
  uniform vec3  uFoam;
  uniform float uShoreDepth;
  uniform float uFoamDepth;
  uniform float uWhitecap;
  uniform float uOpacity;

  varying vec3  vWorld;
  varying vec3  vNormalW;
  varying float vDepth;
  varying float vCrest;

  #include <common>
  #include <fog_pars_fragment>

  vec3 sampleRippleNormal(vec2 uv) {
    return texture2D(uRipple, uv).xyz * 2.0 - 1.0;
  }

  void main() {
    // Dry land: the surface geometry deliberately overfills its outline so it
    // always reaches the classified water edge, and everything past the bank is
    // discarded here. The waterline is therefore terrain-derived, not authored.
    if (vDepth <= 0.0) discard;

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vNormalW);

    // Two detail layers cross-scrolled at different scales, directions and
    // speeds. One layer alone re-reads as a sliding texture; two interfering
    // layers read as a surface. Scale comes from WORLD xz, so every scene gets
    // identically-sized wavelets regardless of mesh size.
    if (uDetail > 0.0) {
      vec2 base = vWorld.xz / uTileYd;
      vec2 drift = uWindDir * uTime;
      vec3 n1 = sampleRippleNormal(base + drift * 0.035);
      vec3 n2 = sampleRippleNormal(base * 2.7 - drift * 0.021 + vec2(0.37, 0.12));
      vec2 perturb = (n1.xy + n2.xy * 0.6) * uDetail;
      // Shallow water is calmer, so fade the chop out toward the shoreline too.
      perturb *= smoothstep(0.0, uShoreDepth, vDepth);
      N = normalize(N + vec3(perturb.x, 0.0, perturb.y));
    }

    // Fresnel. F0 for water is ~0.02: look straight down and you see through it,
    // look along it and it is a mirror. This single term is the difference
    // between a receding surface and a flat blue decal.
    //
    // Capped below 1: textbook Schlick drives reflectance to 100% at grazing
    // incidence, which is true for a mirror-flat sea but washes a small pond out
    // to plain sky at golf camera angles. Holding a little of the water's own
    // colour keeps it reading as a BODY of water — and matches the art direction
    // of the rest of the scene, which is saturated rather than photographic.
    // The F0 FLOOR is raised well above water's physical 0.02. Looking almost
    // straight down (a mini-golf board, a putt camera) a physical Fresnel leaves
    // ~2% reflection, so the wave normals have nothing to modulate and the pond
    // renders as one flat colour — this shader has no diffuse term, since a body
    // of water has no meaningful albedo. A floor keeps the surface reading as
    // rippled from every angle, and suits the scene's stylised look.
    float fres = 0.09 + 0.58 * pow(1.0 - max(dot(N, V), 0.0), 4.0);

    // Reflection: the sky gradient always, the real mirrored scene on top where
    // the planar pass is enabled.
    vec3 R = reflect(-V, N);
    float lat = clamp(0.5 + asin(clamp(R.y, -1.0, 1.0)) / PI, 0.0, 1.0);
    vec3 refl = texture2D(uSky, vec2(0.5, lat)).rgb;

    if (uUseReflection > 0.0) {
      vec4 projected = uReflectionMatrix * vec4(vWorld, 1.0);
      vec2 ruv = projected.xy / max(projected.w, 1e-4);
      // Distort by the surface normal so the mirror ripples with the waves.
      // This offset is in SCREEN space, so it must stay small — a large value
      // smears the reflection into blotches instead of rippling it.
      ruv += N.xz * 0.006;
      // CLAMP rather than fall back to the sky: at a grazing angle part of the
      // pond projects outside the target, and switching sources mid-surface
      // produced a visible patchwork of mirrored scene against flat gradient.
      ruv = clamp(ruv, vec2(0.001), vec2(0.999));
      // The target is linear and was rendered with tone mapping off, so this
      // composites directly and is tone-mapped once, at the end.
      vec3 planar = texture2D(uReflection, ruv).rgb;
      refl = mix(refl, planar, uUseReflection);
    }

    // Body colour by depth: silty green-teal in the shallows deepening to lake
    // blue. This is the through-the-water term, so it is what Fresnel fades out
    // as the view angle flattens.
    float deepness = smoothstep(0.0, uShoreDepth * 1.4, vDepth);
    vec3 body = mix(uShallow, uDeep, deepness);

    vec3 col = mix(body, refl, fres);

    // Sun glint riding the analytic wave normals. High exponent = a tight,
    // travelling sparkle rather than a broad sheen.
    vec3 H = normalize(uSunDir + V);
    float ndh = max(dot(N, H), 0.0);
    // Two lobes: a tight sparkle that picks out individual crests, and a broad,
    // faint sheen so wave FACES catch light even where the tight lobe misses —
    // without the broad term the surface is only lit in a couple of hot spots.
    float spec = pow(ndh, 220.0);
    float sheen = pow(ndh, 14.0);
    col += uSunColor * (spec * 1.4 + sheen * 0.09);

    // Foam: a NARROW lapping band at the edge, plus a light dusting on the wave
    // crests so the shoreline PULSES with the swell instead of sitting there as
    // a painted ring (which is what the old annulus decal was).
    float shoreBand = 1.0 - smoothstep(0.0, uFoamDepth, vDepth);
    // Whitecaps are a WIND phenomenon — a dead-calm pond has none. Gating them
    // on uWhitecap keeps a still mini-golf pond clean instead of stamping a
    // regular lattice of foam across it.
    float crestFoam =
      smoothstep(0.72, 1.0, vCrest) * smoothstep(0.0, uShoreDepth, vDepth) * uWhitecap;
    float foam = clamp(shoreBand * (0.55 + 0.45 * vCrest) + crestFoam * 0.3, 0.0, 1.0);
    col = mix(col, uFoam, foam * 0.7);

    // Alpha: see-through at the margin (the bed shows), opaque once deep, and a
    // hard fade over the last sliver so the surface dissolves into the bank.
    float alpha = mix(0.72, uOpacity, deepness);
    alpha = max(alpha, foam * 0.85);
    alpha *= smoothstep(0.0, 0.09, vDepth);

    gl_FragColor = vec4(col, alpha);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

// --- Kit -------------------------------------------------------------------

export interface WaterKitOptions {
  /** Renderer — used to pick a default quality and size the reflection target. */
  renderer?: THREE.WebGLRenderer;
  /** Override the auto-detected tier. */
  quality?: WaterQuality;
  /** World y of the (level) water surface. Required for the planar pass. */
  waterY?: number;
  /** Sun direction, to match the scene's key light. Defaults to the shared rig. */
  sunDir?: THREE.Vector3;
  /** Detail ripple tile size in yards. */
  tileYd?: number;
  /**
   * How far (yd) the bed sits below the surface where the surface is flat —
   * i.e. how far a wave trough may drop before it would clip through the
   * geometry underneath. Leave unset on a scene with a real modeled basin (the
   * Course); set it on a flat-bedded pond that floats just above its bed.
   */
  clearance?: number;
  /** Depth (yd) at which water reads fully deep. Scale to the scene's ponds. */
  shoreDepth?: number;
  /** Depth (yd) of the lapping foam band at the edge. */
  foamDepth?: number;
  /** Peak wave amplitude (yd) at full wind. Scale to the scene's ponds. */
  waveAmp?: number;
  /** Base wave wavelength (yd). Scale to the scene's ponds. */
  waveLen?: number;
  /** Opacity of fully deep water. */
  opacity?: number;
}

export interface WaterKit {
  /** The shared water material. Attach to any geometry carrying `aDepth`. */
  material: THREE.ShaderMaterial;
  /** Resolved quality tier (after auto-detection / override). */
  quality: WaterQuality;
  /** Per-frame animation hook. `t` is elapsed seconds. */
  update: (t: number) => void;
  /**
   * Register a water mesh so the planar reflection pass can hide it. Harmless
   * on tiers without the pass — call it for every water mesh regardless.
   */
  addSurface: (mesh: THREE.Object3D) => void;
  /**
   * Render the planar reflection. Call ONCE per frame, BEFORE the main render.
   * No-op unless quality is 'high'.
   */
  renderReflection: (
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
  ) => void;
  /** Resize the reflection target with the canvas. */
  setSize: (w: number, h: number) => void;
  /** Drive wave direction + amplitude from the hole wind. */
  setWind: (dirRad: number, mph: number) => void;
}

/**
 * Build the shared water kit. One call per scene; ONE material shared by every
 * water mesh in that scene (so there is one per-frame update and one shader).
 *
 * Every GPU resource is registered through `track()` for teardown disposal,
 * matching the rest of the scene kit.
 */
export function makeWater(track: Track, opts: WaterKitOptions = {}): WaterKit {
  const quality =
    opts.quality ?? (opts.renderer ? pickWaterQuality(opts.renderer) : 'medium');
  const waterY = opts.waterY ?? 0;
  const tileYd = opts.tileYd ?? RIPPLE_TILE_YD;
  const sunDir = (opts.sunDir ?? DEFAULT_SUN).clone().normalize();
  // Wave scale. A scene with much smaller ponds than a golf hole (mini-golf)
  // scales these down; the LOOK and behaviour are still the shared ones.
  const ampScale = (opts.waveAmp ?? AMP_WINDY) / AMP_WINDY;
  const waveLen = opts.waveLen ?? WAVE_BASE_YD;

  const ripple = track(makeRippleNormalMap());
  const sky = track(makeSkyGradientTexture());

  // Tier 3 only. Built here so the uniform block is identical across tiers —
  // the shader always compiles the same, only uUseReflection changes.
  const reflection = quality === 'high' ? makeReflection(waterY, 256, 256) : null;
  if (reflection) {
    track(reflection);
    // Size it to the live canvas immediately; the scenes re-size it on resize.
    if (opts.renderer) {
      const size = opts.renderer.getSize(new THREE.Vector2());
      reflection.setSize(size.x, size.y);
    }
  }

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uRipple: { value: null },
      uSky: { value: null },
      uReflection: { value: null },
      uReflectionMatrix: { value: new THREE.Matrix4() },
      uUseReflection: { value: 0 },
      // Perturbation ADDED to a unit surface normal, so this is in radians-ish:
      // 0.75 tilted the surface by 40°+ per texel and shattered the reflection.
      uDetail: { value: quality === 'low' ? 0 : quality === 'medium' ? 0.08 : 0.12 },
      uTileYd: { value: tileYd },
      uWindDir: { value: new THREE.Vector2(0.7071, 0.7071) },
      uAmp: { value: AMP_CALM * ampScale },
      uWaveLen: { value: waveLen },
      uShoreDepth: { value: opts.shoreDepth ?? SHORE_DEPTH_YD },
      uFoamDepth: { value: opts.foamDepth ?? FOAM_DEPTH_YD },
      uMaxDrop: { value: opts.clearance ?? 1000 },
      uWhitecap: { value: 0 },
      uSunDir: { value: new THREE.Vector3() },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uShallow: { value: new THREE.Color(SHALLOW_COLOR) },
      uDeep: { value: new THREE.Color(DEEP_COLOR) },
      uFoam: { value: new THREE.Color(FOAM_COLOR) },
      uOpacity: { value: opts.opacity ?? 0.92 },
    },
  ]);
  // UniformsUtils.merge clones values, so the texture/vector slots are filled in
  // after the merge to keep the shared references.
  uniforms.uRipple!.value = ripple;
  uniforms.uSky!.value = sky;
  uniforms.uSunDir!.value = sunDir;
  if (reflection) {
    uniforms.uReflection!.value = reflection.target.texture;
    uniforms.uReflectionMatrix!.value = reflection.matrix;
    uniforms.uUseReflection!.value = 1;
  }

  const material = track(
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      // Water is an opaque-ish surface, not a decal: it must occlude the pond
      // bed and a sunk ball. depthWrite stays on, matching the old material.
      depthWrite: true,
      side: THREE.DoubleSide,
      fog: true,
    }),
  );

  const surfaces: THREE.Object3D[] = [];

  return {
    material,
    quality,
    update: (t: number) => {
      uniforms.uTime!.value = t;
    },
    addSurface: (mesh: THREE.Object3D) => {
      surfaces.push(mesh);
      if (reflection) reflection.hidden.push(mesh);
    },
    renderReflection: (renderer, scene, camera) => {
      reflection?.render(renderer, scene, camera);
    },
    setSize: (w: number, h: number) => {
      reflection?.setSize(w, h);
    },
    setWind: (dirRad: number, mph: number) => {
      // Bearing → the XZ direction waves travel. Matches the scene convention
      // (x east, -z downrange), so a tailwind pushes the crests toward the pin.
      const dir = uniforms.uWindDir!.value as THREE.Vector2;
      dir.set(Math.sin(dirRad), -Math.cos(dirRad)).normalize();
      const k = Math.min(1, Math.max(0, mph / WIND_FULL_MPH));
      uniforms.uAmp!.value = (AMP_CALM + (AMP_WINDY - AMP_CALM) * k) * ampScale;
      // A stiffer breeze also shortens the dominant wavelength (more chop).
      uniforms.uWaveLen!.value = waveLen * (1 - 0.3 * k);
      // Whitecaps only start showing in a real breeze, and never dominate.
      uniforms.uWhitecap!.value = Math.max(0, (k - 0.25) / 0.75);
    },
  };
}

// --- Splash / ripple FX ----------------------------------------------------

// Seeded so a splash is identical every run — the visual-QA harness diffs
// frames, and Math.random in the old Range implementation made that unreliable
// (GOLF.md: determinism is a hard requirement).
function splashRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDropletTexture(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rg = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.45, 'rgba(255,255,255,0.72)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export interface WaterFX {
  /** Kick a splash at a world point: droplet crown + expanding ripple rings. */
  splash: (x: number, y: number, z: number, strength?: number) => void;
  /** Per-frame integration. `nowMs` is performance.now(), `dt` seconds. */
  update: (nowMs: number, dt: number) => void;
}

/**
 * Shared splash: a crown of droplets plus staggered expanding ripple rings.
 *
 * This existed only in the Range — the Course played a splash SOUND and drew
 * nothing, and Putt had neither. Lifting it here is the same consolidation the
 * water material itself went through, so a ball finding water looks the same
 * wherever it happens.
 */
export function makeWaterFX(scene: THREE.Scene, track: Track): WaterFX {
  const PMAX = 26;
  const dropTex = track(makeDropletTexture());
  const pos = new Float32Array(PMAX * 3);
  const vel = new Float32Array(PMAX * 3);
  const geo = track(new THREE.BufferGeometry());
  const attr = new THREE.BufferAttribute(pos, 3);
  geo.setAttribute('position', attr);
  const mat = track(
    new THREE.PointsMaterial({
      size: 2.3,
      map: dropTex,
      color: 0xeaf6ff,
      transparent: true,
      depthWrite: false,
      sizeAttenuation: true,
    }),
  );
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);

  const RINGS = 3;
  const ringGeo = track(new THREE.RingGeometry(0.7, 1.0, 32));
  const ringMeshes: THREE.Mesh[] = [];
  const ringMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < RINGS; i++) {
    const m = track(
      new THREE.MeshBasicMaterial({
        color: 0xeaf7ff,
        transparent: true,
        opacity: 0,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const mesh = new THREE.Mesh(ringGeo, m);
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    scene.add(mesh);
    ringMeshes.push(mesh);
    ringMats.push(m);
  }

  let life = 0;
  let lifeMax = 0.75;
  let active = 0;
  let groundY = 0;
  let ringStart = -1;
  let ringScale = 1;
  const rnd = splashRng(0x51a5c0);

  const splash = (x: number, y: number, z: number, strength = 1) => {
    active = Math.min(PMAX, Math.round(18 + 8 * strength));
    groundY = y;
    lifeMax = 0.75;
    mat.size = 2.1 + strength * 0.5;
    for (let i = 0; i < active; i++) {
      const j = i * 3;
      pos[j] = x;
      pos[j + 1] = y + 0.2;
      pos[j + 2] = z;
      const ang = rnd() * Math.PI * 2;
      const sp = (1.8 + rnd() * 4.6) * strength;
      vel[j] = Math.cos(ang) * sp;
      vel[j + 1] = (8 + rnd() * 11) * strength;
      vel[j + 2] = Math.sin(ang) * sp;
    }
    life = lifeMax;
    mat.opacity = 1;
    points.visible = true;
    attr.needsUpdate = true;

    ringStart = performance.now();
    ringScale = 0.8 + strength * 0.5;
    for (const m of ringMeshes) {
      m.position.set(x, y + 0.04, z);
      m.visible = true;
    }
  };

  const update = (nowMs: number, dt: number) => {
    if (points.visible) {
      life -= dt;
      if (life <= 0) {
        points.visible = false;
      } else {
        for (let i = 0; i < active; i++) {
          const j = i * 3;
          const vy = (vel[j + 1] ?? 0) - 22 * dt;
          vel[j + 1] = vy;
          pos[j] = (pos[j] ?? 0) + (vel[j] ?? 0) * dt;
          pos[j + 1] = Math.max(groundY, (pos[j + 1] ?? 0) + vy * dt);
          pos[j + 2] = (pos[j + 2] ?? 0) + (vel[j + 2] ?? 0) * dt;
        }
        mat.opacity = Math.max(0, life / lifeMax);
        attr.needsUpdate = true;
      }
    }

    if (ringStart >= 0) {
      const elapsed = (nowMs - ringStart) / 1000;
      let anyLive = false;
      for (let i = 0; i < ringMeshes.length; i++) {
        const p = (elapsed - i * 0.2) / 1.1;
        const m = ringMeshes[i]!;
        if (p < 0 || p >= 1) {
          m.visible = false;
          if (p < 1) anyLive = true;
          continue;
        }
        anyLive = true;
        m.visible = true;
        m.scale.setScalar(ringScale * (1 + p * 7));
        ringMats[i]!.opacity = (1 - p) * 0.6;
      }
      if (!anyLive) ringStart = -1;
    }
  };

  return { splash, update };
}
