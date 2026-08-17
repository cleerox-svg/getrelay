// The roof — the OPEN state, which is a STACK OF PARKED PANELS over centre
// field, not a symmetric ring.
//
// ⚠⚠ THE RING WAS THE BUG, AND IT WAS A MODEL ERROR RATHER THAN A LOOK ERROR.
// Every previous version of this file drew a band of even depth at every
// bearing: `innerR(b) = outer(b) − ROOF_BAND_FT`, swept −180 → +180. That is
// what a roof looks like when it is HALF closed everywhere at once, which is not
// a state a retractable roof has. A real retractable roof parks its moving
// panels by nesting them into a stack over ONE side of the building, and the
// owner's open-roof references say exactly where: *"You can see how the dome
// collapses behind the outfield. Then to the left and right you see the
// skyline."*
//
// So the open roof is:
//
//   • BEHIND CENTRE FIELD — a thick, layered mass. Several arcs nested, each
//     deeper and lower than the one above it, with the steps visible from
//     inside the bowl. It is DEEPER (250 ft against the ring's 120) and TALLER
//     (a 51 ft stack against a 15 ft plate-and-lip) than the closed roof was at
//     that bearing, because four panels are piled where one used to lie.
//   • TOWARD THE FOUL LINES — nothing at all. Open sky, which is where the city
//     shows through, and which is what `follow-pull` and `follow-oppo` look at.
//     Both of those frames used to carry a band of roof across the top where the
//     reference photographs have skyline.
//
// ⚠ AND THAT IS WHY THE BRIGHT BLUE LEADING EDGE READS AS ONE ARC. It is the
// edge of the STACK — the innermost, lowest panel's lip — not a rim running the
// whole way round. `daylight.roofEdgeHex` did not move; where it is drawn did.
//
// ⚠ THE HEIGHT IS STILL THE POINT AND STILL DATA. `roofPeakFt` is a real
// mechanic: `resolveFence` rules a ball that reaches it `'roof'` under a CLOSED
// roof, so it can never be a home run. The stack's TOP surface is at exactly
// `park.roofPeakFt` — the parked panels sit where the closed roof sat — which is
// what keeps the read-back below a measurement of a gameplay dimension rather
// than of an art choice.
//
// ⚠ AND A PARK WITH NO ROOF GETS NO GEOMETRY. `Alpine Heights` has
// `roof: 'none'` and `roofPeakFt: 0`; this builder returns an empty group for
// it. That is the "content is data, not a branch" rule doing its job — the
// alpine screenshot proves it by having open sky where the home park has a roof.
//
// ⚠ DELETED WITH THE RING (rule 10, delete on supersede): `ROOF_BAND_FT`,
// `MIN_BAND_FT` and `ROOF_SPLIT_DEG`. `MIN_BAND_FT` existed because a 5 ft ring
// degenerated behind the plate into a 2 px dark wire across the `wide` frame;
// there is no longer any roof behind the plate to degenerate. `ROOF_SPLIT_DEG`
// painted two darker columns where "a retractable roof's moving panels part" —
// the panels are now modelled, so a painted seam standing in for them is a
// second implementation of the same concept.

