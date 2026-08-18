// The OPEN roof's shape, asserted out of the geometry it actually builds.
//
// ⚠ WHY THIS FILE EXISTS NOW. `roof.ts` had no test at all. The only mechanical
// statement anybody ever made about the roof was the screenshot harness's
// `checkRoof`, and that check asserted **a measurable roof at all five fence
// bearings** — i.e. it asserted the symmetric ring, which is the thing that
// turned out to be the wrong model. A correct collapse would have failed it BY
// DESIGN. That is the worst possible state for a gate: it was not silent, it was
// pointed the wrong way, and it would have argued against the fix.
//
// So the property is re-stated here in the units the design is written in, and
// the harness's version now asserts the same profile on the DRAWN scene. Two
// readers of one claim, which is the pattern `fence.sample` already uses: a
// varying wall is worth asserting, a constant one is not.
//
// MUTATIONS WATCHED TO FAIL (each reverted, counts as observed):
//   1. `STACK` collapsed to one 280 ft row, i.e. a single band        → 1 fail
//      ("parks its panels BEHIND CENTRE FIELD, several deep")
//   2. the rows' `halfDeg` sorted ASCENDING — the stack widening as
//      it goes down instead of narrowing                              → 1 fail
//      (the CEILING test, not the monotone one: layers and depth still
//       thin outward, but past ±11° the highest drawn surface is no
//       longer the panel at `roofPeakFt`. Worth recording, because the
//       obvious guess about which assertion catches it is wrong.)
//   3. every `halfDeg` set to 180 — the superseded symmetric ring      → 2 fail
//      (the foul lines, and the monotone/symmetry sweep)
//   4. `dropFt` of row 0 changed 0 → 6, i.e. the top of the stack no
//      longer at the park's own ceiling                               → 1 fail
//   5. the truss material's `emissive` wired back to `roofEmissiveHex`,
//      i.e. the single shared emissive that made the night lattice
//      render 0.8 levels from its own soffit                          → 1 fail
//   6. `deckColors` fed a literal `0x969ba2` again instead of
//      `daylight.roofDeckHex` — the shipped state before the night
//      roof stopped being the brightest object in a night frame       → 1 fail
//      (the deck-wiring test below. `daylight.test.ts` still passes in
//       full, which is the same reason leg 5 exists: a table can be
//       right and unreachable.)

import { describe, expect, it } from 'vitest';
import { Color, Mesh, MeshLambertMaterial, Scene } from 'three';
import { ALPINE_HEIGHTS, HARBOURFRONT } from '../../../lib/baseball/parks';
import type { Park } from '../../../lib/baseball/parks';
import { DAYLIGHT } from './daylight';
import type { StadiumCtx } from './geom';
import { pickStadiumQuality } from './quality';
import { buildRoof } from './roof';
import { buildStands } from './stands';
import { TOWER_BEARING_DEG } from './towerSpec';

const TEST_SEED = 20260816;

/**
 * A builder context at the DEFAULT tier. The roof reads `bowlStepDeg` and
 * `trussCells`, so the cheapest tier would test a roof with no lattice; the
 * shipped tier is what the gate photographs.
 */
function ctxFor(park: Park, daylight = DAYLIGHT.day): StadiumCtx {
  const owned: Array<{ dispose(): void }> = [];
  return {
    scene: new Scene(),
    track: (<T extends { dispose(): void }>(r: T) => {
      owned.push(r);
      return r;
    }) as StadiumCtx['track'],
    park,
    quality: pickStadiumQuality({} as never, 'medium'),
    seed: TEST_SEED,
    daylight,
  };
}

const roofOf = (park: Park, daylight = DAYLIGHT.day) => {
  const ctx = ctxFor(park, daylight);
  return buildRoof(ctx, buildStands(ctx));
};

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

