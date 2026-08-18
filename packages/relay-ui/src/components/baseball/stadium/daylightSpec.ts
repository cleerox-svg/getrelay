// THE SHAPE OF A LIGHTING ROW — every column, and the argument for it.
//
// ⚠ THIS FILE IS AN EXTRACTION, NOT A NEW CONCEPT. `daylight.ts` reached the
// 500-line builder cap and the charter's rule is that a cap is met by
// EXTRACTION — the same way `pchip.ts` and `parkValidate.ts` left `parks.ts`.
// The split is along the one seam that does not fork the table: the SHAPE and
// the argument for each column live here; the two ROWS and the accessors stay
// in `daylight.ts`, which is still the only place a value is written.
//
// It is types and prose only — no runtime export at all — so it costs the
// bundle exactly nothing, and `daylight.ts` re-exports the two type names so
// that not one of the fourteen import sites had to move.
//
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
   * The parked stack's TOP surface — the exterior deck, which only the `wide`
   * camera ever sees.
   *
   * ⚠⚠ IT IS A ROW BECAUSE THE NIGHT FRAME HAD THE LIGHTING INVERTED, AND THIS
   * IS THE ONE CHANNEL THAT CAN FIX IT. Measured off `daynight-night.png`, on
   * the `wide` pair: the parked roof rendered at luminance **134.2** against a
   * floodlit turf at **75.7** and a sky at **11.8** — the BRIGHTEST object in a
   * night frame, and **86 %** of its own daytime value (156.9). "A dark dome" is
   * exactly what did not render.
   *
   * The cause is that a `DirectionalLight` has a direction and no position, so
   * it cannot be *under* anything. The night row aims the one directional almost
   * straight down (`sunPos` is nearly overhead), which is right for a rig
   * pointing at the field and wrong for every up-facing surface ABOVE the rig —
   * and a roof 282 ft up is the only large one there is. `sunIntensity` cannot
   * separate them, because the roof deck and the turf are both horizontal and
   * therefore take the same `dot(N, L)`; the ratio between them is FIXED at
   * 1.79 for every intensity. Measured, on the validated shading model in
   * `daylight.test.ts`:
   *
   *     sunIntensity   roof top   turf        (both faces up — they move together)
   *          2.60        135.5     75.9       ← shipped
   *          2.10        120.2     64.7       ← merely "not brighter than day"
   *          0.52         42.7     17.9       ← the roof fixed, the lights off
   *
   * So the only per-surface channel a shared light leaves is REFLECTANCE, which
   * is what this row is. It is the same mechanism `trussHex` already uses for
   * the same reason, one surface away.
   *
   * ⚠ THE DERIVED FLOOR IS BLACK, AND THAT IS WHY THE SHIPPED VALUE IS NOT IT.
   * Removing the rig from this surface exactly — scaling the day albedo by the
   * hemisphere's share of the night irradiance, `E_hemi/E_total` = (0.0059,
   * 0.0097, 0.0197) per channel — gives `0x060b14`, which renders at luminance
   * **0.22**: a hole in the sky, the defect `roofEmissiveHex`'s note below spent
   * a whole round undoing. A parked roof at night is not in a vacuum; it sees
   * city glow and the upward spill off a lit field, neither of which one
   * hemisphere light and one downward directional can deliver.
   *
   * ⚠ SO THE LIFT IS ANCHORED, NOT CHOSEN. `0x44464a` is the value that renders
   * the deck's TOP level with the stack's own SOFFIT — 38.80 against 39.03, and
   * the soffit is the one night surface whose value was measured off a shipped
   * PNG, reproduced to the byte by the model, and signed off by the visual gate.
   * One object, one value: with the rig underneath it, the exterior of a parked
   * stack sees no more light than its interior does. The blue lip (57.3) and the
   * lattice (56.7) stay the bright things up there, which is what
   * `roofEdgeHex`'s note asks for.
   *
   * The panel/bay tints in `roof.ts`'s `deckColors` still apply on top, so the
   * stack keeps its steps: 38.8 → 30.9 across the four panels at night, against
   * 156.9 → 138.8 by day.
   *
   * DAY IS UNMOVED — `0x969ba2` is `roof.ts`'s own former `COLORS.deck`, moved
   * here verbatim so the day frame is byte-identical.
   */
  roofDeckHex: number;
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
   * making the GROUND darker (`crowdBase` < 1) and raising the seat colour to
   * compensate, so the speckle's own texels land bright and everything between
   * them falls away. ⚠ The speckle is no longer written at ×1.0 either — see
   * `crowdPointGain`, which is the CEILING this pair spent two rounds not
   * having.
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
  /**
   * The CEILING on one bright point, as a fraction of its palette entry.
   *
   * ⚠⚠ THIS ROW IS THE THIRD ATTEMPT AT THE NIGHT CROWD, AND IT EXISTS BECAUSE
   * THE FIRST TWO HAD ONLY ONE KNOB. `crowdBase` is the deck's FLOOR and the
   * points had no ceiling at all — they were written at the full palette — so
   * "less like television static" and "less like a black hole" were the same
   * dial pulled in opposite directions. 0.26 was static; 0.10 was a starfield;
   * 0.16 was the compromise, and it still measured as sensor noise:
   *
   *     `daynight-*.png`, `wide`      p50     p99   p99/p50
   *     day   far upper deck        22.1    36.5      1.7
   *     day   near bowl             18.4    73.2      4.0
   *     night far upper deck  →      9.8   150.4     15.4      ← 9× day's
   *     night near bowl       →      4.1   112.3     27.5      ← 6.9× day's
   *
   * A crowd point rendering at 150 is BRIGHTER than the floodlit turf (83) and
   * 2.6× the blue leading edge (57) that is the building's night signature. It
   * is not even a light: the map multiplies, so a ×1.0 texel is a WHITE LAMBERT
   * PATCH taking the field rig full on, and white under floodlights beats green
   * turf every time. That is what a ceiling is for.
   *
   * ⚠ THE CEILING IS ANCHORED: A CROWD POINT MAY NOT OUT-RENDER THE FIELD.
   * 0.55 puts the night deck's p99 at 76.2 far / 67.5 near, just under the
   * floodlit turf's p50 of 83.2 — so the brightest thing in a night frame is
   * the board, then the field, then the crowd, which is the order the reference
   * photographs have.
   *
   * ⚠ AND WITH A CEILING, THE FLOOR COULD GO BACK UP — which is the half the
   * two failed passes could not reach. `crowdBase` returns to 0.26 (the value
   * that was "static" at 16 % density and gain 1, a combination that no longer
   * exists) and the deck's structure comes back with it. Measured on the same
   * two patches, gain 0.55 / base 0.26:
   *
   *     night far upper deck        27.0    76.2      2.8   (was 9.8/150.4/15.4)
   *     night near bowl             15.7    67.5      4.3   (was 4.1/112.3/27.5)
   *
   * i.e. 1.6× and 1.1× of the DAY ratio, against 9× and 6.9× before. Night
   * SHOULD run a little hotter than day — the points stand for self-luminous
   * screens, where by day both the points and the deck under them are lit by
   * the same sun — but 3–5× is where the mid-tones die and nothing but the
   * points survives, which is the "starfield" `crowdBase = 0.10` was rejected
   * for. The near deck's p50 also comes back above the sky's 11.8: a bowl
   * darker than the sky behind it is a hole, not a bowl.
   *
   * ⚠ MEASURED AND NOT SHIPPED: A BIGGER POINT. A texel is 30/`px` ft — 1.41 in
   * at the medium tier — so a phone screen is genuinely ~2 texels, and drawing
   * the point as a 2 × 2 block (coverage held, so a quarter as many points)
   * looked like the fix for "no minification blending". It measured WORSE on
   * both patches: p99 150.4 → 80.7 against gain-alone's 71.5, and p99/p50 7.3 →
   * 8.9, because a hard 2 × 2 block is *more* reliably sampled at full strength
   * than a lone texel is. Softness needs a falloff, not an area, and the
   * ceiling turned out to buy more than either. Recorded so the next round does
   * not spend itself re-deriving it.
   *
   * Day is exactly 1 — `crowd.ts` multiplies by it unconditionally, so the
   * signed-off day texture is byte-identical rather than merely unchanged-ish.
   */
  crowdPointGain: number;
  /**
   * The GROUND OUTSIDE THE BOWL — the concourse/plaza disc `field.ts` lays the
   * park down on. `wide` is the only camera that sees much of it, and it is
   * about a third of that frame.
   *
   * ⚠⚠ IT IS A ROW FOR EXACTLY THE REASON `roofDeckHex` IS ONE, AND IT IS THE
   * SAME DEFECT ONE SURFACE DOWN. Measured off the `daynight` pair with the
   * model in `daylight.test.ts`, which reproduces both frames to the byte:
   *
   *     day   0x63625d → [86,87,82]  L **86.43**
   *     night 0x63625d → [67,70,76]  L **69.80**   ← 81 % of its own day value
   *
   * against a floodlit turf at 83.2, a night sky at 11.9 and a crowd deck whose
   * p50 is 16.8 near / 27.0 far. The ground OUTSIDE the stadium was rendering
   * four times brighter than the seating INSIDE it. A lit bowl on dark ground is
   * the picture; this was the negative of it.
   *
   * ⚠ AND IT HAD ALREADY CONTAMINATED THE CROWD GATE. 122 texels of the
   * harness's "near bowl" crowd rect were this surface, not seating — 0.7 % of
   * the rect, and the whole of its p99. `checkNightBowl` has been reporting a
   * night crowd peak of 67.5 that was a car park. The rect is trimmed and the
   * finding is recorded there.
   *
   * The cause is `roofDeckHex`'s cause, and the apron is the surface that proves
   * that note's central claim rather than merely repeating it. Both are
   * horizontal, so both take the same `dot(N, L)` — 0.9231 at night against
   * 0.7200 by day, i.e. the night rig delivers **28 % MORE** cosine than the day
   * sun ever did — and their night `E_hemi/E_total` triples are identical to
   * four places, (0.0058, 0.0097, 0.0197) against the deck's (0.0059, 0.0097,
   * 0.0197). Two horizontal surfaces hold a fixed ratio at every `sunIntensity`.
   * Reflectance is the only channel left, which is what this row is.
   *
   * ⚠ THE DERIVED FLOOR IS BLACK HERE TOO. Scaling the day albedo by that
   * triple — the rig removed exactly — gives `0x020407`, which renders at
   * **0.00**: not dark, CLIPPED, and the bottom third of `wide` would be a void.
   *
   * ⚠ SO THE SHIPPED VALUE IS DERIVED FROM THE ONE THE GATE ALREADY SIGNED OFF,
   * WITH NO FREE PARAMETER. `roofDeckHex` is a decision about how much light an
   * up-facing surface outside the rig actually gets, and it is expressible as a
   * per-channel irradiance factor: `0x44464a / 0x969ba2` = (0.1895, 0.1869,
   * 0.1895). The apron shares the deck's normal and the deck's two lights, so
   * the same factor is the same statement — applied to the concourse's OWN
   * paint it gives `0x2a2a27`, which renders at **13.65**.
   *
   * It lands well below the deck's 38.80 and that is a RESULT, not a slip: the
   * two surfaces differ only in albedo, and coated roof steel is 2.4× the
   * reflectance of concourse concrete — a ratio the signed-off DAY frame already
   * states as 156.94 against 86.43. Holding the irradiance and letting the paint
   * differ is the physical answer; holding the rendered value and letting the
   * paint differ would have been a repaint.
   *
   * The order it buys, in the frame: turf 83.2 > crowd points 76.2 > blue lip
   * 57.3 > roof deck 38.8 > crowd deck p50 15.7–27.0 > **concourse 13.65** >
   * night sky 11.9. The bowl is now brighter than the ground it stands on.
   *
   * DAY IS UNMOVED — `0x63625d` is `field.ts`'s own former `COLORS.apron`, moved
   * here verbatim, so the day frame is byte-identical rather than merely close.
   */
  apronHex: number;
  /**
   * The CITY on the horizon: the tint ramp `skyline.ts` lerps every high-rise
   * along (short → tall, i.e. near → hazy), and the level its shared window map
   * paints the WALL between two openings at.
   *
   * ⚠⚠ THIS IS THE THIRD SURFACE CARRYING THE SAME INVERSION, AND IT WAS THE
   * WORST OF THEM. `BoxGeometry` is never rotated here, so every facade normal
   * is axis-aligned and the camera sees the `+z` face; that face takes
   * `dot(N, L)` = 0.3795 at night against 0.4423 by day — the night rig lands
   * within 14 % of the day sun on a vertical wall — while the hemisphere fill it
   * used to share the work with has fallen 3.6×. Measured, per the model:
   *
   *     tower shaft   day L 144.00  →  night L **96.09**
   *     tallest block day L 132.38  →  night L **85.83**
   *     whole city    day 106.6–134.6 → night **65.3–87.8**
   *
   * A floodlit turf renders at 83.2. The concrete communications tower — an
   * unlit object 1,250 ft outside the park — was the BRIGHTEST large mass in a
   * night frame, brighter than the field the rig is pointed at.
   *
   * ⚠ THE DERIVED FLOOR IS BLACK, A THIRD TIME. At `up = 0.5` the night
   * `E_hemi/E_total` is (0.0147, 0.0234, 0.0312); scaling the day ramp by it
   * gives `0x070e14`/`0x0f171f` and the tallest building then renders at
   * **0.14** — a skyline with an outline and no body.
   *
   * ⚠ THE SHIPPED BODY IS ANCHORED TO THIS TABLE'S OWN SKY. A building 700–1,500
   * ft out is at the aerial-perspective limit, and the limit is the colour of
   * the atmosphere in front of it — which is already a row here:
   * `skyStops[2]`, the horizon haze, renders at **30.34**. The shipped pair puts
   * the city's walls at **25.27 → 31.48**, straddling it, with the tallest block
   * (the one furthest into the haze) at 31.21. The tower shaft comes with it,
   * 96.09 → **35.58**, and its pod 68.38 → **22.66**, off this one column and
   * with no second one — `tower.ts` keeps its own concrete colours and samples
   * the same map's plain lane.
   */
  cityLoHex: number;
  cityHiHex: number;
  /**
   * ⚠⚠ AND THE WINDOWS DO NOT FALL WITH THE BODY — WHICH IS THE WHOLE REASON
   * THIS IS A THIRD COLUMN RATHER THAN A DARKER RAMP. A city at night is lit
   * windows; a skyline whose windows dim with its concrete is a black cut-out.
   *
   * `windows.ts`'s map MULTIPLIES, so a texel can only darken and "make the
   * window brighter" is not an available move. Measured on the shipped table,
   * `α = 1` texels: the tallest block's wall renders 85.83 and its **LIT** window
   * **74.86** — and by day 132.38 against 119.70. The lit windows in this map
   * have never been lit. They are 0.85× of the concrete, in both rows, and
   * always were.
   *
   * The fix is `crowd.ts`'s, one building further out: make the surface colour
   * the colour of the LIT THING and pull the lane between them down. So
   * `cityLoHex`/`cityHiHex` become the colour of a LIT WINDOW at night and this
   * column is the wall's level. The window lane is untouched, and it renders at
   * **66.29 → 78.71** across the sixteen buildings — under the floodlit turf's
   * 83.2, which is `crowdPointGain`'s "may not out-render the field" rule
   * applied to the same kind of point.
   *
   * ⚠ AND THE WINDOW TINT IS WARM BECAUSE THE LIGHT IS COOL. Both night lights
   * are blue — `sunHex` 0xdfe8ff and `hemiSkyHex` 0x2a3a5c — so a neutral tint
   * renders a neutral window. The first pass used a pale cool white on the
   * crowd's precedent and its lit windows came out **(73,76,74)**: grey
   * sparkle, not city lights. The shipped warm ramp renders them
   * **(100,73,43)** at the same luminance. Nothing else moved; the whole
   * difference is that the multiply has to carry the colour temperature the
   * lighting cannot.
   *
   * ⚠ IT IS A CANVAS LEVEL, NOT A LINEAR MULTIPLIER — `windows.ts`'s own note
   * has the arithmetic. 0.58 of white quantises to byte 148 and the sRGB decode
   * makes it **0.2961** in the light the shading happens in.
   *
   * ⚠ DAY IS EXACTLY 1, and exactly for `crowdPointGain`'s reason: `windows.ts`
   * writes literal `#ffffff` at 1, so every day canvas — the city's AND
   * `centrefield.ts`'s hotel band, which does not pass this column at all — is
   * byte-identical rather than roughly unchanged.
   *
   * ⚠ MEASURED AND NOT SHIPPED: AN `emissiveMap`. It is the obvious way to make
   * a window a light rather than a bright patch, and it fails the same test the
   * crowd's did. The map is SHARED with the tower's concrete through the plain
   * lane, so a white lane driving an emissive turns a 790 ft communications
   * tower into a light bulb; separating them needs a second canvas that BOTH
   * rows would then have to build to keep `checkDayNightPairs`'s texture counts
   * equal. Zero draw calls, zero textures and zero triangles is what the
   * multiply buys.
   */
  cityWallGain: number;
}
