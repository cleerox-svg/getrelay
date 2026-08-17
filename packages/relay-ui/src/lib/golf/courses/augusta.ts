// Augusta National Golf Club — Augusta, Georgia. 18 holes, par 72. The named
// holes, doglegs, elevation changes and signature hazards (Amen Corner water on
// 11/12/13, ponds on 15/16, few fairway bunkers, big fast greens) recreated as
// pure CourseHole DATA per the terrain.ts authoring contract. This is a
// procedural arcade recreation — each hole matches the real PAR, YARDAGE (world
// scale d≈yards), DOGLEG DIRECTION and SIGNATURE HAZARDS, not survey geometry.
//
// SHAPE: a hole is a CENTERLINE polyline (terrain.ts). Every hole here is a real
// dogleg — a straight drive leg from the tee, then a genuine CORNER (~20–50°)
// into the approach leg, with the green sitting at the END of that second leg
// where the fairway actually leads. Left and right doglegs and leg lengths are
// varied so no two holes read the same; the sharp signature doglegs (10 Camellia,
// 13 Azalea) bend hardest. `d` stays strictly increasing (no 90°+ switchback) so
// the model's downrange-ordered centerline invariant holds; each dogleg's default
// tee aim (bearing-to-pin) cuts the corner over OB, so keeping the drive in the
// fairway means steering down the first leg — the dogleg matters in play.
//
// ⚠ A PAR 3'S CENTERLINE IS COLLINEAR TEE→PIN, AND THAT IS LOAD-BEARING. The tee
// shot aims down `driveHeading()` — centerline[0] → centerline[1] — precisely so
// "straight" points down the fairway on a dogleg instead of around the corner.
// A par 3 has no corner and no drive leg, so its first segment IS the shot at the
// flag, and a decorative mid-vertex a few yards off the pin line silently aims the
// default tee shot off the green: holes 4, 6, 12 and 16 each carried one, worth
// 3.0–6.4° and 9–20 yd of miss at the pin, and on 6 Juniper NO club at aim 0 could
// reach the green at all. Every par-3 mid-vertex below therefore sits exactly on
// the tee→pin ray (x = d · pin.x / pin.d) and is kept there by a test in
// courseSim.test.ts. Give a par 3 SHAPE with its green, its hazards and its
// terrain, never with a kink in the line the player is aimed down.
//
// Green tilt is authored within the engine's μ cap (≈stimp 10), below true
// Augusta green speeds (each green here reuses a known-good tilt/undulation and is
// only RELOCATED to the new centerline end). Greenside hazards use
// greensideHazard() so they always clear the wobbled fringe pad (the terrain.ts
// invariant) regardless of where the green moved; fairway bunkers sit on the
// INSIDE of the corner, well short of the green and cleared by the same margin.

import { defineCourse } from './builder';
import { greensideHazard, hole } from './builder';
import type { GreenDef, HoleBloom } from '../terrain';

