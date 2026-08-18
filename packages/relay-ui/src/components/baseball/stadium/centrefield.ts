// THE CENTRE-FIELD STRUCTURE — the architectural surround the board sits in.
//
// ⚠ THIS SLICE OWNS THE RECESS AND THEREFORE OWNS THE BOARD'S GEOMETRY, and the
// numbers live next door in `centrefieldSpec.ts` — `CENTREFIELD_BOARD` and
// NOTHING ELSE about the board: no panel mesh, no content, no material. That
// split is the same one `parks.ts` makes for the fence — one set of numbers,
// read by the thing that draws the hole and by the thing that fills it — and it
// exists so the opening a player sees and the board a player reads cannot drift
// apart by a foot.
//
// ⚠ AND NO BOARD IS MOUNTED HERE. The array (video panel, lineup column,
// pitcher panel, linescore strip) is `stadium/board.ts`, which takes
// `CENTREFIELD_BOARD` as its geometry and THROWS if that size at that range
// would put its smallest glyph under the legibility floor. What this file builds
// is everything AROUND it, from a reference photo of the real venue's
// centre-field elevation, a recess in the seating deck for the whole assembly to
// sit in, and the one dark surface the array's own panel gaps show through.
//
// WHAT THE REFERENCE SHOWS, from the field looking out, bottom to top:
//
//     plinth            dark base from the wall top to the frame
//     STRUCTURAL FRAME  the boards are RECESSED INTO it — its face stands
//                       proud of theirs, so the array reads as set into a
//                       building rather than bolted onto a flat wall
//     step-back soffit  the assembly gains depth as it rises
//     WINDOW BAND       several storeys of the hotel that overlooks the field.
//                       The single most recognisable element, and the reason
//                       this is a building and not a generic outfield wall.
//     BANNERS + FLAGS   a line of hanging pennants under the roof edge
//
// ⚠ IT IS BUILT ON RINGS, NOT ON FLAT PANELS, AND THAT IS NOT A STYLE CHOICE.
// The bowl is a ring; a 150 ft flat wall tangent to it at 434 ft has its corners
// at 440.4 ft, i.e. 6.4 ft BEHIND the ring, so a flat window band would be
// swallowed by the seating rake at its own ends. Following the ring keeps the
// whole assembly at one standoff from the deck. The sagitta over the full width
// is 7.3 ft, which is smaller than the step-back between two of its own layers.
//
// ⚠ DRAW CALLS: THREE. The window openings are TEXTURE, not geometry — one
// merged band with a seeded lit/unlit map, exactly the argument `skyline.ts`
// makes for its sixteen towers. The banners are one merged strip of
// vertex-coloured quads, not a quad each, and the two flags and both flagpoles
// merge into that same strip. Measured worst scene was 26 of a ceiling of 40
// before this; it is 29 after, and the ceiling did not move.
//
// ⚠ SEEDED, LIKE EVERY OTHER RANDOM NUMBER IN THE SCENE. Which hotel rooms have
// their lights on and what colour each banner is come from `mulberry32`, never
// `Math.random` — two harness runs must produce byte-identical PNGs.

import {
  Color,
  DoubleSide,
  FrontSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
} from 'three';
import type { BufferGeometry } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import {
  BANNER_R_FT,
  BANNER_TOP_FT,
  BOARD_CLEARANCE_FT,
  BUILDING_HALF_DEG,
  CENTREFIELD_BOARD,
  COLORS,
  FRAME_BOTTOM_FT,
  FRAME_HALF_DEG,
  FRAME_R_FT,
  FRAME_TOP_FT,
  MULLION_BEHIND_FT,
  MULLION_BLEED_FT,
  OPENING_HALF_DEG,
  PLINTH_TOP_FT,
  RECESS_BACK_R_FT,
  RECESS_HALF_DEG,
  RECESS_TOP_FT,
  WINDOW_BOTTOM_FT,
  WINDOW_R_FT,
  WINDOW_STOREYS,
  WINDOW_TOP_FT,
} from './centrefieldSpec';
import { loft, mergeGeometries, ring } from './geom';
import type { Ring, StadiumCtx, StadiumPart } from './geom';
import type { StandsPart } from './stands';
import { buildWindowTexture } from './windows';

/** Banner palette. SCENE-ONLY, weighted toward the park's royal blue / red / white. */
const BANNERS = [0x27408b, 0x27408b, 0xb32335, 0xe8eaf0, 0x27408b, 0xb32335];
const BANNER_COUNT = 13;
const BANNER_DROP_FT = 9;
const FLAG_DROP_FT = 6;

const SEED = 20260818;

