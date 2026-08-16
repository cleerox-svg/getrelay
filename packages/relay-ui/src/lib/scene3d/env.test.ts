// The half of `env.ts` that can be checked without a GPU — which is most of the
// part that can be wrong quietly.
//
// A PMREM either compiles or it does not, and the visual gate catches that. What
// the visual gate CANNOT catch is a sun painted at the wrong azimuth (it just
// looks like a different-looking scene), a disc whose energy scales with the
// texture resolution (so the look changes when someone bumps `width`), or a
// memory figure that was asserted in a doc comment and never computed. Those are
// what this file pins.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { paintSkyEquirect, skyEnvBytes, sunAnglesFromDirection, type SkyEnvConfig } from './env';

const CFG: SkyEnvConfig = {
  elevationDeg: 52,
  azimuthDeg: 143,
  sunAngularDiameterDeg: 0.53,
  sunColor: 0xfff1d6,
  sunIntensity: 60,
  haloRadiusDeg: 26,
  haloIntensity: 0.9,
  zenithColor: 0x1f6ec8,
  horizonColor: 0xdceff8,
  groundColor: 0x5c7a4a,
};

/** Read one texel back out of the half-float buffer as linear RGB. */
function texel(sky: ReturnType<typeof paintSkyEquirect>, i: number, j: number) {
  const o = (j * sky.width + i) * 4;
  const f = THREE.DataUtils.fromHalfFloat;
  return { r: f(sky.data[o]!), g: f(sky.data[o + 1]!), b: f(sky.data[o + 2]!) };
}

/** Nearest texel to a direction, using three's own equirectUv convention. */
function texelAt(sky: ReturnType<typeof paintSkyEquirect>, elDeg: number, azDeg: number) {
  const v = (elDeg / 180) + 0.5;
  const u = (azDeg / 360) + 0.5;
  const i = Math.min(sky.width - 1, Math.max(0, Math.floor(u * sky.width)));
  const j = Math.min(sky.height - 1, Math.max(0, Math.floor(v * sky.height)));
  return texel(sky, i, j);
}

const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('sunAnglesFromDirection', () => {
  it('matches three’s equirect convention: azimuth is atan2(z, x)', () => {
    expect(sunAnglesFromDirection(1, 0, 0)).toEqual({ elevationDeg: 0, azimuthDeg: 0 });
    const east = sunAnglesFromDirection(0, 0, 5);
    expect(east.azimuthDeg).toBeCloseTo(90, 6);
    const up = sunAnglesFromDirection(0, 3, 0);
    expect(up.elevationDeg).toBeCloseTo(90, 6);
  });

  it('is scale-invariant, so a light position can be handed straight in', () => {
    const a = sunAnglesFromDirection(-160, 260, 120);
    const b = sunAnglesFromDirection(-16, 26, 12);
    expect(a.elevationDeg).toBeCloseTo(b.elevationDeg, 6);
    expect(a.azimuthDeg).toBeCloseTo(b.azimuthDeg, 6);
  });
});

