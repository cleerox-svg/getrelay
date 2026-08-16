// The roof — a RING at `park.roofPeakFt`, not a closed dome.
//
// ⚠ THE HEIGHT IS THE POINT AND THE HEIGHT IS DATA. `roofPeakFt` is a real
// mechanic: `resolveFence` rules a ball that reaches it `'roof'`, so it can
// never be a home run. BASEBALL.md measures that it essentially never bites — a
// 125 mph ball at a home-run launch angle apexes 200.3 ft against a 282 ft
// ceiling — which is exactly why the scene has to show how high 282 ft is. A
// player who cannot see the ceiling cannot understand why the one pop-up a
// season that reaches it is not a home run.
//
// ⚠ AND A PARK WITH NO ROOF GETS NO GEOMETRY. `Alpine Heights` has
// `roof: 'none'` and `roofPeakFt: 0`; this builder returns an empty group for
// it. That is the "content is data, not a branch" rule doing its job — the
// alpine screenshot proves it by having open sky where Harbourfront has a ring.

import { DoubleSide, Group, Mesh, MeshLambertMaterial } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import { loft, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import type { StandsPart } from './stands';

/** Depth of the roof's inner lip, ft. SCENE-ONLY: it makes the height READ. */
const LIP_DROP_FT = 14;

/** How far in from the top of the bowl the roof reaches, ft. SCENE-ONLY. */
const ROOF_BAND_FT = 120;

/** Minimum band width so the ring never inverts, ft. SCENE-ONLY. */
const MIN_BAND_FT = 5;

const COLORS = { deck: 0x6e747f, lip: 0x4c515a };

export function buildRoof(
  { scene, track, park, quality }: StadiumCtx,
  stands: StandsPart,
): StadiumPart {
  const group = new Group();
  group.name = 'roof';
  scene.add(group);

  // Data, not a branch: no roof in the park ⇒ no roof in the scene.
  if (!(park.roofPeakFt > 0)) return { group };

  const step = quality.bowlStepDeg;
  const y = park.roofPeakFt;

  // ⚠ THE RING HANGS ON THE TOP OF THE BOWL AND NEVER REACHES THE INFIELD, and
  // the first render is why. Following the bowl's INNER edge put roof panels at
  // 282 ft directly over home plate — geometrically defensible (the bowl's inner
  // edge behind home is `foulTerritoryFt`, 28 ft) and useless, because it hid
  // the field from every elevated camera and made the `wide` shot a photograph
  // of a lid. The inner edge is therefore the OUTFIELD WALL (`fenceAt`, clamped
  // outside the foul lines, so a park's own dimensions still set it), pulled no
  // further in than `ROOF_BAND_FT` from the top of the bowl and never past it.
  // The result is widest over the outfield seats and a thin rim behind home —
  // which is both what a retractable roof's parked panels look like and what
  // leaves a 400 ft opening for a ball to be watched through.
  const outerR = (b: number) => stands.outerRadiusFt(b);
  const innerR = (b: number) => {
    const o = outerR(b);
    const wall = fenceAt(park, Math.max(-FOUL_LINE_DEG, Math.min(FOUL_LINE_DEG, b))).distFt;
    return Math.min(o - MIN_BAND_FT, Math.max(wall, o - ROOF_BAND_FT));
  };

  const inner = ring(-180, 180, step, (b) => ({ r: innerR(b), y }));
  const outer = ring(-180, 180, step, (b) => ({ r: outerR(b), y }));
  const lip = ring(-180, 180, step, (b) => ({ r: innerR(b), y: y - LIP_DROP_FT }));

  const deck = new Mesh(
    track(loft(inner, outer)),
    track(new MeshLambertMaterial({ color: COLORS.deck, side: DoubleSide })),
  );
  deck.name = 'roofRing';
  deck.castShadow = true;
  group.add(deck);

  const fascia = new Mesh(
    track(loft(lip, inner)),
    track(new MeshLambertMaterial({ color: COLORS.lip, side: DoubleSide })),
  );
  fascia.name = 'roofLip';
  group.add(fascia);

  return { group };
}