// BLOSSOM — the reason 13 of these 18 holes carry a `bloom` field.
//
// Augusta names all but five of its holes after a flowering plant, and every one
// of them used to render a plain green tree line: the visual gate counted ZERO
// pink pixels on Pink Dogwood, Azalea and Redbud. That is the sharpest example
// of /GRAPHICS.md's thesis — the gap is CONTENT, not the renderer — because no
// engine change fixes a hole named for a flower nobody modelled.
//
// So the blossom is authored HERE, as data (terrain.ts "THE CANOPY"), one entry
// per namesake plant in roughly the colour that plant actually flowers. It is a
// render tint only: it changes no lie, no collision volume and no ball path, and
// it rides the grove's existing instanced leaf batch, so it costs no draw calls.
// The five holes named for non-flowering plants — 1 Tea Olive (tiny, hidden
// white flowers), 6 Juniper, 7 Pampas, 14 Chinese Fir, 18 Holly — deliberately
// get NO bloom and render exactly as before.
//
// `fraction` is the share of a hole's BROADLEAF trees that flower (pines never
// do), and is deliberately below 1: a uniformly pink grove reads as paint. It is
// pushed higher on the three signature flowering holes (2, 13, 16) and on the
// short par 3s, where the corridor is short enough that only a handful of trees
// are ever in frame.
//
// ⚠ APRIL, AND THE RIGHT PLANT. The visual gate passed 2, 13 and 16 and rejected
// 12, 15 and 17 — every warm-hued hole and no other — for reading as autumn. Two
// distinct mistakes were behind it, and both are easy to repeat:
//
//   1. THE WRONG SEASON'S FEATURE. 15 Firethorn and 17 Nandina were authored
//      from the colour those plants are famous for: pyracantha's orange berries
//      and nandina's red ones. Both are AUTUMN/WINTER features. The Masters is
//      played in April, when pyracantha carries white flower corymbs and nandina
//      white panicles with yellow anthers. An orange canopy over lush green turf
//      was not a stylisation of spring, it was a correct rendering of October.
//   2. THE WRONG FORM FOR THE HUE. Pink survives a crown tint because nothing in
//      nature is a pink tree in autumn. Yellow, orange and red ARE the autumn
//      palette, so no saturation rescues a tree-sized warm crown. 12 Golden Bell
//      is forsythia — a 2–3 m shrub that flowers on bare wands and is never a
//      canopy tree — so it now uses form: 'understory' (terrain.ts BloomForm):
//      the crowns stay green and the yellow is a low drift beneath them. Green
//      leaves above a warm mass below is a silhouette autumn cannot produce.
const BLOOM = {
  pinkDogwood: { color: 0xf2a0bd, fraction: 0.6 }, // 2
  floweringPeach: { color: 0xef7f9e, fraction: 0.5 }, // 3
  crabApple: { color: 0xf6c6d4, fraction: 0.5 }, // 4
  magnolia: { color: 0xf2dde2, fraction: 0.45 }, // 5 — creamy white, faintly pink
  // 8 — Carolina jessamine, a twining VINE that scrambles over fences and low
  // shrubs and is never a canopy tree either. Same warm-hue problem as 12, found
  // by the data guard in courses.test.ts rather than by eye (0xf2d34e lit as a
  // pale mustard cream), so it takes the same treatment.
  //   `fraction` is 0.85 — HIGHER than 12's 0.8 — because the two holes are not
  // framed alike. 8 is a wide-open uphill tee view onto a DISTANT tree line; 12
  // stands its drift much closer to camera. At 0.6 the hole covered 0.173% of
  // frame against 12's 0.378%, and the visual gate ruled it "under-planted for a
  // hole called Yellow Jasmine": only the near right-hand cluster read as
  // deliberate planting, the rest as dots. Perspective, not the drift, is what
  // costs the area, so the hole that shows its tree line from further away needs
  // MORE flowering trees to read the same — not the same number. 0.85 measures
  // 0.259%.
  //   ⚠ DO NOT RAISE IT FURTHER, and do not chase hole 12's area share. The gate
  // measured both frames at nearly the same horizontal extent (342 px vs 352 px)
  // — 12 reads better because its yellow is two unbroken ribbons where 8's is
  // nine islands, so CONTIGUITY is the variable, not area. 0.85 already puts a
  // drift on 4 of the ~5 broadleaf crowns across 8's far centre, and the far
  // ones desaturate to sat 0.14 under distance haze anyway. The remaining gap is
  // drift SPAN and fog handling (GOLF.md defect 16), not `fraction`.
  yellowJasmine: { color: 0xfbc70e, fraction: 0.85, form: 'understory' }, // 8
  carolinaCherry: { color: 0xf0efe0, fraction: 0.5 }, // 9 — white racemes
  camellia: { color: 0xd8506e, fraction: 0.5 }, // 10 — deep rose
  whiteDogwood: { color: 0xf3f2e8, fraction: 0.5 }, // 11
  // 12 — forsythia, on bare arching wands in early spring. Chrome lemon
  // (sat 0.93) rather than the old 0xf5c531 (sat 0.80, which lit as gold and
  // shaded to olive khaki), and 'understory' because forsythia is a shrub: the
  // yellow drifts along the foot of the tree line and the canopy stays green.
  // `fraction` goes UP, not down — a drift is a fraction of a crown's area, so
  // more of them are needed to read as a planting rather than as dots.
  goldenBell: { color: 0xfbdc12, fraction: 0.8, form: 'understory' }, // 12
  azalea: { color: 0xe0508a, fraction: 0.65 }, // 13
  // 15 — pyracantha in APRIL: dense corymbs of clean white flowers. Its orange
  // is the autumn BERRY and does not belong in a Masters-week frame.
  firethorn: { color: 0xf7f8f2, fraction: 0.5 }, // 15
  redbud: { color: 0xcf6ba9, fraction: 0.65 }, // 16
  // 17 — nandina in spring: white panicles, warmed by prominent yellow anthers.
  // Its red is the winter BERRY, likewise out of season.
  nandina: { color: 0xf6efd6, fraction: 0.5 }, // 17
} satisfies Record<string, HoleBloom>;

