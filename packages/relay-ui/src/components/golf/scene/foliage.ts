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
 * BLOSSOM RIDES THE SAME BATCH
 * ----------------------------
 * A flowering hole (`CourseHole.bloom`, authored in the hole DATA — the renderer
 * never parses the hole's name) tints the crown of a seeded fraction of its
 * broadleaves toward a blossom colour and adds a few smaller flower clusters.
 * Both are ordinary leaf-blob instances: the same unit icosahedron and the same
 * white material, differing only in `instanceColor`. So the whole feature costs
 * **zero extra draw calls** — 20 triangles per cluster and nothing else. That is
 * the constraint it was designed against; a mesh per blooming tree would have
 * undone the 25× win this file exists for.
 *
 * The blossom tint is drawn from a SEPARATE generator seeded off the same tree
 * seed, never from `r()`. That is deliberate: it means a blooming tree keeps the
 * exact silhouette, crown count, blob placement and jitter it would have had
 * plain, so bloom moves colour and nothing else.
 *
 * TWO FORMS, BECAUSE A WARM CANOPY IS AN AUTUMN CANOPY
 * ---------------------------------------------------
 * The crown tint above shipped, and the visual gate then rejected exactly the
 * warm-hued holes: 12 Golden Bell (forsythia) measured hue 51° sat 0.49 on its
 * lit facets and RGB [106,110,23] — olive khaki — in shade. Pink survives this
 * treatment because nothing in nature is a pink tree in autumn; yellow, orange
 * and red ARE the autumn palette, so a tree-sized crown in one of them reads as
 * October at any saturation. Chroma is not the lever, and neither is the mix
 * floor: the SILHOUETTE is.
 *
 * So `TreePlacement.bloomForm` selects where the blossom goes. `'canopy'` (the
 * default, and byte-identical to what shipped) tints the crown. `'understory'`
 * leaves the crown GREEN and hangs a low drift of flowering shrub round the foot
 * of the trunk instead — which is also what forsythia, pyracantha and nandina
 * actually are, none of them being trees. Green leaves standing over a warm mass
 * is a silhouette autumn cannot produce, because in autumn the canopy turns
 * first. The drift is more leaf-blob instances, so the draw-call cost is still
 * zero.
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
import type { BloomForm, CourseTree } from '../../../lib/golf/terrain';

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
  /**
   * Blossom colour for a flowering tree, or absent for a plain green one. The
   * CHOICE of which trees flower is made upstream, in the hole data
   * (`terrain.courseTrees`), so it is seeded, testable without `three`, and
   * cannot drift from what the sim sees. Broadleaves only — pines ignore it.
   */
  bloom?: number;
  /**
   * Where that blossom goes — see "TWO FORMS" in the header. Absent means
   * `'canopy'`, which is the behaviour that shipped, so a placement built
   * without this field renders exactly as it always did.
   */
  bloomForm?: BloomForm;
}

/**
 * Adapt the course's tree DATA (`terrain.courseTrees` — the same list the sim
 * collides against, so drawn == played) to grove placements. World z = −d.
 *
 * `form` is the hole's `bloom.form`, passed in rather than carried on
 * `CourseTree` on purpose: it is one constant for the whole hole and nothing in
 * the sim has any business seeing it, so keeping it off the tree list preserves
 * the "strip `bloom` and the list is byte-identical" guarantee unchanged — one
 * render-only field on the sim's data structure, not two.
 */
