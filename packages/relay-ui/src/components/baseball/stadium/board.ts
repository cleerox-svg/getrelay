// THE BOARD ARRAY, MOUNTED — where the picture becomes an object in the park,
// and where the home-run celebration chain is wired end to end.
//
// ⚠ THIS FILE IS THE SEAM `scoreboard.ts` DELIBERATELY LEFT OPEN. That module
// says so in its own header: "IT SUPPLIES THE PICTURE, NOT THE OBJECT. The
// caller builds the quads and the materials and places them in the park." This
// is the caller. Nothing here draws a glyph, decides a layout or invents a
// number; it converts UV rects and feet into four quads, hands one texture to
// one material, and drives three surfaces off one `(BoardArray, tS)`.
//
// ---------------------------------------------------------------------------
// FOUR QUADS, ONE DRAW CALL
// ---------------------------------------------------------------------------
// The array is a stats column, a main video panel, a pitcher column and a
// linescore strip. Each reads its OWN UV rect out of ONE atlas, and the four are
// merged into one geometry under one material, so the whole array is a single
// draw call — which is what `boardAtlas.ts` laid the atlas out as a scale model
// of the board FOR.
//
// ⚠ AND THE GAPS BETWEEN THEM ARE THE WHOLE POINT. Four quads with 1 ft of air
// between them, against a dark backing panel 0.6 ft behind
// (`centrefield.boardBacking`), is what makes the array read as an ARRAY instead
// of one rectangle. The board slice found the failure mode by RENDERING it:
// panels the same shade as the frame collapse the effect entirely, so the atlas
// paints an idle panel LIT-BUT-EMPTY and the backing is the darkest thing in the
// assembly.
//
// ---------------------------------------------------------------------------
// FLAT, NOT ON A RING
// ---------------------------------------------------------------------------
// Every other surface of the centre-field elevation follows the bowl's ring,
// because a 150 ft flat wall tangent to a 434 ft ring has its corners 6.4 ft
// behind it. A VIDEO BOARD IS FLAT — and the atlas's UV rects are a rectangle,
// so a curved face would shear the picture. 100 ft of chord at 430 ft is 2.9 ft
// of sagitta, less than the step-back between two of this assembly's own layers,
// and `centrefield.ts` builds the backing flat to match.
//
// ---------------------------------------------------------------------------
// THE RIBBON IS A MATERIAL SWAP, NOT A MESH
// ---------------------------------------------------------------------------
// `stands.ts` already builds both ribbon bands as ONE merged unlit mesh and
// publishes a one-sentence contract: `u` runs 0 → 1 once around the ring, and it
// sets no `wrapS`, `repeat` or `offset`. Those belong here. So the lit ring that
// sweeps during a home run costs **zero** extra draw calls — it is the band that
// was already there, with a map on it.
//
// ---------------------------------------------------------------------------
// DETERMINISM
// ---------------------------------------------------------------------------
// No clock, no `Math.random`. `tS` is an argument, quantised downstream by
// `boardAnimFrame` (12 Hz) and `ribbonOffsetU` / `towerState` (60 Hz), so a
// frozen scene clock freezes every surface on the same frame and two runs of the
// harness produce the same texels and the same texture offsets.

import { BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import type { Park } from '../../../lib/baseball/parks';
import { CENTREFIELD_BOARD } from './centrefieldSpec';
import { mergeGeometries } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import type { SkylinePart } from './skyline';
import type { StandsPart } from './stands';
import { boardAnimFrame } from './boardPaint';
import { towerState } from './boardRibbon';
import type { BoardGeometry, BoardPanelId } from './boardAtlas';
import { buildScoreboard } from './scoreboard';
import type { BoardArray, ScoreboardHandle } from './scoreboard';

/** One panel's rectangle AS BUILT, scene ft. The gate's read-back seam. */
export interface BoardPanelRect {
  id: BoardPanelId;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z: number;
  uv: { u0: number; v0: number; u1: number; v1: number };
}

export interface BoardPart extends StadiumPart {
  /**
   * Show `array`, `tS` seconds after the current screen appeared. Returns TRUE
   * if either texture actually re-uploaded.
   *
   * ⚠ IT DRIVES THE WHOLE CHAIN, AND THAT IS DELIBERATE. Board, ribbon and tower
   * are one call, exactly as `boardAtlas.boardArrayOps` makes the board's own
   * four panels one call: an eruption that can be half-wired is an eruption that
   * WILL be half-wired the first time a caller forgets a line.
   */
  update(array: BoardArray, tS: number): boolean;
  /**
   * The picture surfaces, for read-back — uploads, keys, op lists. `null` in a
   * park with no centre-field structure to mount an array in, which is a park
   * that should not be paying for two canvases either.
   */
  scoreboard: ScoreboardHandle | null;
  /** The geometry the board was actually built at. */
  geometry: BoardGeometry;
  /** Every panel as built, scene ft. Empty if the board did not build. */
  panels: BoardPanelRect[];
}

/**
 * Derive the array's `BoardGeometry` from what the scene ACTUALLY BUILT.
 *
 * ⚠ THE RIBBON HALF IS MEASURED, NOT TYPED, AND THAT IS THE POINT OF IT BEING A
 * FUNCTION. `boardAtlas.BOARD_GEOMETRY` carries a nominal 5 ft band on a 300 ft
 * ring as its default; the bowl's real ribbon is `stands.ribbonHeightFt` tall
 * and its ring is `stands.ribbonRingFt` long, and the tile count that keeps a
 * ribbon glyph the same SHAPE in the park as on the texture is derived from
 * those. Hand-setting either stretches the typeface — which is exactly what
 * `boardRibbon.ribbonWraps`'s note says it is computed to avoid.
 *
 * The equivalent radius is `ring / 2π`: this bowl is not a circle (60 ft behind
 * the plate, 530 in centre) so no radius describes it, but `ribbonWraps` only
 * ever uses `2πr`, i.e. the circumference, which IS measurable.
 */
export function boardGeometryFor(stands: StandsPart): BoardGeometry {
  return {
    widthFt: CENTREFIELD_BOARD.widthFt,
    heightFt: CENTREFIELD_BOARD.heightFt,
    faceDistFt: CENTREFIELD_BOARD.faceDistFt,
    ribbonHeightFt: stands.ribbonHeightFt,
    ribbonRadiusFt: stands.ribbonRingFt / (2 * Math.PI),
  };
}

/**
 * Where every panel of the array goes, in SCENE feet — PURE, and exported so a
 * test can assert the placement without a WebGL context or a DOM.
 *
 * ⚠ DERIVED FROM THE ATLAS'S OWN UV RECTS AND NOTHING ELSE. There is no second
 * panel table here to keep in step with `BOARD_PANEL_SPECS` — the same argument
 * `boardAtlas.ts` makes for deriving `uv` from `xFt` rather than authoring it,
 * carried one layer out into the geometry. `u` runs left → right across the
 * board as the batter sees it (scene +x is the umpire's right, per `geom.ts`)
 * and `v` runs bottom → top from the sill.
 */
export function boardPanelRects(
  panels: ScoreboardHandle['panels'],
  geometry: BoardGeometry,
  sillFt: number,
): BoardPanelRect[] {
  const { widthFt: W, heightFt: H, faceDistFt: D } = geometry;
  return panels.map((p) => ({
    id: p.id,
    x0: (p.uv.u0 - 0.5) * W,
    x1: (p.uv.u1 - 0.5) * W,
    y0: sillFt + p.uv.v0 * H,
    y1: sillFt + p.uv.v1 * H,
    z: -D,
    uv: p.uv,
  }));
}

/**
 * One flat panel quad, facing the plate, carrying its own slice of the atlas.
 *
 * Winding is `(0,1,2) (0,2,3)` over bottom-left → bottom-right → top-right →
 * top-left, which puts the face normal along +z — toward the plate — for a quad
 * at negative z. Derived, not flipped until it looked right: the edge vectors
 * are `(+w, 0, 0)` and `(0, +h, 0)`, whose cross product is `+z`.
 */
function panelQuad(r: BoardPanelRect): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    'position',
    new BufferAttribute(
      new Float32Array([
        r.x0, r.y0, r.z,
        r.x1, r.y0, r.z,
        r.x1, r.y1, r.z,
        r.x0, r.y1, r.z,
      ]),
      3,
    ),
  );
  g.setAttribute(
    'uv',
    new BufferAttribute(
      new Float32Array([r.uv.u0, r.uv.v0, r.uv.u1, r.uv.v0, r.uv.u1, r.uv.v1, r.uv.u0, r.uv.v1]),
      2,
    ),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/**
 * What the array shows when nobody is driving it.
 *
 * ⚠ IT IS NOT OPTIONAL AND IT IS NOT DECORATION. A `CanvasTexture` over a canvas
 * nothing has drawn on is fully TRANSPARENT, and an opaque `MeshBasicMaterial`
 * ignores alpha — so a board that is never painted is a 100 × 50 ft BLACK
 * RECTANGLE in dead centre field. Every scene that does not drive the board (the
 * gate's `wide`, `pitcher`, every pitch and flight shot) would have shipped one.
 * `buildBoard` therefore paints this once at build time, and the HUD's feed
 * replaces it whenever there is one.
 *
 * The `label` is the park's own name because `BoardScreen.idle` says `label` is
 * "copy the caller owns" — this module invents no words, and a park's name is
 * data it was handed.
 */
export function idleBoardArray(park: Park): BoardArray {
  return {
    main: { kind: 'idle', label: park.name.toUpperCase() },
    left: null,
    right: null,
    strip: null,
    ribbon: { items: [park.name.toUpperCase()] },
  };
}

export interface BoardOpts {
  stands: StandsPart;
  skyline: SkylinePart;
}

export function buildBoard(ctx: StadiumCtx, opts: BoardOpts): BoardPart {
  const { scene, track, park, quality, daylight } = ctx;
  const group = new Group();
  group.name = 'board';
  scene.add(group);

  const geometry = boardGeometryFor(opts.stands);

  // A park with no centre-field structure has no opening to mount an array in —
  // data, not a branch, exactly as `buildCentrefield` and `buildSkyline` decide
  // it. Alpine Heights is a mountain park with a bare outfield wall, and it
  // does not allocate a 2.0 MB atlas it can never show.
  if (park.surroundings !== 'city' || opts.stands.deckTopFt < CENTREFIELD_BOARD.sillFt) {
    return { group, scoreboard: null, geometry, panels: [], update: () => false };
  }

  // ⚠ IT THROWS ON AN UNREADABLE GEOMETRY AND THAT IS NOT GUARDED AWAY HERE.
  // `buildScoreboard` refuses a board whose smallest glyph lands under
  // `MIN_LEGIBLE_CSS_PX`, because a grey smear in centre field passes every
  // automated check and no player can use it. Wrapping this in a try/catch to
  // "degrade gracefully" would restore precisely the silent failure that guard
  // exists to remove.
  const scoreboard = buildScoreboard({ track, quality, geometry });

  const panels = boardPanelRects(scoreboard.panels, geometry, CENTREFIELD_BOARD.sillFt);
  const quads = panels.map(panelQuad);
  const geo = track(mergeGeometries(quads));
  for (const q of quads) q.dispose();
  // ⚠ UNLIT, LIKE EVERY OTHER SELF-LIT SURFACE IN THIS PARK. A videoboard EMITS;
  // a Lambert board 430 ft away, facing the plate and therefore facing away from
  // the one sun, would be a dim grey rectangle carried entirely by the
  // hemisphere fill — which is the measurement `stands.ts` and `centrefield.ts`
  // both record on their own plate-facing surfaces. It is also what makes the
  // night mode work with no new lights: this material does not know the sun
  // exists, so it is exactly as bright at midnight.
  const mesh = new Mesh(geo, track(new MeshBasicMaterial({ map: scoreboard.texture })));
  mesh.name = 'boardArray';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  // --- THE RIBBON: a map on the band `stands.ts` already built. Zero draw
  // calls. `buildScoreboard` has already set `wrapS` and `repeat.x` on the
  // texture from the geometry above, which is the one place that can be wrong.
  //
  // ⚠ THE PER-SECTION TINT GOES OFF WHEN CONTENT GOES ON. `stands.ts` gives each
  // seating section its own ribbon hue, which reads well on a band that is pure
  // light — but a vertex colour MULTIPLIES the map, so a blue-tinted section
  // would render the celebration's red ground almost black and the train's white
  // text as blue. A real ribbon board is one continuous display; the tint was
  // standing in for content, and content has arrived.
  const ribbonMat = opts.stands.ribbon.material as MeshBasicMaterial;
  ribbonMat.map = scoreboard.ribbon;
  ribbonMat.vertexColors = false;
  ribbonMat.needsUpdate = true;

  const rest = daylight.towerGlow;
  opts.skyline.setGlow(rest, 0);
  // Paint ONCE at build, so a scene with no HUD driving it shows a lit idle
  // board rather than a black rectangle — see `idleBoardArray`.
  scoreboard.update(idleBoardArray(park), 0);

  return {
    group,
    scoreboard,
    geometry,
    panels,
    update(array, tS) {
      const drew = scoreboard.update(array, tS);
      // The SAME frame number the atlas and the ribbon were keyed on — read back
      // off the handle rather than recomputed, so the three surfaces cannot
      // strobe out of step. `current()` reports what was PAINTED.
      const frame = scoreboard.current()?.frame ?? boardAnimFrame(array.main, tS);
      const t = towerState(array, tS, frame, rest);
      opts.skyline.setGlow(t.level, t.offsetV);
      return drew;
    },
  };
}
