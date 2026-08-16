/**
 * Instanced scatter — the shared primitive behind a tree grove and a crowd.
 *
 * WHY THIS EXISTS
 * ---------------
 * Draw calls are the dominant mobile cost, and the largest single source of them
 * measured on this codebase was a scatter of small props built as INDIVIDUAL
 * meshes. Golf's grove was one trunk mesh plus five-to-seven leaf meshes per
 * tree, ~550 meshes in total; with the shadow pass each caster is submitted
 * twice, which put the worst scene at 1,034 draw calls — an order of magnitude
 * above a whole stadium. It was never a batching failure: there was no
 * `InstancedMesh` anywhere in the render path.
 *
 * The fix generalises exactly. A gallery of trees and a bowl of spectators are
 * the same problem: N copies of a handful of distinct shapes, each with its own
 * transform and its own tint. One `InstancedMesh` per distinct GEOMETRY collapses
 * the whole scatter to a draw call per shape, and per-instance colour keeps the
 * variety that N separate materials used to buy.
 *
 * THE CONTRACT (`README.md`)
 * --------------------------
 * Nothing here knows what a tree or a spectator is. It takes geometries,
 * materials and matrices; the consumer owns placement, palette and units. There
 * is no RNG in this module ON PURPOSE — placement jitter must be seeded by the
 * caller (`mulberry32`, never `Math.random`) or the screenshot gate stops being
 * able to prove a change was pixel-identical.
 *
 * TWO THINGS WORTH KNOWING BEFORE USING IT
 * ----------------------------------------
 * • **An `InstancedMesh` is culled all-or-nothing.** Batching a scatter that
 *   spans the whole world means every instance is submitted every frame, even
 *   the ones behind the camera — so TRIANGLES can go UP while draw calls
 *   collapse. That is usually the right trade (submission is the mobile cost,
 *   and the shadow pass was drawing them anyway), but it is a trade: measure it,
 *   and split into a few spatial batches if a scatter is genuinely huge.
 * • **Per-instance colour needs a white material.** Three multiplies
 *   `instanceColor` into `diffuseColor`, so a batch spec that wants tinting must
 *   pass a material whose own `color` is white, and the tints must be the colours
 *   the individual materials used to carry.
 */

import * as THREE from 'three';

export interface DisposableResource {
  dispose: () => void;
}
/** The scene's disposal registry — every geometry/material/texture goes through it. */
export type TrackFn = <T extends DisposableResource>(o: T) => T;

/** One distinct shape in a scatter: its geometry, its material, its shadow flags. */
export interface InstanceBatchSpec {
  /**
   * The UNIT shape. Instances scale it, so author it at a natural size of 1 and
   * let the per-instance matrix do the rest — that is what lets two props that
   * differ only in proportion share a batch (and a draw call).
   */
  geometry: THREE.BufferGeometry;
  /** Shared by every instance. Must be white if `tinted` is set (see the header). */
  material: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  /**
   * Allocate a per-instance colour attribute. Off by default: an unused
   * `instanceColor` still costs a buffer and a shader permutation.
   */
  tinted?: boolean;
  /**
   * Leave instance matrices writable after commit (`DynamicDrawUsage`). Off by
   * default — a scatter that never moves should upload once.
   */
  dynamic?: boolean;
}

export interface InstanceBatcher<K extends string> {
  /**
   * Queue one instance. `matrix` is COPIED, so a single scratch `Matrix4` can be
   * reused for the whole scatter.
   */
  add: (key: K, matrix: THREE.Matrix4, tint?: THREE.Color | null) => void;
  /** Instances queued for `key`, or for the whole scatter when `key` is omitted. */
  count: (key?: K) => number;
  /**
   * Build one `InstancedMesh` per non-empty batch, parent them and return them.
   * Empty batches are skipped entirely — a scatter that placed no pines does not
   * pay a draw call for pines. Call ONCE; a second call throws.
   */
  commit: (parent: THREE.Object3D) => THREE.InstancedMesh[];
  /** The committed mesh for a batch, or null if it was empty / not yet committed. */
  get: (key: K) => THREE.InstancedMesh | null;
}

