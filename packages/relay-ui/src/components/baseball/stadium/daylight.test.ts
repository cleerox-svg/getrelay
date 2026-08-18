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
// ⚠ "IF `StadiumGL` EVER CHANGES TONE MAPPING, EXPOSURE, COLOUR SPACE OR THE
// LIGHT RIG, THIS FILE FAILS FIRST." THAT CLAIM WAS THREE QUARTERS FALSE AND IS
// NOW TRUE. Measured: the model hard-coded ACES and `exposure = 1` and imported
// nothing from `StadiumGL`, so moving the exposure to golf's 1.15 — a plausible
// edit — passed **967 / 967**, and nothing in the repo named `outputColorSpace`
// at all. ONLY the light rig bound, because only the light rig was imported.
//
// The fix is the one `scoreboard.test.ts` already sets by reaching out of its
// module for `CAMERAS.batter`: reach out for the transfer function too.
// `StadiumGL` exports `RENDER_TRANSFER`, the renderer is configured FROM it,
// and `aces()` below is driven BY it — so the exposure is not merely asserted
// equal to 1, it is the number the five goldens are computed at. Narrowing the
// claim was the other option and it is worth less: a golden pixel is only
// evidence about a renderer if the model and the renderer share the curve.
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
//  10. `RENDER_TRANSFER.exposure` 1 → 1.15, golf's value          → 6 fail
//      (the transfer pin, the golden-pixel test, BOTH "day is
//      unmoved" tests and both night dark-mass tests. This is the
//      mutation the header's claim described and did not catch:
//      it passed 967/967 before this file imported the constant.)
//  11. `RENDER_TRANSFER.outputColorSpace` → `LinearSRGBColorSpace` → 1 fail
//      (the transfer pin. It cannot move a golden, because the
//      model's job is to say what the renderer's sRGB encode does;
//      an assertion is the only instrument for this one.)
//  12. `night.apronHex` back to 0x63625d — the SHIPPED defect,
//      the ground OUTSIDE the bowl at 4× the seating inside it → 2 fail
//      (the concourse dark-mass test, and `field.test.ts`'s
//      apron-wiring test on its "the two rows differ" leg)
//  13. `night.apronHex` = 0x020407, the EXACTLY derived
//      rig-removed albedo                                    → 2 fail
//      (the concourse floor AND no-clipping. Same pairing as
//      legs 1 and 7: "black" and "unreadable" are different
//      defects and it takes both assertions to cover them.)
//  14. `night.cityWallGain` back to 1 — the shipped defect, a
//      concrete tower out-rendering the floodlit turf         → 1 fail
//      (the city test, on THREE of its legs at once: the wall is
//      no longer dark, the window is 0.85× the wall rather than
//      2×, and the lane byte is 255 instead of 148)
//  15. `night.cityLoHex`/`cityHiHex` left at the day concrete,
//      i.e. the wall darkened but the tint never re-coloured    → 2 fail
//      (`skyline.test.ts`'s rows-differ leg, and the WARMTH leg
//      here — the windows still separate from the wall at
//      74.9 / 30.7, they just render (73,76,74), which is grey
//      sparkle. ⚠ The separation leg alone does NOT catch this,
//      measured: 74.9/30.7 = 2.4× passes it. It takes both.)
//
// See also `roof.test.ts`, which asserts the WIRING — that the truss material
// takes `trussEmissiveHex` and the underside takes `roofEmissiveHex`. Splitting
// the column and forgetting to rewire it would pass every test in this file.

