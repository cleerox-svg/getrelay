// The stadium's SCENE FRAME and its two geometry primitives.
//
// ⚠ THIS FILE INVENTS NO DIMENSIONS. It converts (bearing, distance, height) —
// the frame `parks.ts` publishes its fence in — into Three.js coordinates, and
// lofts rings of those points into meshes. Every radius and height handed to it
// comes from `parks.ts`, `zone.ts` or `fielding.ts`. A builder that hard-codes a
// distance is a bug the visual gate is meant to catch.
//
// THE FRAME. `airPhysics` WORLD is right-handed, Z up, with the plate at the
// batted-ball origin, `−x` toward centre field and `+y` toward the first-base
// side (`parks.ts` maps bearing β to the WORLD direction `(−cos β, sin β, 0)`).
// Three.js is Y up, so the scene uses the CYCLIC permutation
//
//     scene.x = world.y   (lateral, + = first-base / right-field side)
//     scene.y = world.z   (height)
//     scene.z = world.x   (− = toward centre field)
//
// A cyclic permutation preserves handedness, so a cross product computed in
// either frame agrees with the other — which is why this and not an axis swap.
// A camera behind the plate looking down −z therefore sees the first-base side
// on its right, exactly as `zone.ts`'s REPORT frame says the umpire does.
//
// These helpers are deliberately NOT in `lib/scene3d/` yet: they are keyed to
// the baseball bearing frame and nothing else in the repo speaks it. If golf
// ever wants a lofted ring, THAT is the moment they move up, not before.

import { BufferAttribute, BufferGeometry } from 'three';
import type { Group, Scene } from 'three';
import type { Park } from '../../../lib/baseball/parks';
import type { StadiumQuality } from './quality';

export const DEG = Math.PI / 180;

/** Anything the scene must dispose of on unmount. */
export interface Disposable {
  dispose(): void;
}

/** Register a resource for disposal; returns it so calls can be inlined. */
export type Track = <T extends Disposable>(resource: T) => T;

/**
 * What every builder is handed. The charter's shape is `(scene, track) =>
 * handle`; this is that plus the two read-only inputs a builder is allowed to
 * consult — the park DATA and the quality tier. Nothing else is in scope, and
 * in particular no builder may reach for a renderer, a camera or a sim.
 */
export interface StadiumCtx {
  scene: Scene;
  track: Track;
  park: Park;
  quality: StadiumQuality;
}

/** Every builder returns at least its own group, so the composer can dispose it. */
export interface StadiumPart {
  group: Group;
}

/** Scene-space position of a point at `bearingDeg`, `distFt` out, `heightFt` up. */
export function at(bearingDeg: number, distFt: number, heightFt: number): [number, number, number] {
  const b = bearingDeg * DEG;
  return [distFt * Math.sin(b), heightFt, -distFt * Math.cos(b)];
}

/** Inverse of `at`'s bearing: scene (x, z) → bearing in degrees. */
export function bearingOf(x: number, z: number): number {
  return Math.atan2(x, -z) / DEG;
}

/** A flat `[x, y, z, x, y, z, …]` ring of points, in bearing order. */
export type Ring = number[];

/**
 * Sample a ring across a bearing span.
 *
 * `stepDeg` is a QUALITY knob (see `quality.ts`), never a dimension: the span
 * is always closed exactly on `b1` so the last sample lands on the foul line
 * whatever the step is, and `fenceAt` is evaluated at every sample rather than
 * interpolated — the drawn wall is the pchip wall, not a chord approximation of
 * five knots.
 */
export function ring(
  b0: number,
  b1: number,
  stepDeg: number,
  radiusAndHeight: (bearingDeg: number) => { r: number; y: number },
): Ring {
  const n = Math.max(1, Math.ceil(Math.abs(b1 - b0) / stepDeg));
  const out: Ring = [];
  for (let i = 0; i <= n; i++) {
    const b = b0 + ((b1 - b0) * i) / n;
    const { r, y } = radiusAndHeight(b);
    const p = at(b, r, y);
    out.push(p[0], p[1], p[2]);
  }
  return out;
}

/**
 * A triangle fan from one apex to a ring — the ground sectors (grass, infield
 * dirt, the foul apron).
 *
 * Winding is `(apex, i+1, i)`, which puts the face normal along +y for a ring
 * sampled in increasing bearing. Verified by hand rather than by flipping until
 * it looked right: at β = 0 the fan's edge vectors are `(0,0,−D)` and
 * `(εD, 0, ~0)`, whose cross product is `−y`, so the indices are reversed.
 */
export function fan(apex: [number, number, number], r: Ring): BufferGeometry {
  const count = r.length / 3;
  const pos = new Float32Array((count + 1) * 3);
  pos[0] = apex[0];
  pos[1] = apex[1];
  pos[2] = apex[2];
  pos.set(r, 3);
  const idx: number[] = [];
  for (let i = 1; i < count; i++) idx.push(0, i + 1, i);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * Loft a quad strip between two corresponding rings — the ONE primitive behind
 * the warning track (inner ring → outer ring, flat), the outfield wall (base
 * ring → top ring, vertical), the seating rake (wall top → deck top) and the
 * roof ring. Three surfaces that look unrelated are one function, which is the
 * anti-bloat rule applied to geometry rather than to files.
 *
 * `a` is the inner/lower ring and `b` the outer/upper one; with that ordering
 * the winding below yields +y normals for a flat band and plate-facing normals
 * for a vertical wall. Both cases were derived, not guessed.
 */
export function loft(a: Ring, b: Ring, colors?: Float32Array): BufferGeometry {
  const count = Math.min(a.length, b.length) / 3;
  const pos = new Float32Array(count * 6);
  pos.set(a.slice(0, count * 3), 0);
  pos.set(b.slice(0, count * 3), count * 3);
  const idx: number[] = [];
  for (let i = 0; i + 1 < count; i++) {
    const a0 = i;
    const a1 = i + 1;
    const b0 = count + i;
    const b1 = count + i + 1;
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  if (colors) g.setAttribute('color', new BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A flat quad in the ground plane, given four scene-space corners. */
export function quad(
  p0: [number, number, number],
  p1: [number, number, number],
  p2: [number, number, number],
  p3: [number, number, number],
): BufferGeometry {
  const pos = new Float32Array([...p0, ...p1, ...p2, ...p3]);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex([0, 2, 1, 0, 3, 2]);
  g.computeVertexNormals();
  return g;
}

/**
 * A closed polygon in the ground plane at height `y`, given `[x, z]` pairs in
 * counter-clockwise-from-above order. Used for home plate; a five-vertex
 * `ShapeGeometry` would drag Three's triangulator in for two triangles.
 */
export function polygon(xz: Array<[number, number]>, y: number): BufferGeometry {
  const pos = new Float32Array(xz.length * 3);
  xz.forEach(([x, z], i) => {
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
  });
  const idx: number[] = [];
  for (let i = 1; i + 1 < xz.length; i++) idx.push(0, i + 1, i);
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}
