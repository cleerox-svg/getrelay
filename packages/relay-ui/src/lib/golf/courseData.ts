// Course data layer — the metric, sampled foundation the terrain mesh AND the
// ball physics both read through ONE query. It replaces the loose procedural
// functions (heightAt/gradientAt/surfaceAt in terrain.ts) with three concrete
// pieces:
//
//   • HeightField  — a sampled heightmap with BILINEAR interpolation; returns the
//                    ground HEIGHT and the surface NORMAL at any (x, z).
//   • SurfaceMask  — an RGBA mask sampled per texel; returns the SURFACE enum
//                    {TEE, FAIRWAY, GREEN, ROUGH, BUNKER, WATER}.
//   • CourseData   — wraps both + a per-surface MATERIAL table and exposes the
//                    single lookup getSurfaceAt(x,z) →
//                    { height, normal, surface, friction, restitution }.
//
// The terrain mesh is built by DISPLACING a segmented plane from the HeightField
// (buildTerrainMesh), so the rendered ground and the physics ground are the same
// samples — the look and the play can never disagree.
//
// UNITS: everything here is METERS. Real golf dimensions are the source of truth:
//   flagstick 2.13 m · ball 0.0427 m diameter · hole 0.108 m diameter.
// The legacy sim/renderer author holes in yards; buildCourseData() bakes a
// yard-space CourseHole into a metric field+mask via M_PER_YD, so this layer is
// the metric normalization of that data. Nothing here imports three.
//
// AXES: field coordinates are (x = lateral, z = downrange), height is up. A
// returned normal is {x, y, z} with y up — the consumer maps it onto its own
// scene axes (the CourseGL scene uses x→X, z→−Z, height→Y).

// --- Unit normalization ----------------------------------------------------

/** Meters per yard — the exact international-yard conversion. */
export const M_PER_YD = 0.9144;
/** Yards per meter. */
export const YD_PER_M = 1 / M_PER_YD;

/** Real regulation dimensions, in METERS — the normalized world scale. */
export const FLAGSTICK_HEIGHT_M = 2.13;
export const BALL_DIAMETER_M = 0.0427;
export const BALL_RADIUS_M = BALL_DIAMETER_M / 2;
export const HOLE_DIAMETER_M = 0.108;
export const HOLE_RADIUS_M = HOLE_DIAMETER_M / 2;

// --- Surface enum ----------------------------------------------------------

/**
 * The surfaces a course point can be. This is the exact set the SurfaceMask
 * encodes; richer lies the hole author uses (fringe, cart path, OB) are folded
 * onto these six when a mask is baked (see SURFACE_FROM_HOLE).
 */
export const Surface = {
  TEE: 'TEE',
  FAIRWAY: 'FAIRWAY',
  GREEN: 'GREEN',
  ROUGH: 'ROUGH',
  BUNKER: 'BUNKER',
  WATER: 'WATER',
} as const;
export type CourseSurface = (typeof Surface)[keyof typeof Surface];

/** All surfaces, in a stable order (mask palette index === this index). */
export const SURFACE_ORDER: CourseSurface[] = [
  Surface.TEE,
  Surface.FAIRWAY,
  Surface.GREEN,
  Surface.ROUGH,
  Surface.BUNKER,
  Surface.WATER,
];

// --- Per-surface material --------------------------------------------------

/**
 * The physical descriptor a surface carries — the "per-surface behavior" the old
 * label-only model could not express. `friction` is a normalized [0..1] rolling
 * resistance (0 = frictionless ice, 1 = the ball stops dead); `restitution` is
 * the normalized [0..1] bounce energy kept on impact (0 = no bounce). Values
 * mirror the FEEL of the yard-space rangeSim.TERRAIN table (a fast, receptive
 * green; a firm, lively fairway; grabby rough; dead sand; terminal water),
 * distilled to the two coefficients a metric physics step needs.
 */
export interface SurfaceMaterial {
  friction: number;
  restitution: number;
}

