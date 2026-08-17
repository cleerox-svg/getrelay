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
   * The roof's space-frame truss, and the emissive both it and the roof's
   * underside carry.
   *
   * ⚠ THIS IS THE ONE PLACE A LIGHT WOULD OTHERWISE HAVE BEEN ADDED, and it is
   * an owner note off a reference photograph: from inside the bowl looking up
   * through the roof opening, the truss reads as a **pale, brightly-lit
   * lattice** against the night sky — it catches the stadium lighting from
   * below. Ours was `0x272b32` under an overhead rig, i.e. black.
   *
   * The honest way to render an upward wash with ONE directional light is not a
   * second light: it is a paler surface plus a small EMISSIVE term, which is
   * `MeshLambertMaterial`'s own channel and costs nothing. The roof's underside
   * takes the same emissive, because it has the same problem for the same
   * reason — it faces DOWN, so an overhead rig gives it nothing at all.
   *
   * In daylight both are zero and the truss keeps the dark value `roof.ts`
   * derived, because "picked out against a pale underside" is the day effect and
   * lifting it would flatten exactly what that file is about.
   */
  trussHex: number;
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
   * this pair is the whole mechanism. `crowd.ts`'s map MULTIPLIES the seat
   * colour, so a texel can only ever darken — which means "bright points on
   * dark" cannot be authored by making the dots brighter. It is authored by
   * making the GROUND darker (`crowdBase` ≪ 1) and raising the seat colour to
   * compensate, so the speckle's own ×1.0 texels land bright and everything
   * between them falls away.
   *
   * The measured problem this fixes: the day crowd runs sd 1.94 → 3.40, i.e. it
   * barely reads for a texture the scene is already paying for. At night the
   * same texels are a dense field of bright points against black — which is what
   * the interior photograph shows, because what is actually being photographed
   * is thirty thousand phone screens.
   */
  seatsHex: number;
  crowdBase: number;
}

/**
 * ⚠ THE SUN MOVES AND THE TARGET DOES NOT. Day keeps M1's placement, which sits
 * behind home on purpose so that the inward face of the outfield wall — the
 * surface `batter`, `flight` and `wide` all look at — is lit. Night puts the
 * same light almost straight overhead and slightly behind, which is what a real
 * light rig does: banks on the roof ring pointing down at the field. The aim
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
    trussHex: 0x272b32,
    roofEmissiveHex: 0x000000,
    roofEdgeHex: 0x4a4f58,
    roofEdgeEmissiveHex: 0x000000,
    fasciaHex: 0x121620,
    // The values `stands.ts` derived and the visual gate signed off in daylight.
    seatsHex: 0x243356,
    crowdBase: 1,
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
    // Pale, and carrying its own light — see the field's note.
    trussHex: 0x9aa3b0,
    roofEmissiveHex: 0x2f3742,
    roofEdgeHex: 0x2f6bff,
    roofEdgeEmissiveHex: 0x1e46b4,
    // A lit line, not a glow — bright enough to draw the deck edge, dark enough
    // that four of them do not become the brightest thing in the bowl.
    fasciaHex: 0x2a5fe0,
    // Raised so the map's ×1.0 speckle texels land BRIGHT; `crowdBase` then
    // takes everything between them back down past where they started.
    seatsHex: 0x7d97e8,
    crowdBase: 0.26,
  },
};

export const isDaylightId = (v: unknown): v is DaylightId => v === 'day' || v === 'night';

export const daylightOf = (v: unknown): Daylight => DAYLIGHT[isDaylightId(v) ? v : 'day'];
