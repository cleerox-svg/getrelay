// THE PEOPLE — and the three properties that make them worth drawing.
//
//   1. The defence stands where `fielders.ALIGNMENT` says it stands. Proved by
//      MUTATING `ALIGNMENT` and watching the drawn figure follow, not by
//      comparing against a second copy of the same numbers.
//   2. A figure is 6.00 ft, from the same constant `stadium/scale.ts`'s magenta
//      measuring stick is built from — read back out of BOTH drawn geometries.
//   3. Nothing behind the plate occludes the strike zone from the `batter`
//      camera. Raycast from the real camera pose against the real merged mesh,
//      with a POSITIVE control (a ray aimed AT the catcher must hit) so the test
//      cannot pass by raycasting nothing.
//
// MUTATIONS WATCHED TO FAIL (each reverted, 18 tests in the suite):
//    1. `ALIGNMENT` snapshotted into a module-level `FROZEN` copy      → 1 fail
//       (the coupling test, and ONLY it — which is the point)
//    2. the catcher moved onto the centre line                        → 2 fail
//    3. the umpire moved onto the centre line                         → 2 fail
//    4. the pitcher placed 4 ft beside the mound at ground level      → 3 fail
//    5. `crownFt` reported from the wrong pose                        → 2 fail
//    6. a second Mesh added — the merge undone                        → 1 fail
//    7. `segmentsFor` ignoring the tier                               → 1 fail
//    8. `scale.ts`'s box built from a literal 5.5 ft                  → 1 fail
//    9. stature moved to 1.524 m                                      → 2 fail
//   10. the dirt/grass test widened so outfielders stand on clay      → 1 fail
//   11. the builder reporting eleven spots and drawing NOTHING        → 6 fail
//       (including the POSITIVE CONTROL, which is what it is for)
//
// ⚠ ONE MUTANT SURVIVED FIRST TIME AND IS RECORDED BECAUSE IT DID. A copy of
// `ALIGNMENT` taken INSIDE `figurePlacements()` passed all 18 — correctly, since
// a copy taken per call still reads the live array. Mutant 1 above is the real
// version of that defect; the first attempt was a bad mutant, not a weak test,
// and knowing which is why it is written down.

import { describe, expect, it } from 'vitest';
import { Raycaster, Scene, Vector3 } from 'three';
import type { BufferGeometry, Mesh } from 'three';
import { HARBOURFRONT } from '../../../lib/baseball/parks';
import { ALIGNMENT } from '../../../lib/baseball/fielders';
import { RULE_ZONE, RUBBER_D_FT } from '../../../lib/baseball/zone';
import { CAMERAS } from './camera';
import { DAYLIGHT } from './daylight';
import { buildFigures, FIGURE_STATURE_FT, figurePlacements, poseCrownUnits } from './figures';
import type { FiguresPart } from './figures';
import { at } from './geom';
import type { StadiumCtx } from './geom';
import { MOUND_HEIGHT_FT } from './mound';
import { pickStadiumQuality, isStadiumTier } from './quality';
import type { StadiumTier } from './quality';
import { buildScaleReference } from './scale';

const TEST_SEED = 20260816;

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

function ctxFor(tier: StadiumTier | null): { ctx: StadiumCtx; owned: Array<{ dispose(): void }> } {
  const owned: Array<{ dispose(): void }> = [];
  const quality = pickStadiumQuality(
    { capabilities: { isWebGL2: true, maxTextureSize: 8192, precision: 'highp' } } as never,
    tier,
  );
  return {
    owned,
    ctx: {
      scene: new Scene(),
      track: (<T extends { dispose(): void }>(r: T) => {
        owned.push(r);
        return r;
      }) as StadiumCtx['track'],
      park: HARBOURFRONT,
      seed: TEST_SEED,
      daylight: DAYLIGHT.day,
      quality,
    },
  };
}

