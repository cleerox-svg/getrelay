// The seating bowl — and the one thing that makes a bowl read as a BUILDING.
//
// ⚠ IT IS A BANDING PROBLEM, NOT A TEXTURE PROBLEM. Until this pass the bowl was
// one lofted rake in flat neutral grey, and the visual gate's verdict on the
// 0.8 s follow swoop was that a featureless slab sweeping a third of the frame
// reads as motion sickness rather than as broadcast. What fixes that is not seat
// detail — at 400 ft a seat is a fifth of a pixel — it is HORIZONTAL BANDING:
//
//     seats (deep navy, speckled)  ←  the decks
//     dark fascia                  ←  immediately below each ribbon
//     BRIGHT RIBBON-BOARD LED      ←  the primary depth cue, unlit/emissive
//     dark fascia                  ←  immediately above
//     seats …
//
// Two ribbons and four fascia edges do more than any amount of seat geometry,
// and they cost nothing: they are long thin quads on the same lofted rings the
// rake already used.
//
// ⚠ AND THE SEATS ARE NAVY, NOT GREY. A large part of why the old bowl read as
// CONCRETE is that it was neutral grey; real empty seating reads dark
// navy-charcoal and occupied rows read as a fine light speckle, never as
// individuals. So there is no crowd mesh here and there will not be one — the
// crowd is speckle in ONE procedurally-generated texture, which is also where
// the vomitory openings (the dark tunnel mouths that break the seating field up)
// live. Zero draw calls, zero instances, and `quality.seatTexturePx` gates it.
//
// ⚠ THE WHOLE BOWL IS THREE DRAW CALLS. Every band is lofted separately so its
// colour is crisp at the seam, then `mergeGeometries` concatenates them into one
// lit shell + one unlit ribbon strip, plus the skirt. Draw calls are the tight
// budget (~18 to spend across the entire art pass against a ceiling of 40);
// triangles are not. A band per material would have been nine.
//
// ⚠ THE BOWL'S INNER EDGE IS NOT IN THIS FILE. `stadium/bowlEdge.ts` derives it
// from park data — the wall in fair territory, the foul-ground offset curve
// outside it, clamped by the backstop. `field.ts` reads the same function, so
// the turf ends exactly where the seating starts.
//
// ⚠ THE ONLY RANDOMNESS IN THE SCENE LIVES HERE, and it is seeded. Per-section
// brightness on the seats, the ribbon's per-section colour and every speckle in
// the crowd texture come from `mulberry32(BOWL_SEED)` — the same three-free PRNG
// the sim uses, never `Math.random`. Two runs of the screenshot harness must
// produce byte-identical PNGs; one unseeded call anywhere in this file breaks
// that silently.

import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import {
  RECESS_EDGE_BEARINGS,
  RECESS_HALF_DEG,
  RECESS_STANDOFF_FT,
  RECESS_TOP_FT,
} from './centrefieldSpec';
import { buildCrowdTexture, FASCIA_V0, SECTIONS_PER_TILE } from './crowd';
import { bowlInnerRadiusFt, wallTopFt } from './bowlEdge';
import { loft, mergeGeometries, ring } from './geom';
import type { Ring, StadiumCtx, StadiumPart } from './geom';

/** Horizontal run of the seating rake, ft. SCENE-ONLY (no physics reads it). */
const DECK_DEPTH_FT = 130;

/** Height of the back of the rake above field level, ft. SCENE-ONLY. */
const DECK_TOP_FT = 130;

/** Clearance the deck keeps below a roof, ft. SCENE-ONLY. */
const ROOF_CLEARANCE_FT = 40;

/** Seat-section brightness jitter, ±fraction. SCENE-ONLY (a feel knob). */
const SECTION_JITTER = 0.1;

/**
 * Width of one seating section, ft, measured along the bowl's own front rail.
 *
 * ⚠ FEET, NOT DEGREES, AND THE DEGREES VERSION WAS WRONG. A 7.5° section is 8 ft
 * wide behind the plate (r ≈ 61) and 52 ft wide in centre field (r ≈ 400), so
 * the crowd texture came out stretched 2.5:1 vertically in the `pitcher` frame
 * and 2:1 horizontally in every outfield frame, off ONE square tile. Sections
 * are placed by cumulative ARC LENGTH instead, which is both what a real bowl
 * does and what keeps the tile square.
 */
