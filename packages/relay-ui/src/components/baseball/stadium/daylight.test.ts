// THE ROOF SOFFIT, IN THE ONLY UNITS THAT CAN ADJUDICATE IT: RENDERED LEVELS.
//
// ⚠⚠ WHY THIS FILE EXISTS. `daylight.ts` is a table of hexes, and a hex tells
// you nothing about what a surface RENDERS at. Every previous claim about the
// roof underside was made in hex space and every one of them was wrong in pixel
// space:
//
//   • `roof.ts` said `0x6b727c` was the value that "survives being lit from one
//     side only". It renders at luminance **14.07** against a 175 sky. The
//     visual gate called the frame "a hole punched in the sky", and it was
//     right — that is 5.5 % of the range.
//   • `daylight.ts` said the night truss reads as a "pale, brightly-lit
//     lattice". It rendered **0.8 levels** from the soffit it hangs under,
//     because ONE emissive column was wired to BOTH materials and it dominates
//     the diffuse term ~50:1. The pale `0x9aa3b0` was inert.
//
// Both defects are invisible to every other test in the suite — the geometry is
// correct, the draw calls are correct, the day/night pair is byte-identical —
// and both were found by a human looking at a PNG. This file is the mechanical
// version of that look.
//
// ⚠ THE MODEL BELOW IS A MODEL, AND IT IS VALIDATED, NOT ASSUMED. It is not a
// second renderer and must never grow into one: it solves exactly ONE FAMILY of
// case — an unshadowed Lambert surface whose normal is AXIS-ALIGNED, so the two
// lights reduce to constants. Straight DOWN (a soffit, a truss ribbon seen from
// below) takes 100 % of the hemisphere's GROUND colour and nothing at all from
// the single `DirectionalLight`; straight UP (the parked roof's exterior deck)
// takes the hemisphere's SKY colour plus `dot(N, L)` of the directional, where
// `L` is fixed by `sunPos − sunTarget`. Under that restriction the whole shading
// chain is five lines, and it is pinned against bytes read out of the shipped
// screenshots in the first test below.
//
// ⚠ THE UP-FACING CASE IS NEW, AND IT CAME IN WITH ITS OWN GOLDENS RATHER THAN
// ON ITS OWN AUTHORITY. It reproduces `daynight-day.png`'s and
// `daynight-night.png`'s roof deck EXACTLY, to the byte, alongside the three
// downward-facing surfaces that were already pinned — FIVE golden pixels off
// THREE shipped PNGs. A model that hits five golden pixels dead on is measuring
// the renderer.
//
// If `StadiumGL` ever changes tone mapping, exposure, colour space or the light
// rig, THIS FILE FAILS FIRST, at the golden-pixel test, which is the correct
// place for it to fail.
//
// MUTATIONS WATCHED TO FAIL (each reverted, counts as observed):
//   1. `day.roofEmissiveHex` back to 0x000000 — the shipped void      → 1 fail
//      (the DAY separation test, on its FLOOR)
//      ⚠ and NOT the no-clipping test, which was the guess. 14.07 is a
//      real value; "clipped" and "unreadable" are different defects and
//      it takes both assertions to cover them.
//   2. `night.trussEmissiveHex` = `night.roofEmissiveHex`, i.e. the
//      single shared emissive this change split                       → 2 fail
//      (the NIGHT lattice here, and the wiring test in `roof.test.ts`)
//   3. `day.trussEmissiveHex` back to 0x000000                        → 1 fail
//      (no-clipping: the truss returns to a literal 0,0,0)
//   4. `day.roofEmissiveHex` pushed to 0x8a929c — "brighter is safer"  → 1 fail
//      (the DAY separation test, on its CEILING — the soffit stops
//      being a dark mass against the sky)
//   5. `roof.ts`'s truss material rewired to `roofEmissiveHex`         → 1 fail
//      (`roof.test.ts` only — every assertion in THIS file still
//      passes, which is precisely why that test exists)
//   6. `night.roofDeckHex` back to 0x969ba2 — the SHIPPED defect, the
//      roof at 86 % of its own daytime luminance at night       → 2 fail
//      (the NIGHT dark-mass test here, and `roof.test.ts`'s
//      deck-wiring test on its "the two rows differ" leg)
//   7. `night.roofDeckHex` = 0x060b14, the EXACTLY derived
//      sky-only albedo — the rig removed rather than moved      → 2 fail
//      (the dark-mass test on its FLOOR, and no-clipping. Same
//      pairing as leg 1: "black" and "unreadable" are different
//      defects and it takes both assertions to cover them.)
//   8. `day.crowdPointGain` 1 → 0.99                            → 1 fail
//      (the exact-1 test. 1 is the identity that keeps the day
//      texture byte-identical, not "roughly full brightness".)
//   9. `night.crowdPointGain` 0.55 → 0.2, i.e. under `crowdBase` → 1 fail
//      (a "point" darker than the deck it sits on is not a point)
//
// See also `roof.test.ts`, which asserts the WIRING — that the truss material
// takes `trussEmissiveHex` and the underside takes `roofEmissiveHex`. Splitting
// the column and forgetting to rewire it would pass every test in this file.

