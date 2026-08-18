// The playing surface — and this file exists because of a defect the VISUAL
// GATE DID NOT CATCH.
//
// ⚠ THE WHOLE FIELD RENDERED FACE-DOWN AND ALL FIFTEEN SCENES PASSED. The mown
// turf is an unshared-vertex grid; its first winding put every triangle's normal
// at −y, so a `FrontSide` material drew nothing and every camera photographed
// the grey concrete apron underneath it. The harness checks draw calls,
// triangles, fence distances read back out of the vertex buffer, the tracer
// against the sim, the reveal and the framing — and none of those is "is the
// grass visible". A human comparing PNGs found it in one glance, which is
// exactly the class of thing a human should not be the only guard against.
//
// So: the ground surfaces are asserted to FACE UP, from their own built
// geometry, and the infield's shape is asserted from the same buffers.
//
// MUTATIONS WATCHED TO FAIL (each reverted):
//   1. `mownGrass`'s winding reversed (the original defect)        → 2 fail
//   2. the turf clipped at the foul lines (foul ground back to
//      grey concourse, the `wide` shot's car park)                 → 1 fail
//   3. the infield drawn as a solid fan again (no grass cutouts)   → 2 fail
//   4. the warning track's inner ring set to the wall (no track)   → 1 fail
//   5. `mat(daylight.apronHex)` back to a literal 0x63625d — the
//      SHIPPED defect, the concourse OUTSIDE the bowl rendering at
//      four times the seating inside it                            → 1 fail
//      (the apron-wiring test below. `daylight.test.ts` still passes
//      in full, which is `roof.test.ts`'s reason for existing applied
//      to the ground: a table can be right and unreachable.)

import { describe, expect, it } from 'vitest';
import { Scene } from 'three';
import type { BufferGeometry, Mesh, MeshLambertMaterial } from 'three';
import { ALPINE_HEIGHTS, fenceAt, FOUL_LINE_DEG, HARBOURFRONT } from '../../../lib/baseball/parks';
import type { Park } from '../../../lib/baseball/parks';
import { infieldDepthFt } from '../../../lib/baseball/fielding';
import { buildField } from './field';
import { bearingOf } from './geom';
import type { StadiumCtx } from './geom';
import { pickStadiumQuality } from './quality';
import { DAYLIGHT } from './daylight';

/**
 * The session seed the scene is built with here. FIXED — `StadiumCtx.seed`
 * exists so the tower's LED programme can differ per session, and a test that
 * fed it a clock would be the one thing the whole determinism chapter forbids.
 */
const TEST_SEED = 20260816;

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

function build(park: Park, light = DAYLIGHT.day) {
  const owned: Array<{ dispose(): void }> = [];
  const ctx: StadiumCtx = {
    scene: new Scene(),
    track: (<T extends { dispose(): void }>(r: T) => {
      owned.push(r);
      return r;
    }) as StadiumCtx['track'],
    park,
    seed: TEST_SEED,
    daylight: light,
    // The DEFAULT tier, because `fenceStepDeg` decides how finely the turf and
    // the dirt arc are sampled and the shipping tier is the one to measure.
    quality: pickStadiumQuality({
      capabilities: { isWebGL2: true, maxTextureSize: 8192, precision: 'highp' },
    } as never),
  };
  const part = buildField(ctx);
  const byName = new Map<string, Mesh>();
  part.group.traverse((o) => {
    if ((o as Mesh).isMesh) byName.set(o.name, o as Mesh);
  });
  return { part, byName, owned };
}

/** Every vertex of a mesh as (bearingDeg, radiusFt, y). */
function polar(geo: BufferGeometry): Array<{ b: number; r: number; y: number }> {
  const p = geo.getAttribute('position');
  const out: Array<{ b: number; r: number; y: number }> = [];
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    out.push({ b: bearingOf(x, z), r: Math.hypot(x, z), y: p.getY(i) });
  }
  return out;
}

