// The city outside the bowl — and the one thing about it that is not taste.
//
// ⚠ THE SKYLINE IS DATA, NOT A BRANCH, and this test is the mechanical guard on
// that. `roof.ts` has always obeyed the rule (a roofless park gets no roof
// geometry, and the Alpine screenshot proves it by having open sky); the
// skyline's first version did not, and put a 790 ft downtown communications
// tower on a mountain park at 5,200 ft. The visual gate CAN see that — it is a
// grey slab in a photograph — but only if a human is looking at the right shot,
// and "content is data" deserves an assertion rather than an eye.
//
// MUTATIONS WATCHED TO FAIL (each reverted):
//   1. `if (park.surroundings !== 'city') return { group }` deleted   → 2 fail
//   2. the tower's three shells dropped from the merge                → 1 fail

import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import type { BufferGeometry, Mesh } from 'three';
import { ALPINE_HEIGHTS, HARBOURFRONT } from '../../../lib/baseball/parks';
import type { Park } from '../../../lib/baseball/parks';
import { buildSkyline } from './skyline';
import type { StadiumCtx } from './geom';
import { pickStadiumQuality } from './quality';
import { DAYLIGHT } from './daylight';

/**
 * The session seed the scene is built with here. FIXED — `StadiumCtx.seed`
 * exists so the tower's LED programme can differ per session, and a test that
 * fed it a clock would be the one thing the whole determinism chapter forbids.
 */
const TEST_SEED = 20260816;

/**
 * The minimum a `(scene, track) => handle` builder needs. `pickStadiumQuality`
 * is called with a stub renderer whose capabilities force the low tier, which
 * is fine: `buildSkyline` reads no quality knob, and asserting that by handing
 * it the cheapest tier is stronger than handing it the default.
 */
function ctxFor(park: Park): { ctx: StadiumCtx; owned: Array<{ dispose(): void }> } {
  const owned: Array<{ dispose(): void }> = [];
  const quality = pickStadiumQuality(
    { capabilities: { isWebGL2: false, maxTextureSize: 2048, precision: 'mediump' } } as never,
  );
  return {
    ctx: {
      scene: new Scene(),
      track: (<T extends { dispose(): void }>(r: T) => {
        owned.push(r);
        return r;
      }) as StadiumCtx['track'],
      park,
      quality,
      seed: TEST_SEED,
      daylight: DAYLIGHT.day,
    },
    owned,
  };
}

describe('the skyline is park DATA', () => {
  it('a downtown park gets a city; a mountain park gets nothing at all', () => {
    // Guard the guard: the two parks must actually differ on the field, or this
    // test passes on a builder that ignores it.
    expect(HARBOURFRONT.surroundings).toBe('city');
    expect(ALPINE_HEIGHTS.surroundings).toBe('none');

    const city = ctxFor(HARBOURFRONT);
    const cityPart = buildSkyline(city.ctx);
    // TWO meshes: the whole city in one, and the tower's LED strips in the
    // other. Still the draw-call budget asserted rather than intended — a box
    // per building would be seventeen, and a strip per band fifteen more.
    //
    // ⚠ THE STRIPS ARE A SECOND CALL AND CANNOT BE THE FIRST. They are unlit
    // (`MeshBasicMaterial`) and the city is Lambert, and the whole reason the
    // strips exist is that an unlit surface is exactly as bright at midnight as
    // at noon — which is what carries the night mode with no extra lights. One
    // material cannot be both.
    expect(cityPart.group.children.length).toBe(2);
    // city geometry + city material, strip geometry + strip material. The chase
    // map is `null` with no DOM (this suite runs in node), which is the same
    // fallback `buildWindowTexture` takes and why the count is 4 and not 5.
    expect(city.owned.length).toBe(4);

    const alp = ctxFor(ALPINE_HEIGHTS);
    const alpPart = buildSkyline(alp.ctx);
    expect(alpPart.group.children.length).toBe(0);
    // …and it allocates NOTHING, so a park without a city pays nothing for one.
    expect(alp.owned.length).toBe(0);

    for (const r of city.owned) r.dispose();
  });

  it('the tower is in the mesh, and it is the tallest thing in it', () => {
    // The tower is the landmark the whole module exists for, and it is merged
    // in with sixteen boxes — so "the skyline rendered" does not imply "the
    // tower rendered". Read the merged bounding box back: the buildings top out
    // at 440 ft by construction and the tower's profile ends at 790.
    const { ctx, owned } = ctxFor(HARBOURFRONT);
    const part = buildSkyline(ctx);
    const mesh = part.group.children[0] as Mesh;
    const geo = mesh.geometry as BufferGeometry;
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    expect(box.max.y).toBeGreaterThan(700);
    expect(box.min.y).toBeCloseTo(0, 3); // everything stands ON the ground (float32)

    // ⚠ AND THE TOWER IS A TOWER, NOT JUST A TALL THING. `max.y > 700` alone
    // dies only if ALL THREE of its shells go; dropping the base shell leaves
    // the pod and the mast at the same height and passes — measured, as a
    // surviving mutation. So find the mast tip, then require the same vertical
    // axis to carry geometry all the way to the GROUND (the shaft) and to bulge
    // past the shaft's width two thirds of the way up (the pod).
    const p = geo.getAttribute('position');
    let tipI = 0;
    for (let i = 1; i < p.count; i++) if (p.getY(i) > p.getY(tipI)) tipI = i;
    const ax = p.getX(tipI);
    const az = p.getZ(tipI);
    // ⚠ 70 ft, NOT 200. The tower's widest ring is its 52 ft base and its pod
    // is 47, so 70 contains the whole silhouette — while 200 also swept up a
    // neighbouring high-rise, whose own footing at y = 0 satisfied the "reaches
    // the ground" clause and let a mutation that DELETED the tower's base shell
    // pass. Measured, as a surviving mutation, and this is the repair.
    const onAxis = (i: number) => Math.hypot(p.getX(i) - ax, p.getZ(i) - az) < 70;
    let lowest = Infinity;
    let podWidest = 0;
    for (let i = 0; i < p.count; i++) {
      if (!onAxis(i)) continue;
      lowest = Math.min(lowest, p.getY(i));
      if (p.getY(i) > 590 && p.getY(i) < 670) {
        podWidest = Math.max(podWidest, Math.hypot(p.getX(i) - ax, p.getZ(i) - az));
      }
    }
    expect(lowest, 'the tower shaft does not reach the ground').toBeLessThan(1);
    expect(podWidest, 'the observation pod is missing').toBeGreaterThan(30);
    // Well outside the bowl (outer radius ~531 ft) and inside the 6,000 ft far
    // plane, so nothing here can intersect the park or vanish at the horizon.
    expect(Math.hypot(box.max.x, box.max.z)).toBeGreaterThan(600);
    expect(Math.hypot(box.max.x, box.max.z)).toBeLessThan(4000);
    for (const r of owned) r.dispose();
  });
});