// −x = dogleg left, +x = dogleg right. Greens are big (r 15–17). Elevation
// (teeElev→greenElev) reflects the up/downhill notes. Each hole's green is passed
// into an IIFE so the pin can reference it (pin sits just inside the green).

const HOLES = [
  // 1 · Tea Olive — P4 445, dogleg RIGHT ~30°, uphill; fairway bunker inside right.
  ((g: GreenDef) =>
    hole({
      id: 1,
      name: 'Tea Olive',
      par: 4,
      yards: 445,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 235, x: 2 },
        { d: 417, x: 107 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [{ kind: 'bunker', d: 255, x: 30, r: 10, depth: -1.6 }],
      terrain: { seed: 201, hilliness: 2.2, hillScale: 34, teeElev: 6, greenElev: 11 },
    }))({ d: 417, x: 107, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 2 · Pink Dogwood — P5 575, dogleg LEFT ~33°, downhill; fairway + greenside bunkers.
  // ⚠ The card says 575 and this hole was authored 585 — the only hole on the
  // property that did not match, and the 10 yd that made the advertised total
  // 7,555 against Augusta National's 7,545. Fixed by SHORTENING THE SECOND LEG
  // rather than by editing the label: leg 2 keeps its bearing (the dogleg is still
  // 32.7°) and is scaled 300.4 → 289.6 yd, which walks the green in along the same
  // line to (523, −175) and the pin with it. Centerline path length 574.8 yd.
  ((g: GreenDef) =>
    hole({
      id: 2,
      name: 'Pink Dogwood',
      bloom: BLOOM.pinkDogwood,
      par: 5,
      yards: 575,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 285, x: -10 },
        { d: 523, x: -175 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 305, x: -42, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -135 }),
      ],
      terrain: { seed: 202, hilliness: 2.6, hillScale: 36, teeElev: 12, greenElev: 5 },
    }))({ d: 523, x: -175, r: 17, raise: 2.4, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 3 · Flowering Peach — P4 350, short dogleg LEFT ~26°; bunkers left.
  ((g: GreenDef) =>
    hole({
      id: 3,
      name: 'Flowering Peach',
      bloom: BLOOM.floweringPeach,
      par: 4,
      yards: 350,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 180, x: -4 },
        { d: 331, x: -83 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        { kind: 'bunker', d: 200, x: -28, r: 8, depth: -1.5 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.7, bearingDeg: 160 }),
      ],
      terrain: { seed: 203, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 9 },
    }))({ d: 331, x: -83, r: 15, raise: 2.4, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.012 }),
  // 4 · Flowering Crab Apple — P3 240, long par 3, gently angled LEFT ~6.4°; bunker.
  // Mid-vertex on the tee→pin ray: 115 · (−27/240) = −12.94 (was −6, aiming 3.4°
  // and 14 yd right of the flag).
  ((g: GreenDef) =>
    hole({
      id: 4,
      name: 'Flowering Crab Apple',
      bloom: BLOOM.crabApple,
      par: 3,
      yards: 240,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 115, x: -12.94 },
        { d: 238, x: -25 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -90 })],
      terrain: { seed: 204, hilliness: 1.8, hillScale: 34, teeElev: 10, greenElev: 8 },
    }))({ d: 238, x: -25, r: 16, raise: 2.2, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 5 · Magnolia — P4 495, dogleg LEFT ~41° uphill; two deep fairway bunkers inside left.
  ((g: GreenDef) =>
    hole({
      id: 5,
      name: 'Magnolia',
      bloom: BLOOM.magnolia,
      par: 4,
      yards: 495,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -8 },
        { d: 428, x: -176 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        // Two staggered bunkers on the INSIDE (left) of the corner, guarding the
        // corner-cutting line — both sit in the left of the fairway, ~8 and ~11 yd
        // left (perpendicular) of the centerline as it swings hard left to the green.
        { kind: 'bunker', d: 270, x: -38, r: 10, depth: -1.9 },
        { kind: 'bunker', d: 295, x: -66, r: 9, depth: -1.9 },
      ],
      terrain: { seed: 205, hilliness: 2.4, hillScale: 35, teeElev: 7, greenElev: 12 },
    }))({ d: 428, x: -176, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 6 · Juniper — P3 180, downhill, angled RIGHT ~9°; tiered green.
  // Mid-vertex on the tee→pin ray: 90 · (28/178) = 14.16 (was 4 — the worst of the
  // four at 6.4° / 20 yd left of the flag, which is why a dead-straight, perfectly
  // clubbed tee shot could not find this green with any club). Straightening it
  // takes the centerline path length to 178.6 against the card's 180; the played
  // yardage is the tee→pin distance (180.2) and is untouched, and a kink big enough
  // to make up the 1.4 yd is exactly what broke the hole.
  ((g: GreenDef) =>
    hole({
      id: 6,
      name: 'Juniper',
      par: 3,
      yards: 180,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 14.16 },
        { d: 176, x: 30 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 34,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -45 })],
      terrain: { seed: 206, hilliness: 1.8, hillScale: 33, teeElev: 14, greenElev: 6 },
    }))({ d: 176, x: 30, r: 16, raise: 2.4, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.012 }),
  // 7 · Pampas — P4 450, narrow tree-lined dogleg RIGHT ~32°; greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 7,
      name: 'Pampas',
      par: 4,
      yards: 450,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 230, x: 4 },
        { d: 415, x: 124 },
      ],
      fairwayHalf: 14,
      fairwayTaper: -2,
      roughHalf: 32,
      green: g,
      hazards: [
        { kind: 'bunker', d: 250, x: 32, r: 9, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -125 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -55 }),
      ],
      terrain: { seed: 207, hilliness: 2.0, hillScale: 33, teeElev: 8, greenElev: 11 },
    }))({ d: 415, x: 124, r: 15, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 8 · Yellow Jasmine — P5 570, uphill dogleg LEFT ~32°; fairway + greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 8,
      name: 'Yellow Jasmine',
      bloom: BLOOM.yellowJasmine,
      par: 5,
      yards: 570,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: -8 },
        { d: 519, x: -176 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [
        { kind: 'bunker', d: 295, x: -42, r: 11, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: 160 }),
      ],
      terrain: { seed: 208, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 519, x: -176, r: 17, raise: 2.6, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 9 · Carolina Cherry — P4 460, dogleg LEFT ~39°; downhill then uphill green.
  ((g: GreenDef) =>
    hole({
      id: 9,
      name: 'Carolina Cherry',
      bloom: BLOOM.carolinaCherry,
      par: 4,
      yards: 460,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 240, x: -6 },
        { d: 407, x: -149 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [
        { kind: 'bunker', d: 260, x: -36, r: 9, depth: -1.7 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 209, hilliness: 2.4, hillScale: 35, teeElev: 10, greenElev: 12 },
    }))({ d: 407, x: -149, r: 16, raise: 3.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 10 · Camellia — P4 495, SHARP dogleg LEFT ~49° (signature), big downhill; bunker.
  ((g: GreenDef) =>
    hole({
      id: 10,
      name: 'Camellia',
      bloom: BLOOM.camellia,
      par: 4,
      yards: 495,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 245, x: -10 },
        { d: 402, x: -204 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [
        // Fairway bunker on the INSIDE (left) fairway edge of the sharp corner
        // (~14 yd left, perpendicular, of the centerline), tempting the aggressive
        // corner-cutting drive.
        { kind: 'bunker', d: 268, x: -60, r: 9, depth: -1.9 },
        greensideHazard(g, 4, { kind: 'bunker', r: 9, depth: -2.0, bearingDeg: 20 }),
      ],
      terrain: { seed: 210, hilliness: 2.8, hillScale: 36, teeElev: 14, greenElev: 4 },
    }))({ d: 402, x: -204, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 11 · White Dogwood — P4 520, downhill dogleg LEFT ~29°; POND left of green (water).
  ((g: GreenDef) =>
    hole({
      id: 11,
      name: 'White Dogwood',
      bloom: BLOOM.whiteDogwood,
      par: 4,
      yards: 520,
      pin: { d: g.d + 2, x: g.x + 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 260, x: -6 },
        { d: 483, x: -139 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: 175 })],
      terrain: { seed: 211, hilliness: 2.4, hillScale: 35, teeElev: 12, greenElev: 5 },
    }))({ d: 483, x: -139, r: 16, raise: 2.2, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 12 · Golden Bell — P3 155, Rae's Creek WATER fronts a shallow, wide green; near-straight.
  // Mid-vertex on the tee→pin ray: 80 · (−11/157) = −5.61 (was 0, aiming 4.0° and
  // 11 yd right of the flag — over the creek's widest point).
  ((g: GreenDef) =>
    hole({
      id: 12,
      name: 'Golden Bell',
      bloom: BLOOM.goldenBell,
      par: 3,
      yards: 155,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 80, x: -5.61 },
        { d: 155, x: -9 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.0, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 90 }),
      ],
      terrain: { seed: 212, hilliness: 1.6, hillScale: 32, teeElev: 8, greenElev: 7 },
    }))({ d: 155, x: -9, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 13 · Azalea — P5 545, SHARP dogleg LEFT ~47° (signature); Rae's Creek WATER fronts.
  ((g: GreenDef) =>
    hole({
      id: 13,
      name: 'Azalea',
      bloom: BLOOM.azalea,
      par: 5,
      yards: 545,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 250, x: -12 },
        { d: 441, x: -236 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 44,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 13, depth: -2.2, bearingDeg: -40 })],
      terrain: { seed: 213, hilliness: 2.6, hillScale: 36, teeElev: 9, greenElev: 8 },
    }))({ d: 441, x: -236, r: 16, raise: 2.0, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 14 · Chinese Fir — P4 440, dogleg RIGHT ~30°, NO bunkers; heavily contoured green.
  ((g: GreenDef) =>
    hole({
      id: 14,
      name: 'Chinese Fir',
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 220, x: 4 },
        { d: 409, x: 117 },
      ],
      fairwayHalf: 17,
      fairwayTaper: -3,
      roughHalf: 40,
      green: g,
      hazards: [],
      terrain: { seed: 214, hilliness: 2.4, hillScale: 34, teeElev: 8, greenElev: 11 },
    }))({ d: 409, x: 117, r: 17, raise: 2.8, tiltPct: 0.045, tiltDir: Math.PI, undulation: 0.014 }),
  // 15 · Firethorn — P5 550, dogleg RIGHT ~27°; POND fronts the green (water).
  ((g: GreenDef) =>
    hole({
      id: 15,
      name: 'Firethorn',
      bloom: BLOOM.firethorn,
      par: 5,
      yards: 550,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 270, x: 6 },
        { d: 517, x: 138 },
      ],
      fairwayHalf: 18,
      fairwayTaper: -3,
      roughHalf: 42,
      green: g,
      hazards: [greensideHazard(g, 4, { kind: 'water', r: 14, depth: -2.4, bearingDeg: -125 })],
      terrain: { seed: 215, hilliness: 2.4, hillScale: 36, teeElev: 10, greenElev: 9 },
    }))({ d: 517, x: 138, r: 16, raise: 2.0, tiltPct: 0.038, tiltDir: Math.PI, undulation: 0.01 }),
  // 16 · Redbud — P3 170, played over a POND (water carry), angled RIGHT ~3°.
  // Mid-vertex on the tee→pin ray: 90 · (9/171) = 4.74 (was 0, aiming 3.0° and 9 yd
  // left of the flag — into the pond).
  ((g: GreenDef) =>
    hole({
      id: 16,
      name: 'Redbud',
      bloom: BLOOM.redbud,
      par: 3,
      yards: 170,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 90, x: 4.74 },
        { d: 169, x: 11 },
      ],
      fairwayHalf: 13,
      roughHalf: 30,
      green: g,
      hazards: [
        greensideHazard(g, 4, { kind: 'water', r: 15, depth: -2.2, bearingDeg: -90 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 7, depth: -1.6, bearingDeg: 20 }),
      ],
      terrain: { seed: 216, hilliness: 1.6, hillScale: 32, teeElev: 9, greenElev: 8 },
    }))({ d: 169, x: 11, r: 16, raise: 1.8, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
  // 17 · Nandina — P4 440, uphill dogleg RIGHT ~28°; fairway + greenside bunkers.
  ((g: GreenDef) =>
    hole({
      id: 17,
      name: 'Nandina',
      bloom: BLOOM.nandina,
      par: 4,
      yards: 440,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 225, x: 2 },
        { d: 413, x: 106 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 38,
      green: g,
      hazards: [
        { kind: 'bunker', d: 245, x: 30, r: 9, depth: -1.8 },
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -120 }),
        greensideHazard(g, 4, { kind: 'bunker', r: 8, depth: -1.8, bearingDeg: -60 }),
      ],
      terrain: { seed: 217, hilliness: 2.2, hillScale: 34, teeElev: 7, greenElev: 12 },
    }))({ d: 413, x: 106, r: 16, raise: 2.6, tiltPct: 0.042, tiltDir: Math.PI, undulation: 0.01 }),
  // 18 · Holly — P4 465, dogleg RIGHT ~37° (signature) uphill; two fairway bunkers inside right.
  ((g: GreenDef) =>
    hole({
      id: 18,
      name: 'Holly',
      par: 4,
      yards: 465,
      pin: { d: g.d + 2, x: g.x - 2 },
      centerline: [
        { d: 0, x: 0 },
        { d: 230, x: 8 },
        { d: 413, x: 156 },
      ],
      fairwayHalf: 16,
      fairwayTaper: -3,
      roughHalf: 39,
      green: g,
      hazards: [
        { kind: 'bunker', d: 250, x: 36, r: 10, depth: -1.8 },
        { kind: 'bunker', d: 285, x: 46, r: 9, depth: -1.8 },
      ],
      terrain: { seed: 218, hilliness: 2.6, hillScale: 36, teeElev: 6, greenElev: 13 },
    }))({ d: 413, x: 156, r: 16, raise: 2.6, tiltPct: 0.04, tiltDir: Math.PI, undulation: 0.01 }),
];

export const AUGUSTA = defineCourse(
  { id: 'augusta', name: 'Augusta National', location: 'Augusta, Georgia' },
  HOLES,
);