import { describe, expect, it } from 'vitest';
import { DAYLIGHT } from './daylight';
import type { Daylight } from './daylight';
import { COLORS as ROOF_COLORS } from './roof';

/* ------------------------------------------------------------------ model */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
type RGB = [number, number, number];
const linOf = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map(
  (v) => toLinear(v / 255),
) as RGB;

/** three's `ACESFilmicToneMapping`, verbatim from `tonemapping_pars_fragment`. */
const ACES_IN = [0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566, 0.0284, 0.13383, 0.83777];
const ACES_OUT = [1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602];
const mul = (m: number[], v: RGB): RGB =>
  [0, 1, 2].map((r) => m[r * 3]! * v[0] + m[r * 3 + 1]! * v[1] + m[r * 3 + 2]! * v[2]) as RGB;
function aces(c: RGB): RGB {
  // `toneMappingExposure` is 1 — `StadiumGL`'s default and what the harness runs.
  let v = mul(ACES_IN, c.map((x) => x / 0.6) as RGB);
  v = v.map((x) => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.432951) + 0.238081)) as RGB;
  return mul(ACES_OUT, v).map(clamp01) as RGB;
}

/**
 * What one Lambert surface of the roof renders at, as sRGB bytes.
 *
 * `up` is the hemisphere weight `0.5·dot(N, ŷ) + 0.5`: **0** for a soffit or a
 * truss ribbon seen from below (normal straight down — no sun, pure ground
 * colour), **0.5** for a vertical step face or the leading-edge lip, **1** for
 * the parked stack's exterior deck.
 *
 * `sunlit` adds the one `DirectionalLight`. It is FALSE for every downward and
 * vertical surface here — three gives a Lambert surface `dot(N, L)` of the
 * directional and that is ≤ 0 for a soffit — and TRUE only for the deck, where
 * `dot((0,1,0), L̂)` is the light's own y over its length. That single term is
 * the whole of the night roof's inversion: the night row aims the rig nearly
 * straight down, so an up-facing surface 282 ft in the air catches MORE of it
 * than the day sun ever delivered.
 */
function renderPx(
  colorHex: number,
  emissiveHex: number,
  row: Daylight,
  up = 0,
  sunlit = false,
): RGB {
  const ground = linOf(row.hemiGroundHex);
  const sky = linOf(row.hemiSkyHex);
  const d = linOf(colorHex);
  const e = linOf(emissiveHex);
  const to = [0, 1, 2].map((i) => row.sunPos[i]! - row.sunTarget[i]!);
  const dotNL = sunlit ? to[1]! / Math.hypot(to[0]!, to[1]!, to[2]!) : 0;
  const sun = linOf(row.sunHex);
  // `irradiance × BRDF_Lambert`, and `BRDF_Lambert` is `diffuse / π`.
  const lit = [0, 1, 2].map(
    (i) =>
      (((ground[i]! + (sky[i]! - ground[i]!) * up) * row.hemiIntensity +
        sun[i]! * row.sunIntensity * dotNL) *
        d[i]!) /
        Math.PI +
      e[i]!,
  ) as RGB;
  return aces(lit).map((v) => Math.round(toSrgb(v) * 255)) as RGB;
}

/** Rec.709 on the sRGB bytes — the units every soffit and crowd figure is in. */
const lumaOf = (rgb: RGB) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const chromaOf = (rgb: RGB) => Math.max(...rgb) - Math.min(...rgb);
const bytesOf = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** `roof.ts`'s `COLORS.under`, quoted so a change there fails here. */
// ⚠ IMPORTED, NOT QUOTED. This was a hand-copied 0x6b727c whose comment claimed
// "a change there fails here" — it did not, because roof.ts's COLORS was not
// exported. Measured: dropping `under` to a near-black 0x1a1c20 (the exact
// hole-in-the-sky defect this file exists to catch) passed 967/967, and every
// luminance figure below was then measuring a colour the scene no longer drew.
const UNDER_HEX = ROOF_COLORS.under;

