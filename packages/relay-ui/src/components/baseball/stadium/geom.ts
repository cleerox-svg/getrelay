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

import { BufferAttribute, BufferGeometry, Color } from 'three';
import type { Group, Scene } from 'three';
import type { Park } from '../../../lib/baseball/parks';
import type { Daylight } from './daylight';
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
  /**
   * The SESSION seed. Everything seeded in the scene that is allowed to differ
   * between sessions mixes this in; everything that must not — the bowl's
   * section jitter, the skyline's placement, the crowd speckle — keeps its own
   * module constant and ignores it.
   *
   * ⚠ IT IS A SEED, NOT A CLOCK, WHICH IS WHY IT CAN EXIST AT ALL. The tower's
   * LED programme changes nightly in the real venue, and "changes nightly" is
   * the one thing a byte-identical screenshot gate cannot have — so it changes
   * per SEED. Two runs of the harness pass the same seed and get the same tower.
   */
  seed: number;
  /**
   * The lighting row — day or night. COSMETIC, and `stadium/daylight.ts` carries
   * the whole argument for why that is a hard rule rather than a preference.
   *
   * ⚠ IT IS IN THE CONTEXT RATHER THAN PASSED TO THE THREE BUILDERS THAT WANT IT
   * because it is exactly the same kind of input as `quality`: scene-wide, read
   * only, decided once at build. It arrived as an extra argument on `buildSky`
   * and an extra field on `buildBoard`'s options, and the third caller (the
   * roof's truss) is the one that made that a pattern rather than a special
   * case.
   */
  daylight: Daylight;
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
 *
 * ⚠ A FULL CIRCLE CLOSES ON ITS OWN FIRST SAMPLE, AND THAT IS A BUG FIX. A span
 * of exactly 360° names its endpoint TWICE — `−180` and `+180` are the same
 * bearing — and a caller's `radiusAndHeight` is not obliged to agree with itself
 * about it. `stands.ts`'s did not: outside fair territory it held the wall
 * height at "the nearer foul line", and `Math.sign(±180)` picks a DIFFERENT line
 * at each end, so Harbourfront's 14 ft 4 in left line and 12 ft 7 in right line
 * met as a **1.75 ft crack** in the front rail — measured on the render as a
 * 53 px step in the bowl foot, at bearing ±180, which is dead centre of the
 * `pitcher` frame. `stands.ts` fixed its own function to be periodic; this line
 * makes the ring closed by CONSTRUCTION, so the next caller whose function is
 * not periodic gets a slanted quad rather than a hole. Closure is a property of
 * a circle, not a property of the data drawn round one.
 *
 * ⚠ `extraBearings` FORCES EXACT SAMPLES, AND IT EXISTS FOR STEP CHANGES. The
 * uniform sampling is a QUALITY knob, so a caller whose radius jumps at a
 * particular bearing — the centre-field structure's recess in the deck — would
 * otherwise have that jump land wherever the step happened to fall, up to 3°
 * (≈22 ft at the wall) away from where the data says it is, and differently at
 * each tier. Passing the two bearings either side of the step (`H ± 1e-4`) puts
 * a near-vertical face exactly there at every tier. Every ring in a lofted set
 * must be given the SAME list, or the rings stop corresponding and `loft` pairs
 * the wrong columns.
 */
