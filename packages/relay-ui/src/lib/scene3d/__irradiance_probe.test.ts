// TEMPORARY tuning probe — delete before commit.
// Computes the cosine-weighted hemispherical irradiance of the painted sky on an
// up-facing normal, so the blue:red balance can be tuned analytically instead of
// by re-shooting the harness.
import { it } from 'vitest';
import { paintSkyEquirect } from './env';
import { DataUtils } from 'three';

function irradianceUp(cfg: Parameters<typeof paintSkyEquirect>[0]) {
  const { data, width, height } = paintSkyEquirect(cfg);
  let r = 0, g = 0, b = 0, wsum = 0;
  for (let y = 0; y < height; y++) {
    // row 0 = nadir → theta from -PI/2 (down) to +PI/2 (up)
    const v = (y + 0.5) / height;
    const elev = (v - 0.5) * Math.PI;
    if (elev <= 0) continue; // upper hemisphere only for an up-facing normal
    const cosw = Math.sin(elev); // N·L for N = up
    const solid = Math.cos(elev); // equirect row area weight
    const w = cosw * solid;
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

it('probe', () => {
  const base = {
    sunAngularDiameterDeg: 0.53,
    sunColor: 0xfff1d6,
    sunIntensity: 60,
    haloRadiusDeg: 28,
    haloIntensity: 1.1,
    skyMidElevationDeg: 8,
    width: 512,
    elevationDeg: 42,
    azimuthDeg: 140,
  };
  const variants: Record<string, { zenithColor: number; skyMidColor: number; horizonColor: number; groundColor: number }> = {
    'CURRENT                      ': { zenithColor: 0x1f6ec8, skyMidColor: 0x8ac6ea, horizonColor: 0xdceff8, groundColor: 0x5c7a4a },
    'warm horizon                 ': { zenithColor: 0x1f6ec8, skyMidColor: 0x8ac6ea, horizonColor: 0xf0e8da, groundColor: 0x5c7a4a },
    'warm horizon + warm ground   ': { zenithColor: 0x1f6ec8, skyMidColor: 0x8ac6ea, horizonColor: 0xf0e8da, groundColor: 0x6e7f44 },
    'warm horiz+ground+mid        ': { zenithColor: 0x1f6ec8, skyMidColor: 0x9ec9e0, horizonColor: 0xf0e8da, groundColor: 0x6e7f44 },
    'warmer still                 ': { zenithColor: 0x2a72bd, skyMidColor: 0xa8cbdc, horizonColor: 0xf5ead6, groundColor: 0x77853f },
  };
  console.log('\n  variant                          R      G      B    B:R   G:R');
  for (const [name, v] of Object.entries(variants)) {
    const e = irradianceUp({ ...base, ...v });
    console.log(
      `  ${name} ${e.r.toFixed(3)}  ${e.g.toFixed(3)}  ${e.b.toFixed(3)}   ${(e.b / e.r).toFixed(2)}  ${(e.g / e.r).toFixed(2)}`,
    );
  }
  console.log('  hemisphere light it replaced   0.640  0.860  1.050   1.64  1.34\n');
});
