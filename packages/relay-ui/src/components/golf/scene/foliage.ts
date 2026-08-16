/**
 * The golf grove — every tree in the world, in three draw calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * This replaces `lib/golf/scenery.ts`'s `createTreeKit`, which built each tree as
 * a `Group` of individual meshes: one trunk plus five-to-seven leaf blobs for a
 * broadleaf, one trunk plus four-to-five cone tiers for a pine. Hole 1 plants 92
 * trees, which is ~550 meshes, and every shadow caster is submitted a second time
 * for the shadow map — so the tee view measured **1,034 draw calls**, an order of
 * magnitude above the whole baseball stadium and by far the largest GPU cost
 * anyone had measured here. There was no `InstancedMesh` anywhere in the golf
 * render path.
 *
 * WHAT CHANGED, AND WHAT DELIBERATELY DID NOT
 * -------------------------------------------
 * The ART is unchanged. Same low-poly species, same 5-tone leaf palette, same
 * seeded per-tree jitter drawn in the same ORDER from the same `mulberry32`-class
 * generator — every tree lands at the same place, at the same scale, with the
 * same crown, wearing the same colour it wore before. What changed is submission:
 * three `InstancedMesh`es (trunk, leaf blob, pine tier) instead of ~550 meshes.
 *
 * Three, not four, because the two species' trunks are the SAME tapered cylinder
 * at different sizes: the broadleaf's is 0.45→0.85 over 5.5 and the pine's
 * 0.32→0.6 over 5.0, i.e. taper ratios of 0.5294 and 0.5333. One unit cylinder at
 * the broadleaf's ratio, scaled per instance, reproduces the pine's top radius to
 * within 0.0024 yd (~2 mm) — under a millimetre of screen space at any camera
 * this game uses. Three's instancing path divides the normal by each column's
 * squared length before applying the instance matrix, so a non-uniformly scaled
 * cone still shades with the correct slope; the sun rakes these trunks exactly as
 * it did.
 *
 * The 5 leaf MATERIALS collapse to one white material plus a per-instance
 * `instanceColor`, which three multiplies into `diffuseColor` — the same five
 * colours, one program.
 *
 * THE TRADE, STATED
 * -----------------
 * An `InstancedMesh` is frustum-culled all-or-nothing, so the whole grove is now
 * submitted in every view, including the trees behind the camera that used to be
 * culled per-mesh. Triangles therefore go UP a little in tight views while draw
 * calls collapse by ~99%. That is the right way round on mobile — submission is
 * the cost that killed frames, the shadow pass was drawing most of them anyway,
 * and a grove is ~10k triangles against a terrain mesh's 50k.
 */

import * as THREE from 'three';
import { createInstanceBatcher, composeInstance, type TrackFn } from '../../../lib/scene3d/instancing';
import type { CourseTree } from '../../../lib/golf/terrain';

/**
 * One tree. `y` is the ground elevation at its base (the range is flat, so it
 * defaults to 0; the course passes `heightAt` so trees sit on the terrain).
 * `seed` drives the per-tree jitter and MUST be stable across loads — the
 * screenshot gate cannot tell a regression from a reseeded grove.
 */
export interface TreePlacement {
  kind: 'pine' | 'broadleaf';
  x: number;
  z: number;
  scale: number;
  seed: number;
  y?: number;
}

/**
 * Adapt the course's tree DATA (`terrain.courseTrees` — the same list the sim
 * collides against, so drawn == played) to grove placements. World z = −d.
 */
export function groveFromCourseTrees(trees: readonly CourseTree[]): TreePlacement[] {
  return trees.map((t) => ({ kind: t.kind, x: t.x, z: -t.d, scale: t.scale, seed: t.seed, y: t.ground }));
}

/** The 5-tone leaf palette, unchanged from the per-material version. */
const LEAF_COLORS = [0x2f7d3a, 0x3c8f44, 0x59a24a, 0x276b34, 0x4f9a52];
const TRUNK_COLOR = 0x6b4a2f;

/** Top/bottom radius of the shared unit trunk — the broadleaf's taper (see header). */
const TRUNK_TAPER = 0.45 / 0.85;
/** Per-species trunk footprint: [bottom radius, height]. Instance scale, not geometry. */
const BROADLEAF_TRUNK: [number, number] = [0.85, 5.5];
const PINE_TRUNK: [number, number] = [0.6, 5.0];

/**
 * The per-tree jitter generator. Byte-for-byte the `treeRng` the tree kit used
 * (a `mulberry32` variant), kept identical so a given seed produces the tree it
 * always produced. Never `Math.random`: the visual gate's determinism rests on
 * this, and 23 of 25 scenes once differed between two runs of unchanged code.
 */
function treeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pickLeaf = (r: number): number =>
  LEAF_COLORS[Math.floor(r * LEAF_COLORS.length)] ?? LEAF_COLORS[0]!;

