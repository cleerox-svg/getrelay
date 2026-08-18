// THE BALL'S SEAMS — the two properties the map cannot be eyeballed for.
//
// ⚠ WHY THIS FILE EXISTS. `stadium/flight.ts` carried the line "off-white
// leather, no seams at this milestone" for four rounds and the visual gate
// recorded a standing FAIL against its own checklist for every one of them: the
// game is about reading a pitch, and a featureless sphere gives a player nothing
// to judge one against. The map that fixes it has two claims that a PNG cannot
// settle, and both are arithmetic:
//
//   • THE CURVE IS ON THE SPHERE. The whole texture is a distance field to that
//     curve, so a curve that leaves the unit sphere makes every angle below it
//     wrong — and it still LOOKS like a seam, which is why an eye is the wrong
//     instrument.
//   • THE COVERAGE IS A BUDGET. Measured off the shipped PNGs the ball is 33 px
//     across at `contact`, 28 px at the plate in `batter` and 5 px at the tracer
//     tip in `homerun`. At 5 px the whole map collapses to its area-weighted
//     MEAN through the mip chain, so what keeps "seams that read at 33 px" from
//     turning into "a pink dot at 5" is the fraction of the sphere the thread
//     actually covers. That is a number, and it is the number asserted here.
//
// MUTATIONS WATCHED TO FAIL (each reverted, counts as observed):
//   1. `SEAM_C` hand-set to 0.8 instead of `2√(ab)` — the closure
//      identity broken, the curve off the sphere               → 1 fail
//   2. `SEAM_A` 0.85 → 0.5, which degenerates the seam to a
//      great circle                                            → 1 fail
//   3. `STITCH_OUT_RAD` 0.075 → 0.30, "bolder stitches"         → 2 fail
//      (the coverage budget AND the far-ball tint — at 4× the
//      width the far ball loses a fifth of its luminance and the
//      hue swings into the red)
//   4. `STITCH_DUTY` 0.42 → 1, i.e. a solid red band            → 2 fail
//      (the same two. ⚠ An earlier draft of this line predicted
//      the far-ball tint would survive a solid band at the
//      shipped width; measured, it does not — 6.3 % coverage is
//      already past the 0.93 bound. The prediction was wrong and
//      the number is what is recorded.)

import { describe, expect, it } from 'vitest';
import {
  buildBallTexture,
  SEAM_HALF_RAD,
  STITCH_OUT_RAD,
  seamLengthRad,
  seamPoint,
  seamShade,
} from './ballSkin';

/** `flight.ts`'s ball albedo, quoted — the thing the map multiplies. */
const BALL_COLOR = [0xf7, 0xf4, 0xea] as const;
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/**
 * Area-weighted integral of the SHIPPED classifier over the whole sphere.
 *
 * The `sin θ` weight is the point: an equirect grid over-samples the poles by a
 * factor of `1/sin θ`, and an unweighted mean would therefore report whatever
 * the map does at the poles as though it were the ball.
 */
function integrate(steps = 256) {
  let wsum = 0;
  const mean = [0, 0, 0];
  let thread = 0;
  let groove = 0;
  for (let iy = 0; iy < steps / 2; iy++) {
    const theta = (Math.PI * (iy + 0.5)) / (steps / 2);
    const w = Math.sin(theta);
    for (let ix = 0; ix < steps; ix++) {
      const phi = (Math.PI * 2 * (ix + 0.5)) / steps;
      const c = seamShade(-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta));
      wsum += w;
      for (let k = 0; k < 3; k++) mean[k]! += w * c[k]!;
      if (c[0] === 207) thread += w;
      else if (c[0] === 219) groove += w;
    }
  }
  return {
    mean: mean.map((v) => v / wsum) as [number, number, number],
    thread: thread / wsum,
    groove: groove / wsum,
  };
}