describe('the ground faces UP', () => {
  it('every ground surface normal points at the sky', () => {
    // ⚠ THE ONE ASSERTION THAT WOULD HAVE CAUGHT THE DEFECT. It is written over
    // ALL the ground meshes rather than over the grass alone, because the same
    // mistake is available in every one of them and none of the others has a
    // test either.
    const { byName, owned } = build(HARBOURFRONT);
    const rows: string[] = [];
    for (const name of ['apron', 'grass', 'warningTrack', 'infieldDirt']) {
      const mesh = byName.get(name);
      expect(mesh, `${name} was not built`).toBeTruthy();
      const n = mesh!.geometry.getAttribute('normal');
      let worst = 1;
      for (let i = 0; i < n.count; i++) worst = Math.min(worst, n.getY(i));
      rows.push(`  ${name.padEnd(13)} ${n.count} verts, worst normal.y ${worst.toFixed(4)}`);
      // A degenerate cell (the turf grid clips its rows to the wall, so the
      // ones past it collapse) has a zero-length normal, which reads 0 — that
      // is fine; what must never happen is a NEGATIVE y.
      expect(worst, `${name} is facing down`).toBeGreaterThanOrEqual(-1e-6);
    }
    log(`\n[GROUND NORMALS — the check that would have caught a face-down field]\n${rows.join('\n')}\n`);
    for (const r of owned) r.dispose();
  });
});

describe('the turf', () => {
  it('covers FOUL ground too, out to the foot of the stands', () => {
    // Foul territory used to be the concrete apron showing through, which in
    // the `wide` shot read as a car park between the lines and the seats.
    const { byName, owned } = build(HARBOURFRONT);
    const pts = polar(byName.get('grass')!.geometry);
    const maxAbsBearing = Math.max(...pts.map((p) => Math.abs(p.b)));
    expect(maxAbsBearing).toBeGreaterThan(FOUL_LINE_DEG + 40);
    // …and behind the plate it stops at the BACKSTOP, not somewhere invented:
    // the deepest turf at |β| > 150° is the park's own backstop distance.
    const behind = pts.filter((p) => Math.abs(p.b) > 150);
    expect(Math.max(...behind.map((p) => p.r))).toBeCloseTo(HARBOURFRONT.backstopFt, 1);
    for (const r of owned) r.dispose();
  });

  it('ends at the wall less the warning track, in FAIR territory, park by park', () => {
    for (const park of [HARBOURFRONT, ALPINE_HEIGHTS]) {
      const { byName, owned } = build(park);
      const grass = polar(byName.get('grass')!.geometry).filter(
        (p) => Math.abs(p.b) < FOUL_LINE_DEG - 1,
      );
      const trackPts = polar(byName.get('warningTrack')!.geometry);
      // At dead centre the turf stops 15 ft short of the wall and the track
      // fills exactly that band — read out of two independent buffers.
      const near0 = (a: Array<{ b: number; r: number }>) =>
        a.filter((p) => Math.abs(p.b) < 0.8).map((p) => p.r);
      const wall = fenceAt(park, 0).distFt;
      expect(Math.max(...near0(grass))).toBeCloseTo(wall - 15, 0);
      expect(Math.max(...near0(trackPts))).toBeCloseTo(wall, 0);
      expect(Math.min(...near0(trackPts))).toBeCloseTo(wall - 15, 0);
      for (const r of owned) r.dispose();
    }
  });
});

