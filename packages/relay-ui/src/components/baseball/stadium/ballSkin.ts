// THE BALL'S SEAMS — one procedural equirectangular map, no image asset.
//
// ⚠ WHY IT IS A TEXTURE AND NOT GEOMETRY, DECIDED BY ARITHMETIC. Measured off
// the shipped shots, the ball is **33 px** across at its largest anywhere in
// the game (`contact`, just off the bat), **28 px** at the plate in `batter`,
// and **5 px** at the tracer tip in `homerun`. A raised seam is 108 stitches of
// geometry on a mesh that is 192 triangles today and is drawn at five pixels
// half the time. As a map it is one canvas, zero triangles, zero draw calls and
// the same one material.
//
// ⚠ AND IT IS THE ONE TEXTURE IN THIS DIRECTORY THAT *WANTS* MIPMAPS.
// `crowd.ts`, `windows.ts` and `grain.ts` all switch them off with the same
// argument — a mip chain averages their detail to a flat colour at exactly the
// distance the surface is read from. The ball is the opposite case and the
// arithmetic says so: at 5 px a real baseball IS an off-white dot, so averaging
// the seams away at range is not a loss of information, it is the correct
// answer. Left at three's defaults (`generateMipmaps`, trilinear minification)
// deliberately, and the seam's coverage is what makes that safe — see
// `SEAM_HALF_RAD`.
//
// ⚠ WHITE IS "UNCHANGED", the same convention `crowd.ts`, `grain.ts` and
// `windows.ts` use: the map MULTIPLIES `flight.ts`'s `BALL_COLOR`, so the
// leather stays the one authored albedo and the seam is a modulation of it. A
// ball skin can therefore never repaint the ball, only cut into it.
//
// ⚠ SEEDED, NEVER `Math.random`. Only the stitch length jitters, and it jitters
// off a module constant so two harness runs write byte-identical PNGs.

import { CanvasTexture, SRGBColorSpace } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';

/** Fixed seed. Determinism is a hard gate — see the header. */
const SKIN_SEED = 20260818;

/**
 * The seam, as a closed curve that lies EXACTLY on the unit sphere.
 *
 * ⚠ IT IS A CLOSED FORM, NOT A TRACED SHAPE, and that matters because a
 * hand-plotted curve would not close and would not stay on the sphere. Take
 *
 *     P(t) = ( a·cos t + b·cos 3t,  c·sin 2t,  a·sin t − b·sin 3t )
 *
 * Then `Px² + Pz² = a² + b² + 2ab·cos 4t` and `Py² = c²·sin² 2t
 * = c²(1 − cos 4t)/2`, so choosing **`c² = 4ab`** kills the `cos 4t` term
 * outright and the sum collapses to `(a + b)²`. With `a + b = 1` the curve is on
 * the unit sphere for every `t`, with no normalisation step and no drift — which
 * is what lets the distance field below be a pure angle.
 *
 * `a` is the only shape parameter left. FEEL KNOB: it sets how far the seam
 * swings off the equator, `asin(c) = asin(2√(a(1−a)))`. 0.85 gives ±45.6°,
 * which is the two-peanut cover a baseball has; 0.5 degenerates to a great
 * circle and 1.0 to a doubled equator.
 */
const SEAM_A = 0.85;
const SEAM_B = 1 - SEAM_A;
const SEAM_C = 2 * Math.sqrt(SEAM_A * SEAM_B);

/**
 * A point of the seam, on the unit sphere. Exported so `ballSkin.test.ts` can
 * assert the closure identity above rather than take the algebra on trust — a
 * wrong `SEAM_C` still LOOKS like a seam and puts the curve off the sphere,
 * which quietly breaks the distance field the whole map is drawn from.
 */
export function seamPoint(t: number): [number, number, number] {
  return [
    SEAM_A * Math.cos(t) + SEAM_B * Math.cos(3 * t),
    SEAM_C * Math.sin(2 * t),
    SEAM_A * Math.sin(t) - SEAM_B * Math.sin(3 * t),
  ];
}

/**
 * Half-widths, radians of arc from the seam curve.
 *
 * ⚠ THESE ARE A COVERAGE BUDGET, NOT A LOOK. The seam band's area on a unit
 * sphere is `length × 2w`; the curve is **8.753 rad** long (asserted), so the
 * stitch rows between 0.030 and 0.075 rad sweep 8.753 × 2 × 0.045 = 0.79 sr of
 * 4π, 6.3 %, and `STITCH_DUTY` takes the red itself to a measured **2.66 %**.
 * That is what makes the mip average 95 % leather, and the far ball 98.0 % of
 * the seamless one it replaces — the property that stops "seams that read at
 * 33 px" from becoming "a pink dot at 5". Widen these and both numbers move;
 * `ballSkin.test.ts` integrates the shipped classifier and asserts them.
 */
export const SEAM_HALF_RAD = 0.018;
export const STITCH_IN_RAD = 0.03;
export const STITCH_OUT_RAD = 0.075;

/** Stitches per full circuit of the seam, per side. FEEL KNOB — a real ball has 108. */
const STITCH_COUNT = 54;
/** Fraction of one stitch pitch the thread actually occupies. FEEL KNOB. */
const STITCH_DUTY = 0.42;

