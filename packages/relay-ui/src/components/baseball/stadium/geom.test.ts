// The geometry primitives' bench — and it exists because ONE of them is now
// load-bearing for the whole art pass.
//
// `mergeGeometries` is what lets the banded bowl, the roof truss, the mown turf
// and the skyline each cost a SINGLE draw call. Draw calls are the tight budget
// in this scene (the worst frame is 26 against a ceiling of 40, where triangles
// are 15 k against 120 k), so a merge that silently drops an attribute or
// mis-offsets an index does not crash — it renders something plausible and
// wrong. Both of those failures were hit for real while this pass was written:
//
//   • a fascia band authored WITHOUT UVs made the merge drop the `uv` attribute
//     from all nine bowl bands (it takes the INTERSECTION), so the crowd texture
//     sampled texel (0,0) everywhere and the bowl came back flat;
//   • the mown-turf grid was wound the other way round, so `computeVertexNormals`
//     faced it DOWN and a FrontSide material drew nothing at all — the whole
//     field rendered as the grey apron underneath it.
//
// Neither is caught by a typecheck and neither throws.
//
// MUTATIONS WATCHED TO FAIL (each reverted):
//   1. `mergeGeometries` index offset `+ vo` dropped        → 1 fail
//   2. the attribute filter changed from `every` to `some`  → 1 fail
//   3. the index array changed from Uint32 to Uint16        → 1 fail
//   4. `loft`'s uv `u` read from the index instead of the
//      caller's array (i.e. the old `uRepeat` behaviour)    → 1 fail
//
// M3b added the RING CLOSURE tests, and three more mutations were watched.
// Mutation 6 is not hypothetical — it is the bug this file's author wrote,
// shipped to the renderer, and found in a PNG rather than in a test, which is
// the reason these three assertions exist at all:
//   5. the full-circle closure dropped (the pre-M3b behaviour)  → 2 fail
//   6. the closure SORTED IN with the extra bearings instead of
//      appended after them — its bearing is `b0`, so an ascending
//      sort moves it to the FRONT and the ring loses its last
//      segment. On the render: a ~180 px hole straight through the
//      backstop, dead centre of the `pitcher` frame               → 1 fail
//   7. a PARTIAL span closed too (the foul-line rings must end on
//      the foul line, not wrap back to −45°)                      → 1 fail

import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { loft, mergeGeometries, ring } from './geom';

/** A one-triangle geometry at a given offset, with an optional colour. */
function tri(offset: number, withColor: boolean): BufferGeometry {
  const g = new BufferGeometry();
  const pos = new Float32Array([offset, 0, 0, offset + 1, 0, 0, offset, 1, 0]);
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  if (withColor) g.setAttribute('color', new BufferAttribute(new Float32Array(9).fill(0.5), 3));
  g.setIndex([0, 1, 2]);
  return g;
}

