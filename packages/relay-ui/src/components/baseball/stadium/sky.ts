// THE SKY — a graded dome, not a fill colour.
//
// ⚠ WHAT IT REPLACES AND WHY. `scene.background` was a single `Color`, and the
// visual gate measured the consequence exactly: high-frequency detail 0.0000 and
// "identical at five separated points". A flat fill has no horizon, so the top
// of the bowl meets the sky at a hard edge with nothing behind it, and `wide` —
// where sky is 34 % of the frame — reads as a cut-out on coloured paper.
//
// ⚠ AND WHAT IT DELIBERATELY DOES NOT DO: per-pixel grain. The other surfaces in
// this pass got seeded noise because a 3×3-blur measurement said they were flat;
// the sky is the one surface where that measurement should NOT be chased. A
// 256 px map stretched over a 360° dome is magnified ~100× at the `batter`
// camera's focal length, so any per-texel noise is filtered to a smooth wobble
// before it reaches a pixel — and if it were not filtered it would be sensor
// noise, which is not what a sky looks like. What is authored instead is what a
// sky actually has: a zenith-to-horizon GRADIENT, a warm haze band at the
// horizon, and seeded soft cloud banding. So the "flat fill, identical at five
// separated points" finding is answered while the grain number stays near zero,
// and that is the right answer rather than a missed one.
//
// ⚠ ONE DRAW CALL AND ONE TEXTURE. A `BackSide` sphere at `SKY_RADIUS_FT`, 32×16
// segments = 1,024 triangles against a 120,000 ceiling. It is a mesh rather than
// an equirect `scene.background` because a mesh takes the same `track()`
// disposal path as everything else in the scene and can take an emissive night
// material later without a second code path — the same argument the ribbon
// boards make for being a separate mesh.
//
// ⚠ SEEDED. The cloud banding comes from `mulberry32`; two harness runs must
// produce byte-identical PNGs.

import {
  BackSide,
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  SphereGeometry,
} from 'three';
import type { Scene } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import type { Daylight } from './daylight';
import type { Track } from './geom';

/**
 * Dome radius, ft. SCENE-ONLY.
 *
 * ⚠ IT HAS TO CLEAR THE SKYLINE AND SIT INSIDE THE FAR PLANE. `skyline.ts`'s
 * towers stand ~900–1,600 ft out and the cameras run a 6,000 ft far plane, so
 * 3,000 ft is outside everything in the park and comfortably inside the frustum
 * from `wide` (1,000 ft up at z = +470, i.e. 1,105 ft off centre — the far side
 * of the dome is then 4,105 ft away).
 */
const SKY_RADIUS_FT = 3000;

/**
 * Cloud band count. FEEL KNOB. The band LIFT is not here — it is a column of
 * `daylight.ts`, because a cloud lift authored for an afternoon reads as fog at
 * night, and the two skies are one dome under one gradient function.
 */
const BANDS = 9;

const SKY_SEED = 20260819;

/**
 * The gradient map: `v` runs 0 at the bottom of the sphere to 1 at the top, so
 * the whole authored ramp is one column and the texture is deliberately narrow
 * in `u`. Clouds break that column up horizontally, which is the only reason it
 * is not 1 px wide.
 */
function skyTexture(px: number, rng: () => number, sky: Daylight): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const w = px;
  const h = px;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Canvas y runs DOWN and texture v runs UP, so row 0 is the zenith.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  grad.addColorStop(0, hex(sky.skyStops[0]));
  grad.addColorStop(0.55, hex(sky.skyStops[1]));
  // The haze band is TIGHT to the horizon. A gradient that reaches its palest
  // value halfway up reads as fog, not as distance. At night the same band is
  // the city's glow, which is the one thing that keeps a dark dome from being
  // a black rectangle behind the bowl.
  grad.addColorStop(0.9, hex(sky.skyStops[2]));
  grad.addColorStop(1, hex(sky.skyStops[2]));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Seeded cloud banding — wide, soft, horizontal, concentrated in the upper
  // half where a dome actually shows sky rather than horizon.
  for (let i = 0; i < BANDS; i++) {
    const cy = rng() * h * 0.62;
    const half = h * (0.012 + rng() * 0.035);
    const x0 = rng() * w;
    const wide = w * (0.25 + rng() * 0.5);
    const a = sky.skyBandLift * (0.4 + rng() * 0.6);
    const g = ctx.createLinearGradient(0, cy - half, 0, cy + half);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${a.toFixed(3)})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    // Two rects so a band that runs off the right edge reappears on the left —
    // the texture wraps in `u`, and a band cut at the seam is a visible line.
    ctx.fillRect(x0, cy - half, wide, half * 2);
    if (x0 + wide > w) ctx.fillRect(x0 - w, cy - half, wide, half * 2);
  }

  const tex = new CanvasTexture(canvas);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * Build the sky dome. `px` is the map edge — `0` (the `low` tier) ships no map
 * and the dome is a flat fill, i.e. exactly the old behaviour, which is a
 * legitimate cheap tier.
 *
 * ⚠ NIGHT IS THIS SAME DOME WITH A DIFFERENT PALETTE ROW, not a second sky.
 * That is why the gradient stops and the cloud lift were moved out to
 * `daylight.ts`: a night sky built by a second function would drift from the day
 * one the first time either was touched, which is precisely the "second scene"
 * tax the charter's camera-modes rule exists to avoid, one surface down.
 */
export function buildSky(scene: Scene, track: Track, px: number, sky: Daylight): Mesh {
  const tex = px > 0 ? skyTexture(px, mulberry32(SKY_SEED), sky) : null;
  if (tex) track(tex);
  const dome = new Mesh(
    track(new SphereGeometry(SKY_RADIUS_FT, 32, 16)),
    // ⚠ UNLIT. A sky lit by the scene's own sun would darken on the side away
    // from it, which is the opposite of what the sky does, and would put the
    // stadium's shadow logic in charge of the horizon.
    track(
      new MeshBasicMaterial({
        color: tex ? 0xffffff : sky.skyStops[1],
        side: BackSide,
        ...(tex ? { map: tex } : {}),
        // The dome is drawn like a background: never occludes, never occluded.
        depthWrite: false,
      }),
    ),
  );
  dome.name = 'sky';
  dome.renderOrder = -1;
  scene.add(dome);
  return dome;
}
