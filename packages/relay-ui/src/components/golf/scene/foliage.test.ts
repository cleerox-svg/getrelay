// The grove's two load-bearing properties: it costs three draw calls, and it is
// the SAME grove it was before instancing.
//
// The second one is the whole reason this file exists. Instancing rewrote how
// every tree in the game is submitted, and the only way to know the art survived
// is to check the transforms against the geometry the old per-mesh builder
// produced — the screenshot gate can tell you the frame moved, not which tree.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BLOOM_TUFTS, buildGrove, groveFromCourseTrees, type TreePlacement } from './foliage';
import { courseTrees, HOLE_1 } from '../../../lib/golf/terrain';
import type { DisposableResource } from '../../../lib/scene3d/instancing';

const track = <T extends DisposableResource>(o: T): T => o;

function build(trees: TreePlacement[]) {
  const scene = new THREE.Scene();
  const meshes = buildGrove(scene, track, trees);
  return { scene, meshes };
}

/** Every instance matrix in a batch, keyed by the batch's geometry type. */
function instances(mesh: THREE.InstancedMesh): THREE.Matrix4[] {
  const out: THREE.Matrix4[] = [];
  for (let i = 0; i < mesh.count; i++) {
    const m = new THREE.Matrix4();
    mesh.getMatrixAt(i, m);
    out.push(m);
  }
  return out;
}

describe('the golf grove — draw-call budget', () => {
  it('draws the WHOLE of Hole 1 in three instanced meshes', () => {
    const trees = groveFromCourseTrees(courseTrees(HOLE_1));
    // Sanity: this is a real grove, not an empty list making the count trivial.
    expect(trees.length).toBeGreaterThan(80);
    const { scene, meshes } = build(trees);
    expect(meshes).toHaveLength(3);
    expect(scene.children).toHaveLength(3);
    // The old builder made a Group per tree holding 5–8 meshes.
    const loose = meshes.reduce((n, m) => n + m.count, 0);
    expect(loose).toBeGreaterThan(400);
  });

  it('stays at three meshes no matter how many trees are planted', () => {
    const many: TreePlacement[] = [];
    for (let i = 0; i < 2000; i++) {
      many.push({ kind: i % 2 ? 'pine' : 'broadleaf', x: i, z: -i, scale: 1, seed: i });
    }
    expect(build(many).meshes).toHaveLength(3);
  });

  it('spends nothing on a species that was never planted', () => {
    // Pines only: the leaf-blob batch must not be committed at all.
    const pines: TreePlacement[] = [{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 7 }];
    expect(build(pines).meshes).toHaveLength(2);
  });

  it('casts shadows from every batch', () => {
    for (const m of build([{ kind: 'broadleaf', x: 0, z: 0, scale: 1, seed: 1 }]).meshes) {
      expect(m.castShadow).toBe(true);
    }
  });
});