export const SURFACE_MATERIAL: Record<CourseSurface, SurfaceMaterial> = {
  TEE: { friction: 0.35, restitution: 0.5 }, // firm mown, like fairway
  FAIRWAY: { friction: 0.35, restitution: 0.5 }, // firm and lively
  GREEN: { friction: 0.22, restitution: 0.34 }, // smoothest/fastest, receptive
  ROUGH: { friction: 0.75, restitution: 0.3 }, // grabby, kills the roll
  BUNKER: { friction: 0.9, restitution: 0.12 }, // sand digs in, nearly dead
  WATER: { friction: 1.0, restitution: 0.0 }, // terminal
};

/** RGB the mask paints each surface (0..255). Distinct enough to decode exactly. */
export const SURFACE_RGB: Record<CourseSurface, [number, number, number]> = {
  TEE: [120, 180, 90],
  FAIRWAY: [90, 165, 70],
  GREEN: [150, 225, 110],
  ROUGH: [55, 110, 55],
  BUNKER: [230, 210, 150],
  WATER: [40, 110, 175],
};

// --- 3D vector -------------------------------------------------------------

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// --- HeightField -----------------------------------------------------------

/**
 * A regular grid of heights sampled with bilinear interpolation. The grid has
 * `nx` × `nz` COLUMNS of samples (so (nx-1) × (nz-1) cells) laid over the world
 * rectangle [originX, originX + (nx-1)·cellX] × [originZ, originZ + (nz-1)·cellZ].
 * Cell spacing is per-axis (real heightmaps and the render grid are rarely
 * square). Heights are row-major: index = row(z)·nx + col(x). Lengths in METERS.
 */
export class HeightField {
  readonly nx: number;
  readonly nz: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly h: Float32Array;

  constructor(
    heights: Float32Array,
    nx: number,
    nz: number,
    cellX: number,
    cellZ = cellX,
    originX = 0,
    originZ = 0,
  ) {
    if (heights.length !== nx * nz) {
      throw new Error(`HeightField: expected ${nx * nz} heights, got ${heights.length}`);
    }
    if (nx < 2 || nz < 2) throw new Error('HeightField: need at least 2×2 samples');
    this.h = heights;
    this.nx = nx;
    this.nz = nz;
    this.cellX = cellX;
    this.cellZ = cellZ;
    this.originX = originX;
    this.originZ = originZ;
  }

  /** World X of the field's far edge (inclusive). */
  get maxX(): number {
    return this.originX + (this.nx - 1) * this.cellX;
  }
  /** World Z of the field's far edge (inclusive). */
  get maxZ(): number {
    return this.originZ + (this.nz - 1) * this.cellZ;
  }

  /** Raw sample at integer grid coords, clamped to the field edge. */
  private at(col: number, row: number): number {
    const c = col < 0 ? 0 : col >= this.nx ? this.nx - 1 : col;
    const r = row < 0 ? 0 : row >= this.nz ? this.nz - 1 : row;
    return this.h[r * this.nx + c]!;
  }

  /**
   * Ground height at world (x, z), BILINEARLY interpolated between the four
   * surrounding samples. Out-of-bounds queries clamp to the nearest edge sample.
   */
  height(x: number, z: number): number {
    const gx = (x - this.originX) / this.cellX;
    const gz = (z - this.originZ) / this.cellZ;
    const x0 = Math.floor(gx);
    const z0 = Math.floor(gz);
    const fx = gx - x0;
    const fz = gz - z0;
    const h00 = this.at(x0, z0);
    const h10 = this.at(x0 + 1, z0);
    const h01 = this.at(x0, z0 + 1);
    const h11 = this.at(x0 + 1, z0 + 1);
    const top = h00 + (h10 - h00) * fx;
    const bot = h01 + (h11 - h01) * fx;
    return top + (bot - top) * fz;
  }