function build(tier: StadiumTier | null = null): { part: FiguresPart; ctx: StadiumCtx } {
  const { ctx } = ctxFor(tier);
  const part = buildFigures(ctx);
  ctx.scene.updateMatrixWorld(true);
  return { part, ctx };
}

const meshOf = (part: FiguresPart): Mesh => part.group.children[0] as Mesh;
const geoOf = (part: FiguresPart): BufferGeometry => meshOf(part).geometry;

describe('stadium figures — the eleven', () => {
  it('prints the placement table', () => {
    const { part } = build();
    log(
      `\n[FIGURES — ${part.figures.length} people, one mesh, ${part.triangles} triangles]\n` +
        '   id   pose      x_ft     z_ft     y_ft   yaw°   crown_ft  stature_ft\n' +
        part.figures
          .map(
            (f) =>
              `  ${f.id.padStart(3)}   ${f.pose.padEnd(7)}` +
              `${f.pos[0].toFixed(1).padStart(7)}  ${f.pos[2].toFixed(1).padStart(7)}` +
              `  ${f.pos[1].toFixed(2).padStart(6)}` +
              `  ${((f.yaw * 180) / Math.PI).toFixed(0).padStart(5)}` +
              `   ${f.crownFt.toFixed(2).padStart(7)}` +
              `     ${(poseCrownUnits(f.pose) * FIGURE_STATURE_FT).toFixed(2)}`,
          )
          .join('\n') +
        `\n\n  reference stature ${FIGURE_STATURE_FT.toFixed(4)} ft` +
        ` — every pose is a fraction of it, upright = 1.000\n`,
    );
    expect(part.figures.length).toBe(11);
  });

  it('has every defensive position, the batter and the umpire — and no duplicates', () => {
    const ids = build().part.figures.map((f) => f.id);
    expect([...ids].sort()).toEqual(
      ['1B', '2B', '3B', 'B', 'C', 'CF', 'LF', 'P', 'RF', 'SS', 'UMP'].sort(),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the defence is drawn WHERE THE SIM FIELDS FROM', () => {
  it('every ALIGNMENT spot has a figure standing exactly on it', () => {
    const drawn = new Map(build().part.figures.map((f) => [f.id, f.pos]));
    for (const spot of ALIGNMENT) {
      const want = at(spot.bearingDeg, spot.distFt, 0);
      const got = drawn.get(spot.pos);
      expect(got, `no figure for ${spot.pos}`).toBeDefined();
      expect(got?.[0]).toBeCloseTo(want[0], 10);
      expect(got?.[2]).toBeCloseTo(want[2], 10);
    }
  });

  it('MOVES when ALIGNMENT moves — the coupling is live, not a copy', () => {
    // ⚠ THIS IS THE ONE ASSERTION IN THE FILE A HARD-CODED SET OF COORDINATES
    // COULD NOT PASS. Everything above compares the builder against ALIGNMENT's
    // values; only this compares it against ALIGNMENT's IDENTITY.
    const before = figurePlacements().find((f) => f.id === 'SS')?.pos ?? [0, 0, 0];
    const ss = ALIGNMENT.find((f) => f.pos === 'SS');
    if (!ss) throw new Error('no SS in ALIGNMENT');
    const original = { bearingDeg: ss.bearingDeg, distFt: ss.distFt };
    try {
      ss.distFt = original.distFt + 7;
      ss.bearingDeg = original.bearingDeg - 5;
      const after = figurePlacements().find((f) => f.id === 'SS')?.pos ?? [0, 0, 0];
      const want = at(ss.bearingDeg, ss.distFt, 0);
      expect(after[0]).toBeCloseTo(want[0], 10);
      expect(after[2]).toBeCloseTo(want[2], 10);
      const moved = Math.hypot(after[0] - before[0], after[2] - before[2]);
      expect(moved).toBeGreaterThan(7);
    } finally {
      ss.bearingDeg = original.bearingDeg;
      ss.distFt = original.distFt;
    }
    expect(figurePlacements().find((f) => f.id === 'SS')?.pos[0]).toBeCloseTo(before[0], 10);
  });

  it('stands the pitcher ON the rubber and on top of the mound', () => {
    const p = build().part.figures.find((f) => f.id === 'P');
    // Dead centre laterally, at RUBBER_D_FT, at the mound TABLE's height — not
    // beside the mound and not at ground level in a hole.
    expect(p?.pos[0]).toBe(0);
    expect(p?.pos[2]).toBeCloseTo(-RUBBER_D_FT, 10);
    expect(p?.pos[1]).toBe(MOUND_HEIGHT_FT);
  });

  it('faces every fielder at the plate', () => {
    for (const f of build().part.figures) {
      if (f.id === 'C' || f.id === 'UMP') continue;
      // The chest direction is (sin yaw, cos yaw); a fielder's must point from
      // where he stands back to the plate at the origin.
      const dx = -f.pos[0];
      const dz = -f.pos[2];
      const len = Math.hypot(dx, dz) || 1;
      expect(Math.sin(f.yaw)).toBeCloseTo(dx / len, 9);
      expect(Math.cos(f.yaw)).toBeCloseTo(dz / len, 9);
    }
  });

  it('puts the infield on the dirt and the outfield on the grass', () => {
    const y = new Map(build().part.figures.map((f) => [f.id, f.pos[1]]));
    // `field.ts`'s layer stack: grass 0.06, dirt 0.18. The five infielders that
    // are not the pitcher stand inside `infieldDepthFt`; the three outfielders
    // do not. Asserted as an ORDER, so the layer constants can move together.
    for (const id of ['1B', '2B', '3B', 'SS', 'C', 'B', 'UMP']) {
      expect(y.get(id), id).toBeGreaterThan(y.get('CF') ?? 99);
    }
    for (const id of ['LF', 'CF', 'RF']) expect(y.get(id), id).toBe(y.get('CF'));
  });
});

describe('scale — a person is 6 ft, and the measuring stick agrees', () => {
  it('is 1.83 m exactly, through one international foot', () => {
    expect(FIGURE_STATURE_FT).toBeCloseTo(1.83 / 0.3048, 12);
    // 1.83 m is 6 ft to two decimals and 6.0039 to four. The conversion is the
    // assertion; the round number is a coincidence of the brief's metric figure.
    expect(FIGURE_STATURE_FT).toBeCloseTo(6.003937007874016, 12);
  });

  it('the magenta reference box is built from the SAME stature', () => {
    // ⚠ READ OUT OF THE DRAWN GEOMETRY, not out of the constant. `scale.ts`
    // importing `FIGURE_STATURE_FT` is a fact about an import line; this is a
    // fact about the box in the picture.
    const { ctx } = ctxFor(null);
    const part = buildScaleReference(ctx);
    const box = part.group.children[0] as Mesh;
    box.geometry.computeBoundingBox();
    const bb = box.geometry.boundingBox;
    expect((bb?.max.y ?? 0) - (bb?.min.y ?? 0)).toBeCloseTo(FIGURE_STATURE_FT, 6);
  });

  it('every pose reaches a plausible fraction of stature, and none exceeds it', () => {
    const { part } = build();
    for (const f of part.figures) {
      const h = f.crownFt - f.pos[1];
      // A crouching catcher is short; nobody is TALLER than his own stature.
      expect(h, f.id).toBeLessThanOrEqual(FIGURE_STATURE_FT + 1e-9);
      expect(h, f.id).toBeGreaterThan(0.6 * FIGURE_STATURE_FT);
    }
    const batter = part.figures.find((f) => f.id === 'B');
    // The batter is the figure the visual gate reads against the 400 ft fence,
    // so his stance may not be a crouch: 5.8–6.0 ft to the crown.
    expect((batter?.crownFt ?? 0) - (batter?.pos[1] ?? 0)).toBeGreaterThan(5.8);
  });

  it('the DRAWN mesh reaches each figure’s reported crown, and no higher', () => {
    // Binds the reported numbers to the vertex buffer. A builder that reported a
    // crown it never drew would pass every test above this one.
    const { part } = build();
    const pos = geoOf(part).getAttribute('position');
    const tallest = new Map<string, number>();
    for (const f of part.figures) tallest.set(f.id, -Infinity);
    for (let i = 0; i < pos.count; i++) {
      let best = '';
      let bestD = Infinity;
      for (const f of part.figures) {
        const d = Math.hypot(pos.getX(i) - f.pos[0], pos.getZ(i) - f.pos[2]);
        if (d < bestD) {
          bestD = d;
          best = f.id;
        }
      }
      tallest.set(best, Math.max(tallest.get(best) ?? -Infinity, pos.getY(i)));
    }
    for (const f of part.figures) {
      const drawn = tallest.get(f.id) ?? 0;
      // The batter's BAT is above his crown by design; everyone else's tallest
      // vertex is the top of the head sphere.
      if (f.id === 'B') expect(drawn).toBeGreaterThan(f.crownFt);
      else expect(drawn, f.id).toBeCloseTo(f.crownFt, 6);
    }
  });
});

describe('the plate crew does not stand in front of the strike zone', () => {
  /** Every corner of the rule zone plus its centre, in scene ft at the plate. */
  const zoneTargets = (): Vector3[] => {
    const out: Vector3[] = [];
    for (const x of [RULE_ZONE.left, 0, RULE_ZONE.right]) {
      for (const h of [RULE_ZONE.bottom, (RULE_ZONE.bottom + RULE_ZONE.top) / 2, RULE_ZONE.top]) {
        out.push(new Vector3(x, h, 0));
      }
    }
    return out;
  };

  it('no figure blocks any sightline from the batter camera to the zone', () => {
    const { part } = build();
    const eye = new Vector3(...CAMERAS.batter.pos);
    const ray = new Raycaster();
    const blocked: string[] = [];
    for (const t of zoneTargets()) {
      const dir = t.clone().sub(eye);
      const dist = dir.length();
      ray.set(eye, dir.normalize());
      ray.far = dist;
      const hits = ray.intersectObject(meshOf(part), false);
      const first = hits[0];
      if (first) blocked.push(`(${t.x.toFixed(2)}, ${t.y.toFixed(2)}) at ${first.distance.toFixed(1)} ft`);
    }
    expect(blocked).toEqual([]);
  });

  it('POSITIVE CONTROL: a ray aimed at the catcher DOES hit', () => {
    // ⚠ WITHOUT THIS THE TEST ABOVE PASSES ON AN EMPTY SCENE, A MESH WITH NO
    // WORLD MATRIX, OR A RAYCASTER POINTED AT NOTHING. Two of the four guards
    // that survived a mutant in this repo failed exactly this way.
    const { part } = build();
    const catcher = part.figures.find((f) => f.id === 'C');
    if (!catcher) throw new Error('no catcher');
    const eye = new Vector3(...CAMERAS.batter.pos);
    // Aimed at mid-torso via the STATURE, not via `crownFt` — the control must
    // not depend on the same reported number the tests above are checking.
    const target = new Vector3(
      catcher.pos[0],
      catcher.pos[1] + 0.3 * FIGURE_STATURE_FT,
      catcher.pos[2],
    );
    const dir = target.clone().sub(eye);
    const ray = new Raycaster(eye, dir.clone().normalize(), 0, dir.length() + 2);
    expect(ray.intersectObject(meshOf(part), false).length).toBeGreaterThan(0);
  });

  it('keeps a stated lateral margin, so the clearance is not aspect-dependent', () => {
    // The sightline half-width at a depth `z` behind the plate is
    // `RULE_ZONE.right · (eyeZ − z) / eyeZ`; a figure's nearest body vertex must
    // be outside it. This is the number `PLATE_CREW`'s comment quotes.
    const { part } = build();
    const pos = geoOf(part).getAttribute('position');
    const eyeZ = CAMERAS.batter.pos[2];
    const margins = new Map<string, number>();
    for (const f of part.figures) margins.set(f.id, Infinity);
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z <= 0 || z >= eyeZ) continue;
      const half = RULE_ZONE.right * ((eyeZ - z) / eyeZ);
      let best = '';
      let bestD = Infinity;
      for (const f of part.figures) {
        const d = Math.hypot(pos.getX(i) - f.pos[0], z - f.pos[2]);
        if (d < bestD) {
          bestD = d;
          best = f.id;
        }
      }
      margins.set(best, Math.min(margins.get(best) ?? Infinity, Math.abs(pos.getX(i)) - half));
    }
    log(
      `\n[ZONE SIGHTLINE — from the batter camera at ` +
        `(${CAMERAS.batter.pos.join(', ')})]\n` +
        [...margins]
          .filter(([, m]) => Number.isFinite(m))
          .map(([id, m]) => `  ${id.padStart(3)}  nearest vertex clears the zone cone by ${m.toFixed(2)} ft`)
          .join('\n') +
        '\n',
    );
    for (const [id, m] of margins) {
      if (Number.isFinite(m)) expect(m, id).toBeGreaterThan(0.5);
    }
    // And the crew IS between the camera and the plate — otherwise the margin
    // above is measured over an empty half-space.
    expect(Number.isFinite(margins.get('C') ?? Infinity)).toBe(true);
    expect(Number.isFinite(margins.get('UMP') ?? Infinity)).toBe(true);
  });
});

describe('the GPU budget', () => {
  it('is ONE mesh, ONE material — one draw call for eleven people', () => {
    const { part } = build();
    const meshes = part.group.children.filter((c) => (c as Mesh).isMesh);
    expect(meshes.length).toBe(1);
    expect(Array.isArray(meshOf(part).material)).toBe(false);
    // Vertex colours, not eleven tinted materials.
    expect(geoOf(part).getAttribute('color')).toBeDefined();
  });

  it('costs a stated number of triangles at every tier, and NEVER loses a figure', () => {
    const rows = (['low', 'medium', 'high'] as const).map((tier) => {
      const { part } = build(tier);
      return { tier, tris: part.triangles, n: part.figures.length };
    });
    log(
      '\n[FIGURE COST — by tier]\n' +
        rows.map((r) => `  ${r.tier.padEnd(7)} ${String(r.tris).padStart(6)} tris   ${r.n} figures`).join('\n') +
        '\n',
    );
    // Monotone in tier, all eleven at every tier, and inside a budget stated as
    // a number: 8,000 is under 7 % of the harness's 120,000-triangle scene
    // ceiling for the entire population of the stadium.
    expect(rows.map((r) => r.n)).toEqual([11, 11, 11]);
    const [lo, med, hi] = rows.map((r) => r.tris);
    expect(lo ?? 0).toBeLessThan(med ?? 0);
    expect(med ?? 0).toBeLessThan(hi ?? 0);
    expect(hi ?? 0).toBeLessThan(8000);
    // `low` is a real saving, not a rounding: at least a third off.
    expect(lo ?? 0).toBeLessThan((med ?? 0) * 0.7);
  });

  it('is byte-identical between two builds with the same context', () => {
    const a = geoOf(build().part).getAttribute('position').array as Float32Array;
    const b = geoOf(build().part).getAttribute('position').array as Float32Array;
    expect(a.length).toBe(b.length);
    expect(Array.from(a.slice(0, 512))).toEqual(Array.from(b.slice(0, 512)));
    let same = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) same = false;
    expect(same).toBe(true);
  });

  it('honours the ?quality= override the tier probe exposes', () => {
    expect(isStadiumTier('low')).toBe(true);
    expect(build('low').part.figures.length).toBe(11);
  });
});
