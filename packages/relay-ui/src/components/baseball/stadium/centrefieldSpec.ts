// THE CENTRE-FIELD ELEVATION, AS DATA — every dimension of the board array, its
// panel gaps, the recess the deck is cut to and the colours of the surround.
//
// ⚠ IT IS A SEPARATE FILE FOR THE REASON `parkValidate.ts` IS ONE: the 500-line
// cap, and a seam that was already there. `stands.ts` needs four of these
// numbers to cut its recess and NOTHING else about the building, and the board
// slice needs `CENTREFIELD_BOARD` and `CENTREFIELD_PANELS` and nothing else at
// all. With the constants in the builder, `stands.ts` had to import from a
// module that imports `stands.ts` back for a type; with them here the graph is
// a tree. Data on one side, geometry on the other — the same split `parks.ts`
// makes for the fence.

/**
 * ⚠ THE BOARD ARRAY'S REAL GEOMETRY — THE HANDOFF CONSTANT.
 *
 * The board slice TAKES these and throws if its own legibility floor is not met
 * at this size, which is what stops a board rendering unreadable text while
 * every test still passes. So this is a contract, not a hint:
 *
 *   • `widthFt` / `heightFt` — the array's overall face, all panels together.
 *   • `faceDistFt` — plate-centred distance to that face, along `bearingDeg`.
 *   • `sillFt` — height of its BOTTOM edge above field level. The board slice
 *     needs this to place the array; a width and a height alone do not say
 *     where it hangs.
 *   • `bearingDeg` — 0, dead centre. Stated rather than assumed.
 *
 * 100 × 50 ft at 430 ft is the size the visual gate verified against this bowl
 * (505 × 262 px, 56 % of frame width, ~half the bowl's visible height) and this
 * file did NOT move it. The surround is sized around it, not the other way
 * round: the frame's opening is `BOARD_CLEARANCE_FT` larger on every side, and
 * everything else is derived from the frame.
 */
export const CENTREFIELD_BOARD = {
  widthFt: 100,
  heightFt: 50,
  faceDistFt: 430,
  sillFt: 26,
  bearingDeg: 0,
} as const;

/**
 * ⚠ THE PANEL GAPS, AND THEY ARE GEOMETRY RATHER THAN DECORATION.
 *
 * The array is four panels — an 18 ft stats column, a 60 ft main screen, an
 * 18 ft pitcher column, and a 98 ft linescore strip under them — separated by a
 * 1.0 ft frame gap. The board's ATLAS deliberately leaves those texels empty so
 * that a dark structural member shows through, and that is what makes the array
 * read as four panels set into a building instead of one rectangle. If nothing
 * is behind the gaps the two halves disagree and the effect is lost, so the
 * mullions are built HERE, at the board plane, from these numbers:
 *
 *     ├1├────18────┤1├──────────60──────────┤1├────18────┤1┤   = 100 ft
 *
 * i.e. the 98 ft run is centred with a 1 ft margin either side, which is the
 * only arrangement in which 18 + 1 + 60 + 1 + 18 and a 98 ft linescore are both
 * true of a 100 ft board.
 *
 * ⚠ `upperFt` IS THE ONE NUMBER HERE THAT IS NOT GIVEN, and it is flagged. The
 * board slice publishes the widths and the gap but not the split between the
 * upper row and the linescore strip, so 38 / 1 / 11 is chosen and stated. It is
 * a SAFE assumption rather than a guess about someone else's data: the
 * horizontal mullion sits BEHIND the board plane, so if the real split differs
 * the mismatch shows a dark bar behind a lit panel (invisible) and the actual
 * gap falls on the recess's own dark back wall (indistinguishable). Nothing
 * breaks; the gap simply reads one shade less crisply than it could.
 */
export const CENTREFIELD_PANELS = {
  gapFt: 1,
  statsWidthFt: 18,
  mainWidthFt: 60,
  pitcherWidthFt: 18,
  linescoreWidthFt: 98,
  upperFt: 38,
  linescoreFt: 11,
} as const;

/** Gap between the array's edge and the frame's opening, ft. SCENE-ONLY. */
export const BOARD_CLEARANCE_FT = 3;

/** How far BEHIND the board plane the mullions sit, ft. SCENE-ONLY. */
export const MULLION_BEHIND_FT = 0.6;

/**
 * The elevation, as DATA, ft above field level. SCENE-ONLY — nothing in the
 * physics reads any of it, and `resolveFence` does not know this structure
 * exists (a ball that reaches 430 ft at 26 ft of height has already cleared a
 * 400 ft wall and been ruled a home run).
 */
export const PLINTH_TOP_FT = 22;
export const FRAME_BOTTOM_FT = CENTREFIELD_BOARD.sillFt - BOARD_CLEARANCE_FT - 1;
export const FRAME_TOP_FT =
  CENTREFIELD_BOARD.sillFt + CENTREFIELD_BOARD.heightFt + BOARD_CLEARANCE_FT + 5;
export const WINDOW_BOTTOM_FT = FRAME_TOP_FT + 2;
export const STOREY_FT = 8.5;
export const WINDOW_STOREYS = 4;
export const WINDOW_TOP_FT = WINDOW_BOTTOM_FT + STOREY_FT * WINDOW_STOREYS;
/**
 * ⚠ THE WHOLE ASSEMBLY MUST FIT UNDER `stands.deckTopFt`, WHICH IS 130 ft HERE,
 * AND THE FIRST DRAFT DID NOT — it summed to 131, `buildCentrefield` took its
 * own "the deck cannot hold it" early return, and the harness printed 25 draws
 * where 28 were expected. That guard is right (a park with a low roof squeezes
 * the bowl and should not grow a building through the back of it) but it is a
 * SILENT one, so the arithmetic above it has to be checked rather than assumed:
 * 22 → 84 frame, 86 → 120 windows, 120 → 129 banners.
 */
