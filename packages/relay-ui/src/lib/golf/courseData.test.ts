// Headless harness for the metric Course data layer (lib/golf/courseData.ts).
// Proves the pieces the terrain mesh and a metric physics step both rely on:
// bilinear height sampling, gradient-derived normals, RGBA→enum mask decoding,
// the unified getSurfaceAt() lookup, displaced-plane mesh construction, and the
// yard→meter bake of a real hole. Run: `pnpm --filter @relay/ui test`.

import { describe, it, expect } from 'vitest';
import {
  CourseData,
  HeightField,
  SurfaceMask,
  Surface,
  SURFACE_MATERIAL,
  SURFACE_RGB,
  SURFACE_ORDER,
  buildTerrainMesh,
  buildCourseData,
  decodeSurface,
  FLAGSTICK_HEIGHT_M,
  BALL_DIAMETER_M,
  HOLE_DIAMETER_M,
  M_PER_YD,
  YD_PER_M,
} from './courseData';
import { HOLE_1, heightAt, surfaceAt } from './terrain';

// A 3×3 field over [0,2]×[0,2] (cell = 1) that is a pure plane h = 0.5·x + 0.25·z
// — so height is exact everywhere and the gradient (hence normal) is constant.
function planeField(): HeightField {
  const nx = 3;
  const nz = 3;
  const h = new Float32Array(nx * nz);
  for (let r = 0; r < nz; r++)
    for (let c = 0; c < nx; c++) h[r * nx + c] = 0.5 * c + 0.25 * r;
  return new HeightField(h, nx, nz, 1);
}

describe('metric constants', () => {
  it('use real regulation dimensions in meters', () => {
    expect(FLAGSTICK_HEIGHT_M).toBe(2.13);
    expect(BALL_DIAMETER_M).toBe(0.0427);
    expect(HOLE_DIAMETER_M).toBe(0.108);
    expect(M_PER_YD).toBeCloseTo(0.9144, 6);
    expect(YD_PER_M * M_PER_YD).toBeCloseTo(1, 12);
  });
});

describe('HeightField', () => {
  it('returns exact node samples and bilinear midpoints on a plane', () => {
    const f = planeField();
    // Nodes are exact.
    expect(f.height(0, 0)).toBeCloseTo(0, 12);
    expect(f.height(2, 0)).toBeCloseTo(1.0, 12);
    expect(f.height(0, 2)).toBeCloseTo(0.5, 12);
    // Bilinear interior points on a plane are exact too.
    expect(f.height(0.5, 0.5)).toBeCloseTo(0.5 * 0.5 + 0.25 * 0.5, 12);
    expect(f.height(1.3, 1.7)).toBeCloseTo(0.5 * 1.3 + 0.25 * 1.7, 12);
  });

  it('clamps out-of-bounds queries to the edge', () => {
    const f = planeField();
    expect(f.height(-5, 0)).toBeCloseTo(f.height(0, 0), 12);
    expect(f.height(99, 99)).toBeCloseTo(f.height(2, 2), 12);
  });

  it('derives a unit normal from the slope', () => {
    const f = planeField(); // ∂h/∂x = 0.5, ∂h/∂z = 0.25
    const n = f.normal(1, 1);
    const len = Math.hypot(n.x, n.y, n.z);
    expect(len).toBeCloseTo(1, 12);
    // n ∝ (-0.5, 1, -0.25); the normal tilts against the up-slope.
    expect(n.x).toBeLessThan(0);
    expect(n.z).toBeLessThan(0);
    expect(n.y).toBeGreaterThan(0);
    expect(n.x / n.z).toBeCloseTo(0.5 / 0.25, 6); // ratio matches the gradient
  });

  it('gives a straight-up normal on flat ground', () => {
    const h = new Float32Array(9).fill(3);
    const f = new HeightField(h, 3, 3, 1);
    const n = f.normal(1, 1);
    expect(n.x).toBeCloseTo(0, 12);
    expect(n.y).toBeCloseTo(1, 12);
    expect(n.z).toBeCloseTo(0, 12);
  });

  it('rejects a mismatched buffer', () => {
    expect(() => new HeightField(new Float32Array(5), 3, 3, 1)).toThrow();
  });
});

describe('SurfaceMask', () => {
  it('decodes an RGBA raster to the surface enum', () => {
    // 2×1 mask: left = FAIRWAY, right = BUNKER.
    const rgba = new Uint8ClampedArray(2 * 1 * 4);
    const put = (i: number, s: (typeof SURFACE_ORDER)[number]) => {
      const [r, g, b] = SURFACE_RGB[s];
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    };
    put(0, Surface.FAIRWAY);
    put(1, Surface.BUNKER);
    const m = new SurfaceMask(rgba, 2, 1, 1);
    expect(m.surface(0, 0)).toBe(Surface.FAIRWAY);
    expect(m.surface(1, 0)).toBe(Surface.BUNKER);
  });

  it('nearest-matches a noisy colour to the closest palette entry', () => {
    const [r, g, b] = SURFACE_RGB[Surface.WATER];
    expect(decodeSurface(r + 6, g - 5, b + 4)).toBe(Surface.WATER);
  });

  it('every palette colour round-trips to its own surface', () => {
    for (const s of SURFACE_ORDER) {
      const [r, g, b] = SURFACE_RGB[s];
      expect(decodeSurface(r, g, b)).toBe(s);
    }
  });
});