import { Color, DoubleSide, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { at, bearingOf, loft, mergeGeometries, quad, ring } from './geom';
import type { Ring, StadiumCtx, StadiumPart } from './geom';
import type { StandsPart } from './stands';

/**
 * THE PARKED STACK, AS DATA — one row per moving panel, outermost first.
 *
 * ⚠ SCENE-ONLY, EVERY COLUMN, and none of it is published. A retractable roof's
 * panel count, travel and parked depth are engineering data this repo does not
 * have; what IS observed, off the owner's photographs, is the SHAPE — a mass
 * behind centre field that is layered, that steps, and that stops well short of
 * the foul lines. These four rows are that shape written down, and the read-back
 * at the bottom of this file plus `checkRoof` in the screenshot harness assert
 * the shape rather than the rows.
 *
 *   `halfDeg`  how far either side of dead centre this panel reaches. It
 *              NARROWS down the stack, so the four leading edges are four
 *              nested arcs and the steps are visible from inside the bowl
 *              rather than hidden behind each other.
 *   `dropFt`   how far below `park.roofPeakFt` this panel's TOP surface sits.
 *              Row 0 is 0 — the top of the stack is the ceiling the physics
 *              enforces, and the read-back measures that.
 *   `depthFt`  radial run in from the top of the bowl. It GROWS down the stack,
 *              so the lowest panel reaches furthest over the field and its lip
 *              is the leading edge the celebration is composed against.
 *
 * ⚠⚠ THE OUTERMOST ROW'S `halfDeg` IS THE ONE NUMBER WITH A FRAMING CONSEQUENCE,
 * AND IT WAS MEASURED TWICE. The first version shipped 26°, on the argument that
 * the `flight` camera following a ball to a corner puts roof-plane bearings
 * −55°…−18° (pull) and +18°…+58° (oppo) across the top of frame, so anything
 * past ~26° puts roof back into the two shots this whole change exists to open
 * onto sky. That reasoning was right and INCOMPLETE, and the render said so: at
 * 26° the stack reaches camera-bearing 23.2° in the STATIC `flight` frame, the
 * landmark stands at 14.0°, and the roof's outer edge crosses that column at
 * 15.0° of elevation against the observation pod's 14.7° — so the collapse
 * that put the tower in frame horizontally **decapitated it vertically**. The
 * pod and the mast were behind the overhang; only the shaft showed.
 *
 * 11° is what clears it. The stack's right edge then reaches camera-bearing
 * 10.4° against the tower's left flank at 12.6° — 2.2° of open sky between
 * them, at every radius the panels occupy (the mapping from plate bearing to
 * camera bearing tightens as the radius falls, so the edge never swings out).
 * That is the owner's sentence made geometric: *"The tower is then seen in open
 * sky, not through a gap in a ring."*
 *
 * The depths came in with it so the mass stays a MASS rather than a finger: a
 * ±11° wedge running 250 ft deep is 204 ft across the back, 108 across the
 * front and 250 long, which is a parked stack in plan. At 26° with the old
 * 280 ft depths it was a fan; at 11° with those depths it would have been a
 * spike pointed at the plate.
 */
interface RoofPanel {
  halfDeg: number;
  dropFt: number;
  depthFt: number;
}
const STACK: readonly RoofPanel[] = [
  { halfDeg: 11, dropFt: 0, depthFt: 130 },
  { halfDeg: 9.5, dropFt: 11, depthFt: 170 },
  { halfDeg: 8, dropFt: 22, depthFt: 210 },
  { halfDeg: 6.5, dropFt: 33, depthFt: 250 },
];

/** Thickness of one panel slab, ft. SCENE-ONLY: it gives every step an edge. */
const PANEL_THICK_FT = 4;

/**
 * Drop of the LEADING panel's lip, ft. SCENE-ONLY.
 *
 * ⚠ THIS IS THE BUILDING'S NIGHT SIGNATURE AND IT IS ONE ARC, NOT A RING. See
 * `daylight.roofEdgeHex`: in every night photograph the leading edge of the
 * parked stack is a thick bright BLUE band, and it is the arc `homerun`,
 * `flight` and the three `follow-*` scenes compose the celebration against. Only
 * the innermost, lowest panel carries it — the ones above it show a plain
 * `PANEL_THICK_FT` step face instead, which is what makes the mass read as
 * stacked rather than as four blue rings.
 */
const LIP_DROP_FT = 14;

/**
 * Nearest the stack may reach the plate, ft. SCENE-ONLY, and it is a GUARD.
 *
 * `depthFt` is measured in from the top of the bowl, which in a shallow park
 * could put a panel over the infield — the defect the ring version hit when it
 * followed the bowl's inner edge and hung roof at 282 ft directly over home
 * plate, hiding the field from every elevated camera. Harbourfront's deepest
 * panel lands at 281 ft, so this never binds here; it binds for the next park.
 */
const MIN_INNER_FT = 200;

/**
 * How far the space frame hangs below each panel, ft. SCENE-ONLY.
 *
 * ⚠ NOT ZERO, AND NOT BECAUSE IT LOOKS BETTER. A lattice drawn IN the slab is
 * coplanar with it and z-fights; hung below it reads as structure from the
 * cameras that can see the underside at all. 3 ft under a 4 ft slab leaves 4 ft
 * of clear air above the next panel's top surface at an 11 ft step.
 */
const TRUSS_HANG_FT = 3;

/** Width of a truss member as drawn, ft. SCENE-ONLY. */
const TRUSS_MEMBER_FT = 2.2;

/** Panel-bay pitch on a deck's top surface, deg. SCENE-ONLY. */
const ROOF_PANEL_DEG = 7.5;

/**
 * ⚠ THE UNDERSIDE IS DARK, NOT BLACK, AND THE FIRST RENDER WAS BLACK. It faces
 * DOWN, so the only light reaching it is the hemisphere's GROUND colour at
 * roughly half weight — 0x2a2e36 under that is indistinguishable from 0x000000
 * and the roof read as a hole punched in the sky. These are the values that
 * survive being lit from one side only. The truss stays the darkest thing in
 * the group, because "picked out against the underside" is the whole effect.
 */
const COLORS = { deck: 0x969ba2, under: 0x6b727c };

/** What the read-back says about the drawn roof at one bearing. */
export interface RoofSample {
  /** Top of the stack, ft — `park.roofPeakFt` wherever the stack covers. */
  peakFt: number;
  /** Innermost and outermost radius of the whole mass at this bearing, ft. */
  innerFt: number;
  outerFt: number;
  /** How many panels cover this bearing. The stack's depth, as a count. */
  layers: number;
}

export interface RoofPart extends StadiumPart {
  /**
   * The drawn roof at a bearing, read back out of the built vertex buffer.
   * `null` where there is no roof — a park without one, and every bearing
   * outside the stack.
   *
   * ⚠ THIS IS THE OTHER HALF OF `fence.sample`, AND ITS ABSENCE WAS A HOLE THE
   * VISUAL GATE NAMED. The fence's distance AND height are measured out of the
   * drawn vertex buffer and differenced against `parks.ts`, so a wall drawn from
   * the five knots instead of the pchip shows up as a delta and a non-zero exit
   * code. The ROOF had no equivalent: the harness printed `roofPeak 282 ft`
   * straight out of `parks.ts`, i.e. it printed its own input.
   *
   * ⚠ AND IT NOW REPORTS A PROFILE, NOT A HEIGHT. The old shape could only say
   * "the roof is 282 ft up here", which every bearing answered identically —
   * so the check built on it asserted a measurable roof at all five bearings and
   * a correct collapse would have failed it BY DESIGN. `layers` and the band are
   * what let `checkRoof` assert the profile this file intends: deep behind
   * centre, absent at the lines, symmetric about dead centre — the same way
   * `fence.sample` asserts a VARYING wall rather than a constant one.
   */
  sample(bearingDeg: number): RoofSample | null;
}

export function buildRoof(
  { scene, track, park, quality, daylight }: StadiumCtx,
  stands: StandsPart,
): RoofPart {
  const group = new Group();
  group.name = 'roof';
  scene.add(group);

  // Data, not a branch: no roof in the park ⇒ no roof in the scene.
  if (!(park.roofPeakFt > 0)) return { group, sample: () => null };

  const step = quality.bowlStepDeg;
  const peak = park.roofPeakFt;
  // The stack sits on the top of the bowl, exactly as the ring did, so a park's
  // own dimensions still set where the roof begins.
  const outerR = (b: number) => stands.outerRadiusFt(b);

  const decks: BufferGeometry[] = [];
  const unders: BufferGeometry[] = [];
  const trusses: BufferGeometry[] = [];
  let lipGeo: BufferGeometry | null = null;
  /**
   * Where each panel's deck loft lands in the MERGED buffer, so `sampleStack`
   * can walk one panel at a time. `loft` writes its inner ring first and its
   * outer ring second, so a panel occupies `2 × count` vertices from `start`.
   */
  const spans: Array<{ start: number; count: number }> = [];
  let base = 0;

  // A plain index loop, not `forEach`: `lipGeo` is assigned in exactly one
  // iteration and read after the loop, and a callback body puts that assignment
  // outside the compiler's flow analysis.
  for (let i = 0; i < STACK.length; i++) {
    const panel = STACK[i]!;
    const y = peak - panel.dropFt;
    const low = y - PANEL_THICK_FT;
    const innerR = (b: number) => Math.max(MIN_INNER_FT, outerR(b) - panel.depthFt);
    const arc = (r: (b: number) => number, h: number): Ring =>
      ring(-panel.halfDeg, panel.halfDeg, step, (b) => ({ r: r(b), y: h }));
    const inner = arc(innerR, y);
    const outer = arc(outerR, y);
    const innerLow = arc(innerR, low);
    const outerLow = arc(outerR, low);
    const cols = inner.length / 3;

    // ⚠ TWO SINGLE-SIDED SHEETS PER PANEL, NOT ONE DOUBLE-SIDED ONE. A
    // `DoubleSide` slab shows the SAME colour from above and below; the whole
    // point is that the exterior is pale and the underside is dark, which is
    // what the reference photography is entirely about. The extra draw call is
    // paid once for the stack, not once per panel — everything merges.
    //
    // ⚠ AND THE TOP HAS PANEL LINES. Measured on the ring version: 0.06 levels
    // of detail over a 400×80 px patch of the roof's upper surface, i.e. the
    // 18-level range in it was ENTIRELY Lambert curvature. `deckColors` costs no
    // draw call and no triangle: it is a per-column vertex colour on a loft that
    // was already there, plus one step of tint per panel so the stack reads as
    // stacked from the only camera that sees the top (`wide`).
    decks.push(loft(inner, outer, { colors: deckColors(cols, i, panel.halfDeg) }));
    spans.push({ start: base, count: cols });
    base += cols * 2;

    unders.push(loft(outerLow, innerLow));
    // The step face at this panel's leading edge. The LOWEST panel gets the blue
    // lip instead — see `LIP_DROP_FT`.
    if (i < STACK.length - 1) unders.push(loft(innerLow, inner));
    else lipGeo = loft(arc(innerR, y - LIP_DROP_FT), inner);

    const truss = buildTruss(
      innerR,
      outerR,
      panel.halfDeg,
      low - TRUSS_HANG_FT,
      // Cells in proportion to the arc, so a member is the same physical size
      // under every panel rather than four times denser under the narrowest.
      Math.round((quality.trussCells * 2 * panel.halfDeg) / 360),
    );
    if (truss) trusses.push(truss);
  }

  const deckGeo = track(mergeGeometries(decks));
  for (const g of decks) g.dispose();
  const deck = new Mesh(
    deckGeo,
    track(new MeshLambertMaterial({ vertexColors: true, side: FrontSide })),
  );
  deck.name = 'roofStack';
  deck.castShadow = true;
  group.add(deck);

  // ⚠ THE UNDERSIDE AND THE TRUSS CARRY AN EMISSIVE AT NIGHT, AND IT IS NOT A
  // FLOURISH. Both face DOWN, so an overhead night rig reaches neither and the
  // whole roof renders black — which loses the element that frames the tower in
  // the one shot `homerun` and `flight` are composing. The alternative is a
  // second light pointing up, which the shadow budget refuses. See
  // `daylight.trussHex`.
  const underGeo = track(mergeGeometries(unders));
  for (const g of unders) g.dispose();
  const under = new Mesh(
    underGeo,
    track(
      new MeshLambertMaterial({
        color: COLORS.under,
        emissive: daylight.roofEmissiveHex,
        side: FrontSide,
      }),
    ),
  );
  under.name = 'roofUnderside';
  group.add(under);

  if (lipGeo) {
    const fascia = new Mesh(
      track(lipGeo),
      track(
        new MeshLambertMaterial({
          color: daylight.roofEdgeHex,
          emissive: daylight.roofEdgeEmissiveHex,
          side: DoubleSide,
        }),
      ),
    );
    fascia.name = 'roofLip';
    group.add(fascia);
  }

  if (trusses.length) {
    const trussGeo = track(mergeGeometries(trusses));
    for (const g of trusses) g.dispose();
    const mesh = new Mesh(
      trussGeo,
      track(
        new MeshLambertMaterial({
          color: daylight.trussHex,
          emissive: daylight.roofEmissiveHex,
          side: DoubleSide,
        }),
      ),
    );
    mesh.name = 'roofTruss';
    group.add(mesh);
  }

  return { group, sample: (deg) => sampleStack(deckGeo, spans, deg) };
}

/**
 * Read the stack back out of its own merged vertex buffer.
 *
 * Every panel is scanned; the ones whose arc brackets the bearing contribute a
 * layer, and the aggregate is the mass a player sees at that bearing — the
 * highest top surface, the innermost leading edge and the outermost back edge.
 * Heights and radii come from the buffer, never from `STACK`, which is what
 * makes this a measurement rather than an echo of the table above it.
 */
function sampleStack(
  geo: BufferGeometry,
  spans: Array<{ start: number; count: number }>,
  bearingDeg: number,
): RoofSample | null {
  const pos = geo.getAttribute('position');
  const radius = (i: number) => Math.hypot(pos.getX(i), pos.getZ(i));
  let peakFt = -Infinity;
  let innerFt = Infinity;
  let outerFt = -Infinity;
  let layers = 0;
  for (const s of spans) {
    for (let k = 0; k + 1 < s.count; k++) {
      const i = s.start + k;
      const b0 = bearingOf(pos.getX(i), pos.getZ(i));
      const b1 = bearingOf(pos.getX(i + 1), pos.getZ(i + 1));
      if (bearingDeg < Math.min(b0, b1) - 1e-9 || bearingDeg > Math.max(b0, b1) + 1e-9) continue;
      const t = b1 === b0 ? 0 : (bearingDeg - b0) / (b1 - b0);
      const lerp = (a: number, b: number) => a + (b - a) * t;
      const o = s.start + s.count + k;
      peakFt = Math.max(peakFt, lerp(pos.getY(i), pos.getY(i + 1)));
      innerFt = Math.min(innerFt, lerp(radius(i), radius(i + 1)));
      outerFt = Math.max(outerFt, lerp(radius(o), radius(o + 1)));
      layers++;
      break;
    }
  }
  return layers > 0 ? { peakFt, innerFt, outerFt, layers } : null;
}

/**
 * Per-column colours for one panel's TOP surface: alternating bays, and one
 * step of tint per panel so the stack reads as stacked from above.
 *
 * The `wide` camera is the only one that sees the top at all, and from 1000 ft
 * up four coplanar-looking arcs of identical grey are one arc. The step is
 * small — a parked stack is four of the same panel, not four different
 * buildings — and it is the shading, not the colour, that carries it.
 */
function deckColors(count: number, panelIndex: number, halfDeg: number): Float32Array {
  const arr = new Float32Array(count * 2 * 3);
  const c = new Color();
  const stack = 1 - panelIndex * 0.06;
  for (let i = 0; i < count; i++) {
    const b = -halfDeg + (2 * halfDeg * i) / (count - 1 || 1);
    const bay = Math.floor((b + 180) / ROOF_PANEL_DEG) % 2 === 0 ? 1 : 0.955;
    c.set(COLORS.deck).multiplyScalar(bay * stack);
    for (const v of [i, count + i]) {
      arr[v * 3] = c.r;
      arr[v * 3 + 1] = c.g;
      arr[v * 3 + 2] = c.b;
    }
  }
  return arr;
}

/**
 * The space frame under one panel, as flat ribbons: an inner chord, an outer
 * chord and a zigzag web that alternates inner→outer→inner between them. That
 * zigzag is what makes it read as TRIANGULATED rather than as a grid, and it is
 * the one thing the eye actually picks out of a dome underside.
 *
 * Every panel's frame merges into ONE geometry, so `cells` is free up to the
 * triangle ceiling and the whole stack costs exactly one draw call. `cells <= 0`
 * (the low tier) returns null and the panel is simply a dark plate — the cheap
 * tier loses detail, never structure.
 */
function buildTruss(
  innerR: (b: number) => number,
  outerR: (b: number) => number,
  halfDeg: number,
  y: number,
  cells: number,
): BufferGeometry | null {
  if (cells <= 0) return null;
  const parts: BufferGeometry[] = [];
  const w = TRUSS_MEMBER_FT / 2;
  // A ribbon between two (bearing, radius) points, widened along the radius so
  // it is visible from below whatever its direction. `quad` is the ground-plane
  // primitive and every member here is horizontal, so this is exactly it.
  const member = (b0: number, r0: number, b1: number, r1: number) => {
    const a = at(b0, r0, y);
    const c = at(b1, r1, y);
    const dx = c[0] - a[0];
    const dz = c[2] - a[2];
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * w;
    const nz = (dx / len) * w;
    parts.push(
      quad(
        [a[0] + nx, y, a[2] + nz],
        [c[0] + nx, y, c[2] + nz],
        [c[0] - nx, y, c[2] - nz],
        [a[0] - nx, y, a[2] - nz],
      ),
    );
  };
  for (let i = 0; i < cells; i++) {
    const b0 = -halfDeg + (2 * halfDeg * i) / cells;
    const b1 = -halfDeg + (2 * halfDeg * (i + 1)) / cells;
    member(b0, innerR(b0), b1, innerR(b1)); // inner chord
    member(b0, outerR(b0), b1, outerR(b1)); // outer chord
    // The web: alternate the diagonal's sense so consecutive cells share a
    // vertex and the pattern is a row of triangles rather than a row of Vs.
    if (i % 2 === 0) member(b0, innerR(b0), b1, outerR(b1));
    else member(b0, outerR(b0), b1, innerR(b1));
    // …plus the radial post that closes each triangle pair.
    member(b0, innerR(b0), b0, outerR(b0));
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}