const SECTION_WIDTH_FT = 30;

/** Fixed seed for every draw in this file. Determinism is the point — see header. */
const BOWL_SEED = 20260815;

/** How far behind the outfield wall the bowl skirt stands, ft. SCENE-ONLY. */
const SKIRT_BEHIND_FT = 1.5;

/**
 * Height of the padded lower wall on the skirt, ft. SCENE-ONLY.
 *
 * ⚠ THE SKIRT IS THE BACKSTOP, AND AT 60 ft IT IS A WALL THE PITCHER CAMERA
 * STARES STRAIGHT AT. One flat dark slab across the middle of that frame is the
 * same defect this whole file exists to fix, one surface further in — so the
 * skirt is two bands, padding below and concrete above, which costs no draw call
 * because they merge.
 */
const SKIRT_PAD_FT = 8;

/**
 * The bowl's cross-section, as DATA. `dr` is the horizontal run out from the
 * foot of the bowl and `y` the height above the field, both ft, both SCENE-ONLY.
 * `kind` is the band running from the PREVIOUS station to this one, so the first
 * row is the front rail and carries no band.
 *
 * ⚠ THE LAST ROW IS PINNED TO `DECK_DEPTH_FT` / `DECK_TOP_FT` ON PURPOSE. The
 * roof stack hangs on `outerRadiusFt` and the sun's shadow volume is sized from
 * it, so the profile may gain or lose rows freely as long as it ends where the
 * old single rake ended — otherwise an art edit silently re-frames the roof and
 * re-sizes a 1024² shadow map.
 */
type BandKind = 'seats' | 'fascia' | 'led';
const PROFILE: Array<{ dr: number; y: number; kind: BandKind }> = [
  { dr: 0, y: 0, kind: 'seats' }, // front rail — y comes from the wall top
  { dr: 42, y: 33, kind: 'seats' }, // lower deck
  { dr: 43.5, y: 37.2, kind: 'fascia' },
  { dr: 44.3, y: 40.6, kind: 'led' }, // ribbon board 1
  { dr: 45.8, y: 44.8, kind: 'fascia' },
  { dr: 88, y: 84, kind: 'seats' }, // upper deck
  { dr: 89.5, y: 88.2, kind: 'fascia' },
  { dr: 90.3, y: 91.6, kind: 'led' }, // ribbon board 2
  { dr: 91.8, y: 95.8, kind: 'fascia' },
  { dr: DECK_DEPTH_FT, y: DECK_TOP_FT, kind: 'seats' }, // top deck — see above
];

/**
 * ⚠ COLOURS ARE A SCHEME, NOT A MARK. Royal blue / red / white is a palette
 * (`ip.test.ts` says so explicitly), and "empty seating reads dark navy" is an
 * observation about how upholstered plastic photographs at 400 ft.
 */
const COLORS = {
  // ⚠ `seats` AND `fascia` MOVED TO `daylight.ts` AND THE DAY VALUES DID NOT
  // CHANGE. Both are read off the lighting row now, because at night the bowl is
  // read by BLUE LED LINES along each deck edge rather than by seat colour, and
  // because the crowd's contrast is inverted (bright points on dark) which needs
  // the seat colour raised. See `daylight.fasciaHex` / `seatsHex` / `crowdBase`.
  concrete: 0x767a82, // the skirt / backstop above the padding
  // ⚠ LIGHTER THAN A REAL PAD LOOKS, AND FOR A LIGHTING REASON. The backstop
  // faces the ONE sun's back (StadiumGL puts the sun behind home so it lights
  // the outfield wall the batter is looking at), so this surface is carried
  // entirely by the hemisphere fill at roughly half weight. A true pad colour of
  // 0x1b3b2c rendered as pure black across the middle of the `pitcher` frame —
  // measured, on the render. Anything facing the plate has to be authored a
  // stop or two brighter than it should look.
  pad: 0x40705a, // the padded lower wall a ball comes off
};

