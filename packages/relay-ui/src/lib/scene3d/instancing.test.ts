// The half of `instancing.ts` that can be checked without a GPU — which is the
// half that goes wrong quietly.
//
// A batcher that drops instances, mis-pairs a tint with a transform or forgets a
// bounding sphere produces a scene that still renders: fewer trees, or the wrong
// green, or a grove that vanishes when the camera turns. None of those throw, and
// the screenshot gate can only tell you the frame changed, not why.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  atlasUvRect,
  composeInstance,
  createInstanceBatcher,
  makeImpostorQuads,
  type DisposableResource,
} from './instancing';

/** A stand-in for a scene's disposal registry. */
function tracker() {
  const tracked: DisposableResource[] = [];
  return {
    tracked,
    track: <T extends DisposableResource>(o: T): T => {
      tracked.push(o);
      return o;
    },
  };
}

function specs() {
  return {
    a: { geometry: new THREE.BoxGeometry(1, 1, 1), material: new THREE.MeshBasicMaterial() },
    b: {
      geometry: new THREE.ConeGeometry(1, 1, 4),
      material: new THREE.MeshBasicMaterial(),
      tinted: true,
      castShadow: true,
    },
  };
}

describe('createInstanceBatcher', () => {
  it('commits one InstancedMesh per non-empty batch, whatever the instance count', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 500; i++) b.add('a', m.makeTranslation(i, 0, 0));
    const scene = new THREE.Scene();
    const meshes = b.commit(scene);
    // The whole point: 500 props, ONE submission. And the empty batch costs zero.
    expect(meshes).toHaveLength(1);
    expect(meshes[0]!.count).toBe(500);
    expect(scene.children).toHaveLength(1);
  });

  it('writes every instance matrix in insertion order', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 4; i++) b.add('a', m.makeTranslation(i * 2, i, -i));
    const mesh = b.commit(new THREE.Scene())[0]!;
    const read = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      mesh.getMatrixAt(i, read);
      p.setFromMatrixPosition(read);
      expect([p.x, p.y, p.z]).toEqual([i * 2, i, -i]);
    }
  });

  it('copies the matrix, so one scratch Matrix4 can drive a whole scatter', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const scratch = new THREE.Matrix4();
    b.add('a', scratch.makeTranslation(1, 0, 0));
    b.add('a', scratch.makeTranslation(2, 0, 0));
    const mesh = b.commit(new THREE.Scene())[0]!;
    const read = new THREE.Matrix4();
    mesh.getMatrixAt(0, read);
    expect(new THREE.Vector3().setFromMatrixPosition(read).x).toBe(1);
  });

  it('stores per-instance tints in the working colour space, aligned with the transforms', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const m = new THREE.Matrix4();
    const hexes = [0x2f7d3a, 0x59a24a, 0x276b34];
    for (const h of hexes) b.add('b', m.makeTranslation(h, 0, 0), new THREE.Color(h));
    const mesh = b.commit(new THREE.Scene())[0]!;
    const c = new THREE.Color();
    for (let i = 0; i < hexes.length; i++) {
      mesh.getColorAt(i, c);
      // Byte-equal to the Color a per-instance MATERIAL would have carried —
      // that equality is what makes the collapse from 5 materials to 1 invisible.
      expect(c.getHex()).toBe(hexes[i]);
    }
  });

  it('defaults a missing tint to white rather than shifting every later instance', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const m = new THREE.Matrix4();
    b.add('b', m.makeTranslation(0, 0, 0));
    b.add('b', m.makeTranslation(1, 0, 0), new THREE.Color(0xff0000));
    const mesh = b.commit(new THREE.Scene())[0]!;
    const c = new THREE.Color();
    mesh.getColorAt(0, c);
    expect(c.getHex()).toBe(0xffffff);
    mesh.getColorAt(1, c);
    expect(c.getHex()).toBe(0xff0000);
  });

  it('allocates no instanceColor for an untinted batch', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    b.add('a', new THREE.Matrix4());
    expect(b.commit(new THREE.Scene())[0]!.instanceColor).toBeNull();
  });

  it('computes a bounding sphere that covers every instance', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    const m = new THREE.Matrix4();
    b.add('a', m.makeTranslation(-100, 0, 0));
    b.add('a', m.makeTranslation(100, 0, 0));
    const mesh = b.commit(new THREE.Scene())[0]!;
    // Non-null and wide: a lazily-computed or stale sphere is the aim-arc
    // frustum-cull bug again, except it takes the whole grove with it.
    expect(mesh.boundingSphere).not.toBeNull();
    expect(mesh.boundingSphere!.radius).toBeGreaterThan(100);
  });

  it('tracks the meshes for teardown, and leaves the caller its own geometry', () => {
    const t = tracker();
    const s = specs();
    const b = createInstanceBatcher(s, t.track);
    b.add('a', new THREE.Matrix4());
    const mesh = b.commit(new THREE.Scene())[0]!;
    expect(t.tracked).toContain(mesh);
    expect(t.tracked).not.toContain(s.a.geometry);
  });

  it('refuses an unknown batch, a late add and a second commit', () => {
    const { track } = tracker();
    const b = createInstanceBatcher(specs(), track);
    // @ts-expect-error — the key union is the first line of defence; this is the second.
    expect(() => b.add('nope', new THREE.Matrix4())).toThrow(/unknown batch/);
    b.commit(new THREE.Scene());
    expect(() => b.add('a', new THREE.Matrix4())).toThrow(/after commit/);
    expect(() => b.commit(new THREE.Scene())).toThrow(/twice/);
  });
});