describe('the open roof', () => {
  it('prints the profile it builds', () => {
    const roof = roofOf(HARBOURFRONT);
    log('\n[ROOF — the parked stack at Harbourfront Dome, read off the drawn deck]');
    log('  bearing   layers   inner_ft   outer_ft    depth_ft    peak_ft');
    for (let b = 0; b <= 45; b += 3) {
      const s = roof.sample(b);
      log(
        s
          ? `  ${String(b).padStart(6)}°   ${String(s.layers).padStart(6)}   ` +
              `${s.innerFt.toFixed(1).padStart(8)}   ${s.outerFt.toFixed(1).padStart(8)}   ` +
              `${(s.outerFt - s.innerFt).toFixed(1).padStart(8)}   ${s.peakFt.toFixed(2).padStart(7)}`
          : `  ${String(b).padStart(6)}°        0   — open sky —`,
      );
    }
  });

  it('parks its panels BEHIND CENTRE FIELD, several deep', () => {
    const roof = roofOf(HARBOURFRONT);
    const centre = roof.sample(0);
    expect(centre).not.toBeNull();
    // "Several arcs nested, with visible steps where panels stack."
    expect(centre!.layers).toBeGreaterThanOrEqual(3);
    // And DEEPER than the symmetric ring it replaced, which ran a 120 ft band at
    // every bearing. Four panels piled where one used to lie.
    expect(centre!.outerFt - centre!.innerFt).toBeGreaterThan(200);
  });

  it('leaves the FOUL LINES open — which is where the skyline shows through', () => {
    const roof = roofOf(HARBOURFRONT);
    // Not "thin". Absent. `follow-pull` and `follow-oppo` look here.
    for (const b of [-45, -40, 45, 40]) expect(roof.sample(b)).toBeNull();
    // …and the edge is inside the outfield, not just outside the foul line: a
    // stack that reached to 44° would pass the line above and still put roof
    // across the top of both corner frames.
    for (const b of [-33, 33]) expect(roof.sample(b)).toBeNull();
    // ⚠ AND IT CLEARS THE LANDMARK. `towerSpec.TOWER_BEARING_DEG` is 14°, and
    // roof at that bearing is what hid the observation pod behind the overhang
    // in the `flight` frame — the whole point of the collapse is that the tower
    // stands in OPEN SKY. Read from the tower's own module, so moving the
    // landmark moves the assertion with it.
    for (const b of [-TOWER_BEARING_DEG, TOWER_BEARING_DEG]) {
      expect(roof.sample(b), `roof at the landmark's bearing ${b}°`).toBeNull();
    }
  });

  it('thins MONOTONICALLY outward and is symmetric about dead centre', () => {
    const roof = roofOf(HARBOURFRONT);
    let lastLayers = Infinity;
    let lastDepth = Infinity;
    // ⚠ THE SWEEP IS OFFSET OFF THE INTEGERS ON PURPOSE. `STACK`'s `halfDeg`
    // values are whole degrees, and a sample landing EXACTLY on a panel's edge
    // is a knife edge — which side of the ±1e-9 bracket it falls on is float
    // noise, and it reads as a 45 ft asymmetry that is not there. Quarter-degree
    // phase never lands on one.
    for (let b = 0.25; b <= 45; b += 0.5) {
      const r = roof.sample(b);
      const l = roof.sample(-b);
      // Symmetry: same coverage, same layers, and the SAME PANELS either side.
      expect(!!r, `coverage at ±${b}°`).toBe(!!l);
      if (r && l) {
        expect(r.layers, `layers at ±${b}°`).toBe(l.layers);
        // ⚠ DEPTH IS SYMMETRIC ONLY TO 0.5 ft, AND THAT IS THE PARK, NOT SLOP.
        // The stack hangs on the top of the BOWL, and the bowl follows the wall
        // — Harbourfront's published profile runs 328/368/381/400/372/359/328,
        // i.e. it is NOT mirror-symmetric (375.4 ft at −22° against 365.9 at
        // +22°). The panel table is mirrored; the thing it is bolted to is not.
        // Measured worst |Δdepth| where the layer counts agree: 0.159 ft.
        expect(Math.abs(r.outerFt - r.innerFt - (l.outerFt - l.innerFt))).toBeLessThan(0.5);
      }
      const layers = r?.layers ?? 0;
      const depth = r ? r.outerFt - r.innerFt : 0;
      expect(layers, `layers must not grow outward at ${b}°`).toBeLessThanOrEqual(lastLayers);
      // ⚠ THE 0.5 ft IS THE SAMPLING RESIDUAL, NOT SLOP. Both edges of a panel
      // are chord polylines through `quality.bowlStepDeg` = 3°, and the sagitta
      // goes as the radius: 530·(1 − cos 1.5°) = 0.18 ft on the outer edge
      // against 0.09 on the inner, so a panel of CONSTANT depth reads ±0.3 ft
      // between posts. Measured worst step within one panel: 0.33 ft. The thing
      // being measured is the 40 ft drop from one panel to the next, so 0.5 ft
      // is 1.5× the residual and 80× under the signal.
      expect(depth, `depth must not grow outward at ${b}°`).toBeLessThanOrEqual(lastDepth + 0.5);
      lastLayers = layers;
      lastDepth = depth;
    }
  });

  it('puts the TOP of the stack at the park`s own ceiling — the gameplay dimension', () => {
    // `resolveFence` rules a ball that reaches `roofPeakFt` `'roof'` under a
    // closed roof, so this is not decoration: the parked panels sit where the
    // closed roof sits, and the highest drawn surface has to say so.
    const roof = roofOf(HARBOURFRONT);
    for (let b = -11; b <= 11; b += 0.5) {
      const s = roof.sample(b);
      if (!s) continue;
      expect(s.peakFt, `peak at ${b}°`).toBeCloseTo(HARBOURFRONT.roofPeakFt, 3);
    }
  });

  // ⚠ THE WIRING, WHICH IS A DIFFERENT QUESTION FROM THE VALUES.
  // `daylight.test.ts` asserts that the truss and the soffit are far enough
  // apart in rendered luminance to read as a lattice. It cannot see WHICH
  // column each material was handed — and the defect that made the night truss
  // invisible was exactly that: one emissive column wired to both materials, a
  // pale `trussHex` that never reached a pixel, and every existing test green.
  // So the wiring is asserted where the materials are, on BOTH rows.
  it('gives the truss and the underside SEPARATE emissives, from their own columns', () => {
    for (const light of [DAYLIGHT.day, DAYLIGHT.night]) {
      const roof = roofOf(HARBOURFRONT, light);
      const matOf = (name: string) => {
        const mesh = roof.group.children.find((c) => c.name === name) as Mesh | undefined;
        expect(mesh, `${light.id}: no mesh named ${name}`).toBeDefined();
        return mesh!.material as MeshLambertMaterial;
      };
      expect(matOf('roofUnderside').emissive.getHex(), `${light.id} underside`).toBe(
        light.roofEmissiveHex,
      );
      expect(matOf('roofTruss').emissive.getHex(), `${light.id} truss`).toBe(light.trussEmissiveHex);
      expect(matOf('roofTruss').color.getHex(), `${light.id} truss colour`).toBe(light.trussHex);
      expect(matOf('roofLip').emissive.getHex(), `${light.id} lip`).toBe(light.roofEdgeEmissiveHex);
    }
    // …and the two emissives are genuinely different values at night, which is
    // the whole content of the split. A table that set them equal would satisfy
    // every assertion above.
    expect(DAYLIGHT.night.trussEmissiveHex).not.toBe(DAYLIGHT.night.roofEmissiveHex);
    expect(DAYLIGHT.day.trussEmissiveHex).not.toBe(DAYLIGHT.day.roofEmissiveHex);
  });

  // ⚠ THE DECK'S COLOUR IS A VERTEX ATTRIBUTE, NOT A MATERIAL COLOUR, which is
  // why it needs its own reader. `roofStack` ships `vertexColors: true` over a
  // white material, so `material.color` is 0xffffff on both rows and the test
  // above cannot see the deck at all — the value lives in the buffer, tinted
  // per bay and per panel by `deckColors`. The BRIGHTEST vertex is the one with
  // no tint (`bay = 1`, panel 0), so it is exactly `daylight.roofDeckHex`.
  it('paints the deck from `daylight.roofDeckHex`, per row', () => {
    for (const light of [DAYLIGHT.day, DAYLIGHT.night]) {
      const roof = roofOf(HARBOURFRONT, light);
      const deck = roof.group.children.find((c) => c.name === 'roofStack') as Mesh | undefined;
      expect(deck, `${light.id}: no roofStack mesh`).toBeDefined();
      const attr = deck!.geometry.getAttribute('color');
      expect(attr, `${light.id}: the deck has no vertex colours`).toBeDefined();
      const peak = [0, 1, 2].map((c) =>
        Math.max(...Array.from({ length: attr.count }, (_, i) => attr.getComponent(i, c))),
      );
      // `Color.set(hex)` decodes sRGB → linear, which is the space the buffer is
      // in, so the expectation is built the same way rather than by hand.
      const want = new Color(light.roofDeckHex);
      expect(peak[0]!, `${light.id} deck r`).toBeCloseTo(want.r, 6);
      expect(peak[1]!, `${light.id} deck g`).toBeCloseTo(want.g, 6);
      expect(peak[2]!, `${light.id} deck b`).toBeCloseTo(want.b, 6);
    }
    // …and the two rows are genuinely different, which is the content of the
    // column. A table that set them equal would satisfy everything above.
    expect(DAYLIGHT.night.roofDeckHex).not.toBe(DAYLIGHT.day.roofDeckHex);
  });

  it('is DATA, not a branch: a roofless park gets no roof geometry anywhere', () => {
    const roof = roofOf(ALPINE_HEIGHTS);
    expect(ALPINE_HEIGHTS.roofPeakFt).toBe(0);
    expect(roof.group.children).toHaveLength(0);
    for (let b = -180; b < 180; b += 5) expect(roof.sample(b)).toBeNull();
  });
});