/**
 * Multipliers on `BALL_COLOR`. FEEL KNOBS, and both are DARKENINGS because a
 * multiplying map has no other move — see the header.
 */
const THREAD_RGB = [207, 63, 55] as const;
const GROOVE_RGB = [219, 217, 214] as const;
/** White — "leather, exactly as `flight.ts` authored it". */
const LEATHER_RGB = [255, 255, 255] as const;

/** How many points the seam is sampled at for the distance field. */
const CURVE_SAMPLES = 360;

/**
 * The seam, sampled once at module load with its cumulative arc length and its
 * seeded per-stitch duty jitter.
 *
 * ⚠ ARC LENGTH, NOT `t`. `t` is not uniform along this curve — it crawls at the
 * swings and races across the equator — so a stitch row spaced in `t` bunches
 * up exactly where the seam is most visible.
 */
const SEAM = (() => {
  const rng = mulberry32(SKIN_SEED);
  const p: Array<[number, number, number]> = [];
  const arc = new Float64Array(CURVE_SAMPLES);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    p.push(seamPoint((i / CURVE_SAMPLES) * Math.PI * 2));
    if (i > 0) {
      const a = p[i - 1]!;
      const b = p[i]!;
      arc[i] = arc[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
  }
  const last = p[CURVE_SAMPLES - 1]!;
  const first = p[0]!;
  const total =
    arc[CURVE_SAMPLES - 1]! +
    Math.hypot(first[0] - last[0], first[1] - last[1], first[2] - last[2]);
  const jitter = new Float64Array(STITCH_COUNT);
  for (let i = 0; i < STITCH_COUNT; i++) jitter[i] = 0.82 + rng() * 0.36;
  return { p, arc, total, jitter };
})();

/** The seam's total arc length on the unit sphere, rad. */
export const seamLengthRad = () => SEAM.total;

/**
 * What ONE direction on the ball's surface multiplies `BALL_COLOR` by, as sRGB
 * bytes — white is "leather, unchanged".
 *
 * ⚠ IT IS EXPORTED AND THE BUILDER IS ITS ONLY OTHER CALLER, so
 * `ballSkin.test.ts` integrates THE SHIPPED CLASSIFIER over the sphere rather
 * than a copy of it. The coverage budget in `SEAM_HALF_RAD`'s note is the whole
 * argument for leaving mipmaps on, and a budget checked against a re-typed
 * version of the code it is budgeting would be checking nothing.
 */
export function seamShade(nx: number, ny: number, nz: number): readonly [number, number, number] {
  // Nearest point on the seam, by dot product — both are unit vectors, so the
  // largest dot is the smallest arc.
  let best = -2;
  let bestI = 0;
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const q = SEAM.p[i]!;
    const d = nx * q[0] + ny * q[1] + nz * q[2];
    if (d > best) {
      best = d;
      bestI = i;
    }
  }
  const ang = Math.acos(Math.min(1, Math.max(-1, best)));
  if (ang < SEAM_HALF_RAD) return GROOVE_RGB;
  if (ang < STITCH_IN_RAD || ang > STITCH_OUT_RAD) return LEATHER_RGB;
  // Which side of the seam this direction is on, so the two rows can run half a
  // pitch out of phase — which is what makes a run of stitches read as a
  // herringbone rather than as two parallel dashed lines.
  const a = SEAM.p[bestI]!;
  const b = SEAM.p[(bestI + 1) % CURVE_SAMPLES]!;
  const cross =
    nx * (a[1] * b[2] - a[2] * b[1]) +
    ny * (a[2] * b[0] - a[0] * b[2]) +
    nz * (a[0] * b[1] - a[1] * b[0]);
  const s = (SEAM.arc[bestI]! / SEAM.total) * STITCH_COUNT + (cross >= 0 ? 0 : 0.5);
  const idx = ((Math.floor(s) % STITCH_COUNT) + STITCH_COUNT) % STITCH_COUNT;
  return s - Math.floor(s) < STITCH_DUTY * SEAM.jitter[idx]! ? THREAD_RGB : LEATHER_RGB;
}

/**
 * The seam map, or `null` with no DOM (a unit test, an SSR pass) or at a tier
 * with maps switched off — a legitimately cheap ball, not a broken one.
 *
 * `px` is the canvas WIDTH; the height is half of it, which is what an
 * equirectangular map of a sphere is.
 */
export function buildBallTexture(px: number): CanvasTexture | null {
  if (px <= 0 || typeof document === 'undefined') return null;
  const w = Math.max(16, Math.round(px));
  const h = Math.max(8, Math.round(px / 2));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const img = ctx.createImageData(w, h);
  const data = img.data;
  for (let py = 0; py < h; py++) {
    // three's `SphereGeometry` writes `uv = (φ/2π, 1 − θ/π)` and `CanvasTexture`
    // flips Y, so canvas row 0 is the +Y pole. θ from the top, φ around.
    const theta = (Math.PI * (py + 0.5)) / h;
    const sinT = Math.sin(theta);
    const ny = Math.cos(theta);
    for (let pxi = 0; pxi < w; pxi++) {
      const phi = (Math.PI * 2 * (pxi + 0.5)) / w;
      const [r, g, b] = seamShade(-Math.cos(phi) * sinT, ny, Math.sin(phi) * sinT);
      const o = (py * w + pxi) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
