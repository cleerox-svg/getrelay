// DAY AND NIGHT, AS DATA — the two ROWS. The SHAPE and the argument for every
// column are in `daylightSpec.ts`; this file is the values and nothing else.
//
// ⚠ THE TOGGLE IS COSMETIC AND THAT IS A HARD RULE — see `daylightSpec.ts`'s
// header for why, and `shared/prefs.test.ts` for the assertion that means it.
// Every field below is a light, a colour or an emissive level, and none of it
// is ever handed to `lib/baseball`.

import type { Daylight, DaylightId } from './daylightSpec';

export type { Daylight, DaylightId } from './daylightSpec';

/**
 * ⚠ THE SUN MOVES AND THE TARGET DOES NOT. Day keeps M1's placement, which sits
 * behind home on purpose so that the inward face of the outfield wall — the
 * surface `batter`, `flight` and `wide` all look at — is lit. Night puts the
 * same light almost straight overhead and slightly behind, which is what a real
 * light rig does: banks on the roof structure pointing down at the field. The aim
 * point is unchanged so the shadow volume, which `StadiumGL` sizes from the
 * bowl's own radius, frames the identical ground either way.
 */
export const DAYLIGHT: Record<DaylightId, Daylight> = {
  day: {
    id: 'day',
    sunPos: [-520, 700, 260],
    sunTarget: [0, 0, -170],
    sunHex: 0xfff4e0,
    sunIntensity: 2.1,
    hemiSkyHex: 0xcfe4f8,
    hemiGroundHex: 0x7c7264,
    hemiIntensity: 1.6,
    clearHex: 0x8fb6dd,
    skyStops: [0x4f8bc9, 0x74a8dc, 0xc6dcef],
    skyBandLift: 0.16,
    towerGlow: 0.22,
    // The sunlit exterior. Moved verbatim from `roof.ts`'s `COLORS.deck`.
    roofDeckHex: 0x969ba2,
    // Dark metal, and it stays dark: a dark lattice on a lifted soffit IS the
    // day effect. Its own emissive only lifts it off the clipping floor, so
    // that the members read as members rather than as holes in the plate.
    trussHex: 0x272b32,
    trussEmissiveHex: 0x121518,
    // 0x000000 → this. 0.055 of `hemiSkyHex` — the sky the soffit of a parked
    // roof sees from three open sides, which a straight-down normal under one
    // hemisphere light cannot be given any other way. L 14.07 → 54.4.
    roofEmissiveHex: 0x343a40,
    roofEdgeHex: 0x4a4f58,
    roofEdgeEmissiveHex: 0x000000,
    fasciaHex: 0x121620,
    // The values `stands.ts` derived and the visual gate signed off in daylight.
    seatsHex: 0x243356,
    crowdBase: 1,
    crowdSpeckle: 0.16,
    crowdPointGain: 1,
    // The sunlit concourse. Moved verbatim from `field.ts`'s `COLORS.apron`.
    apronHex: 0x63625d,
    // The sunlit city. Moved verbatim from `skyline.ts`'s `COLORS.cityLo/Hi`.
    // Taller reads paler: aerial perspective, and it separates the cluster.
    cityLoHex: 0x6d7683,
    cityHiHex: 0x99a4b2,
    // Exactly 1 — `windows.ts` writes literal `#ffffff` at 1, so both day
    // canvases are byte-identical. See the column's note.
    cityWallGain: 1,
  },
  night: {
    id: 'night',
    // Overhead and a little behind the plate, so the mound and the infield
    // arc still cast a short shadow rather than none at all — a rig with no
    // shadow under it reads as an unlit scene with the lights turned up.
    sunPos: [-60, 900, 200],
    sunTarget: [0, 0, -170],
    // Metal halide reads cool white against the warm emissives.
    sunHex: 0xdfe8ff,
    // ⚠ BRIGHTER THAN THE DAY SUN, DELIBERATELY. The brief is "floodlit turf,
    // the bowl reading BRIGHTER than the sky rather than darker", and at night
    // the hemisphere fill is nearly gone — so the one directional is carrying
    // surfaces the fill used to carry in daylight. It is the same single light,
    // not a second one.
    sunIntensity: 2.6,
    // A dim, cool fill: sky-side is the city's own glow, ground-side the
    // spill off a lit field.
    hemiSkyHex: 0x2a3a5c,
    hemiGroundHex: 0x2c3a34,
    hemiIntensity: 0.45,
    clearHex: 0x0a1020,
    // Near-black at the zenith, warming to a low city-glow band at the
    // horizon. The same three-stop machinery the day dome uses.
    skyStops: [0x060a16, 0x0d1730, 0x24304e],
    // A cloud lift that reads at night is a cloud lift that reads as fog.
    skyBandLift: 0.05,
    towerGlow: 1.0,
    // 0x969ba2 → this. Not a darker paint: the same paint under the light it
    // actually gets, which is city glow and spill and NOT the field rig. It
    // renders at 38.80 against the soffit's 39.03. See the field's note.
    roofDeckHex: 0x44464a,
    // Pale, and NOW carrying its own light — see the field's note. The pale
    // value was inert until `trussEmissiveHex` existed: the shared emissive put
    // the lattice 0.8 levels from the soffit it hangs under.
    trussHex: 0x9aa3b0,
    // 0.07 of `sunHex` — the rig, caught from below. L 39.81 → 56.7 against an
    // unmoved 39.03 soffit. Deliberately level with the blue lip's 57.3 rather
    // than over it: the lip is the building's signature and it keeps that by
    // being the most SATURATED thing up there, not the brightest.
    trussEmissiveHex: 0x40434b,
    roofEmissiveHex: 0x2f3742,
    roofEdgeHex: 0x2f6bff,
    roofEdgeEmissiveHex: 0x1e46b4,
    // A lit line, not a glow — bright enough to draw the deck edge, dark enough
    // that four of them do not become the brightest thing in the bowl.
    fasciaHex: 0x2a5fe0,
    // ⚠ A PALE COOL WHITE, NOT A RAISED NAVY — the map can only darken, so this
    // IS the colour of a bright point. 0x7d97e8 was the first attempt and it is
    // why the owner saw blue static: a periwinkle multiplied by 1.0 is a
    // periwinkle. A phone screen is white with the barest blue in it.
    seatsHex: 0xd6e0f4,
    // ⚠ 0.26 → 0.10 → 0.16 → 0.26 AGAIN, AND THE ROUND TRIP IS THE FINDING.
    // Every one of those was this dial trying to do two jobs: 0.26 at the day's
    // 16 % density and an uncapped point was television static; 0.10 was a pure
    // starfield with the vomitories, the clumps and the seat-row banding all
    // crushed to the same black; 0.16 was the compromise and STILL measured as
    // sensor noise (p99/p50 = 15.4 far, 27.5 near, against day's 1.7 and 4.0).
    //
    // The floor was never the defect. The point's CEILING was, and it did not
    // exist — see `crowdPointGain`, which is new and is what lets the floor
    // come back up. At 0.26 with 3 % density and gain 0.55 the deck's mid-tones
    // are alive again (near p50 4.1 → 15.7, above the sky's 11.8) while the
    // points fall to 76/67, just under the floodlit turf. The number is the
    // same; the pairing it sits in is not, and the pairing is what was static.
    crowdBase: 0.26,
    // 16 % → 3 %. A phone is not a person: roughly one seat in thirty is holding
    // a lit screen, and 16 % of texels at this tile size is television static.
    // At the 4:1 minification the `pitcher` camera sees, this is what makes the
    // points SPARSE; `crowdPointGain` below is what stops each one being a
    // full-brightness pinprick, and `crowdBase` above is what keeps the deck
    // between them a surface rather than a void. Three rows, three jobs.
    crowdSpeckle: 0.03,
    // A crowd point may not out-render the field. See the row's own note.
    crowdPointGain: 0.55,
    // 0x63625d → this, and it is DERIVED rather than picked: the day paint under
    // the same per-channel irradiance factor `roofDeckHex` already applies to the
    // surface that shares its normal, (0.1895, 0.1869, 0.1895). It renders at
    // 13.65 against the deck's 38.80 because concourse concrete is 2.4× darker
    // paint than coated roof steel — the ratio the day frame already states.
    // Below the near crowd deck's own 16.8, which is the picture claim.
    apronHex: 0x2a2a27,
    // ⚠ A WARM OFFICE LIGHT, NOT A DARKENED CONCRETE — the map can only darken,
    // so this IS the colour of a LIT WINDOW and `cityWallGain` is the wall
    // behind it. It is warm because the rig and the fill are both cool at
    // night, so a neutral tint renders a neutral window: the first pass here
    // was a pale cool white and its windows came out (73,76,74), grey sparkle
    // rather than city lights. This one gives (100,73,43). The ramp keeps its
    // short→tall order either way.
    cityLoHex: 0xb09070,
    cityHiHex: 0xc0a080,
    // Bodies at 25.27–31.48, straddling the sky dome's own horizon stop (30.34)
    // — the aerial-perspective limit a building this far out sits at. The
    // windows do not move: 66.29–78.71, under the floodlit turf's 83.2.
    cityWallGain: 0.58,
  },
};

export const isDaylightId = (v: unknown): v is DaylightId => v === 'day' || v === 'night';

export const daylightOf = (v: unknown): Daylight => DAYLIGHT[isDaylightId(v) ? v : 'day'];
