// DAY AND NIGHT, AS DATA — one table, two rows, read by the composer, the sky
// dome and the tower.
//
// ⚠⚠ THE TOGGLE IS COSMETIC AND THAT IS A HARD RULE, NOT A PREFERENCE.
//
// The air model derives ρ from temperature (`airDensity`), so a physically
// honest night would be cooler, denser air and a ball that carries shorter — by
// several feet. A *player-selectable* option that changes carry is a "pick the
// easy mode" button on a leaderboard game, so temperature and humidity are held
// IDENTICAL across this table and nothing in it is ever handed to
// `lib/baseball`. Every field below is a light, a colour or an emissive level.
//
// `shared/prefs.test.ts` asserts it the only way that means anything: it runs
// the published max-carry ladder with the preference set to `night` and again
// with it set to `day`, and requires the two byte-identical — including the
// sampled tracks, not just the carry scalars. If night is ever to PLAY
// differently it rolls from the daily seed, exactly as the roof state was always
// meant to; a preference cannot do it.
//
// ⚠ NO NEW LIGHTS. The budget is what it always was: ONE shadow-casting
// directional + ONE hemisphere fill. A night game is that sun REPOSITIONED
// OVERHEAD (a light rig, not a sun on the horizon), a tinted fill, and the
// EMISSIVE surfaces — ribbons, board, roof underside, tower bands — becoming the
// actual light in the picture. Four or six floodlights would each want a shadow
// pass, and GOLF.md records a 2048² shadow map killing a real Android WebView
// GPU process. The shadow map stays 1024² and there stays exactly one of it.

export type DaylightId = 'day' | 'night';