import { ACESFilmicToneMapping, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';
import { RENDER_TRANSFER } from '../StadiumGL';
import { DAYLIGHT } from './daylight';
import type { Daylight } from './daylight';
import { COLORS as ROOF_COLORS } from './roof';
import { wallLaneByte } from './windows';

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
  // ⚠ THE EXPOSURE IS READ, NOT ASSUMED. This used to be the literal 1 with a
  // comment saying it was `StadiumGL`'s default — which is exactly how an
  // exposure change passed 967 tests. See the header.
  const x0 = RENDER_TRANSFER.exposure;
  let v = mul(ACES_IN, c.map((x) => (x * x0) / 0.6) as RGB);
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
 * `dotNL` adds the one `DirectionalLight` and is `max(0, N·L̂)`. It is **0** for
 * every downward-facing surface — three gives a Lambert surface `dot(N, L)` and
 * that is ≤ 0 for a soffit — and for the leading-edge lip, whose normal sweeps
 * an arc and is taken conservatively edge-on. Two families are non-zero, and
 * both are axis-aligned so the cosine is one component of `L̂`:
 *
 *   • `dotUp`   — a HORIZONTAL surface, `L̂.y`. The parked roof deck and the
 *     concourse apron. 0.7200 by day, **0.9231** at night.
 *   • `dotFace` — a CAMERA-FACING VERTICAL wall, `L̂.z`. Every high-rise, since
 *     `skyline.ts` never rotates a `BoxGeometry`, and the tower's shells.
 *     0.4423 by day, **0.3795** at night.
 *
 * That single term is the whole of all three inversions: the night row aims the
 * rig nearly straight down, so an up-facing surface 282 ft in the air catches
 * 28 % MORE cosine than the day sun ever delivered, and a vertical wall outside
 * the park still catches 86 % of it — while the hemisphere fill that used to
 * share the work has fallen 3.6×.
 *
 * `scale` is a VERTEX-COLOUR multiplier in linear light, which is what
 * `geom.tintGeometry` writes and what `windows.ts`'s wall lane multiplies by.
 * It is a separate argument from `colorHex` because both of those are per-mesh
 * factors on top of a shared authored hex, and folding them into the hex would
 * quantise twice.
 */
function renderPx(
  colorHex: number,
  emissiveHex: number,
  row: Daylight,
  up = 0,
  dotNL = 0,
  scale = 1,
): RGB {
  const ground = linOf(row.hemiGroundHex);
  const sky = linOf(row.hemiSkyHex);
  const d = linOf(colorHex).map((v) => v * scale) as RGB;
  const e = linOf(emissiveHex);
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
/**
 * What an UNLIT `MeshBasicMaterial` renders that hex at — the sky dome's case,
 * and the only one in the scene. It is NOT `bytesOf`: tone mapping still runs,
 * and on a dark colour it runs hard. `skyStops[2]` reads 47.9 as bytes and
 * **30.34** on screen.
 *
 * ⚠ VALIDATED THE SAME WAY EVERYTHING ELSE HERE IS. Sampling the sky column of
 * the shipped `daynight` pair at x = 700: night y = 230 reads (3,11,36) and
 * this model puts the 0.2 point of the mid→horizon ramp at (3,10,35); day
 * y = 300 reads (165,194,215) against (158,190,214) at 0.2 and (173,198,216)
 * at 0.4. The dome is a gradient so no single stop is a golden, but ACES is
 * demonstrably in the path for the unlit material too.
 */
const unlitPx = (hex: number): RGB =>
  aces(linOf(hex)).map((v) => Math.round(toSrgb(v) * 255)) as RGB;

/** `roof.ts`'s `COLORS.under`, quoted so a change there fails here. */
// ⚠ IMPORTED, NOT QUOTED. This was a hand-copied 0x6b727c whose comment claimed
// "a change there fails here" — it did not, because roof.ts's COLORS was not
// exported. Measured: dropping `under` to a near-black 0x1a1c20 (the exact
// hole-in-the-sky defect this file exists to catch) passed 967/967, and every
// luminance figure below was then measuring a colour the scene no longer drew.
const UNDER_HEX = ROOF_COLORS.under;

/** `L̂` of the one directional, from the row's own two points. */
const lightDir = (row: Daylight): RGB => {
  const to = [0, 1, 2].map((i) => row.sunPos[i]! - row.sunTarget[i]!) as RGB;
  const len = Math.hypot(to[0]!, to[1]!, to[2]!);
  return to.map((v) => v / len) as RGB;
};
/** `dot(N, L̂)` for a HORIZONTAL surface and for a CAMERA-FACING VERTICAL one. */
const dotUp = (row: Daylight) => lightDir(row)[1]!;
const dotFace = (row: Daylight) => lightDir(row)[2]!;

const soffit = (row: Daylight) => renderPx(UNDER_HEX, row.roofEmissiveHex, row);
/** The stack's exterior, the one roof surface that faces the light. */
const deck = (row: Daylight) => renderPx(row.roofDeckHex, 0x000000, row, 1, dotUp(row));
const truss = (row: Daylight) => renderPx(row.trussHex, row.trussEmissiveHex, row);
const lip = (row: Daylight) => renderPx(row.roofEdgeHex, row.roofEdgeEmissiveHex, row, 0.5);
/**
 * The concourse disc — the same normal and the same two lights as `deck`, which
 * is the whole reason it is in this file.
 */
const apron = (row: Daylight) => renderPx(row.apronHex, 0x000000, row, 1, dotUp(row));

/**
 * ⚠ THE SKYLINE'S TALLEST BLOCK, AND THE THREE NUMBERS BELOW ARE READ OUT OF
 * `skyline.ts` RATHER THAN CHOSEN. Its facade tint is
 * `lerp(cityLoHex, cityHiHex, min(1, h/440)) × (0.92 + rng()·0.16)`; the
 * building that dominates the top of `daynight-*.png` is index 7 of the seeded
 * band, `h = 512 ft` so the lerp saturates at **1**, at a tint scale of
 * **1.0432**. Replaying `mulberry32(20260817)` here would be a second copy of
 * `buildSkyline`'s loop; the two constants are quoted instead, and the golden
 * pixels below are what keeps them honest — they come off the shipped PNGs, so
 * if that stream ever moves they stop matching.
 */
const B7_LERP = 1;
const B7_TINT = 1.0432;
/** The lit-window texel `windows.ts` paints, at `α = 1`. It MULTIPLIES the tint. */
const WINDOW_TEXEL = 0xffecbe;
/**
 * The wall lane, as three actually samples it: `wallGain` is a CANVAS level, so
 * it is quantised to a byte and then sRGB-decoded. 0.58 → 148 → **0.2961**.
 */
const wallLane = (row: Daylight) => toLinear(wallLaneByte(row.cityWallGain) / 255);
/**
 * The ramp, back as a hex so `renderPx` can take it.
 *
 * ⚠ THE sRGB ROUND TRIP IS EXACT ONLY AT THE ENDS, and that is why `B7_LERP` is
 * 1. `tintGeometry` lerps in LINEAR and never re-encodes; this re-encodes so the
 * value can go through the same `renderPx` every other surface uses. At f = 0 or
 * 1 the round trip returns the authored byte unchanged, so the goldens are
 * exact. A mid-ramp building would pick up a quantisation step, and there is no
 * reason to ask for one.
 */
const cityLerp = (row: Daylight, f: number): number => {
  const lo = linOf(row.cityLoHex);
  const hi = linOf(row.cityHiHex);
  const v = [0, 1, 2].map((i) => toSrgb(lo[i]! + (hi[i]! - lo[i]!) * f));
  return (Math.round(v[0]! * 255) << 16) | (Math.round(v[1]! * 255) << 8) | Math.round(v[2]! * 255);
};
/** The tallest high-rise's CONCRETE, and one of its LIT windows. */
const cityWall = (row: Daylight) =>
  renderPx(cityLerp(row, B7_LERP), 0x000000, row, 0.5, dotFace(row), B7_TINT * wallLane(row));
const cityWindowOf = (row: Daylight): RGB => {
  const t = linOf(cityLerp(row, B7_LERP)).map((v) => v * B7_TINT) as RGB;
  const lit = linOf(WINDOW_TEXEL);
  const alb = [0, 1, 2].map((i) => t[i]! * lit[i]!) as RGB;
  const ground = linOf(row.hemiGroundHex);
  const sky = linOf(row.hemiSkyHex);
  const sun = linOf(row.sunHex);
  const dn = dotFace(row);
  const linear = [0, 1, 2].map(
    (i) =>
      (((ground[i]! + (sky[i]! - ground[i]!) * 0.5) * row.hemiIntensity + sun[i]! * row.sunIntensity * dn) *
        alb[i]!) /
      Math.PI,
  ) as RGB;
  return aces(linear).map((v) => Math.round(toSrgb(v) * 255)) as RGB;
};

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
        ['concourse', row.apronHex, 0x000000, apron(row)],
        ['city wall', row.cityHiHex, 0x000000, cityWall(row)],
        ['city window', WINDOW_TEXEL, 0x000000, cityWindowOf(row)],
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
    // ⚠ TEN GOLDEN PIXELS, READ OUT OF THREE PNGs THE VISUAL GATE PRODUCED, and
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
    expect(renderPx(0x969ba2, 0x000000, DAYLIGHT.day, 1, dotUp(DAYLIGHT.day))).toEqual([151, 158, 164]);
    expect(renderPx(0x969ba2, 0x000000, DAYLIGHT.night, 1, dotUp(DAYLIGHT.night))).toEqual([126, 136, 158]);
    expect(renderPx(UNDER_HEX, 0x2f3742, DAYLIGHT.night)).toEqual([31, 40, 53]);
    expect(renderPx(0x9aa3b0, 0x2f3742, DAYLIGHT.night)).toEqual([31, 41, 54]);
    // …and the pair above is the night defect itself, stated as a number: the
    // shared emissive put a PALE lattice 0.78 levels from its own soffit.
    expect(
      Math.abs(lumaOf(renderPx(0x9aa3b0, 0x2f3742, DAYLIGHT.night)) - lumaOf(renderPx(UNDER_HEX, 0x2f3742, DAYLIGHT.night))),
    ).toBeLessThan(1);

    // ⚠ THE CONCOURSE, SAME PAIR, SAME NORMAL AS THE DECK. Modal colour over
    // [80,1400 200×120] and [10,700 90×120], both wholly on the ground disc
    // outside the bowl — 100 % and 97 % of their rects, because the apron is
    // the one ground surface `field.ts` does NOT grain:
    //
    //   daynight-day.png    (86,87,82)  luma  86.43
    //   daynight-night.png  (67,70,76)  luma  69.80   ← 81 % of day
    //
    // Quoted against `0x63625d`, the PRE-CHANGE apron colour the day row still
    // ships, on the same rule as the deck goldens above.
    expect(renderPx(0x63625d, 0x000000, DAYLIGHT.day, 1, dotUp(DAYLIGHT.day))).toEqual([86, 87, 82]);
    expect(renderPx(0x63625d, 0x000000, DAYLIGHT.night, 1, dotUp(DAYLIGHT.night))).toEqual([67, 70, 76]);
    // ⚠ AND THE SKYLINE, WHICH IS THE FIRST *VERTICAL* SURFACE PINNED HERE —
    // so `dotFace` is measured rather than assumed. Modal colour over
    // [330,60 40×130], wholly inside the tallest high-rise's facade, 57 % of
    // the rect (the rest is its window grid):
    //
    //   daynight-day.png    (123,134,144)  luma 132.38
    //   daynight-night.png  (73,87,112)    luma  85.83   ← ABOVE the floodlit
    //                                                      turf's 83.2
    // Quoted against the DAY ramp at both rows, again so the goldens survive
    // the table moving. `B7_TINT` and `B7_LERP` are `skyline.ts`'s own seeded
    // values; these two lines are what proves them.
    const dayRamp = cityLerp(DAYLIGHT.day, B7_LERP);
    expect(renderPx(dayRamp, 0x000000, DAYLIGHT.day, 0.5, dotFace(DAYLIGHT.day), B7_TINT)).toEqual([
      123, 134, 144,
    ]);
    expect(renderPx(dayRamp, 0x000000, DAYLIGHT.night, 0.5, dotFace(DAYLIGHT.night), B7_TINT)).toEqual([
      73, 87, 112,
    ]);
  });

  it('the renderer TRANSFER FUNCTION is pinned, not assumed — see the header', () => {
    // ⚠ THE CLAIM AT THE TOP OF THIS FILE, MADE TRUE. `aces()` above divides by
    // `RENDER_TRANSFER.exposure`, so every golden pixel already moves with it;
    // these three lines cover what a golden cannot see. `outputColorSpace` in
    // particular can never move a pixel HERE — the model's whole job is to
    // reproduce the renderer's sRGB encode, so if the renderer stopped doing
    // one the model would happily keep doing it and agree with nothing.
    expect(RENDER_TRANSFER.toneMapping).toBe(ACESFilmicToneMapping);
    expect(RENDER_TRANSFER.outputColorSpace).toBe(SRGBColorSpace);
    expect(RENDER_TRANSFER.exposure).toBe(1);
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
        ['concourse', apron(row)],
        ['city wall', cityWall(row)],
        ['city window', cityWindowOf(row)],
      ] as const) {
        expect(lumaOf(px), `${row.id} ${name} renders at ${px.join(',')}`).toBeGreaterThan(3);
      }
    }
  });
});