  /**
   * Unit surface normal at world (x, z). Computed from the height GRADIENT via a
   * central difference one cell wide, so it always matches height() exactly. For
   * ground y = height(x,z) the up-facing normal is (-∂h/∂x, 1, -∂h/∂z) normalized.
   */
  normal(x: number, z: number): Vec3 {
    const ex = this.cellX;
    const ez = this.cellZ;
    const dhx = (this.height(x + ex, z) - this.height(x - ex, z)) / (2 * ex);
    const dhz = (this.height(x, z + ez) - this.height(x, z - ez)) / (2 * ez);
    const nx = -dhx;
    const ny = 1;
    const nz = -dhz;
    const len = Math.hypot(nx, ny, nz) || 1;
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  /** Height and normal together (one gradient, so it's cheaper than two calls). */
  sample(x: number, z: number): { height: number; normal: Vec3 } {
    return { height: this.height(x, z), normal: this.normal(x, z) };
  }
}

// --- SurfaceMask -----------------------------------------------------------

/**
 * An RGBA raster classifying the ground into CourseSurface. Sampled per TEXEL
 * (nearest, never blended — a lie is categorical), decoded to the enum by the
 * nearest palette colour so hand-painted or lossily-stored masks still resolve.
 * Same grid geometry conventions as HeightField.
 */
export class SurfaceMask {
  readonly nx: number;
  readonly nz: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly originX: number;
  readonly originZ: number;
  private readonly rgba: Uint8ClampedArray;

  constructor(
    rgba: Uint8ClampedArray,
    nx: number,
    nz: number,
    cellX: number,
    cellZ = cellX,
    originX = 0,
    originZ = 0,
  ) {
    if (rgba.length !== nx * nz * 4) {
      throw new Error(`SurfaceMask: expected ${nx * nz * 4} bytes, got ${rgba.length}`);
    }
    this.rgba = rgba;
    this.nx = nx;
    this.nz = nz;
    this.cellX = cellX;
    this.cellZ = cellZ;
    this.originX = originX;
    this.originZ = originZ;
  }

  /** Nearest texel index for world (x, z), clamped to the mask edge. */
  private texel(x: number, z: number): number {
    let col = Math.round((x - this.originX) / this.cellX);
    let row = Math.round((z - this.originZ) / this.cellZ);
    col = col < 0 ? 0 : col >= this.nx ? this.nx - 1 : col;
    row = row < 0 ? 0 : row >= this.nz ? this.nz - 1 : row;
    return (row * this.nx + col) * 4;
  }