describe('CourseData.getSurfaceAt', () => {
  it('returns height, normal, surface and material together', () => {
    const f = planeField();
    const rgba = new Uint8ClampedArray(9 * 4);
    const [r, g, b] = SURFACE_RGB[Surface.GREEN];
    for (let i = 0; i < 9; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    const cd = new CourseData(f, new SurfaceMask(rgba, 3, 3, 1));
    const s = cd.getSurfaceAt(1, 1);
    expect(s.surface).toBe(Surface.GREEN);
    expect(s.friction).toBe(SURFACE_MATERIAL.GREEN.friction);
    expect(s.restitution).toBe(SURFACE_MATERIAL.GREEN.restitution);
    expect(s.height).toBeCloseTo(f.height(1, 1), 12);
    expect(Math.hypot(s.normal.x, s.normal.y, s.normal.z)).toBeCloseTo(1, 12);
  });
});

describe('buildTerrainMesh', () => {
  it('displaces a segmented plane from the field', () => {
    const f = planeField();
    const rgba = new Uint8ClampedArray(9 * 4);
    const [r, g, b] = SURFACE_RGB[Surface.FAIRWAY];
    for (let i = 0; i < 9; i++) {
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
    }
    const mesh = buildTerrainMesh(f, new SurfaceMask(rgba, 3, 3, 1), 2, 2);
    const vcount = 3 * 3;
    expect(mesh.positions.length).toBe(vcount * 3);
    expect(mesh.normals.length).toBe(vcount * 3);
    expect(mesh.uvs.length).toBe(vcount * 2);
    expect(mesh.colors.length).toBe(vcount * 3);
    expect(mesh.indices.length).toBe(2 * 2 * 6);
    // Every vertex Y equals the field height at its (x, z).
    for (let v = 0; v < vcount; v++) {
      const x = mesh.positions[v * 3]!;
      const z = mesh.positions[v * 3 + 2]!;
      expect(mesh.positions[v * 3 + 1]!).toBeCloseTo(f.height(x, z), 10);
    }
    // Corner UVs span [0,1].
    expect(mesh.uvs[0]).toBe(0);
    expect(mesh.uvs[mesh.uvs.length - 2]).toBe(1);
    // Colour matches the painted surface.
    expect(mesh.colors[0]).toBeCloseTo(r / 255, 6);
  });
});

describe('buildCourseData (yard hole → metric layer)', () => {
  const cd = buildCourseData(
    HOLE_1,
    (d, x) => heightAt(HOLE_1, d, x),
    (d, x) => surfaceAt(HOLE_1, d, x),
    { cellM: 1.5 },
  );

  it('classifies the real hole features through the metric mask', () => {
    const at = (dYd: number, xYd: number) =>
      cd.getSurfaceAt(xYd * M_PER_YD, dYd * M_PER_YD).surface;
    expect(at(HOLE_1.tee.d, HOLE_1.tee.x)).toBe(Surface.TEE);
    expect(at(HOLE_1.pin.d, HOLE_1.pin.x)).toBe(Surface.GREEN);
    // Pond guarding the approach (hazard[2]) and the fairway bunker (hazard[0]).
    expect(at(478, 16)).toBe(Surface.WATER);
    expect(at(300, 20)).toBe(Surface.BUNKER);
    // Off the corridor is rough/OB → ROUGH on the mask.
    expect(at(180, 90)).toBe(Surface.ROUGH);
  });

  it('preserves elevation to metric scale (green pad sits above the tee)', () => {
    const teeH = cd.getSurfaceAt(HOLE_1.tee.x * M_PER_YD, HOLE_1.tee.d * M_PER_YD).height;
    const pinH = cd.getSurfaceAt(HOLE_1.pin.x * M_PER_YD, HOLE_1.pin.d * M_PER_YD).height;
    // Heights are meters: the yard elevation × 0.9144, within one grid cell.
    expect(teeH).toBeCloseTo(heightAt(HOLE_1, HOLE_1.tee.d, HOLE_1.tee.x) * M_PER_YD, 1);
    expect(pinH).toBeGreaterThan(teeH); // raised green
  });

  it('builds a mesh whose extent matches the baked field', () => {
    const mesh = cd.buildMesh(64, 96);
    expect(mesh.positions.length).toBe(65 * 97 * 3);
    // Field spans the metric width of the yard extent (±120 yd → 240 yd),
    // quantized to whole cells (cellM = 1.5), so within one cell of 240 yd.
    const spanM = cd.field.maxX - cd.field.originX;
    expect(Math.abs(spanM - 240 * M_PER_YD)).toBeLessThanOrEqual(1.5);
  });
});