describe('the golf grove — the art is unchanged', () => {
  // Reference values captured from the per-mesh builder this replaced
  // (scenery.ts createTreeKit, seed 5020 / 9020, the first two trees Hole 1
  // plants). If instancing had reordered a single RNG draw, every one of these
  // would move.
  it('plants a broadleaf with the crown the old builder gave it', () => {
    const { meshes } = build([{ kind: 'broadleaf', x: 10, z: -20, scale: 1.7, seed: 5020, y: 3 }]);
    const trunk = meshes.find((m) => m.count === 1)!;
    const leaves = meshes.find((m) => m.count > 1)!;
    // 5 + floor(r*3) blobs, so 5..7 — and exactly what the seed produced before.
    expect(leaves.count).toBe(6);

    const t = instances(trunk)[0]!;
    const p = new THREE.Vector3().setFromMatrixPosition(t);
    const s = new THREE.Vector3().setFromMatrixScale(t);
    // Group (10, 3, −20) × scale 1.7, trunk local y 2.5 → world y = 3 + 4.25.
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.y).toBeCloseTo(3 + 2.5 * 1.7, 6);
    expect(p.z).toBeCloseTo(-20, 6);
    // Unit trunk scaled to the broadleaf's 0.85 base radius × 5.5 height, × 1.7.
    expect(s.x).toBeCloseTo(0.85 * 1.7, 6);
    expect(s.y).toBeCloseTo(5.5 * 1.7, 6);

    // Crown blobs sit around local y 6..7.2 (× 1.7 + ground), never at the base.
    for (const m of instances(leaves)) {
      const bp = new THREE.Vector3().setFromMatrixPosition(m);
      expect(bp.y).toBeGreaterThan(3 + 4 * 1.7);
      expect(bp.distanceTo(new THREE.Vector3(10, bp.y, -20))).toBeLessThan(3.8 * 1.7);
    }
  });

  it('stacks a pine in tapering tiers off one trunk', () => {
    const { meshes } = build([{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 9020 }]);
    const trunk = meshes.find((m) => m.count === 1)!;
    const tiers = meshes.find((m) => m.count > 1)!;
    expect(tiers.count).toBeGreaterThanOrEqual(4);
    expect(tiers.count).toBeLessThanOrEqual(5);

    const st = new THREE.Vector3().setFromMatrixScale(instances(trunk)[0]!);
    expect(st.x).toBeCloseTo(0.6, 6);
    expect(st.y).toBeCloseTo(5.0, 6);

    let lastY = -Infinity;
    let lastR = Infinity;
    for (const m of instances(tiers)) {
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      const s = new THREE.Vector3().setFromMatrixScale(m);
      expect(p.y).toBeGreaterThan(lastY); // tiers climb
      expect(s.x).toBeLessThan(lastR); // and narrow
      lastY = p.y;
      lastR = s.x;
    }
  });

  it('gives the shared unit trunk the broadleaf taper, within 3 mm of the pine it also serves', () => {
    // One geometry for both species is what makes the grove 3 draws and not 4.
    // The pine's real taper is 0.32/0.6 = 0.5333 against the broadleaf's 0.5294;
    // at the pine's 0.6 base radius that is a 0.0024 yd error in the top radius.
    const { meshes } = build([{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 1 }]);
    const geo = meshes.find((m) => m.count === 1)!.geometry as THREE.CylinderGeometry;
    const topR = geo.parameters.radiusTop * 0.6;
    expect(Math.abs(topR - 0.32)).toBeLessThan(0.003);
  });

  it('is deterministic — the same seeds build byte-identical transforms', () => {
    const trees = groveFromCourseTrees(courseTrees(HOLE_1));
    const dump = () =>
      build(trees)
        .meshes.map((m) => Array.from(m.instanceMatrix.array))
        .flat();
    expect(dump()).toEqual(dump());
  });

  it('tints leaves from the 5-tone palette, and paints a pine one colour', () => {
    const palette = new Set([0x2f7d3a, 0x3c8f44, 0x59a24a, 0x276b34, 0x4f9a52]);
    const trees = groveFromCourseTrees(courseTrees(HOLE_1));
    const { meshes } = build(trees);
    const c = new THREE.Color();
    for (const m of meshes) {
      if (!m.instanceColor) continue;
      const seen = new Set<number>();
      for (let i = 0; i < m.count; i++) {
        m.getColorAt(i, c);
        seen.add(c.getHex());
      }
      for (const hex of seen) expect(palette.has(hex)).toBe(true);
      // Variety survived the collapse from 5 materials to 1 — if instanceColor
      // were dropped the whole grove would be a single flat white.
      expect(seen.size).toBeGreaterThan(1);
    }
    // A single pine wears exactly one leaf colour, as it did with one material.
    const one = build([{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 4242 }]);
    const tiers = one.meshes.find((m) => m.count > 1)!;
    const hues = new Set<number>();
    for (let i = 0; i < tiers.count; i++) {
      tiers.getColorAt(i, c);
      hues.add(c.getHex());
    }
    expect(hues.size).toBe(1);
  });

  it('maps course tree DATA to world z = −d, so drawn == played', () => {
    const [t] = courseTrees(HOLE_1);
    const [p] = groveFromCourseTrees([t!]);
    expect(p).toEqual({ kind: t!.kind, x: t!.x, z: -t!.d, scale: t!.scale, seed: t!.seed, y: t!.ground });
  });
});

