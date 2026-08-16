// Guards the COLOUR BALANCE of golf's sky environment.
//
// `ENV_INTENSITY`'s comment derives the total ambient from the painted sky's
// cosine-weighted irradiance. That derivation is the whole balance of the IBL
// change, and until now it was a number in a comment that nothing re-checked. A
// later tweak to any sky colour could move it silently, and the failure is not a
// crash — it is the scene slowly going the wrong colour.
//
// ⚠ THE FINDING THAT MOTIVATED THIS TEST. The visual gate flagged two real
// caveats after IBL landed: the deepest tree-shadow rough drifts toward cyan
// (hue 126° → 180°), and warm materials like the pond's mud bank desaturate
// toward grey. Both have one cause — the sky's blue:red irradiance ratio is
// ~4.8:1 where the hemisphere light it replaced was ~1.6:1.
//
// The gate's suggested fix was "warm GROUND_BOUNCE / HORIZON". **Measured, that
// does almost nothing**: warming both moves the ratio 4.83 → 4.79. For an
// UP-FACING normal the cosine weighting concentrates on the upper sky, so the
// horizon band and the sub-horizon bounce contribute nearly zero to this number.
// The levers that actually work are `SKY_MID` and `ZENITH`:
//
//   current (skyMid 0x8ac6ea, zenith 0x1f6ec8)          B:R 4.83
//   skyMid → 0x9ec9e0                                    B:R 3.68
//   skyMid → 0xa8cbdc, zenith → 0x2a72bd                 B:R 2.97
//   the hemisphere light this replaced                   B:R 1.64
//
// Anyone tuning the cyan-shade caveat should start there, and re-run the visual
// gate afterwards — the cool shade is also what bought the scene its shadow
// FORM, so pulling the ratio all the way back to 1.64 would undo the gain.
//
// This test does not pick a target. It pins the ratio inside a band wide enough
// for deliberate tuning and tight enough that an accidental change trips it.

import { describe, expect, it } from 'vitest';
import { DataUtils } from 'three';
import { paintSkyEquirect, type SkyEnvConfig } from '../../../lib/scene3d/env';
import { GOLF_SKY } from './env';

/**
 * Cosine-weighted irradiance on an up-facing normal, integrated over the upper
 * hemisphere of the painted equirect. Row 0 is nadir (`flipY` is false), so the
 * elevation of row `y` is `((y + 0.5) / height - 0.5) * PI`.
 *
 * Two weights, and conflating them is the easy mistake: `sin(elev)` is N·L for an
 * up-facing normal, and `cos(elev)` is the shrinking area of an equirect row as
 * it approaches the pole.
 */
function irradianceUp(cfg: SkyEnvConfig): { r: number; g: number; b: number } {
  const { data, width, height } = paintSkyEquirect(cfg);
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  for (let y = 0; y < height; y++) {
    const elev = ((y + 0.5) / height - 0.5) * Math.PI;
    if (elev <= 0) continue;
    const w = Math.sin(elev) * Math.cos(elev);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      r += DataUtils.fromHalfFloat(data[i]!) * w;
      g += DataUtils.fromHalfFloat(data[i + 1]!) * w;
      b += DataUtils.fromHalfFloat(data[i + 2]!) * w;
    }
    wsum += w * width;
  }
  return { r: r / wsum, g: g / wsum, b: b / wsum };
}

/** A representative golf sun — mid-morning, high and behind-left. */
const SUN = { elevationDeg: 42, azimuthDeg: 140 };

describe('golf sky — irradiance colour balance', () => {
  it('stays cooler than the hemisphere light it replaced, but not arbitrarily so', () => {
    const e = irradianceUp({ ...GOLF_SKY, ...SUN });
    const blueToRed = e.b / e.r;

    // Lower bound: below ~2 the sky stops being a sky and the change stops
    // buying the cool-shade form that justified it.
    // Upper bound: above ~6 the deepest shade goes frankly cyan, which the gate
    // already caught at 4.8. Tighten this as the caveat gets tuned; do not raise
    // it to make a change pass.
    expect(blueToRed).toBeGreaterThan(2);
    expect(blueToRed).toBeLessThan(6);
  });

  it('is green-dominant in luminance, not blue-dominant', () => {
    // Blue outweighs red by design, but if BLUE ever carries more luminance than
    // GREEN the scene reads as moonlight rather than daylight. Rec.709 weights.
    const e = irradianceUp({ ...GOLF_SKY, ...SUN });
    expect(0.7152 * e.g).toBeGreaterThan(0.0722 * e.b);
  });

  it('carries essentially no diffuse energy from the sun disc', () => {
    // ENV_INTENSITY's derivation assumes this. A 0.53° disc is 6.7e-5 sr, so
    // even at radiance 60 it is ~0.4% of the total — the DirectionalLight is the
    // key light, and an env sun carrying real energy would double it.
    const withSun = irradianceUp({ ...GOLF_SKY, ...SUN });
    const noSun = irradianceUp({ ...GOLF_SKY, ...SUN, sunIntensity: 0 });
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect((lum(withSun) - lum(noSun)) / lum(withSun)).toBeLessThan(0.05);
  });

  it('does not depend on where the sun is, to within the halo', () => {
    // The diffuse term should be dominated by the sky gradient, not the sun's
    // position. If moving the sun swings irradiance a lot, the halo is too hot
    // and is acting as a second key light.
    const a = irradianceUp({ ...GOLF_SKY, elevationDeg: 20, azimuthDeg: 0 });
    const b = irradianceUp({ ...GOLF_SKY, elevationDeg: 70, azimuthDeg: 200 });
    const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(Math.abs(lum(a) - lum(b)) / lum(a)).toBeLessThan(0.35);
  });
});