/** A vertical band of the assembly: two rings at one radius, lofted. */
function slab(
  step: number,
  h0: number,
  h1: number,
  rFt: number,
  y0: number,
  y1: number,
  hex: number,
  extra?: readonly number[],
): BufferGeometry {
  const a = ring(h0, h1, step, () => ({ r: rFt, y: y0 }), extra);
  const b = ring(h0, h1, step, () => ({ r: rFt, y: y1 }), extra);
  return loft(a, b, { colors: flatColors(a.length / 3, hex) });
}

/** A horizontal ledge: one bearing span, two radii, at one height. */
function ledge(
  step: number,
  h0: number,
  h1: number,
  r0: number,
  r1: number,
  y: number,
  hex: number,
): BufferGeometry {
  const a = ring(h0, h1, step, () => ({ r: r0, y }));
  const b = ring(h0, h1, step, () => ({ r: r1, y }));
  return loft(a, b, { colors: flatColors(a.length / 3, hex) });
}

const scratch = new Color();
function flatColors(count: number, hex: number): Float32Array {
  const arr = new Float32Array(count * 2 * 3);
  scratch.set(hex);
  for (let v = 0; v < count * 2; v++) {
    arr[v * 3] = scratch.r;
    arr[v * 3 + 1] = scratch.g;
    arr[v * 3 + 2] = scratch.b;
  }
  return arr;
}

/** UVs that run 0…1 across the band and 0…1 up it — the window map's frame. */
function bandUV(count: number): { v0: number; v1: number; u: number[] } {
  return { v0: 0, v1: 1, u: Array.from({ length: count }, (_, i) => i / (count - 1 || 1)) };
}

/**
 * A FLAT vertical rectangle across dead centre — the one surface in this file
 * that is not built on a ring, and it is flat because the thing it backs is.
 *
 * `stadium/board.ts` builds the array as four flat quads at `faceDistFt`,
 * because a video board is flat and because the atlas's UV rects are a
 * rectangle. A curved backing behind a flat face crosses it (measured: 2.3 ft of
 * crossing at the board's own edge), so this follows the board rather than the
 * bowl. The sagitta it gives up is 2.9 ft over 100 ft at 430, which is less than
 * the step-back between two of this assembly's own layers.
 */
function boardBacking(
  halfWFt: number,
  y0: number,
  y1: number,
  distFt: number,
  hex: number,
): BufferGeometry {
  const a: Ring = [-halfWFt, y0, -distFt, halfWFt, y0, -distFt];
  const b: Ring = [-halfWFt, y1, -distFt, halfWFt, y1, -distFt];
  return loft(a, b, { colors: flatColors(2, hex) });
}

/** One flat quad standing at a bearing, hanging from `yTop` down `drop`. */
function hanging(
  bearingDeg: number,
  halfDeg: number,
  rFt: number,
  yTop: number,
  drop: number,
  hex: number,
): BufferGeometry {
  const a: Ring = [];
  const b: Ring = [];
  for (const s of [-1, 1]) {
    const t = ((bearingDeg + s * halfDeg) * Math.PI) / 180;
    a.push(rFt * Math.sin(t), yTop, -rFt * Math.cos(t));
    b.push(rFt * Math.sin(t), yTop - drop, -rFt * Math.cos(t));
  }
  return loft(a, b, { colors: flatColors(2, hex) });
}