describe('the skinned infield', () => {
  it('is an ANNULUS with grass inside the base paths, not a solid fan', () => {
    // The M1 gate blamed the batter's-eye "dirt lot" on the arc RADIUS and was
    // wrong: at that camera's 23.2° horizontal FOV the arc moves by ≤2.2 ft.
    // The cause was that the infield was one solid fan with no grass in it.
    const { byName, owned } = build(HARBOURFRONT);
    const dirt = polar(byName.get('infieldDirt')!.geometry);
    const fair = dirt.filter((p) => Math.abs(p.b) < FOUL_LINE_DEG - 1);

    // The OUTER edge is `fielding.ts`'s own arc — the same function the fielder
    // model asks "did this land on the dirt". Asserted at EVERY outer vertex
    // against the arc evaluated at THAT vertex's own bearing, rather than at a
    // handful of round numbers: the sampling step is 0.5°, so a vertex "near
    // −40°" is up to 0.5 ft off the arc AT −40° while being exactly on the arc
    // where it actually sits. The first version of this line compared the two
    // and failed on the sampling residual, which is a test bug and not a
    // geometry one.
    // 123 ft separates the two rings at every fair bearing: the annulus's INNER
    // edge (the base paths, inset) peaks at 119.3 ft dead centre and its outer
    // edge bottoms out at 127.6 ft on the line.
    let worstArc = 0;
    let outerCount = 0;
    for (const p of fair.filter((q) => q.r > 123)) {
      outerCount++;
      worstArc = Math.max(worstArc, Math.abs(p.r - infieldDepthFt(p.b)));
    }
    expect(outerCount, 'no outer-edge vertices were measured').toBeGreaterThan(50);
    expect(worstArc, 'the dirt edge is not fielding.ts’s arc').toBeLessThan(1e-3);

    // …and there is a HOLE in it, which is the whole point. The annulus's INNER
    // edge is the base-path diamond inset by 8 ft, so at a given bearing the
    // nearest dirt vertex outside the home-plate circle sits there and NOT at
    // the plate. A solid fan has no inner ring at all: its nearest vertex
    // outside the circle is on the ARC, 155.5 ft out at dead centre against the
    // annulus's 119.3 — so this one number separates the two shapes.
    //
    // ⚠ A VERTEX COUNT CANNOT DO THIS, and the first version of this assertion
    // tried. "No dirt vertices between 20 and 100 ft" is false for the real
    // geometry (the inner ring dips to 82 ft near the foul lines) and ALSO true
    // of a solid fan, which has an apex and a rim and nothing in between.
    const diamond = (b: number) =>
      (90 * Math.SQRT2) /
      (Math.cos((Math.abs(b) * Math.PI) / 180) + Math.sin((Math.abs(b) * Math.PI) / 180));
    for (const b of [0, 20, 40]) {
      const near = fair.filter((p) => Math.abs(Math.abs(p.b) - b) < 0.6 && p.r > 15).map((p) => p.r);
      expect(near.length, `nothing sampled at ${b}°`).toBeGreaterThan(0);
      expect(Math.min(...near), `inner edge at ${b}°`).toBeCloseTo(diamond(b) - 8, 0);
    }
    // The two pieces that DO exist: the plate circle and the annulus.
    expect(fair.some((p) => p.r <= 13.01)).toBe(true);
    expect(fair.some((p) => p.r > 123)).toBe(true);

    // Roughly how much turf that put back, against the ~7,000 ft² of a real
    // infield's ~15,800 that is grass. Reported, not asserted to a tolerance —
    // the shape is a design decision, the ORDER is the claim.
    const inner = (b: number) => Math.max(13, (90 * Math.SQRT2) / (Math.cos((Math.abs(b) * Math.PI) / 180) + Math.sin((Math.abs(b) * Math.PI) / 180)) - 8);
    let skin = 0;
    let all = 0;
    for (let b = -45; b < 45; b += 0.25) {
      const d = (0.25 * Math.PI) / 180 / 2;
      all += d * infieldDepthFt(b) ** 2;
      skin += d * (infieldDepthFt(b) ** 2 - inner(b) ** 2);
    }
    log(
      `\n[INFIELD] inside the 95 ft arc: ${all.toFixed(0)} ft² of fair ground, of which ` +
        `${skin.toFixed(0)} ft² is skin and ${(all - skin).toFixed(0)} ft² is grass ` +
        `(${((100 * (all - skin)) / all).toFixed(0)} %)\n`,
    );
    expect(all - skin).toBeGreaterThan(4000);
    for (const r of owned) r.dispose();
  });
});

/**
 * ⚠ THE APRON'S COLOUR IS A LIGHTING ROW, AND NOTHING ELSE COULD SEE IT.
 * `daylight.test.ts` can say what `apronHex` RENDERS at in both rows; it cannot
 * say whether the mesh was handed that column or a literal, and the defect it
 * was added for is exactly the literal. Same argument, same shape and same file
 * split as `roof.test.ts`'s deck-wiring test one surface up.
 */
describe('the concourse takes its colour from the lighting row', () => {
  it('the apron material is `daylight.apronHex`, on BOTH rows', () => {
    for (const light of [DAYLIGHT.day, DAYLIGHT.night]) {
      const { byName, owned } = build(HARBOURFRONT, light);
      const apron = byName.get('apron');
      expect(apron, `${light.id}: no apron mesh`).toBeDefined();
      expect((apron!.material as MeshLambertMaterial).color.getHex(), `${light.id} apron`).toBe(
        light.apronHex,
      );
      for (const r of owned) r.dispose();
    }
    // …and the two rows are genuinely different values, which is the whole
    // content of the column. A table that set them equal would satisfy every
    // assertion above and still ship the inversion.
    expect(DAYLIGHT.night.apronHex).not.toBe(DAYLIGHT.day.apronHex);
  });
});