export interface Daylight {
  id: DaylightId;
  /** The one shadow-casting directional: position, aim, colour, intensity. */
  sunPos: [number, number, number];
  sunTarget: [number, number, number];
  sunHex: number;
  sunIntensity: number;
  /** The one hemisphere fill. */
  hemiSkyHex: number;
  hemiGroundHex: number;
  hemiIntensity: number;
  /** The clear colour behind the sky dome — see `StadiumGL`'s `SKY` note. */
  clearHex: number;
  /** Zenith / mid / horizon-haze stops of the dome gradient. */
  skyStops: readonly [number, number, number];
  /** Cloud-band brightness lift on the dome. Night clouds barely register. */
  skyBandLift: number;
  /**
   * RESTING emissive multiplier for the tower's LED bands, before any
   * celebration pulse. Day is not zero — an LED strip in daylight is a visible
   * dark-grey stripe, not nothing.
   */
  towerGlow: number;
  /**
   * The roof's space-frame truss and the roof's UNDERSIDE, each with its own
   * emissive. Three columns, two surfaces, and the split is the fix — see
   * below.
   *
   * ⚠ THIS IS THE ONE PLACE A LIGHT WOULD OTHERWISE HAVE BEEN ADDED, and it is
   * an owner note off a reference photograph: from inside the bowl looking up
   * through the roof opening, the truss reads as a **pale, brightly-lit
   * lattice** — it catches the stadium lighting from below. Ours was
   * `0x272b32` under an overhead rig, i.e. black.
   *
   * The honest way to render an upward wash with ONE directional light is not a
   * second light: it is a paler surface plus an EMISSIVE term, which is
   * `MeshLambertMaterial`'s own channel and costs nothing — no draw call, no
   * triangle, no shadow pass.
   *
   * ⚠⚠ WHY THERE ARE NOW TWO EMISSIVES WHERE THERE WAS ONE. Both surfaces
   * face DOWN, so `HemisphereLight` gives them 100 % of `hemiGroundHex` and the
   * sun gives them nothing at all — which makes the emissive, not the diffuse
   * colour, the dominant term in what they render at. One SHARED emissive
   * therefore adds the same number to both and cannot separate them:
   *
   *   • NIGHT, measured off `night-homerun.png` and reproduced exactly by the
   *     shading model in `daylight.test.ts`: soffit **L 39.03**, truss
   *     **L 39.81**. **0.8 levels apart.** The pale `0x9aa3b0` above was doing
   *     nothing at all — `0x2f3742` swamped it ~50:1 — so the "pale, brightly-lit
   *     lattice" this comment has claimed since it was written HAS NEVER BEEN
   *     RENDERED. It photographed as a flat slab with the blue lip on top.
   *   • DAY, both were zero, so both fell to the bottom of the range: soffit
   *     **L 14.07**, truss **L 0.00** — the truss was clipping to literal black.
   *
   * So `trussEmissiveHex` is its own column. `roofEmissiveHex` is now the
   * UNDERSIDE'S ALONE, which is what its name always said and what `roof.ts`
   * always wanted.
   *
   * ⚠ AND THE DAY ROW IS NO LONGER ZERO, WHICH IS A REVERSAL OF THE LINE THAT
   * USED TO END THIS COMMENT. It said day should stay black because "picked out
   * against a pale underside" is the day effect — correct about the effect,
   * wrong about the pixels: the underside was not pale, it was L 14 against a
   * L 175 sky, and the truss it was supposed to pick out was L 0. The frame read
   * as a HOLE PUNCHED IN THE SKY, and the parked stack (`roof.ts`) is roughly
   * FOUR TIMES the area of the ring it replaced — measured off the shot diff,
   * **6.89 % of the whole 900 × 1600 `flight` frame** and 6.23 % of `homerun`,
   * i.e. about a fifth of the top third of each — so what was a thin dark strip
   * became the most conspicuous mass in the picture. The same authoring that
   * was defensible on a strip is not defensible on a slab.
   *
   * The day emissive is authored **two stops over the physics**, on exactly the
   * precedent the backstop pad and this same underside already set: a surface
   * that faces away from the only sun is carried by the fill alone, and the
   * visual gate has twice confirmed that two stops of author's licence reads
   * with no visible cost. It is not arbitrary — it stands in for a term the one
   * hemisphere light structurally cannot deliver. A `HemisphereLight` gives a
   * straight-down normal the GROUND colour and nothing else, but the soffit of a
   * PARKED, open roof sees open sky across three sides of a ±11° wedge. Both
   * day emissives are therefore a fraction of `hemiSkyHex` — 0.055 for the
   * underside, 0.010 for a member that is mostly shaded by its own panel — which
   * is why they are cool rather than the warm cast of the ground bounce.
   *
   * At night the story is the other one: `roofEmissiveHex` is the field rig
   * bouncing off a pale soffit, and `trussEmissiveHex` is 0.07 of `sunHex`, the
   * same rig catching the lattice. The night SOFFIT does not move — the mass
   * already reads against the sky, and `roofEdgeHex`'s blue leading edge is
   * composed against exactly that gap.
   *
   * Resulting luminances (Rec.709 on the sRGB bytes, the units the crowd and
   * soffit measurements are all quoted in):
   *
   *   DAY    soffit 14.07 → **54.4**   truss  0.00 → **6.9**
   *   NIGHT  soffit 39.03 → 39.03      truss 39.81 → **56.7**
   *
   * `daylight.test.ts` asserts the separations rather than the hexes.
   */
  trussHex: number;
  trussEmissiveHex: number;
  roofEmissiveHex: number;
  /**
   * ⚠ THE ROOF'S LEADING EDGE — THE BUILDING'S NIGHT SIGNATURE, and the owner's
   * highest-value single note off four night photographs: *"they use blue lights
   * now."* In the aerials the roof's leading edge is a thick, bright blue band
   * along the whole arc and is the most identifiable feature of the building
   * from outside; from the upper deck it is a broad blue arc across the top of
   * frame. Ours was a dark grey rim.
   *
   * It is worth more than any other night change because of WHERE it is:
   * `homerun`, `flight` and all three `follow-*` scenes compose the celebration
   * against that arc. The `emissive` is what makes it a LIGHT rather than a
   * painted stripe, on the same argument as the truss — a band lit only by an
   * overhead rig would be a dark edge-on surface.
   */
  roofEdgeHex: number;
  roofEdgeEmissiveHex: number;
  /**
   * The deck fascias — the thin dark bands immediately above and below each
   * ribbon board.
   *
   * ⚠ AT NIGHT THE BOWL IS READ BY BLUE LINES, NOT BY SEAT COLOUR. That is the
   * photographs' third observation and it is a structural one: in daylight the
   * decks are legible because navy upholstery is a different value from
   * concrete, and at night everything is the same value, so the LED accent along
   * each deck edge is what carries the tiering. It costs nothing — the fascias
   * are already a band of the merged lit shell with their own vertex colour.
   */
  fasciaHex: number;
  /**
   * The seating's base colour, and how far the crowd map pulls it DOWN between
   * the people.
   *
   * ⚠⚠ THE NIGHT CROWD IS AN INVERTED CONTRAST PROBLEM, NOT A BRIGHTER ONE, and
   * this pair is half the mechanism. `crowd.ts`'s map MULTIPLIES the seat
   * colour, so a texel can only ever darken — which means "bright points on
   * dark" cannot be authored by making the dots brighter. It is authored by
   * making the GROUND darker (`crowdBase` ≪ 1) and raising the seat colour to
   * compensate, so the speckle's own ×1.0 texels land bright and everything
   * between them falls away.
   *
   * ⚠ THE FIRST ATTEMPT AT THAT OVERSHOT, AND THE OWNER LOOKED AT THE FRAME.
   * `crowdBase = 0.26` with the day's 16 % speckle density made
   * `night-homerun.png` a dense field of high-frequency BLUE noise — television
   * static, not a dark bowl with scattered bright points. Two separate faults,
   * and both are fixed by rows of this table rather than by a knob in
   * `crowd.ts`:
   *
   *   • DENSITY. 16 % of texels is right for DAY, where the bright points are
   *     thirty thousand people in seats and the deck really is wall-to-wall
   *     crowd. It is wrong for NIGHT, where the bright points are the fraction
   *     of that crowd holding a lit phone. `crowdSpeckle` is therefore a row,
   *     not a constant — same population, different thing being photographed.
   *   • COLOUR. The map multiplies, so a ×1.0 texel over a NAVY seat is a
   *     bright NAVY point, and the reference shows white-ish phone screens.
   *     The speckle has to OVERRIDE, and the only way a multiply overrides is
   *     if the thing being multiplied is already the colour you want: so at
   *     night `seatsHex` becomes a pale cool WHITE and the map becomes a MASK
   *     — ×1.0 gives the screen, ×`crowdBase` gives near-black. The seating's
   *     navy is genuinely gone at night, and that is not a loss being hidden:
   *     between the points the deck is ~0.01 in linear light, where no hue
   *     survives anyway, and `fasciaHex` below already says in as many words
   *     that at night the bowl is read by BLUE LINES rather than by seat
   *     colour.
   *
   * ⚠ AND IT IS STILL ONE TEXTURE, ONE MATERIAL, ZERO DRAW CALLS. An
   * `emissiveMap` was the obvious alternative and it does not work here: the
   * fascia bands share this map and sample its white lane, so a white lane that
   * drives an emissive turns every deck-edge LED line into a blown-out white
   * stripe, and separating them needs a second canvas that both modes would
   * then have to build to keep `checkDayNightPairs`'s texture count equal.
   * Measured against, not assumed away.
   */
  seatsHex: number;
  crowdBase: number;
  /** Fraction of crowd texels that are a bright point. See `crowdBase`. */
  crowdSpeckle: number;
}

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
    // 0.26 → 0.16. The map is sampled in sRGB, so this is ~0.024 in the LINEAR
    // light the renderer works in — the deck between the points is very dark,
    // which is what "a dark bowl with scattered points" means.
    //
    // ⚠ AND 0.10 WAS TOO FAR, WHICH IS A SECOND MEASUREMENT AND NOT A WOBBLE.
    // At 0.10 the bowl came out at luminance 11.5 with a 0–190 range: a pure
    // starfield, with the vomitories, the clumps and the seat-row banding all
    // crushed to the same black. That is "noise", and the brief asks for
    // "texture rather than noise at 400 ft". 0.16 is 2.4× brighter in linear
    // light — enough for the coarse octave and the tunnel mouths to read as
    // structure — while still 6.6× below the 0.26 the owner saw as static.
    crowdBase: 0.16,
    // 16 % → 3 %. A phone is not a person: roughly one seat in thirty is holding
    // a lit screen, and 16 % of texels at this tile size is television static.
    // At the 4:1 minification the `pitcher` camera sees, the two together take
    // the deck's mean from 0.207 to 0.040 in linear light — a 5.2× drop with
    // the individual points UNCHANGED at full brightness, which is exactly the
    // "sparse, not dim" the reference asks for.
    crowdSpeckle: 0.03,
  },
};

export const isDaylightId = (v: unknown): v is DaylightId => v === 'day' || v === 'night';

export const daylightOf = (v: unknown): Daylight => DAYLIGHT[isDaylightId(v) ? v : 'day'];