export function buildCentrefield(
  { scene, track, park, quality }: StadiumCtx,
  stands: StandsPart,
): StadiumPart {
  const group = new Group();
  group.name = 'centrefield';
  scene.add(group);

  // Data, not a branch: only a park whose surroundings say `city` carries this
  // building, exactly as `skyline.ts` does. Alpine Heights is a mountain park.
  if (park.surroundings !== 'city') return { group };
  // …and only if the deck is actually tall enough to hold it. A park with a low
  // roof squeezes the bowl (`stands.ts`'s `yScale`), and a 130 ft assembly in a
  // 90 ft bowl would stand proud of the back of the seating.
  if (stands.deckTopFt < RECESS_TOP_FT) return { group };

  const step = quality.bowlStepDeg;
  const rng = mulberry32(SEED);
  const lit: BufferGeometry[] = [];

  // --- THE BACKING SHELL, and it is a bug fix rather than a layer of the
  // reference. `stands.ts` cuts the deck to `RECESS_HALF_DEG`, which is
  // deliberately a little WIDER than the building so the cut cannot clip the
  // structure — and that margin was daylight: measured on `homerun.png`, a pale
  // vertical strip of SKYLINE showing between the deck's cut edge and the
  // building's own edge, ~25 px wide and the full height of the assembly. One
  // slab spanning the whole cut, behind everything else, closes it. It is the
  // same class of hole as the bowl's own ±180 seam: a wedge removed from one
  // surface and not filled by the next.
  const SHELL_HALF_DEG = RECESS_HALF_DEG + 0.35;
  lit.push(
    slab(step, -SHELL_HALF_DEG, SHELL_HALF_DEG, RECESS_BACK_R_FT, 0, BANNER_TOP_FT, COLORS.plinth),
  );

  // --- the plinth: wall top to the foot of the frame, full building width.
  lit.push(slab(step, -BUILDING_HALF_DEG, BUILDING_HALF_DEG, FRAME_R_FT, 0, PLINTH_TOP_FT, COLORS.plinth));

  // --- the STRUCTURAL FRAME, as a picture frame: a bottom rail, a top rail and
  // two piers. The hole between them is where the array goes and is deliberately
  // empty — see the header.
  lit.push(
    slab(step, -FRAME_HALF_DEG, FRAME_HALF_DEG, FRAME_R_FT, PLINTH_TOP_FT, FRAME_BOTTOM_FT, COLORS.frame),
    slab(step, -FRAME_HALF_DEG, FRAME_HALF_DEG, FRAME_R_FT, CENTREFIELD_BOARD.sillFt + CENTREFIELD_BOARD.heightFt + BOARD_CLEARANCE_FT, FRAME_TOP_FT, COLORS.frame),
    slab(step, -FRAME_HALF_DEG, -OPENING_HALF_DEG, FRAME_R_FT, FRAME_BOTTOM_FT, FRAME_TOP_FT, COLORS.frame),
    slab(step, OPENING_HALF_DEG, FRAME_HALF_DEG, FRAME_R_FT, FRAME_BOTTOM_FT, FRAME_TOP_FT, COLORS.frame),
  );

  // --- THE REVEAL: the recess's own back wall and its four returns. Without
  // this the opening is a hole through the bowl to the sky, and a board slice
  // that has not landed yet would show as a window rather than as a dark recess.
  lit.push(
    slab(step, -OPENING_HALF_DEG, OPENING_HALF_DEG, RECESS_BACK_R_FT, FRAME_BOTTOM_FT, FRAME_TOP_FT, COLORS.reveal),
    ledge(step, -OPENING_HALF_DEG, OPENING_HALF_DEG, FRAME_R_FT, RECESS_BACK_R_FT, FRAME_BOTTOM_FT, COLORS.reveal),
    ledge(step, -OPENING_HALF_DEG, OPENING_HALF_DEG, FRAME_R_FT, RECESS_BACK_R_FT, FRAME_TOP_FT, COLORS.reveal),
  );

  // --- THE MULLION FIELD: ONE flat dark panel filling the whole board opening,
  // `MULLION_BEHIND_FT` behind the board plane.
  //
  // ⚠ IT IS THE COMPLEMENT OF THE PANELS, NOT A COPY OF THEIR GAPS, AND THAT IS
  // THE FIX FOR A REAL MISALIGNMENT. The first draft built five separate members
  // from a hand-copied panel table (`upperFt: 38 / gap 1 / linescore 11`) and
  // laid them on RINGS at the board's radius. Both halves were wrong:
  //
  //   • The atlas's real split is 1 / 29.5 / 1.5 / 17 / 1 from the TOP, so the
  //     horizontal member sat at 37–38 ft where the actual gap is at 44–45.5 —
  //     7 ft out, i.e. a dark bar across the middle of a lit panel and a gap
  //     with nothing behind it. The suite could not see it: no test compares a
  //     scene constant against `BOARD_PANEL_SPECS`.
  //   • A ring at 430.6 ft and a FLAT board face at 430 ft cross. At the board's
  //     own outer edge the ring stands 2.3 ft in FRONT of the panel corner, so
  //     the very members meant to hide behind the display would have overdrawn
  //     its edges.
  //
  // A single flat backing has neither failure mode by construction: whatever the
  // panel table says, the gaps between the quads are holes, and what shows
  // through a hole is this. It is also four slabs cheaper. The atlas deliberately
  // paints its own frame gaps `FRAME`-dark as well, so the two agree even at a
  // grazing angle where the parallax between the planes opens up.
  lit.push(
    boardBacking(
      CENTREFIELD_BOARD.widthFt / 2 + MULLION_BLEED_FT,
      CENTREFIELD_BOARD.sillFt - MULLION_BLEED_FT,
      CENTREFIELD_BOARD.sillFt + CENTREFIELD_BOARD.heightFt + MULLION_BLEED_FT,
      CENTREFIELD_BOARD.faceDistFt + MULLION_BEHIND_FT,
      COLORS.mullion,
    ),
  );

  // --- the step-back soffit between the frame's top and the window band.
  lit.push(
    ledge(step, -BUILDING_HALF_DEG, BUILDING_HALF_DEG, FRAME_R_FT, WINDOW_R_FT, FRAME_TOP_FT, COLORS.soffit),
    slab(step, -BUILDING_HALF_DEG, BUILDING_HALF_DEG, WINDOW_R_FT, FRAME_TOP_FT, WINDOW_BOTTOM_FT, COLORS.soffit),
    // …and the parapet above the windows, up to the banner line.
    slab(step, -BUILDING_HALF_DEG, BUILDING_HALF_DEG, WINDOW_R_FT, WINDOW_TOP_FT, BANNER_TOP_FT, COLORS.building),
  );

  const structureGeo = track(mergeGeometries(lit));
  for (const g of lit) g.dispose();
  const structure = new Mesh(
    structureGeo,
    track(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide })),
  );
  structure.name = 'centrefieldStructure';
  structure.castShadow = true;
  structure.receiveShadow = true;
  group.add(structure);

  // --- THE WINDOW BAND. One band, one map, one draw call.
  const winA = ring(-BUILDING_HALF_DEG, BUILDING_HALF_DEG, step, () => ({
    r: WINDOW_R_FT,
    y: WINDOW_BOTTOM_FT,
  }));
  const winB = ring(-BUILDING_HALF_DEG, BUILDING_HALF_DEG, step, () => ({
    r: WINDOW_R_FT,
    y: WINDOW_TOP_FT,
  }));
  // ⚠ THE HOTEL BAND: 40 rooms across, `WINDOW_STOREYS` up, ~42 % lit. One
  // texture, no geometry — see `windows.ts` for the arithmetic that decides it.
  const winTex = buildWindowTexture({
    px: quality.seatTexturePx * 4,
    cols: 40,
    rows: WINDOW_STOREYS,
    litFraction: 0.42,
    rng,
  });
  if (winTex) track(winTex);
  const windows = new Mesh(
    track(loft(winA, winB, { colors: flatColors(winA.length / 3, COLORS.building), uv: bandUV(winA.length / 3) })),
    track(
      new MeshLambertMaterial({
        vertexColors: true,
        side: FrontSide,
        ...(winTex ? { map: winTex } : {}),
      }),
    ),
  );
  windows.name = 'centrefieldWindows';
  windows.receiveShadow = true;
  group.add(windows);

  // --- BANNERS AND FLAGS, one merged unlit strip.
  //
  // ⚠ UNLIT (`MeshBasicMaterial`), like the ribbon boards, and for the same
  // reason: these hang under a soffit facing the plate, i.e. away from the one
  // sun, so a Lambert banner is a dark smudge. The ribbon's note has the
  // measurement.
  const cloth: BufferGeometry[] = [];
  const bannerHalf = (BUILDING_HALF_DEG * 0.82) / BANNER_COUNT;
  for (let i = 0; i < BANNER_COUNT; i++) {
    const b = -BUILDING_HALF_DEG * 0.86 + (2 * BUILDING_HALF_DEG * 0.86 * i) / (BANNER_COUNT - 1);
    const hex = BANNERS[Math.floor(rng() * BANNERS.length)] ?? BANNERS[0] ?? 0xffffff;
    cloth.push(hanging(b, bannerHalf, BANNER_R_FT, BANNER_TOP_FT - 1, BANNER_DROP_FT, hex));
  }
  // Two flags at the ends, on poles. The poles are thin vertical slabs merged
  // into the same strip — a flagpole nobody can resolve at 430 ft still has to
  // exist, or the flags float.
  for (const s of [-1, 1]) {
    const b = s * BUILDING_HALF_DEG * 0.95;
    const poleHalf = 0.12;
    cloth.push(
      hanging(b, poleHalf, BANNER_R_FT, BANNER_TOP_FT + 16, 16 + BANNER_DROP_FT, COLORS.pole),
      hanging(b + s * bannerHalf * 1.6, bannerHalf * 1.5, BANNER_R_FT, BANNER_TOP_FT + 14, FLAG_DROP_FT, s < 0 ? 0xb32335 : 0xe8eaf0),
    );
  }
  const bannerGeo = track(mergeGeometries(cloth));
  for (const g of cloth) g.dispose();
  const banners = new Mesh(
    bannerGeo,
    track(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide })),
  );
  banners.name = 'centrefieldBanners';
  group.add(banners);

  return { group };
}