describe('the golf grove — blossom', () => {
  const PINK = 0xf2a0bd;
  const plain: TreePlacement[] = [
    { kind: 'broadleaf', x: 0, z: 0, scale: 1.7, seed: 5020, y: 3 },
    { kind: 'pine', x: 20, z: -10, scale: 1.4, seed: 9020 },
    { kind: 'broadleaf', x: -20, z: -30, scale: 1.5, seed: 5046 },
  ];
  const flowering: TreePlacement[] = plain.map((p, i) =>
    i === 0 ? { ...p, bloom: PINK } : p,
  );

  const colours = (mesh: THREE.InstancedMesh): number[] => {
    const c = new THREE.Color();
    const out: number[] = [];
    if (!mesh.instanceColor) return out; // untinted batch (trunks)
    for (let i = 0; i < mesh.count; i++) {
      mesh.getColorAt(i, c);
      out.push(c.getHex());
    }
    return out;
  };

  it('costs NO extra draw call — blossom rides the leaf batch', () => {
    // The whole design constraint. Trunk / leaf / tier, flowering or not.
    expect(build(plain).meshes).toHaveLength(3);
    expect(build(flowering).meshes).toHaveLength(3);
  });

  // A grove of exactly one blooming broadleaf, so the leaf batch reads
  // [crown …, tufts …] with nothing else interleaved.
  const ONE = { kind: 'broadleaf', x: 0, z: 0, scale: 1.7, seed: 5020, y: 3 } as const;
  const oneCrown = 6; // 5 + floor(r*3) for seed 5020 — see the parity test above.

  it('does not move a single tree — bloom is colour only', () => {
    // The blossom generator is seeded separately from the per-tree render RNG
    // precisely so this holds. Every trunk, tier and original crown blob must
    // land exactly where it lands on a hole with no bloom field.
    const a = build([ONE]).meshes;
    const b = build([{ ...ONE, bloom: PINK }]).meshes;
    // Trunk: identical outright.
    expect(Array.from(b[0]!.instanceMatrix.array)).toEqual(Array.from(a[0]!.instanceMatrix.array));
    // Crown: the flower clusters are APPENDED, so the original blobs are the
    // untouched prefix.
    const pa = Array.from(a[1]!.instanceMatrix.array);
    expect(Array.from(b[1]!.instanceMatrix.array).slice(0, pa.length)).toEqual(pa);

    // …and the same holds across a MIXED grove: bloom must not perturb the trees
    // around it, so trunks and pine tiers are identical for the whole scatter.
    const ma = build(plain).meshes;
    const mb = build(flowering).meshes;
    for (const i of [0, 2]) {
      expect(Array.from(mb[i]!.instanceMatrix.array)).toEqual(Array.from(ma[i]!.instanceMatrix.array));
    }
  });

  it('adds exactly three flower clusters per blooming tree, and nothing else', () => {
    expect(build(flowering).meshes[1]!.count - build(plain).meshes[1]!.count).toBe(3);
    expect(build([{ ...ONE, bloom: PINK }]).meshes[1]!.count - build([ONE]).meshes[1]!.count).toBe(3);
  });

  it('turns the blooming crown pink and leaves every other tree green', () => {
    const palette = new Set([0x2f7d3a, 0x3c8f44, 0x59a24a, 0x276b34, 0x4f9a52]);
    const green = colours(build(plain).meshes[1]!);
    const bloomed = colours(build(flowering).meshes[1]!);
    for (const hex of green) expect(palette.has(hex)).toBe(true);

    // Leaf-batch order: tree 0's crown, then tree 0's 3 clusters, then tree 2's
    // crown (tree 1 is a pine and lands in the tier batch).
    const changed = bloomed.slice(0, oneCrown);
    const untouched = bloomed.slice(oneCrown + BLOOM_TUFTS);
    expect(changed.every((h, i) => h !== green[i])).toBe(true);
    expect(untouched).toEqual(green.slice(oneCrown));

    // Every retinted blob is genuinely in the pink half of the mix, not a green
    // with a pink hint — a crown that only hints reads as measles. Red must
    // dominate outright, and carry at least half the blossom's own red.
    const c = new THREE.Color();
    const target = new THREE.Color().setHex(PINK);
    for (const hex of changed) {
      c.setHex(hex);
      expect(c.r).toBeGreaterThan(c.g);
      expect(c.r).toBeGreaterThan(c.b);
      expect(c.r).toBeGreaterThan(target.r * 0.5);
    }
  });

  it('makes the flower clusters lighter than the blossom colour itself', () => {
    const bloomed = colours(build(flowering).meshes[1]!);
    const tufts = bloomed.slice(oneCrown, oneCrown + BLOOM_TUFTS);
    expect(tufts).toHaveLength(BLOOM_TUFTS);
    const target = new THREE.Color().setHex(PINK);
    const c = new THREE.Color();
    for (const hex of tufts) {
      c.setHex(hex);
      // A lerp from white toward PINK: never darker than the blossom.
      expect(c.r).toBeGreaterThanOrEqual(target.r - 1e-6);
      expect(c.g).toBeGreaterThanOrEqual(target.g - 1e-6);
      expect(c.b).toBeGreaterThanOrEqual(target.b - 1e-6);
    }
  });

  it('ignores a bloom on a pine — conifers do not flower', () => {
    const conifer: TreePlacement[] = [{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 9020, bloom: PINK }];
    const bare: TreePlacement[] = [{ kind: 'pine', x: 0, z: 0, scale: 1, seed: 9020 }];
    const a = build(bare).meshes;
    const b = build(conifer).meshes;
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(Array.from(b[i]!.instanceMatrix.array)).toEqual(Array.from(a[i]!.instanceMatrix.array));
      expect(colours(b[i]!)).toEqual(colours(a[i]!));
    }
  });

  it('is deterministic — the same seeds bloom the same colours twice', () => {
    const dump = () => build(flowering).meshes.map((m) => colours(m));
    expect(dump()).toEqual(dump());
  });

  it('forwards the hole data’s bloom to the placement, and omits it otherwise', () => {
    const trees = courseTrees(HOLE_1);
    expect(groveFromCourseTrees(trees).some((p) => 'bloom' in p)).toBe(false);
    const tinted = groveFromCourseTrees([{ ...trees[0]!, kind: 'broadleaf', bloom: PINK }]);
    expect(tinted[0]!.bloom).toBe(PINK);
  });
});