describe('composeInstance', () => {
  it('matches what an Object3D with the same position/rotation/scale would produce', () => {
    const o = new THREE.Object3D();
    o.position.set(3, -1, 7);
    o.rotation.set(0.4, 1.1, -0.2); // default XYZ order, as composeInstance uses
    o.scale.set(0.85, 5.5, 0.85);
    o.updateMatrix();
    const m = composeInstance(new THREE.Matrix4(), 3, -1, 7, 0.4, 1.1, -0.2, 0.85, 5.5, 0.85);
    for (let i = 0; i < 16; i++) expect(m.elements[i]).toBeCloseTo(o.matrix.elements[i]!, 12);
  });

  it('treats a single scale argument as uniform', () => {
    const m = composeInstance(new THREE.Matrix4(), 0, 0, 0, 0, 0, 0, 2);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect([s.x, s.y, s.z]).toEqual([2, 2, 2]);
  });
});

describe('atlas quads', () => {
  it('maps a cell index row-major with v measured from the bottom', () => {
    expect(atlasUvRect({ columns: 2, rows: 2, index: 0 })).toEqual([0, 0.5, 0.5, 1]);
    expect(atlasUvRect({ columns: 2, rows: 2, index: 3 })).toEqual([0.5, 0, 1, 0.5]);
  });

  it('wraps an out-of-range index, so a hash can address a cell directly', () => {
    expect(atlasUvRect({ columns: 2, rows: 2, index: 5 })).toEqual(
      atlasUvRect({ columns: 2, rows: 2, index: 1 }),
    );
    expect(atlasUvRect({ columns: 2, rows: 2, index: -1 })).toEqual(
      atlasUvRect({ columns: 2, rows: 2, index: 3 }),
    );
  });

  it('builds N crossed quads as ONE indexed geometry, pivoted at the base', () => {
    const geo = makeImpostorQuads(4, 9, { planes: 3 });
    expect(geo.getAttribute('position').count).toBe(12);
    expect(geo.getIndex()!.count).toBe(18); // 6 triangles, one draw
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    expect(bb.min.y).toBe(0);
    expect(bb.max.y).toBe(9);
  });

  it('can point every normal up, so a foliage cross does not read as two hard cards', () => {
    const n = makeImpostorQuads(1, 1, { planes: 2, normals: 'up' }).getAttribute('normal');
    for (let i = 0; i < n.count; i++) expect(n.getY(i)).toBe(1);
  });

  it('bakes the atlas cell into the UVs', () => {
    const uv = makeImpostorQuads(1, 1, {
      planes: 1,
      cell: { columns: 4, rows: 1, index: 1 },
    }).getAttribute('uv');
    expect(uv.getX(0)).toBeCloseTo(0.25, 6);
    expect(uv.getX(1)).toBeCloseTo(0.5, 6);
  });
});