/**
 * Collect instances, then commit them as one `InstancedMesh` per batch.
 *
 * Two-phase because `InstancedMesh` needs its count up front, and a scatter's
 * count is normally only known once placement has run. Everything created here
 * (the meshes and their instance buffers) is registered with `track` so the
 * scene's teardown frees it; the geometries and materials in `specs` stay the
 * CALLER's to track, since they are usually shared with something else.
 */
export function createInstanceBatcher<K extends string>(
  specs: Record<K, InstanceBatchSpec>,
  track: TrackFn,
): InstanceBatcher<K> {
  const keys = Object.keys(specs) as K[];
  /** Flat 16-float runs, one per queued instance, in insertion order. */
  const matrices = new Map<K, number[]>();
  /** Flat 3-float runs, parallel to `matrices`. Only filled for tinted batches. */
  const tints = new Map<K, number[]>();
  const meshes = new Map<K, THREE.InstancedMesh>();
  let committed = false;
  for (const k of keys) {
    matrices.set(k, []);
    tints.set(k, []);
  }

  const add = (key: K, matrix: THREE.Matrix4, tint?: THREE.Color | null): void => {
    const buf = matrices.get(key);
    if (!buf) throw new Error(`createInstanceBatcher: unknown batch "${key}"`);
    if (committed) throw new Error(`createInstanceBatcher: "${key}" added after commit()`);
    for (let i = 0; i < 16; i++) buf.push(matrix.elements[i]!);
    if (specs[key].tinted) {
      const c = tints.get(key)!;
      // A tinted batch with a missing tint would silently shift by one triple and
      // mis-colour every instance after it, so default to white rather than skip.
      c.push(tint?.r ?? 1, tint?.g ?? 1, tint?.b ?? 1);
    }
  };

  const commit = (parent: THREE.Object3D): THREE.InstancedMesh[] => {
    if (committed) throw new Error('createInstanceBatcher: commit() called twice');
    committed = true;
    const out: THREE.InstancedMesh[] = [];
    for (const key of keys) {
      const buf = matrices.get(key)!;
      const n = buf.length / 16;
      if (n === 0) continue;
      const spec = specs[key];
      const mesh = track(new THREE.InstancedMesh(spec.geometry, spec.material, n));
      mesh.instanceMatrix.array.set(buf);
      mesh.instanceMatrix.needsUpdate = true;
      if (!spec.dynamic) mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      if (spec.tinted) {
        const colors = new Float32Array(tints.get(key)!);
        const attr = new THREE.InstancedBufferAttribute(colors, 3);
        if (!spec.dynamic) attr.setUsage(THREE.StaticDrawUsage);
        mesh.instanceColor = attr;
      }
      mesh.castShadow = spec.castShadow ?? false;
      mesh.receiveShadow = spec.receiveShadow ?? false;
      // Three culls an InstancedMesh against `object.boundingSphere` when it is
      // non-null, and computes it lazily otherwise. Do it now, while every matrix
      // is known: a sphere computed later (or a stale one) is the same class of
      // bug as the aim-arc frustum cull.
      mesh.computeBoundingSphere();
      parent.add(mesh);
      meshes.set(key, mesh);
      out.push(mesh);
    }
    return out;
  };

  return {
    add,
    commit,
    count: (key?: K) => {
      if (key !== undefined) return (matrices.get(key)?.length ?? 0) / 16;
      let n = 0;
      for (const buf of matrices.values()) n += buf.length / 16;
      return n;
    },
    get: (key: K) => meshes.get(key) ?? null,
  };
}

// --- Transform helper ------------------------------------------------------

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * Compose an instance matrix from position / XYZ-Euler rotation / scale into
 * `out`, allocating nothing. The scatter loops that feed a batcher run once per
 * prop per scene build, so the churn is worth avoiding.
 */