/**
 * ⚠ WHERE THE TEXTURE'S OWN SEAM FALLS AROUND THE BOWL, in SECTIONS.
 *
 * The running `u` is normalised so it ends on a whole number of TILES, which
 * keeps the tile from being cut short at bearing ±180. That is necessary and it
 * was not sufficient: the aisle stripe lives at the LEADING EDGE of each
 * section, so a `u` starting at 0 puts an aisle exactly at ±180 — directly
 * behind the plate, dead centre of the `pitcher` frame, where the visual gate
 * measured it as a 6 px dark stripe at luminance 9.3–12.0 against the bowl's
 * 23.1. Offsetting the whole run by a fraction of a section puts the seam in
 * plain seating; a whole number of tiles PLUS a constant phase is still a whole
 * number of tiles, so the wrap stays exact.
 *
 * 0.8 is the middle of the wider quiet zone: `crowd.ts` draws the aisle over
 * section-u [0, 0.0104] and the vomitory over [0.425, 0.575], so [0.60, 0.99]
 * is the larger of the two gaps and 0.8 is its centre.
 */
const U_PHASE_SECTIONS = 0.8;

/** The ribbon board's per-section palette, weighted white-ish. SCENE-ONLY. */
const RIBBON = [0xeef3ff, 0xeef3ff, 0xeef3ff, 0xdfe8ff, 0xffbe5c, 0x4d86ff];

export interface StandsPart extends StadiumPart {
  /** Inner edge of the bowl at a bearing, ft. */
  innerRadiusFt(bearingDeg: number): number;
  /** Outer edge of the bowl at a bearing, ft. */
  outerRadiusFt(bearingDeg: number): number;
  /** Height of the back of the rake, ft. */
  deckTopFt: number;
  /**
   * The RIBBON BOARDS as one mesh, for a slice that wants to drive them.
   *
   * ⚠ THE CONTRACT IS EXACTLY ONE SENTENCE: **`u` runs 0 → 1 once around the
   * ring.** Nothing here sets `wrapS`, `repeat` or `offset` — those belong to
   * whoever attaches a map, and setting them here would silently halve or
   * double a caller's texel density. Both ribbon bands carry that same `u`, so
   * a partial arc added later (outfield wall boards at field level, say) must
   * cover the SAME FRACTION of the ring or the two will not match.
   *
   * ⚠ AND DO NOT EXPECT THE DEEPEST RIBBON TO CARRY TEXT. Measured by the board
   * slice against the SHIPPED 20° batter lens: this band's real height is
   * ~3.5 ft, which sets ~2.4 ft of glyph and reaches a 10 px legibility floor at
   * ~470 ft. The band runs out to ~530 ft in centre field, so out there it is
   * LIGHT — which is what a home-run sweep wants anyway, because light reads at
   * any distance. The bands down the lines and behind the plate are the ones
   * near enough to carry a readable count. (An earlier version of this note said
   * 326 ft; that was derived from a 40° camera that no longer exists.)
   */
  ribbon: Mesh;
  /**
   * The ribbon band's own SLANT height, ft — measured off `PROFILE`, never
   * typed. A ribbon texture's glyph size is a fraction of this, so a hand-set
   * number here would set the type on the wrong scale the moment the rake is
   * re-shaped by a foot.
   */
  ribbonHeightFt: number;
  /**
   * The ribbon ring's own CIRCUMFERENCE, ft, summed off the drawn ring.
   *
   * ⚠ NOT `2πr` OF ANYTHING. This bowl is not a circle — its inner edge runs
   * from ~60 ft behind the plate to ~530 ft in centre — so there is no radius
   * that describes it, and the tile count a ribbon texture needs is a property
   * of ARC LENGTH. `board.ts` divides this by 2π to hand `boardAtlas`'s
   * `BoardGeometry` an equivalent radius, which is the one place the two
   * vocabularies meet.
   */
  ribbonRingFt: number;
}