describe('the seam curve is a closed curve ON the unit sphere', () => {
  it('|P(t)| = 1 for every t, which is the `c² = 4ab` identity', () => {
    // ⚠ THE ONE DERIVATION IN THE FILE, ASSERTED RATHER THAN TRUSTED.
    // `Px² + Pz² = a² + b² + 2ab·cos 4t` and `Py² = c²(1 − cos 4t)/2`, so only
    // `c² = 4ab` cancels the `cos 4t` and leaves `(a + b)² = 1`. Any other `c`
    // gives a curve that breathes in and out of the sphere — and still looks
    // like a seam in a render.
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const [x, y, z] = seamPoint((i / 2000) * Math.PI * 2);
      worst = Math.max(worst, Math.abs(Math.hypot(x, y, z) - 1));
    }
    log(`\n[BALL SEAM] worst |P(t)| − 1 over 2,000 samples: ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-12);
  });

  it('it closes, and it swings off the equator like a two-piece cover', () => {
    const a = seamPoint(0);
    const b = seamPoint(Math.PI * 2);
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(1e-12);
    // Max |y| is `SEAM_C` exactly, so this pins the shape parameter: 0.85 gives
    // ±45.6°, a baseball's two peanut-shaped panels. `SEAM_A = 0.5` collapses it
    // to a great circle at ±90° and `1.0` to a doubled equator at 0°.
    let maxY = 0;
    for (let i = 0; i < 2000; i++) maxY = Math.max(maxY, Math.abs(seamPoint((i / 2000) * Math.PI * 2)[1]));
    const swingDeg = (Math.asin(maxY) * 180) / Math.PI;
    log(`[BALL SEAM] swing off the equator: ±${swingDeg.toFixed(1)}°, arc length ${seamLengthRad().toFixed(3)} rad`);
    expect(swingDeg).toBeGreaterThan(35);
    expect(swingDeg).toBeLessThan(60);
  });
});

describe('the coverage budget — what keeps the FAR ball off-white', () => {
  it('the thread covers a small enough fraction of the sphere to mip away', () => {
    const { mean, thread, groove } = integrate();
    log(
      `[BALL SEAM] area-weighted coverage: thread ${(thread * 100).toFixed(2)} %, ` +
        `groove ${(groove * 100).toFixed(2)} %, leather ${((1 - thread - groove) * 100).toFixed(2)} %`,
    );
    // The band between `SEAM_HALF_RAD` and `STITCH_OUT_RAD` is a length × width
    // budget: ~7.3 rad of curve × 2 × 0.045 rad ≈ 5.2 % of 4π before the duty
    // cycle takes roughly half of it back.
    expect(SEAM_HALF_RAD).toBeLessThan(STITCH_OUT_RAD);
    expect(thread).toBeLessThan(0.05);
    expect(thread).toBeGreaterThan(0.005);
  });

  it('the FAR ball is still an off-white ball, not a pink dot', () => {
    // ⚠ THIS IS THE 5 px CLAIM, AND IT IS THE REASON MIPMAPS ARE LEFT ON HERE
    // WHILE `crowd.ts`, `windows.ts` AND `grain.ts` ALL SWITCH THEM OFF. At the
    // tracer tip the whole map resolves to its area-weighted mean, so that mean
    // IS the far ball. Averaging is the correct answer only if the average is
    // still leather.
    const { mean } = integrate();
    const far = [0, 1, 2].map((k) => (BALL_COLOR[k]! * mean[k]!) / 255) as [number, number, number];
    const near = luma(BALL_COLOR[0], BALL_COLOR[1], BALL_COLOR[2]);
    const far709 = luma(far[0], far[1], far[2]);
    log(
      `[BALL SEAM] the ball at 5 px: rgb(${far.map((v) => v.toFixed(0)).join(',')}) ` +
        `L ${far709.toFixed(1)} against the seamless ${near.toFixed(1)} ` +
        `(${((100 * far709) / near).toFixed(1)} %)\n`,
    );
    // Within a tenth of a stop of the seamless ball it replaces.
    expect(far709).toBeGreaterThan(0.93 * near);
    // …and still NEUTRAL. A ball whose far mip is measurably red is the failure
    // this budget exists for, and luminance alone cannot see it: the thread is
    // dark, so a red-shifted average and a merely darker one look the same on
    // one number.
    expect(far[0]! - far[1]!).toBeLessThan(BALL_COLOR[0] - BALL_COLOR[1] + 6);
  });

  it('a tier with maps off, or no DOM, gets a plain ball rather than a crash', () => {
    expect(buildBallTexture(0)).toBeNull();
    // This suite runs in node, so there is no `document` and the real call takes
    // the same branch — asserted so the fallback is a tested path and not a
    // hopeful one.
    expect(buildBallTexture(128)).toBeNull();
  });
});