const soffit = (row: Daylight) => renderPx(UNDER_HEX, row.roofEmissiveHex, row);
/** The stack's exterior, the one roof surface that faces the light. */
const deck = (row: Daylight) => renderPx(row.roofDeckHex, 0x000000, row, 1, true);
const truss = (row: Daylight) => renderPx(row.trussHex, row.trussEmissiveHex, row);
const lip = (row: Daylight) => renderPx(row.roofEdgeHex, row.roofEdgeEmissiveHex, row, 0.5);

const log = (s: string) => {
  // eslint-disable-next-line no-console
  console.log(s);
};

/* ------------------------------------------------------------------ tests */

describe('the roof soffit renders as a ROOF, not as a void', () => {
  it('prints what every roof surface renders at, in both rows', () => {
    log('\n[SOFFIT — what the roof underside renders at, per daylight row]');
    log('  row     surface   colour     emissive      rgb            luma');
    for (const row of [DAYLIGHT.day, DAYLIGHT.night]) {
      const rows: Array<[string, number, number, RGB]> = [
        ['deck top', row.roofDeckHex, 0x000000, deck(row)],
        ['soffit', UNDER_HEX, row.roofEmissiveHex, soffit(row)],
        ['truss', row.trussHex, row.trussEmissiveHex, truss(row)],
        ['lip', row.roofEdgeHex, row.roofEdgeEmissiveHex, lip(row)],
      ];
      for (const [name, c, e, px] of rows) {
        log(
          `  ${row.id.padEnd(6)}  ${name.padEnd(8)}  0x${c.toString(16).padStart(6, '0')}   ` +
            `0x${e.toString(16).padStart(6, '0')}    ` +
            `${`[${px.join(',')}]`.padEnd(14)}  ${lumaOf(px).toFixed(2).padStart(6)}`,
        );
      }
      log(
        `  ${row.id.padEnd(6)}  → truss − soffit = ${(lumaOf(truss(row)) - lumaOf(soffit(row)))
          .toFixed(2)
          .padStart(7)} levels`,
      );
    }
    log('');
  });

  it('reproduces the SHIPPED SCREENSHOTS byte for byte — the model is measured', () => {
    // ⚠ THREE GOLDEN PIXELS, READ OUT OF TWO PNGs THE VISUAL GATE PRODUCED, and
    // they are what makes everything below a measurement instead of an opinion.
    // Counts are the modal colour over a rectangle wholly inside the parked
    // stack, so they are the surface and not an edge.
    //
    //   flight.png        [180,120 320×100]   (15,14,12) at 85 % of the rect
    //   night-homerun.png [480,200 380×120]   (31,40,53) at 83 %  ← soffit
    //                                         (31,41,54) at 16 %  ← truss
    //
    // The first is the PRE-CHANGE day soffit, so it is quoted against
    // `0x000000` rather than against the day row's emissive — it pins the
    // MODEL, not the shipped table, and it must keep passing after the table
    // moves. That is the point of pinning it.
    expect(renderPx(UNDER_HEX, 0x000000, DAYLIGHT.day)).toEqual([15, 14, 12]);
    // ⚠ AND THE TWO UP-FACING GOLDENS, WHICH VALIDATE THE DIRECTIONAL TERM.
    // Modal colour over [360,270 180×60], wholly inside the parked stack's TOP
    // surface, off the `wide` day/night pair:
    //
    //   daynight-day.png    (151,158,164) at 35 %   luma 156.94
    //   daynight-night.png  (126,136,158) at 38 %   luma 135.46   ← 86 % of day
    //
    // Both are quoted against `0x969ba2` — the PRE-CHANGE deck colour, which
    // the day row still ships and the night row no longer does — so they pin
    // the MODEL and keep passing after the table moves, exactly as the day
    // soffit's `0x000000` golden above does. The second number IS the defect
    // `roofDeckHex` exists for, stated as a byte: at night the roof was the
    // brightest object in the frame.
    expect(renderPx(0x969ba2, 0x000000, DAYLIGHT.day, 1, true)).toEqual([151, 158, 164]);
    expect(renderPx(0x969ba2, 0x000000, DAYLIGHT.night, 1, true)).toEqual([126, 136, 158]);
    expect(renderPx(UNDER_HEX, 0x2f3742, DAYLIGHT.night)).toEqual([31, 40, 53]);
    expect(renderPx(0x9aa3b0, 0x2f3742, DAYLIGHT.night)).toEqual([31, 41, 54]);
    // …and the pair above is the night defect itself, stated as a number: the
    // shared emissive put a PALE lattice 0.78 levels from its own soffit.
    expect(
      Math.abs(lumaOf(renderPx(0x9aa3b0, 0x2f3742, DAYLIGHT.night)) - lumaOf(renderPx(UNDER_HEX, 0x2f3742, DAYLIGHT.night))),
    ).toBeLessThan(1);
  });

  it('DAY: the soffit is off the floor and the truss is PICKED OUT of it', () => {
    const s = lumaOf(soffit(DAYLIGHT.day));
    const t = lumaOf(truss(DAYLIGHT.day));
    // Two stops over the 14.07 that read as a hole in the sky. The band is wide
    // because the exact value is an author's choice; the FLOOR is the finding.
    expect(s).toBeGreaterThan(40);
    // …and still unmistakably a dark mass against a bright sky. `clearHex` is
    // the day sky behind the dome; a soffit anywhere near it stops being a roof.
    // (`clearHex` is 0x8fb6dd = luma 175.5, and the sky measured off
    // `flight.png` is 175.4 — the dome's haze stop lands on it.)
    expect(s).toBeLessThan(0.5 * lumaOf(bytesOf(DAYLIGHT.day.clearHex)));
    // The day effect, unchanged in kind: a DARK lattice on a lifted plate.
    expect(t).toBeLessThan(s);
    expect(s / Math.max(t, 1e-6)).toBeGreaterThan(4);
  });

  it('NIGHT: the truss is a PALE LATTICE against the soffit it hangs under', () => {
    const s = lumaOf(soffit(DAYLIGHT.night));
    const t = lumaOf(truss(DAYLIGHT.night));
    // The reference note's whole claim, as a number. It was 0.78.
    expect(t - s).toBeGreaterThan(12);
    // ⚠ AND THE BLUE LEADING EDGE KEEPS ITS JOB. The lip is the building's
    // night signature and `homerun`, `flight` and all three `follow-*` frames
    // compose against it, so a truss lift that washed it out would be a net
    // loss. It holds by CHROMA, not by luminance — the two are level on purpose
    // — so chroma is what is asserted.
    const l = lip(DAYLIGHT.night);
    expect(chromaOf(l)).toBeGreaterThan(4 * chromaOf(truss(DAYLIGHT.night)));
    // The soffit does NOT move: the mass already read against the night sky and
    // the lip's contrast is measured against exactly that gap.
    expect(lumaOf(l) - s).toBeGreaterThan(12);
  });

  it('NIGHT: the parked stack is a DARK MASS, not the brightest thing in frame', () => {
    const d = lumaOf(deck(DAYLIGHT.night));
    const dayDeck = lumaOf(deck(DAYLIGHT.day));
    const s = lumaOf(soffit(DAYLIGHT.night));
    // (1) THE INVERSION IS GONE. It was 135.46 against a day 156.94 — 86 %,
    // measured on the `wide` pair — because one `DirectionalLight` has a
    // direction and no position, so a rig aimed at the field cannot be BELOW a
    // roof and an up-facing surface 282 ft up takes it full on. Half is a wide
    // bar deliberately: the finding is that night must be materially DARKER
    // than day up there, not that it must hit one number.
    expect(d).toBeLessThan(0.5 * dayDeck);
    // (2) IT IS STILL A ROOF AND NOT A HOLE. The exactly-derived value — day
    // albedo scaled by the hemisphere's share of the night irradiance, i.e. the
    // rig removed — is 0x060b14, which renders at luma 0.22 against a sky of
    // 15.9. That is the "hole punched in the sky" this whole file exists for,
    // one surface up, so the floor is the sky the mass is seen against.
    expect(d).toBeGreaterThan(lumaOf(bytesOf(DAYLIGHT.night.clearHex)));
    // (3) AND THE LIFT IS ANCHORED TO THE STACK'S OWN SOFFIT. With the rig
    // underneath it, the exterior of a parked stack sees no more light than its
    // interior does — one object, one value — and the soffit is the surface
    // whose night luminance was measured off a shipped PNG and signed off.
    expect(Math.abs(d - s)).toBeLessThan(4);
    // (4) THE BLUE LEADING EDGE IS STILL THE BRIGHTEST THING UP THERE. It is
    // the building's night signature and every celebration frame composes
    // against it; a deck that out-rendered it would be the same defect in a
    // different place.
    expect(d).toBeLessThan(lumaOf(lip(DAYLIGHT.night)));
  });

  it('DAY is unmoved: the deck is the SUNLIT exterior it always was', () => {
    // `roofDeckHex` is `roof.ts`'s own former `COLORS.deck`, moved verbatim, so
    // the day frame is byte-identical rather than merely close. The assertion is
    // the hex, because that is the claim.
    expect(DAYLIGHT.day.roofDeckHex).toBe(0x969ba2);
    expect(deck(DAYLIGHT.day)).toEqual([151, 158, 164]);
    // And the day roof is the bright plate the day soffit is a dark mass under —
    // the relationship the sun makes and the night rig must not.
    expect(lumaOf(deck(DAYLIGHT.day))).toBeGreaterThan(2 * lumaOf(soffit(DAYLIGHT.day)));
  });

  it('no roof surface clips to black in either row', () => {
    // The day truss was a literal [0,0,0] — not "dark", CLIPPED, so its shape
    // carried no information at all and a member was indistinguishable from a
    // hole in the plate. Every surface has to land on a real value.
    for (const row of [DAYLIGHT.day, DAYLIGHT.night]) {
      for (const [name, px] of [
        ['deck', deck(row)],
        ['soffit', soffit(row)],
        ['truss', truss(row)],
        ['lip', lip(row)],
      ] as const) {
        expect(lumaOf(px), `${row.id} ${name} renders at ${px.join(',')}`).toBeGreaterThan(3);
      }
    }
  });
});