export function groveFromCourseTrees(
  trees: readonly CourseTree[],
  form?: BloomForm,
): TreePlacement[] {
  return trees.map((t) => {
    const p: TreePlacement = { kind: t.kind, x: t.x, z: -t.d, scale: t.scale, seed: t.seed, y: t.ground };
    if (t.bloom !== undefined) {
      p.bloom = t.bloom;
      // Only ever SET for the non-default form, so a canopy hole's placements
      // are the same objects (same keys) the harness has been shooting.
      if (form === 'understory') p.bloomForm = form;
    }
    return p;
  });
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
 * How far a flowering crown blob is pushed toward the blossom colour, at least.
 * The remaining 0.4 is seeded spread, so the crown is mostly in flower with
 * green showing through rather than a flat repaint. Set this low and the tree
 * reads as measles: one pink blob in six is a diseased tree, not a blossom.
 */
const BLOOM_MIX_MIN = 0.6;
/**
 * Extra flower clusters per blooming tree. Small, near-pure blossom, hung around
 * the crown's outside so the bloom reads as flowers ON a tree rather than a tree
 * that was painted. They are leaf-blob instances, so 3 of them cost 60 triangles
 * and no draw call.
 */
export const BLOOM_TUFTS = 3;

/**
 * Blobs in one `'understory'` drift. Six overlapping blobs at the foot of the
 * trunk merge into a single mass at every distance this camera uses; a handful
 * fewer leaves gaps the eye reads as separate bushes, which is the ground-level
 * version of the measles failure the crown mix floor exists to avoid.
 */
export const BLOOM_DRIFT_BLOBS = 7;
/**
 * Drift geometry, in the tree's LOCAL units — the group matrix applies the
 * tree's own scale (1.65–2.2 on a course), so a drift stays proportionate to the
 * tree it is planted under instead of shrinking against the big ones.
 *
 * At a typical scale of 1.9 these give a mass ~9 yd across and ~5 yd tall under
 * a ~19 yd tree, against a canopy whose lowest blobs start around 8.5 yd: a
 * quarter of the tree's height with clear air between the two, which is what an
 * arching shrub under mature hardwood looks like — and the gap is the whole
 * point, because "green leaves ABOVE, warm mass BELOW" is the read that autumn
 * cannot fake. The first pass at 5 blobs of 0.85–1.35 measured only 0.33% of
 * frame against 0.77–1.76% on the three holes the gate passed, and read as
 * scattered dots; these are sized from that measurement.
 *
 * Blobs are squashed in y (0.72) so more of each facet faces the sun — a
 * ground-level icosahedron otherwise turns half its faces away from the key
 * light, and an unlit yellow facet is olive.
 */
const DRIFT_SPREAD = 2.8;
const DRIFT_R = [1.1, 1.75] as const;
const DRIFT_Y = [0.8, 1.35] as const;
const DRIFT_SQUASH = 0.72;
/**
 * How close a drift blob sits to the pure blossom colour: 0.88–1.0 of the way
 * from white, i.e. barely washed at all. Unlike a crown blob there is no green
 * to blend with, and that is botanically right — forsythia flowers on bare
 * wands, before a single leaf opens.
 *
 * It started at 0.75 on the theory that lightening would keep the sun-facing
 * facets from going dark. The measurement said otherwise: value was already
 * healthy (0.73 mean) and SATURATION was the weak axis (0.58 against an authored
 * 0.93), because washing toward white is exactly a saturation cut. Chroma is the
 * scarce resource here, so spend the white sparingly.
 */
const DRIFT_PURITY_MIN = 0.88;

const _mixA = new THREE.Color();
const _mixB = new THREE.Color();

/**
 * Blend `base` toward `bloom` by `BLOOM_MIX_MIN + (1−BLOOM_MIX_MIN)·r`, where
 * `r` is a seeded [0,1) roll. Both colours go through `setHex`, so the mix
 * happens in three's working (linear) space and comes back as sRGB hex — the
 * same round trip the palette already makes.
 */
function blossom(base: number, bloom: number, r: number): number {
  return _mixA
    .setHex(base)
    .lerp(_mixB.setHex(bloom), BLOOM_MIX_MIN + (1 - BLOOM_MIX_MIN) * r)
    .getHex();
}

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

    // Blossom draws from its OWN generator so it cannot perturb `r()`: a
    // flowering tree keeps the exact shape, crown count and jitter the same seed
    // gives it plain, and bloom is provably a colour-only change.
    const bloomHex = t.kind === 'broadleaf' ? t.bloom : undefined;
    const br = bloomHex === undefined ? null : treeRng((t.seed ^ 0x9e3779b9) >>> 0);
    // 'understory' keeps the crown green and puts the blossom on the ground —
    // see "TWO FORMS" in the header. Absent/`'canopy'` is the shipped path and
    // must stay bit-identical, so this is a strict equality, not a truthiness.
    const understory = br !== null && t.bloomForm === 'understory';

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
        slot.c = br && !understory ? blossom(col, bloomHex!, br()) : col;
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
      // Flower clusters — same geometry, same material, same InstancedMesh, so
      // this is triangles only. Hung wider (0.55–1.05 crownR) and smaller
      // (0.3–0.52 crownR) than a leaf blob, biased to the upper crown where a
      // flowering tree actually carries its blossom.
      if (br && !understory) {
        for (let i = 0; i < BLOOM_TUFTS; i++) {
          const ang = br() * Math.PI * 2;
          const rad = crownR * (0.55 + br() * 0.5);
          const by = crownY + (br() - 0.3) * crownR * 0.8;
          const bs = crownR * (0.3 + br() * 0.22);
          composeInstance(local, Math.cos(ang) * rad, by, Math.sin(ang) * rad, 0, ang, 0, bs, bs * 0.85, bs);
          // Pure blossom, lightened up to 40% toward white — flowers catch the
          // sun where leaves do not, and it keeps the clusters from flattening
          // into one silhouette against the tinted crown behind them.
          push('leaf', blossom(0xffffff, bloomHex!, br()));
        }
      } else if (br) {
        // UNDERSTORY: a drift of flowering shrub round the base of the trunk,
        // under a crown that stayed green. Same unit icosahedron, same white
        // material, same InstancedMesh — triangles only, no draw call. Placed in
        // the tree's local frame, so the group matrix seats it on the terrain at
        // the tree's own scale and there is no second heightfield lookup to get
        // wrong.
        for (let i = 0; i < BLOOM_DRIFT_BLOBS; i++) {
          const ang = br() * Math.PI * 2;
          const rad = br() * DRIFT_SPREAD;
          const bs = DRIFT_R[0] + br() * (DRIFT_R[1] - DRIFT_R[0]);
          const by = DRIFT_Y[0] + br() * (DRIFT_Y[1] - DRIFT_Y[0]);
          composeInstance(
            local,
            Math.cos(ang) * rad,
            by,
            Math.sin(ang) * rad,
            0,
            ang,
            0,
            bs,
            bs * DRIFT_SQUASH,
            bs,
          );
          push('leaf', blossom(0xffffff, bloomHex!, DRIFT_PURITY_MIN + (1 - DRIFT_PURITY_MIN) * br()));
        }
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
