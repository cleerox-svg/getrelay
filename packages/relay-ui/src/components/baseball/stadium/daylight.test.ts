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
// second renderer and must never grow into one: it solves exactly ONE case, the
// one the roof underside is in and the one three's own lighting handles worst —
// a Lambert surface whose normal points STRAIGHT DOWN, so the single
// shadow-casting `DirectionalLight` contributes nothing at all and the single
// `HemisphereLight` contributes 100 % of its GROUND colour. Under that
// restriction the whole shading chain is four lines, and it is pinned against
// bytes read out of the shipped screenshots in the first test below: it
// reproduces `flight.png`'s soffit and BOTH of `night-homerun.png`'s roof
// colours EXACTLY, to the byte, on three independent surfaces. A model that
// hits three golden pixels dead on is measuring the renderer.
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
//
// See also `roof.test.ts`, which asserts the WIRING — that the truss material
// takes `trussEmissiveHex` and the underside takes `roofEmissiveHex`. Splitting
// the column and forgetting to rewire it would pass every test in this file.

import { describe, expect, it } from 'vitest';
import { DAYLIGHT } from './daylight';
import type { Daylight } from './daylight';

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
 * colour), **0.5** for a vertical step face or the leading-edge lip.
 */
function renderPx(colorHex: number, emissiveHex: number, row: Daylight, up = 0): RGB {
  const ground = linOf(row.hemiGroundHex);
  const sky = linOf(row.hemiSkyHex);
  const d = linOf(colorHex);
  const e = linOf(emissiveHex);
  // `irradiance × BRDF_Lambert`, and `BRDF_Lambert` is `diffuse / π`.
  const lit = [0, 1, 2].map(
    (i) => ((ground[i]! + (sky[i]! - ground[i]!) * up) * row.hemiIntensity * d[i]!) / Math.PI + e[i]!,
  ) as RGB;
  return aces(lit).map((v) => Math.round(toSrgb(v) * 255)) as RGB;
}

/** Rec.709 on the sRGB bytes — the units every soffit and crowd figure is in. */
const lumaOf = (rgb: RGB) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
const chromaOf = (rgb: RGB) => Math.max(...rgb) - Math.min(...rgb);
const bytesOf = (hex: number): RGB => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** `roof.ts`'s `COLORS.under`, quoted so a change there fails here. */
const UNDER_HEX = 0x6b727c;

const soffit = (row: Daylight) => renderPx(UNDER_HEX, row.roofEmissiveHex, row);
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

  it('no roof surface clips to black in either row', () => {
    // The day truss was a literal [0,0,0] — not "dark", CLIPPED, so its shape
    // carried no information at all and a member was indistinguishable from a
    // hole in the plate. Every surface has to land on a real value.
    for (const row of [DAYLIGHT.day, DAYLIGHT.night]) {
      for (const [name, px] of [
        ['soffit', soffit(row)],
        ['truss', truss(row)],
        ['lip', lip(row)],
      ] as const) {
        expect(lumaOf(px), `${row.id} ${name} renders at ${px.join(',')}`).toBeGreaterThan(3);
      }
    }
  });
});