describe('paintSkyEquirect', () => {
  const sky = paintSkyEquirect(CFG);

  it('paints an RGBA half-float equirect of the requested shape', () => {
    expect(sky.width).toBe(512);
    expect(sky.height).toBe(256);
    expect(sky.data.length).toBe(512 * 256 * 4);
  });

  it('is deterministic — the same config paints byte-identical pixels', () => {
    // /GRAPHICS.md §7: scene content is seeded or it is not gate-able. This one
    // has no RNG at all, and that is the property worth freezing.
    expect(Array.from(paintSkyEquirect(CFG).data)).toEqual(Array.from(sky.data));
  });

  it('puts the sun where the config says, not 180° or a hemisphere away', () => {
    const onSun = texelAt(sky, CFG.elevationDeg, CFG.azimuthDeg);
    const opposite = texelAt(sky, CFG.elevationDeg, CFG.azimuthDeg - 180);
    // Same elevation, opposite azimuth: identical base gradient, so any
    // difference is the halo/disc and nothing else.
    expect(lum(onSun)).toBeGreaterThan(lum(opposite) * 2);
  });

  it('carries a real elevation gradient — zenith is not the horizon', () => {
    const zen = texelAt(sky, 88, CFG.azimuthDeg - 180);
    const hor = texelAt(sky, 1, CFG.azimuthDeg - 180);
    // Painted from the golf palette: a deep blue zenith under a pale haze band.
    expect(hor.b).toBeGreaterThan(zen.b);
    expect(lum(hor)).toBeGreaterThan(lum(zen));
  });

  it('bounces the GROUND colour below the horizon, not the sky', () => {
    const below = texelAt(sky, -60, 0);
    const above = texelAt(sky, 60, 0);
    // Turf green: G dominates and B collapses. This is the value baseball will
    // swap for infield brown, so it has to actually reach the pixels.
    expect(below.g).toBeGreaterThan(below.b);
    expect(above.b).toBeGreaterThan(above.g);
  });

  it('does not glow below the horizon even directly under the sun', () => {
    const under = texelAt(sky, -30, CFG.azimuthDeg);
    const away = texelAt(sky, -30, CFG.azimuthDeg - 180);
    expect(lum(under)).toBeCloseTo(lum(away), 3);
  });

  it('conserves sun energy across resolutions', () => {
    // The disc is widened to a texel when it is sub-texel, and its radiance is
    // divided by the solid-angle ratio. If that scaling were wrong, doubling
    // `width` would quietly change how bright the scene is — the sort of bug
    // that gets blamed on the tone mapper a year later.
    const total = (w: number) => {
      const s = paintSkyEquirect({ ...CFG, width: w, haloIntensity: 0 });
      const f = THREE.DataUtils.fromHalfFloat;
      // Solid-angle weighted sum of everything above the base gradient.
      const flat = paintSkyEquirect({ ...CFG, width: w, haloIntensity: 0, sunIntensity: 0 });
      let sum = 0;
      for (let j = 0; j < s.height; j++) {
        const el = ((j + 0.5) / s.height - 0.5) * Math.PI;
        const dOmega = (Math.cos(el) * Math.PI * Math.PI * 2) / (s.width * s.height);
        for (let i = 0; i < s.width; i++) {
          const o = (j * s.width + i) * 4;
          sum += (f(s.data[o + 1]!) - f(flat.data[o + 1]!)) * dOmega;
        }
      }
      return sum;
    };
    const a = total(256);
    const b = total(512);
    expect(a).toBeGreaterThan(0);
    // Within 15%: the widened disc is a jagged texel set, so exact equality is
    // not available, but an unscaled disc would differ by ~4x.
    expect(b / a).toBeGreaterThan(0.85);
    expect(b / a).toBeLessThan(1.15);
  });

  it('never paints a negative or non-finite radiance', () => {
    const f = THREE.DataUtils.fromHalfFloat;
    let bad = 0;
    for (let k = 0; k < sky.data.length; k++) {
      const val = f(sky.data[k]!);
      if (!Number.isFinite(val) || val < 0) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe('skyEnvBytes', () => {
  it('reproduces three’s cubeUV allocation rule', () => {
    // `_setSize(width/4)` then `_allocateTargets()`: 3*max(cube,112) x 4*cube,
    // half-float RGBA, no mips. These are the numbers GOLF.md quotes, so they
    // are asserted rather than believed.
    expect(skyEnvBytes(512)).toEqual({ cubeSize: 128, bytes: 384 * 512 * 8 });
    expect(skyEnvBytes(1024)).toEqual({ cubeSize: 256, bytes: 768 * 1024 * 8 });
    // The 8x128 gradient `lib/golf/scenery.ts` still paints for the `low` tier:
    // a 2x2 cube. That is why it was never worth more than a mirror ball.
    expect(skyEnvBytes(8).cubeSize).toBe(2);
  });

  it('keeps the shipped size at 1.5 MiB', () => {
    expect(skyEnvBytes(512).bytes).toBe(1572864);
  });
});