/**
 * Build the whole grove and add it to the scene.
 *
 * Takes the full placement list rather than handing back an `add…()` pair,
 * because an `InstancedMesh` needs its count up front — and a builder you have to
 * remember to `commit()` is a builder someone will forget to commit, leaving a
 * treeless course that typechecks.
 *
 * Returns the committed meshes (one per non-empty batch) so a caller can assert
 * on them; everything is registered with `track` for teardown.
 */
export function buildGrove(
  scene: THREE.Scene,
  track: TrackFn,
  trees: Iterable<TreePlacement>,
): THREE.InstancedMesh[] {
  // Unit shapes. Each is authored at size 1 in the axis the instance scales, so
  // one geometry serves every size of that shape.
  const trunkGeo = track(new THREE.CylinderGeometry(TRUNK_TAPER, 1, 1, 6));
  const blobGeo = track(new THREE.IcosahedronGeometry(1, 0));
  const coneGeo = track(new THREE.ConeGeometry(1, 1, 7));

  const trunkMat = track(new THREE.MeshStandardMaterial({ color: TRUNK_COLOR, roughness: 1 }));
  // White, so `instanceColor` IS the leaf colour rather than a tint of one.
  // Shared by both leaf batches: same shading, one program.
  const leafMat = track(
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: true }),
  );

  const batcher = createInstanceBatcher(
    {
      trunk: { geometry: trunkGeo, material: trunkMat, castShadow: true },
      leaf: { geometry: blobGeo, material: leafMat, castShadow: true, tinted: true },
      tier: { geometry: coneGeo, material: leafMat, castShadow: true, tinted: true },
    },
    track,
  );

  const group = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const world = new THREE.Matrix4();
  const tint = new THREE.Color();
  // A broadleaf draws its crown BEFORE its group yaw, so the locals are buffered
  // until the yaw is known. 8 is the crown's hard maximum (5 + floor(r*3)).
  const crown: { m: THREE.Matrix4; c: number }[] = [];
  for (let i = 0; i < 8; i++) crown.push({ m: new THREE.Matrix4(), c: 0 });

  const push = (key: 'trunk' | 'leaf' | 'tier', color: number | null): void => {
    world.multiplyMatrices(group, local);
    batcher.add(key, world, color === null ? null : tint.setHex(color));
  };

  for (const t of trees) {
    const r = treeRng(t.seed);
    const y = t.y ?? 0;

    if (t.kind === 'broadleaf') {
      // RNG DRAW ORDER IS LOAD-BEARING — it reproduces the old tree kit exactly.
      const lean = (r() - 0.5) * 0.12;
      const blobs = 5 + Math.floor(r() * 3);
      const crownR = 3 + r() * 0.8;
      const crownY = 6 + r() * 1.2;
      for (let i = 0; i < blobs; i++) {
        const col = pickLeaf(r());
        const ang = r() * Math.PI * 2;
        const rad = r() * crownR * 0.8;
        const by = crownY + (r() - 0.5) * crownR * 0.9;
        const bs = crownR * (0.55 + r() * 0.45);
        const bsy = bs * (0.8 + r() * 0.25);
        const rot = [r() * 3, r() * 3, r() * 3] as const;
        const slot = crown[i]!;
        slot.c = col;
        composeInstance(
          slot.m,
          Math.cos(ang) * rad,
          by,
          Math.sin(ang) * rad,
          rot[0],
          rot[1],
          rot[2],
          bs,
          bsy,
          bs,
        );
      }
      const yaw = r() * Math.PI * 2;
      composeInstance(group, t.x, y, t.z, 0, yaw, 0, t.scale);
      const [tr, th] = BROADLEAF_TRUNK;
      composeInstance(local, 0, 2.5, 0, 0, 0, lean, tr, th, tr);
      push('trunk', null);
      for (let i = 0; i < blobs; i++) {
        local.copy(crown[i]!.m);
        push('leaf', crown[i]!.c);
      }
    } else {
      const tiers = 4 + Math.floor(r() * 2);
      // Pines pick ONE colour for the whole tree, from the first 3 of the palette.
      const col = pickLeaf(r() * 0.5);
      let ty = 4.2;
      let rad = 2.6 + r() * 0.7;
      // A pine has no group yaw, so its group matrix is known up front.
      composeInstance(group, t.x, y, t.z, 0, 0, 0, t.scale);
      const [pr, ph] = PINE_TRUNK;
      composeInstance(local, 0, 2.5, 0, 0, 0, 0, pr, ph, pr);
      push('trunk', null);
      for (let i = 0; i < tiers; i++) {
        const hgt = 2.6 + r() * 0.6;
        const spin = r() * Math.PI;
        composeInstance(local, 0, ty, 0, 0, spin, 0, rad, hgt, rad);
        push('tier', col);
        ty += hgt * 0.62;
        rad *= 0.74 + r() * 0.06;
      }
    }
  }

  return batcher.commit(scene);
}