export const BANNER_TOP_FT = WINDOW_TOP_FT + 9;

/**
 * Plate-centred radii of the three layers, ft. SCENE-ONLY.
 *
 * ⚠ THE FRAME STANDS PROUD OF THE BOARD, WHICH IS THE WHOLE POINT OF THE PHOTO.
 * `FRAME_R < CENTREFIELD_BOARD.faceDistFt` is what makes the array read as
 * recessed; reverse the inequality and it reads as a sign screwed to a wall.
 * The window band steps back again, and the banners hang forward of it.
 */
export const FRAME_R_FT = 425;
export const RECESS_BACK_R_FT = 436;
export const WINDOW_R_FT = 434;
export const BANNER_R_FT = 429;

/** Half-widths, ft, at each layer's own radius. SCENE-ONLY. */
export const FRAME_HALF_FT = 66;
export const BUILDING_HALF_FT = 78;

export const halfDegAt = (halfFt: number, rFt: number) => (Math.atan(halfFt / rFt) * 180) / Math.PI;

/** Half-angle of the frame's opening — the hole the array is mounted in. */
export const OPENING_HALF_DEG = halfDegAt(
  CENTREFIELD_BOARD.widthFt / 2 + BOARD_CLEARANCE_FT,
  CENTREFIELD_BOARD.faceDistFt,
);
export const FRAME_HALF_DEG = halfDegAt(FRAME_HALF_FT, FRAME_R_FT);
export const BUILDING_HALF_DEG = halfDegAt(BUILDING_HALF_FT, WINDOW_R_FT);

/**
 * ⚠ THE RECESS IN THE SEATING DECK — the number `stands.ts` reads.
 *
 * Half-angle of the wedge in which the bowl carries no seating at all, because
 * this structure occupies it. It is the BUILDING's half-angle plus a margin, not
 * the board's: the assembly is wider than the array, and seats drawn behind an
 * opaque 122 ft wall are triangles nobody will ever see.
 */
export const RECESS_HALF_DEG = BUILDING_HALF_DEG + 0.6;

/**
 * Height the recess runs to, ft. Everything below this in the wedge is
 * structure; `stands.ts` lifts its whole profile above it.
 */
export const RECESS_TOP_FT = BANNER_TOP_FT;

/** How far out the recess pushes the deck's front, ft — clear of the back wall. */
export const RECESS_STANDOFF_FT = RECESS_BACK_R_FT + 4;

/**
 * The two bearings a ring MUST sample exactly, so the recess's side walls are
 * vertical at every quality tier rather than wherever the step happened to fall.
 * See `geom.ring`'s `extraBearings`.
 */
export const RECESS_EDGE_BEARINGS: readonly number[] = [
  -RECESS_HALF_DEG - 1e-4,
  -RECESS_HALF_DEG + 1e-4,
  RECESS_HALF_DEG - 1e-4,
  RECESS_HALF_DEG + 1e-4,
];

/**
 * ⚠ COLOURS ARE A SCHEME, NOT A MARK — the same line `stands.ts` and
 * `ip.test.ts` draw. A dark structural frame, warm-lit windows and a mixed
 * banner palette are observations about how a building photographs, and nothing
 * here reproduces a logo, a wordmark or a livery.
 */
export const COLORS = {
  // ⚠ AUTHORED A STOP OR TWO BRIGHTER THAN THEY SHOULD LOOK, which is the same
  // note `stands.ts` carries on its backstop padding and for the same reason:
  // every one of these faces the PLATE, i.e. across the one sun rather than into
  // it, so they are carried largely by the hemisphere fill. The first draft used
  // 0x2b2f36 / 0x3a3f47 and the `batter` frame — where this assembly fills the
  // whole upper half at the 20° lens — came back at luminance 13.7, i.e. a void.
  plinth: 0x4a505a,
  frame: 0x5d646f,
  // ⚠ THE RECESS'S BACK WALL IS NOT THE DARKEST THING HERE, AND THE TWO EARLIER
  // DRAFTS THAT MADE IT SO WERE BOTH WRONG ON THE RENDER. It is in the ROOF's
  // shadow — the sun is behind the plate, the roof ring is 282 ft up, and the
  // whole centre-field elevation sits in it — so a colour chosen to "read deep"
  // arrives at the eye ~2.5× darker again. Measured in `batter.png`, where at
  // the 20° lens this one surface is 30 % of the frame: 0x1a1d22 gave luminance
  // 13.7 and 0x24282f gave 14.3, i.e. a void either way. Depth here is bought by
  // the frame standing PROUD of it (see the radii), not by making it black.
  reveal: 0x5a616b,
  // ⚠ THE MULLIONS ARE THE DARKEST THING IN THE ASSEMBLY, AND THEY ARE WHY THE
  // BACK WALL NEED NOT BE. What has to read dark is the 1 ft GAP between two
  // panels — that is the whole content of "the array is four panels, not one
  // rectangle" — and a 1 ft bar at 430 ft is 0.13° wide, which needs contrast
  // rather than area. Putting the contrast in a member 0.6 ft behind the board
  // plane gets it exactly where the atlas leaves texels empty, and lets the
  // recess's own back wall stay light enough not to be a void in the frame it
  // fills half of.
  mullion: 0x24282f,
  soffit: 0x6d7480,
  building: 0x9aa0aa,
  pole: 0xa8aeb6,
};