describe('mergeGeometries — the draw-call budget as a function', () => {
  it('concatenates vertices and RE-BASES every index', () => {
    const m = mergeGeometries([tri(0, true), tri(10, true), tri(20, true)]);
    const pos = m.getAttribute('position');
    expect(pos.count).toBe(9);
    // Vertices land in input order, untouched.
    expect(pos.getX(0)).toBe(0);
    expect(pos.getX(3)).toBe(10);
    expect(pos.getX(6)).toBe(20);
    // ⚠ AND THE INDICES ARE OFFSET. This is the assertion the mutation exists
    // for: without `+ vo` every part indexes the FIRST part's vertices, which
    // renders one triangle three times over and looks like "the merge lost
    // everything but the first piece".
    const idx = m.getIndex();
    expect(idx).not.toBeNull();
    expect(Array.from({ length: idx!.count }, (_, i) => idx!.getX(i))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('takes the INTERSECTION of attributes — a part without one drops it for all', () => {
    // The real bug: one band without UVs killed the map on the whole bowl. The
    // alternative (zero-filling) is worse, because the parts that DID have the
    // attribute would render correctly and the ones that did not would render
    // black — a lighting-looking bug with a geometry cause.
    const both = mergeGeometries([tri(0, true), tri(10, true)]);
    expect(both.getAttribute('color')).toBeTruthy();
    const mixed = mergeGeometries([tri(0, true), tri(10, false)]);
    expect(mixed.getAttribute('position')).toBeTruthy();
    expect(mixed.getAttribute('color')).toBeUndefined();
    // …and the geometry is still complete: dropping an attribute must not drop
    // a vertex.
    expect(mixed.getAttribute('position').count).toBe(6);
  });

  it('indexes in Uint32, because the merged bowl passes 65 535 vertices', () => {
    // A Uint16 index wraps SILENTLY into a scrambled mesh rather than throwing.
    // Rather than build a 65 k geometry here, assert the array type directly —
    // that is the property, and it is the one the mutation changes.
    const m = mergeGeometries([tri(0, false), tri(1, false)]);
    expect(m.getIndex()!.array).toBeInstanceOf(Uint32Array);
    expect(mergeGeometries([]).getIndex()).toBeNull();
  });
});

describe('ring — a full circle CLOSES, and it closes LAST', () => {
  it('ends exactly where it starts, whatever the caller`s function does at ±180', () => {
    // ⚠ THE 1.75 ft CRACK, AS AN ASSERTION. `stands.ts` held the bowl's front
    // rail at "the nearer foul line's height" outside fair territory, and
    // `Math.sign(±180)` picks a DIFFERENT line at each end of a −180…+180 span —
    // so Harbourfront's 14 ft 4 in left line met its 12 ft 7 in right line as a
    // hole, dead centre of the `pitcher` frame. The park data was fixed; this
    // makes closure a property of the PRIMITIVE, so the next caller whose
    // function is not periodic gets a slanted quad instead of a hole.
    const nasty = (b: number) => ({ r: 100, y: b < 0 ? 10 : 20 });
    const r = ring(-180, 180, 30, nasty);
    const n = r.length / 3;
    for (const k of [0, 1, 2]) {
      expect(r[(n - 1) * 3 + k], `component ${k}`).toBeCloseTo(r[k]!, 9);
    }
  });

  it('closes AFTER any forced extra bearings, not sorted in with them', () => {
    // ⚠ THE MUTATION THIS EXISTS FOR IS ONE I WROTE. The closing sample's
    // bearing IS `b0`, so sorting it with the extras moves it to the FRONT of
    // the array and the ring loses its last segment instead of gaining a
    // closure — measured on the render as a ~180 px hole through the backstop.
    const r = ring(-180, 180, 30, (b) => ({ r: 100, y: b }), [-10.5, 10.5]);
    const n = r.length / 3;
    // 12 uniform samples + 2 extras + 1 closure.
    expect(n).toBe(15);
    // The extras are present, in order, and the ring still closes on its start.
    const ys = Array.from({ length: n }, (_, i) => r[i * 3 + 1]!);
    expect(ys[0]).toBeCloseTo(-180, 9);
    expect(ys[n - 1]).toBeCloseTo(-180, 9);
    expect(ys).toContain(-10.5);
    expect(ys).toContain(10.5);
    // …and the interior is monotone increasing, which a mis-sorted closure
    // breaks at index 1 rather than at the end.
    for (let i = 1; i < n - 1; i++) expect(ys[i]!).toBeGreaterThan(ys[i - 1]!);
  });

  it('does NOT close a partial span — the foul-line rings must end on the line', () => {
    const r = ring(-45, 45, 30, (b) => ({ r: 100, y: b }));
    const n = r.length / 3;
    expect(n).toBe(4);
    expect(r[1]).toBeCloseTo(-45, 9);
    expect(r[(n - 1) * 3 + 1]).toBeCloseTo(45, 9);
  });
});

describe('loft — UVs come from the CALLER, in arc length', () => {
  it('writes the caller`s u per column and its v per ring', () => {
    // Two 3-sample rings, and a `u` the caller chose that is deliberately NOT
    // proportional to the index — which is the whole point. Equal-angle UVs
    // stretch a stadium tile 2.5:1 behind the plate and 2:1 in the outfield,
    // because the bowl's radius varies by nearly 10× around it.
    const a = ring(-90, 90, 90, () => ({ r: 10, y: 0 }));
    const b = ring(-90, 90, 90, () => ({ r: 20, y: 5 }));
    const u = [0, 0.25, 3];
    const g = loft(a, b, { uv: { v0: 0.1, v1: 0.9, u } });
    const uv = g.getAttribute('uv');
    expect(uv.count).toBe(6);
    for (let i = 0; i < 3; i++) {
      expect(uv.getX(i)).toBeCloseTo(u[i]!, 6);
      expect(uv.getY(i)).toBeCloseTo(0.1, 6);
      expect(uv.getX(3 + i)).toBeCloseTo(u[i]!, 6);
      expect(uv.getY(3 + i)).toBeCloseTo(0.9, 6);
    }
    // No uv option ⇒ no uv attribute, which is what makes the intersection rule
    // above bite rather than being a theoretical concern.
    expect(loft(a, b).getAttribute('uv')).toBeUndefined();
  });
});