/* ------------------------------------------------------------- the crowd */

/**
 * ⚠ WHAT THIS BLOCK CAN AND CANNOT SEE, SAID FIRST. The crowd is a canvas, and
 * `buildCrowdTexture` returns `null` without a DOM — this suite runs in node —
 * so nothing here reads a texel. The RENDERED claim is gated in
 * `scripts/shoot-baseball.mjs`'s `checkNightBowl`, which decodes the two
 * `daynight-*.png` files the harness just wrote and measures the deck's own
 * luminance spread against the day frame's. That is the right instrument and it
 * is the one that was missing for three rounds.
 *
 * What IS assertable here is the shape of the TABLE, and it is worth asserting
 * because each row's value is only meaningful against the others. Two night
 * passes failed by turning `crowdBase` alone, which is the FLOOR — with no
 * ceiling on the points, "less like static" and "less like a black hole" were
 * one dial pulled in opposite directions.
 */
describe('the crowd rows are a floor, a density and a CEILING — three jobs', () => {
  it('day is exactly 1, which is what makes the day texture byte-identical', () => {
    // `crowd.ts` multiplies the palette by this UNCONDITIONALLY — no branch, so
    // no drift. 1 is therefore not "roughly full brightness", it is the
    // identity, and 0.99 would silently repaint a texture the visual gate
    // signed off. Asserted exactly, for that reason.
    expect(DAYLIGHT.day.crowdPointGain).toBe(1);
    expect(DAYLIGHT.day.crowdBase).toBe(1);
  });

  it('night caps the point, drops the floor and thins the population', () => {
    const n = DAYLIGHT.night;
    // A point must have a ceiling at all — the defect was that it had none, and
    // a ×1.0 texel over a pale seat rendered at 150 against floodlit turf at 83.
    expect(n.crowdPointGain).toBeLessThan(1);
    // …and it must still be a POINT: brighter than the deck it sits on. This is
    // the bound that stops the ceiling being taken too far in the next round —
    // at or below `crowdBase` the bright points stop existing and the bowl is
    // back to a flat slab, which is the OTHER failure this file's roof half
    // spent a round undoing.
    expect(n.crowdPointGain).toBeGreaterThan(n.crowdBase);
    // The floor and the density are night-specific for their own stated
    // reasons — a dark bowl, and a phone is not a person.
    expect(n.crowdBase).toBeLessThan(DAYLIGHT.day.crowdBase);
    expect(n.crowdSpeckle).toBeLessThan(DAYLIGHT.day.crowdSpeckle);
  });
});