export function buildStands({ scene, track, park, quality, daylight }: StadiumCtx): StandsPart {
  const group = new Group();
  group.name = 'stands';

  const deckTopFt =
    park.roofPeakFt > 0 ? Math.min(DECK_TOP_FT, park.roofPeakFt - ROOF_CLEARANCE_FT) : DECK_TOP_FT;
  // The profile is authored against DECK_TOP_FT; a low roof squeezes it.
  const yScale = deckTopFt / DECK_TOP_FT;
  const innerRadiusFt = (b: number) => bowlInnerRadiusFt(park, b);
  // The bowl stands `SKIRT_BEHIND_FT` behind its inner edge so that in fair
  // territory it sits BEHIND the outfield wall instead of z-fighting with it.
  const footRadiusFt = (b: number) => innerRadiusFt(b) + SKIRT_BEHIND_FT;
  const outerRadiusFt = (b: number) => footRadiusFt(b) + DECK_DEPTH_FT;

  const step = quality.bowlStepDeg;
  // ⚠ THE CENTRE-FIELD RECESS. Inside `RECESS_HALF_DEG` of dead centre the deck
  // carries no seating at all: the board's structural surround occupies the
  // wedge, so the whole profile is pushed OUT past the back of that structure
  // and LIFTED above it, which collapses every band there to zero area. Seats
  // behind an opaque 130 ft building are triangles nobody can ever see, and a
  // board slice that lands later must not have to draw over live geometry.
  // The two edge bearings are force-sampled (`RECESS_EDGE_BEARINGS`) so the
  // wedge's side walls are vertical at every quality tier rather than landing
  // wherever `bowlStepDeg` happened to fall — up to 22 ft out at 430 ft.
  const cuts = park.surroundings === 'city' && deckTopFt >= RECESS_TOP_FT;
  const cutAt = (b: number) => cuts && Math.abs(b) < RECESS_HALF_DEG;
  /** Every station in the wedge collapses onto ONE point — behind and above. */
  const CUT = { r: RECESS_STANDOFF_FT, y: RECESS_TOP_FT };
  const rings: Ring[] = PROFILE.map((st, i) =>
    ring(
      -180,
      180,
      step,
      (b) =>
        cutAt(b)
          ? CUT
          : {
              r: footRadiusFt(b) + st.dr,
              y: i === 0 ? wallTopFt(park, b) : st.y * yScale,
            },
      RECESS_EDGE_BEARINGS,
    ),
  );
  const count = (rings[0]?.length ?? 0) / 3;

  // ⚠ SECTIONS ARE LAID OUT BY ARC LENGTH ALONG THE FRONT RAIL, NOT BY ANGLE —
  // see `SECTION_WIDTH_FT`. The running length is normalised so that `u` ends on
  // a whole number of TEXTURE TILES: a fractional last tile would put a visible
  // discontinuity at bearing ±180, which is directly behind the plate and
  // therefore in the middle of the `pitcher` frame. `SECTIONS_PER_TILE` is why
  // the rounding is to a multiple and not to an integer — one tile now carries
  // four sections so their vomitories can differ (see `crowd.ts`).
  const rail = rings[0] ?? [];
  const arc: number[] = [0];
  for (let i = 1; i < count; i++) {
    const dx = (rail[i * 3] ?? 0) - (rail[(i - 1) * 3] ?? 0);
    const dz = (rail[i * 3 + 2] ?? 0) - (rail[(i - 1) * 3 + 2] ?? 0);
    arc.push((arc[i - 1] ?? 0) + Math.hypot(dx, dz));
  }
  const total = arc[count - 1] || 1;
  const tiles = Math.max(2, Math.round(total / (SECTION_WIDTH_FT * SECTIONS_PER_TILE)));
  const sections = tiles * SECTIONS_PER_TILE;
  // ⚠ `u` IS IN TILES, NOT IN SECTIONS, AND THE FIRST DRAFT CONFUSED THE TWO. A
  // texture wraps every 1.0 of `u`, and one canvas is now `SECTIONS_PER_TILE`
  // sections wide — so handing it a `u` measured in SECTIONS squeezed the whole
  // four-section canvas into every single section, i.e. four aisles and four
  // vomitories where there should be one of each. It rendered as a plausible
  // bowl (that is the trap) with a residual 2 px line at the seam, and it was
  // the SEAM that gave it away rather than the density.
  const uOf = arc.map((s) => (s / total) * tiles + U_PHASE_SECTIONS / SECTIONS_PER_TILE);
  // The RIBBON's own `u`: 0 → 1 once around the ring, and nothing else. See
  // `StandsPart.ribbon` — this is a published contract, not an internal detail.
  const uRibbon = arc.map((s) => s / total);
  const sectionOf = (i: number) =>
    Math.min(sections - 1, Math.max(0, Math.floor(((arc[i] ?? 0) / total) * sections)));

  const rng = mulberry32(BOWL_SEED);
  const shade = Array.from({ length: sections }, () => 1 + (rng() * 2 - 1) * SECTION_JITTER);
  const ribbonHue = Array.from(
    { length: sections },
    () => RIBBON[Math.floor(rng() * RIBBON.length)] ?? RIBBON[0] ?? 0xffffff,
  );

  /**
   * ⚠ THROUGH `Color`, NOT BY UNPACKING THE HEX BYTES. A vertex-colour attribute
   * is consumed in the renderer's LINEAR working space, while a hex literal is
   * sRGB. Dividing the bytes by 255 hands three an sRGB number as if it were
   * linear, which brightens 0x8b (0.545 sRGB ≈ 0.25 linear) by more than a
   * factor of two — the first render of this scene came out a blown-out white
   * cone for exactly that reason. `Color` applies the conversion.
   */
  const scratch = new Color();
  const bandColors = (hex: number | ((section: number) => number), jitter: boolean) => {
    const arr = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
      const s = sectionOf(i);
      scratch.set(typeof hex === 'number' ? hex : hex(s));
      const k = jitter ? (shade[s] ?? 1) : 1;
      for (const v of [i, count + i]) {
        arr[v * 3] = scratch.r * k;
        arr[v * 3 + 1] = scratch.g * k;
        arr[v * 3 + 2] = scratch.b * k;
      }
    }
    return arr;
  };

  const lit: BufferGeometry[] = [];
  const emissive: BufferGeometry[] = [];
  for (let i = 1; i < PROFILE.length; i++) {
    const a = rings[i - 1];
    const b = rings[i];
    const kind = PROFILE[i]?.kind ?? 'seats';
    if (!a || !b) continue;
    if (kind === 'led') {
      emissive.push(
        loft(a, b, {
          colors: bandColors((s) => ribbonHue[s] ?? 0xffffff, false),
          // `v` spans the band's own height, `u` the whole ring. Both bands get
          // the same mapping, so one material can drive both.
          uv: { v0: 0, v1: 1, u: uRibbon },
        }),
      );
    } else if (kind === 'fascia') {
      // Sampling the texture's white lane — see `crowd.ts`. A band without UVs
      // would drop the map off the whole merged shell.
      lit.push(
        loft(a, b, {
          colors: bandColors(daylight.fasciaHex, false),
          uv: { v0: 0.98, v1: 0.98, u: uOf },
        }),
      );
    } else {
      // Seating: UVs so the crowd texture tiles once per SECTION, front row at
      // the rail (v = 0) to the back of the deck.
      lit.push(
        loft(a, b, {
          colors: bandColors(daylight.seatsHex, true),
          uv: { v0: 0, v1: FASCIA_V0, u: uOf },
        }),
      );
    }
  }

  const shellGeo = track(mergeGeometries(lit));
  for (const g of lit) g.dispose();
  const crowd = buildCrowdTexture(quality.seatTexturePx, rng, daylight);
  if (crowd) track(crowd);
  const shell = new Mesh(
    shellGeo,
    track(
      new MeshLambertMaterial({
        vertexColors: true,
        side: DoubleSide,
        ...(crowd ? { map: crowd } : {}),
      }),
    ),
  );
  shell.name = 'seatingRake';
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // ⚠ THE RIBBON IS UNLIT, AND THAT IS THE WHOLE POINT OF IT BEING A SECOND
  // DRAW CALL. A ribbon board emits; a Lambert band lit by the same sun as the
  // seats beside it is just a slightly different grey and reads as nothing.
  // `MeshBasicMaterial` costs one extra call and buys the only self-lit surface
  // in the park — and it is what will carry a night game without a second scene.
  const ribbonGeo = track(mergeGeometries(emissive));
  for (const g of emissive) g.dispose();
  const ribbon = new Mesh(
    ribbonGeo,
    track(new MeshBasicMaterial({ vertexColors: true, side: DoubleSide })),
  );
  ribbon.name = 'ribbonBoards';
  group.add(ribbon);

  // A skirt from field level up to the front of the rake, so the bowl reads as
  // solid from inside the park rather than as a floating ribbon. Behind the
  // lines this IS the backstop and the side walls; in fair territory it hides
  // behind the outfield wall.
  // ⚠ THE SAME `RECESS_EDGE_BEARINGS` AS THE RAKE, AND IT IS NOT OPTIONAL. `loft`
  // pairs rings COLUMN BY COLUMN over `Math.min(a.length, b.length)`, so a skirt
  // sampled without the two extra bearings would have a different column count
  // from the front rail and every quad would connect the wrong pair — silently,
  // and with the tail simply dropped.
  const foot = ring(
    -180,
    180,
    step,
    (b) => (cutAt(b) ? CUT : { r: footRadiusFt(b), y: 0 }),
    RECESS_EDGE_BEARINGS,
  );
  const front = rings[0];
  if (front) {
    // Two bands: padding to `SKIRT_PAD_FT`, concrete from there to the rail —
    // clamped so a park whose wall is lower than the padding still builds.
    const padTop = ring(
      -180,
      180,
      step,
      (b) =>
        cutAt(b)
          ? CUT
          : { r: footRadiusFt(b), y: Math.min(SKIRT_PAD_FT, wallTopFt(park, b)) },
      RECESS_EDGE_BEARINGS,
    );
    const flat = (hex: number) => {
      const arr = new Float32Array(count * 2 * 3);
      scratch.set(hex);
      for (let v = 0; v < count * 2; v++) {
        arr[v * 3] = scratch.r;
        arr[v * 3 + 1] = scratch.g;
        arr[v * 3 + 2] = scratch.b;
      }
      return arr;
    };
    const pad = loft(foot, padTop, { colors: flat(COLORS.pad) });
    const upper = loft(padTop, front, { colors: flat(COLORS.concrete) });
    const skirtGeo = track(mergeGeometries([pad, upper]));
    pad.dispose();
    upper.dispose();
    const skirt = new Mesh(
      skirtGeo,
      track(new MeshLambertMaterial({ vertexColors: true, side: DoubleSide })),
    );
    skirt.name = 'bowlSkirt';
    skirt.receiveShadow = true;
    group.add(skirt);
  }

  scene.add(group);

  // The ribbon's own metrics, MEASURED off the profile and the drawn ring.
  // `PROFILE`'s first `led` row is the band; its slant height is the rise and
  // run between that station and the one below it, which is what a texture
  // mapped `v` 0 → 1 across the band is actually stretched over.
  const ledIdx = PROFILE.findIndex((p) => p.kind === 'led');
  const ledA = PROFILE[ledIdx - 1];
  const ledB = PROFILE[ledIdx];
  const ribbonHeightFt =
    ledA && ledB ? Math.hypot(ledB.dr - ledA.dr, (ledB.y - ledA.y) * yScale) : 1;
  const ledRing = rings[ledIdx] ?? rings[0] ?? [];
  let ribbonRingFt = 0;
  for (let i = 3; i < ledRing.length; i += 3) {
    ribbonRingFt += Math.hypot(
      (ledRing[i] ?? 0) - (ledRing[i - 3] ?? 0),
      (ledRing[i + 2] ?? 0) - (ledRing[i - 1] ?? 0),
    );
  }

  return {
    group,
    innerRadiusFt,
    outerRadiusFt,
    deckTopFt,
    ribbon,
    ribbonHeightFt,
    ribbonRingFt: ribbonRingFt || 1,
  };
}