export function ring(
  b0: number,
  b1: number,
  stepDeg: number,
  radiusAndHeight: (bearingDeg: number) => { r: number; y: number },
  extraBearings?: readonly number[],
): Ring {
  const n = Math.max(1, Math.ceil(Math.abs(b1 - b0) / stepDeg));
  const full = Math.abs(Math.abs(b1 - b0) - 360) < 1e-9;
  const bearings: number[] = [];
  for (let i = 0; i < (full ? n : n + 1); i++) bearings.push(b0 + ((b1 - b0) * i) / n);
  if (extraBearings?.length) {
    const lo = Math.min(b0, b1);
    const hi = Math.max(b0, b1);
    for (const b of extraBearings) if (b > lo && b < hi) bearings.push(b);
    bearings.sort((p, q) => (b1 >= b0 ? p - q : q - p));
  }
  // ⚠ THE CLOSURE IS APPENDED AFTER THE SORT, NOT SORTED WITH THE REST, AND THE
  // FIRST VERSION OF THIS FUNCTION GOT THAT WRONG. The closing sample's bearing
  // is `b0` (it IS the first sample), so an ascending sort moves it to the front
  // and the ring silently loses its last segment — measured on the render as a
  // one-step, ~180 px hole punched straight through the backstop in the
  // `pitcher` frame, i.e. exactly the defect this whole closure change exists to
  // remove, reintroduced by the mechanism meant to remove it.
  if (full) bearings.push(b0);
  const out: Ring = [];
  for (const b of bearings) {
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
export interface LoftOpts {
  /** Per-vertex colour, `a` then `b`, LINEAR space — see `stands.ts`'s warning. */
  colors?: Float32Array;
  /**
   * Generate UVs. `v0`/`v1` are the texture V at ring `a` and ring `b`, and `u`
   * is the texture U per COLUMN — one entry per ring sample, so the caller
   * decides how the texture is distributed around the ring.
   *
   * ⚠ THE CALLER OWNS `u` BECAUSE ANGLE IS THE WRONG PARAMETER. A stadium ring's
   * radius varies by nearly 10× between the backstop (60 ft) and centre field
   * (530 ft), so equal ANGLE means wildly unequal arc length and a texture tile
   * stretched 2.5:1 tall behind the plate and 2:1 wide in the outfield —
   * measured, on the render. The bowl passes cumulative ARC LENGTH, which is
   * what makes a seating section the same physical width everywhere.
   *
   * Baked into the ATTRIBUTE rather than set on `Texture.repeat`, because a band
   * built this way is merged with its neighbours into one geometry and one
   * material — so there is exactly one texture in the scene and no per-band
   * clone. That is the "build the texture once" rule expressed as geometry.
   */
  uv?: { v0: number; v1: number; u: number[] };
}

export function loft(a: Ring, b: Ring, opts: LoftOpts = {}): BufferGeometry {
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
  if (opts.colors) g.setAttribute('color', new BufferAttribute(opts.colors, 3));
  if (opts.uv) {
    const { v0, v1 } = opts.uv;
    const uv = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      const u = opts.uv.u[i] ?? 0;
      uv[i * 2] = u;
      uv[i * 2 + 1] = v0;
      uv[(count + i) * 2] = u;
      uv[(count + i) * 2 + 1] = v1;
    }
    g.setAttribute('uv', new BufferAttribute(uv, 2));
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  weldClosedSeam(g, count);
  return g;
}

/**
 * If the strip's two ends are the SAME POINT, average their normals.
 *
 * ⚠ THIS IS THE LAST 2 px OF THE BACKSTOP SEAM, AND IT IS A LIGHTING BUG RATHER
 * THAN A HOLE. Closing the ring (see `ring`) put the two ends in the same place,
 * but they are still two COLUMNS of vertices, and `computeVertexNormals` gives
 * an end column the normal of the ONE face beside it while every interior column
 * averages TWO. On a curved bowl those differ, so the seam renders as a hard
 * shading edge — measured at bearing ±180 in the `pitcher` frame, luminance 7
 * against the bowl's 22, two pixels wide, dead centre of the shot. Averaging the
 * pair is what a shared vertex would have produced and costs one pass over two
 * columns.
 *
 * Detection is geometric, not a flag, so a caller cannot forget it: the strip is
 * closed exactly when its first and last positions coincide.
 */
function weldClosedSeam(g: BufferGeometry, count: number): void {
  const pos = g.getAttribute('position');
  const nrm = g.getAttribute('normal');
  if (!pos || !nrm || count < 3) return;
  const same = (i: number, j: number) =>
    Math.abs(pos.getX(i) - pos.getX(j)) < 1e-6 &&
    Math.abs(pos.getY(i) - pos.getY(j)) < 1e-6 &&
    Math.abs(pos.getZ(i) - pos.getZ(j)) < 1e-6;
  if (!same(0, count - 1)) return;
  for (const base of [0, count]) {
    const a = base;
    const b = base + count - 1;
    const x = nrm.getX(a) + nrm.getX(b);
    const y = nrm.getY(a) + nrm.getY(b);
    const z = nrm.getZ(a) + nrm.getZ(b);
    const len = Math.hypot(x, y, z) || 1;
    for (const i of [a, b]) nrm.setXYZ(i, x / len, y / len, z / len);
  }
  nrm.needsUpdate = true;
}

/**
 * Concatenate geometries that share an attribute set into ONE.
 *
 * ⚠ THIS IS THE DRAW-CALL BUDGET, EXPRESSED AS A FUNCTION. The stadium's art
 * pass wants a banded bowl, a truss lattice and a skyline — each of which is
 * naturally authored as tens of separate strips and each of which must cost ONE
 * draw call. Rule 7 of the charter legislates draw calls and nothing else here
 * grows as fast: triangles have six figures of headroom, calls have ~18.
 *
 * Every part must carry the same attributes; the intersection is taken and
 * anything present on only some inputs is DROPPED rather than zero-filled,
 * because a half-filled colour attribute renders as black on the parts that
 * lacked it and looks like a lighting bug. Inputs are consumed — they are
 * scratch, never uploaded — so the caller disposes them and tracks only the
 * result.
 */
export function mergeGeometries(parts: BufferGeometry[]): BufferGeometry {
  const g = new BufferGeometry();
  if (!parts.length) return g;
  const wanted = ['position', 'normal', 'color', 'uv'] as const;
  const present = wanted.filter((n) => parts.every((p) => !!p.getAttribute(n)));
  let vertices = 0;
  let indices = 0;
  for (const p of parts) {
    vertices += p.getAttribute('position')?.count ?? 0;
    indices += p.getIndex()?.count ?? 0;
  }
  for (const name of present) {
    const size = parts[0]?.getAttribute(name)?.itemSize ?? 3;
    const arr = new Float32Array(vertices * size);
    let o = 0;
    for (const p of parts) {
      const a = p.getAttribute(name);
      arr.set(a.array as ArrayLike<number>, o);
      o += a.count * size;
    }
    g.setAttribute(name, new BufferAttribute(arr, size));
  }
  // Uint32 unconditionally: a merged bowl passes 65 535 vertices at the `high`
  // tier and a Uint16 index would wrap silently into a scrambled mesh.
  const idx = new Uint32Array(indices);
  let io = 0;
  let vo = 0;
  for (const p of parts) {
    const pi = p.getIndex();
    if (pi) for (let i = 0; i < pi.count; i++) idx[io++] = pi.getX(i) + vo;
    vo += p.getAttribute('position')?.count ?? 0;
  }
  g.setIndex(new BufferAttribute(idx, 1));
  return g;
}

/**
 * Write PLANAR UVs onto a ground geometry, from its own scene x/z, one tile per
 * `tileFt`. Returns the same geometry so calls can be inlined.
 *
 * ⚠ ONE PROJECTION FOR EVERY GROUND SURFACE, WHICH IS THE ONLY WAY THE GRAIN
 * LINES UP. Turf, warning track and infield clay are built by three different
 * primitives — `mownGrass`'s own grid, `loft` and `fan` — and only `loft` can
 * author UVs at all. Deriving them from world position afterwards means all
 * three sample the same tile at the same scale in the same place, so a
 * `stadium/grain.ts` tile cloned across them has no visible discontinuity at a
 * material boundary. It is also the reason there is no `uv` option on `fan`: a
 * fan's apex has no meaningful UV of its own.
 *
 * The whole field is ~1,150 ft across, so at a 30 ft tile that is ~38 repeats —
 * far inside a float32 UV's precision and far inside `RepeatWrapping`.
 */
export function planarUV(g: BufferGeometry, tileFt: number): BufferGeometry {
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / tileFt;
    uv[i * 2 + 1] = pos.getZ(i) / tileFt;
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
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

/**
 * Write a FLAT vertex colour onto a geometry, so differently-tinted parts can be
 * merged under one material.
 *
 * ⚠ THROUGH `Color`, NOT BY UNPACKING HEX BYTES, and `stands.ts` explains the
 * consequence at length: a vertex-colour attribute is consumed in the renderer's
 * LINEAR working space while a hex literal is sRGB, so dividing bytes by 255
 * brightens 0x8b (0.545 sRGB ≈ 0.25 linear) by more than a factor of two. The
 * first render of the bowl came out a blown-out white cone for exactly that
 * reason. Taking a `Color` makes the conversion the caller's `set()`.
 *
 * `scale` may exceed 1 — that is how the tower's pod ring is authored brighter
 * than its shaft under one material.
 */
export function tintGeometry(geo: BufferGeometry, c: Color, scale = 1): BufferGeometry {
  const n = geo.getAttribute('position')?.count ?? 0;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r * scale;
    arr[i * 3 + 1] = c.g * scale;
    arr[i * 3 + 2] = c.b * scale;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}