export function composeInstance(
  out: THREE.Matrix4,
  px: number,
  py: number,
  pz: number,
  rx: number,
  ry: number,
  rz: number,
  sx: number,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  _p.set(px, py, pz);
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _s.set(sx, sy, sz);
  return out.compose(_p, _q, _s);
}

// --- Impostor quads --------------------------------------------------------
//
// The other half of the scatter problem: at distance, a prop does not need to be
// a prop. A textured quad (or a pair of crossed quads, so it survives being
// walked around) costs 2–4 triangles against the ~90–150 a low-poly tree costs,
// and instancing makes the whole far band one draw call.
//
// ATLAS CELLS RATHER THAN A SHADER. The obvious way to vary the sprite per
// instance is a per-instance atlas index resolved in a custom vertex shader.
// This module deliberately does not do that: `/GRAPHICS.md` §2 keeps the GLSL
// surface frozen at one site for the WebGPU port, and a scatter with three or
// four distinct sprites is fine as three or four BATCHES — the UV rect is baked
// into each geometry, and three or four draw calls is still the win. Reach for a
// shader only when the cell count is genuinely large.

/** One cell of a regular atlas, counted left-to-right then top-to-bottom. */
export interface AtlasCell {
  columns: number;
  rows: number;
  /** 0-based, row-major. Out-of-range wraps, so a caller can index by a hash. */
  index: number;
}

/** `[u0, v0, u1, v1]` for an atlas cell, with v measured from the BOTTOM (three's convention). */
export function atlasUvRect(cell: AtlasCell): [number, number, number, number] {
  const cols = Math.max(1, Math.floor(cell.columns));
  const rows = Math.max(1, Math.floor(cell.rows));
  const i = ((Math.floor(cell.index) % (cols * rows)) + cols * rows) % (cols * rows);
  const cx = i % cols;
  const cy = Math.floor(i / cols);
  const u0 = cx / cols;
  const v1 = 1 - cy / rows;
  return [u0, v1 - 1 / rows, u0 + 1 / cols, v1];
}

export interface ImpostorOptions {
  /** Quads intersecting about the Y axis. 1 = a billboard, 2 = a cross, 3+ = a bush. */
  planes?: number;
  /** Which atlas cell to bake into the UVs. Omit for the full 0..1 texture. */
  cell?: AtlasCell;
  /**
   * `'face'` gives each quad its own normal (right for a flat sign or a
   * spectator); `'up'` points every vertex at +Y, which is what stops a foliage
   * cross from reading as two hard-lit cards under a low sun.
   */
  normals?: 'face' | 'up';
  /** Lift the quad's base off the pivot. Default 0 — the pivot is the base. */
  baseY?: number;
}

/**
 * Upright quad(s) intersecting about the Y axis, pivot at the BASE so an instance
 * matrix places it by its footprint rather than its middle. Double-sided
 * rendering is the material's job (`side: THREE.DoubleSide`).
 *
 * Returned as one indexed `BufferGeometry` — the point of a cross impostor is
 * that it stays a single draw.
 */
export function makeImpostorQuads(
  width: number,
  height: number,
  opts: ImpostorOptions = {},
): THREE.BufferGeometry {
  const planes = Math.max(1, Math.floor(opts.planes ?? 2));
  const [u0, v0, u1, v1] = opts.cell ? atlasUvRect(opts.cell) : [0, 0, 1, 1];
  const base = opts.baseY ?? 0;
  const hw = width / 2;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let p = 0; p < planes; p++) {
    const a = (p * Math.PI) / planes;
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    // Face normal of this plane (its in-plane axis rotated a quarter turn).
    const nx = -dz;
    const nz = dx;
    const o = p * 4;
    // bottom-left, bottom-right, top-right, top-left
    pos.push(-dx * hw, base, -dz * hw, dx * hw, base, dz * hw, dx * hw, base + height, dz * hw, -dx * hw, base + height, -dz * hw);
    for (let v = 0; v < 4; v++) {
      if (opts.normals === 'up') nrm.push(0, 1, 0);
      else nrm.push(nx, 0, nz);
    }
    uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}