/* -------------------------------------------- outside the rig: two surfaces */

/**
 * ⚠ TWO MORE SURFACES WITH THE ROOF DECK'S DEFECT, AND THEY ARE HERE BECAUSE
 * THEY SHARE ITS MECHANISM EXACTLY. One `DirectionalLight` has a direction and
 * no position, so a rig "inside the bowl pointing down at the field" is, to
 * every other surface in the scene, a light with infinite reach. Anything the
 * rig should not be lighting is lit by it anyway, and `sunIntensity` cannot
 * separate them — the concourse and the roof deck are BOTH horizontal, so their
 * ratio is fixed at every intensity, which is the finding `roofDeckHex`'s note
 * proves for the turf and this pair confirms independently: their night
 * `E_hemi/E_total` triples agree to four places, (0.0058, 0.0097, 0.0197)
 * against (0.0059, 0.0097, 0.0197).
 *
 * Reflectance is the only per-surface channel a shared light leaves. These are
 * the assertions on the two rows that spend it.
 */
describe('the two surfaces OUTSIDE the light rig are dark masses, not bright ones', () => {
  it('NIGHT: the concourse is DARKER than the seating it stands under', () => {
    const n = lumaOf(apron(DAYLIGHT.night));
    const d = lumaOf(apron(DAYLIGHT.day));
    // (1) THE INVERSION IS GONE. It was 69.80 against a day 86.43 — 81 % — with
    // a floodlit turf at 83.2 and a night crowd deck whose p50 is 15.7 near /
    // 27.0 far, so the ground OUTSIDE the stadium rendered four times brighter
    // than the seating inside it. A lit bowl on dark ground is the picture;
    // that was the negative of it. Half is a wide bar on purpose, the same as
    // the deck's: the finding is that night must be materially darker out
    // there, not that it must hit one number.
    expect(n).toBeLessThan(0.5 * d);
    // (2) IT IS STILL GROUND AND NOT A HOLE. The exactly-derived value — the
    // day albedo scaled by the hemisphere's share of the night irradiance, i.e.
    // the rig removed — is 0x020407, which renders at **0.00**: clipped, not
    // dark. The floor is the clear colour the frame is composed against, and it
    // is the RENDERED one (3.22) rather than the deck test's `bytesOf` reading
    // of the same hex (15.88) — see `unlitPx`. This is a CLIPPING floor; the
    // contrast claim is the next line.
    expect(n).toBeGreaterThan(lumaOf(unlitPx(DAYLIGHT.night.clearHex)));
    // ⚠ AND THE PICTURE CLAIM, WHICH IS THE FINDING: THE BOWL IS BRIGHTER THAN
    // THE GROUND IT STANDS ON. 16.8 is the near-bowl crowd patch's own night
    // p50, measured out of `daynight-night.png` by the harness's
    // `checkNightBowl` and quoted here the way the turf's 83.2 is quoted below
    // — the two are read from the same frame and move together.
    expect(n).toBeLessThan(16.8);
    // (3) AND IT IS BELOW THE PARKED DECK, WHICH IS THE DERIVATION. The two
    // surfaces take identical irradiance, so the shipped value is the deck's
    // own per-channel factor applied to the concourse's own paint — and coated
    // roof steel is 2.4× the reflectance of concourse concrete, a ratio the
    // signed-off DAY frame already states as 156.94 against 86.43. Holding the
    // irradiance and letting the paint differ is the physical answer; holding
    // the rendered value would have been a repaint.
    expect(n).toBeLessThan(lumaOf(deck(DAYLIGHT.night)));
  });

  it('NIGHT: the city is a SILHOUETTE, and its windows are the light in it', () => {
    const wall = lumaOf(cityWall(DAYLIGHT.night));
    const win = lumaOf(cityWindowOf(DAYLIGHT.night));
    const dayWall = lumaOf(cityWall(DAYLIGHT.day));
    // (1) THE INVERSION, AND THIS WAS THE WORST OF THE THREE. The tallest block
    // rendered 85.83 at night against a floodlit turf at 83.2, and the tower's
    // concrete shaft — an unlit object 1,250 ft outside the park — rendered
    // 96.09. The brightest large mass in a night frame was a building.
    expect(wall).toBeLessThan(0.5 * dayWall);
    // (2) THE BODY IS ANCHORED TO THIS TABLE'S OWN SKY, not picked. A building
    // 700–1,500 ft out is at the aerial-perspective limit and the limit is the
    // colour of the atmosphere in front of it — `skyStops[2]`, the horizon
    // haze, which renders at 30.34. The band is ±25 % of it because the ramp
    // spreads the sixteen buildings 25.66–31.81 around it by design.
    const haze = lumaOf(unlitPx(DAYLIGHT.night.skyStops[2]));
    expect(wall).toBeGreaterThan(0.75 * haze);
    expect(wall).toBeLessThan(1.25 * haze);
    // (3) ⚠ AND THE WINDOWS DO NOT FALL WITH IT — THE POINT OF THE THIRD
    // COLUMN. `windows.ts`'s map multiplies, so at `cityWallGain = 1` a "lit"
    // window was 0.85× the wall beside it: 74.86 against 85.83 at night and
    // 119.70 against 132.38 by day. The lit windows in this map had never been
    // lit. Pulling the WALL down is the only move a multiply allows.
    expect(win).toBeGreaterThan(2 * wall);
    // (4) AND A WINDOW MAY NOT OUT-RENDER THE FIELD, which is exactly
    // `crowdPointGain`'s anchor applied to the same kind of bright point. The
    // floodlit turf reads p50 83.2 in the night frame the harness measures.
    expect(win).toBeLessThan(83.2);
    // (5) ⚠ AND IT IS WARM, WHICH THE MULTIPLY HAS TO CARRY BECAUSE THE
    // LIGHTING CANNOT. Both night lights are blue — `sunHex` 0xdfe8ff and
    // `hemiSkyHex` 0x2a3a5c — so a NEUTRAL tint renders a neutral window. The
    // first pass here used the crowd's pale cool white and its lit windows came
    // out (73,76,74): grey sparkle, at the same luminance, not city lights. The
    // shipped ramp renders them (100,73,43).
    const w = cityWindowOf(DAYLIGHT.night);
    expect(w[0]! - w[2]!, `the night window renders ${w.join(',')} — not warm`).toBeGreaterThan(30);
    // …and the canvas level is asserted on the canvas's own quantiser, because
    // the effective multiplier is `toLinear(148/255) = 0.2961` and not 0.58.
    expect(wallLaneByte(DAYLIGHT.night.cityWallGain)).toBe(148);
  });

  it('DAY is unmoved on both: the hexes are the builders own, moved verbatim', () => {
    // The claim is the hex, because that is the claim — `field.ts`'s former
    // `COLORS.apron` and `skyline.ts`'s former `COLORS.cityLo/cityHi`.
    expect(DAYLIGHT.day.apronHex).toBe(0x63625d);
    expect(DAYLIGHT.day.cityLoHex).toBe(0x6d7683);
    expect(DAYLIGHT.day.cityHiHex).toBe(0x99a4b2);
    // ⚠ EXACTLY 1, for `crowdPointGain`'s reason: `windows.ts` writes literal
    // `#ffffff` at 1, so both day canvases — the city's AND `centrefield.ts`'s
    // hotel band, which does not pass the column at all — stay byte-identical
    // rather than roughly unchanged. 0.99 would silently repaint them.
    expect(DAYLIGHT.day.cityWallGain).toBe(1);
    // …and that is the CANVAS's claim, so it is asserted on the canvas's own
    // quantiser rather than on the fraction: 1 → 255 is the identity, and
    // `windows.ts` short-circuits it to a literal `#ffffff`.
    expect(wallLaneByte(DAYLIGHT.day.cityWallGain)).toBe(255);
    expect(apron(DAYLIGHT.day)).toEqual([86, 87, 82]);
    expect(cityWall(DAYLIGHT.day)).toEqual([123, 134, 144]);
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