  /** The surface at world (x, z), decoded from the nearest texel colour. */
  surface(x: number, z: number): CourseSurface {
    const i = this.texel(x, z);
    return decodeSurface(this.rgba[i]!, this.rgba[i + 1]!, this.rgba[i + 2]!);
  }
}

/** Nearest palette match for an RGB triplet → the surface it encodes. */
export function decodeSurface(r: number, g: number, b: number): CourseSurface {
  let best: CourseSurface = Surface.ROUGH;
  let bestD = Infinity;
  for (const s of SURFACE_ORDER) {
    const [pr, pg, pb] = SURFACE_RGB[s];
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

// --- CourseData ------------------------------------------------------------

/** The unified surface query result — everything a consumer needs at a point. */
export interface SurfaceSample {
  height: number;
  normal: Vec3;
  surface: CourseSurface;
  friction: number;
  restitution: number;
}

/**
 * A course's playable ground: a HeightField + a SurfaceMask + the material
 * table, behind ONE query. This is the single source of truth the terrain mesh
 * and the ball physics both read — getSurfaceAt(x,z) answers "how high, which
 * way does it slope, what lie is it, and how does it play" in one call.
 */
export class CourseData {
  readonly field: HeightField;
  readonly mask: SurfaceMask;

  constructor(field: HeightField, mask: SurfaceMask) {
    this.field = field;
    this.mask = mask;
  }

  /** height · normal · surface · friction · restitution at world (x, z). */
  getSurfaceAt(x: number, z: number): SurfaceSample {
    const { height, normal } = this.field.sample(x, z);
    const surface = this.mask.surface(x, z);
    const mat = SURFACE_MATERIAL[surface];
    return { height, normal, surface, friction: mat.friction, restitution: mat.restitution };
  }

  /** Displaced terrain geometry from the HeightField (see buildTerrainMesh). */
  buildMesh(segX: number, segZ: number): TerrainMesh {
    return buildTerrainMesh(this.field, this.mask, segX, segZ);
  }
}

// --- Terrain mesh ----------------------------------------------------------

/**
 * Interleaved geometry arrays for a displaced-plane terrain — three-free so this
 * module never imports the renderer. The consumer wraps them in a
 * THREE.BufferGeometry (position/normal/uv/color attributes + index).
 */
export interface TerrainMesh {
  positions: Float32Array; // (segX+1)·(segZ+1) × 3, world (x, height, z)
  normals: Float32Array; // × 3, from the HeightField gradient
  uvs: Float32Array; // × 2, [0..1] across the field
  colors: Float32Array; // × 3, per-vertex surface colour (0..1)
  indices: Uint32Array; // 2 triangles per cell
  segX: number;
  segZ: number;
}

/**
 * Build a terrain mesh by DISPLACING a segmented plane from the HeightField: a
 * (segX+1)×(segZ+1) vertex grid spanning the field, each vertex lifted to
 * field.height and coloured by the mask's surface. Vertex normals come straight
 * from field.normal (the physics slope), not from face averaging, so shading and
 * physics share the exact surface. Positions are world (x, y=height, z).
 */
export function buildTerrainMesh(
  field: HeightField,
  mask: SurfaceMask,
  segX: number,
  segZ: number,
): TerrainMesh {
  const vx = segX + 1;
  const vz = segZ + 1;
  const count = vx * vz;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const colors = new Float32Array(count * 3);
  const spanX = field.maxX - field.originX;
  const spanZ = field.maxZ - field.originZ;

  let p = 0;
  let u = 0;
  for (let j = 0; j < vz; j++) {
    const z = field.originZ + (j / segZ) * spanZ;
    for (let i = 0; i < vx; i++) {
      const x = field.originX + (i / segX) * spanX;
      const y = field.height(x, z);
      const n = field.normal(x, z);
      positions[p] = x;
      positions[p + 1] = y;
      positions[p + 2] = z;
      normals[p] = n.x;
      normals[p + 1] = n.y;
      normals[p + 2] = n.z;
      const [r, g, b] = SURFACE_RGB[mask.surface(x, z)];
      colors[p] = r / 255;
      colors[p + 1] = g / 255;
      colors[p + 2] = b / 255;
      uvs[u] = i / segX;
      uvs[u + 1] = j / segZ;
      p += 3;
      u += 2;
    }
  }

  const indices = new Uint32Array(segX * segZ * 6);
  let t = 0;
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * vx + i;
      const b = a + vx;
      indices[t] = a;
      indices[t + 1] = b;
      indices[t + 2] = a + 1;
      indices[t + 3] = a + 1;
      indices[t + 4] = b;
      indices[t + 5] = b + 1;
      t += 6;
    }
  }

  return { positions, normals, uvs, colors, indices, segX, segZ };
}

/**
 * Sample an arbitrary height function onto a HeightField whose nodes are laid at
 * exactly `nodesX` × `nodesZ` points spanning the world rectangle [x0,x1]×[z0,z1].
 * Because the nodes coincide with a segmented plane of (nodesX-1)×(nodesZ-1)
 * cells, displacing that plane from this field reproduces the sampler at every
 * vertex (bilinear at a node returns the stored value). This is how a consumer
 * that already works in its own units (e.g. the yard-space renderer) routes its
 * ground through the HeightField without changing a single vertex.
 */
export function sampleHeightField(
  sample: (x: number, z: number) => number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  nodesX: number,
  nodesZ: number,
): HeightField {
  const cellX = (x1 - x0) / (nodesX - 1);
  const cellZ = (z1 - z0) / (nodesZ - 1);
  const h = new Float32Array(nodesX * nodesZ);
  for (let r = 0; r < nodesZ; r++) {
    const z = z0 + r * cellZ;
    for (let c = 0; c < nodesX; c++) h[r * nodesX + c] = sample(x0 + c * cellX, z);
  }
  return new HeightField(h, nodesX, nodesZ, cellX, cellZ, x0, z0);
}

// --- Baking a CourseHole into the metric data layer ------------------------

// The hole author (terrain.ts) works in YARDS with richer lies. These map the
// hole's Surface strings onto the mask's six enum values.
const SURFACE_FROM_HOLE: Record<string, CourseSurface> = {
  tee: Surface.TEE,
  fairway: Surface.FAIRWAY,
  green: Surface.GREEN,
  fringe: Surface.FAIRWAY, // mown collar → plays like short grass
  rough: Surface.ROUGH,
  bunker: Surface.BUNKER,
  water: Surface.WATER,
  cartpath: Surface.ROUGH, // firm path has no mask colour of its own → rough
  ob: Surface.ROUGH, // out of bounds is off-corridor grass on the mask
};

/** The yard-space hole shape this baker needs (a structural subset of CourseHole). */
export interface BakeableHole {
  tee: { d: number; x: number };
  pin: { d: number; x: number };
}

export interface BakeOptions {
  /** Grid spacing in METERS (default 2 m). Smaller = finer field + mask. */
  cellM?: number;
  /** World rectangle to bake, in YARDS (matches the renderer's terrain extent). */
  dMinYd?: number;
  dMaxYd?: number;
  xHalfYd?: number;
}

/**
 * Bake a yard-space hole (its procedural heightAt/surfaceAt) into a metric
 * CourseData: sample both on a regular grid over the hole's extent, converting
 * yards → meters (M_PER_YD) for positions AND heights. The result is the
 * normalized, sampled model this layer exposes — a HeightField + SurfaceMask the
 * renderer and a metric physics step can share.
 *
 * `heightAtYd(d,x)` and `surfaceAtYd(d,x)` are the hole's own samplers (passed in
 * so this module needn't import terrain.ts and stays dependency-light). Field
 * coords: x = lateral (meters), z = downrange (meters), z increasing with d.
 */
export function buildCourseData(
  hole: BakeableHole,
  heightAtYd: (d: number, x: number) => number,
  surfaceAtYd: (d: number, x: number) => string,
  opts: BakeOptions = {},
): CourseData {
  const cell = opts.cellM ?? 2;
  const dMin = opts.dMinYd ?? -20;
  const dMax = opts.dMaxYd ?? hole.pin.d + 110;
  const xHalf = opts.xHalfYd ?? 120;

  const originX = -xHalf * M_PER_YD;
  const originZ = dMin * M_PER_YD;
  const widthM = 2 * xHalf * M_PER_YD;
  const lengthM = (dMax - dMin) * M_PER_YD;
  const nx = Math.max(2, Math.round(widthM / cell) + 1);
  const nz = Math.max(2, Math.round(lengthM / cell) + 1);

  const heights = new Float32Array(nx * nz);
  const rgba = new Uint8ClampedArray(nx * nz * 4);

  for (let row = 0; row < nz; row++) {
    const zM = originZ + row * cell;
    const dYd = zM * YD_PER_M; // z(m) → downrange d(yd)
    for (let col = 0; col < nx; col++) {
      const xM = originX + col * cell;
      const xYd = xM * YD_PER_M;
      const idx = row * nx + col;
      heights[idx] = heightAtYd(dYd, xYd) * M_PER_YD;
      const surf = SURFACE_FROM_HOLE[surfaceAtYd(dYd, xYd)] ?? Surface.ROUGH;
      const [r, g, b] = SURFACE_RGB[surf];
      rgba[idx * 4] = r;
      rgba[idx * 4 + 1] = g;
      rgba[idx * 4 + 2] = b;
      rgba[idx * 4 + 3] = 255;
    }
  }

  const field = new HeightField(heights, nx, nz, cell, cell, originX, originZ);
  const mask = new SurfaceMask(rgba, nx, nz, cell, cell, originX, originZ);
  return new CourseData(field, mask);
}
