// The city beyond the park — a cluster of rectangular high-rises, plus the
// landmark tower's concrete merged into the same mesh.
//
// ⚠ THE TOWER ITSELF IS `stadium/tower.ts`. It left this file at the 500-line
// cap, which is the charter's rule: at a cap the fix is EXTRACTION. What stays
// here is the CITY — a seeded band of boxes — and the one line that merges the
// tower's shells into the same geometry so the whole horizon is one draw call.
//
// ⚠ ARCHITECTURE IS NOT A MARK. A tapered concrete communications tower with a
// pod near the top is a building TYPOLOGY and a downtown skyline is a shape;
// neither is trade dress, no name appears anywhere, and every vertex below is
// generated from a profile written here rather than traced from anything.
// `ip.test.ts` scans this file like every other.
//
// ⚠ ONE MESH. THE WHOLE CITY. Draw calls are the tight budget in this scene
// (~18 to spend across the entire art pass against a ceiling of 40) and
// triangles are not — so the tower's twelve-sided shells and every high-rise box
// are merged into a single geometry with a vertex-colour attribute carrying the
// per-building tint. A box per building would have been seventeen draw calls for
// a thing that occupies a few hundred pixels of sky.
//
// ⚠ AND IT IS SEEDED. Placement, footprint, height and tint all come from
// `mulberry32(SKYLINE_SEED)` — never `Math.random`, because two runs of the
// screenshot harness must produce byte-identical PNGs and a skyline that
// reshuffles is the easiest possible way to break that.

import { BoxGeometry, BufferAttribute, BufferGeometry, Color, FrontSide, Group, Mesh, MeshLambertMaterial } from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import { DEG, mergeGeometries, tintGeometry } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import { buildTowerLights, towerShells } from './tower';
import { towerAnchor } from './towerSpec';
import { buildWindowTexture } from './windows';

/** Fixed seed. Determinism is a hard gate — see the header. */
const SKYLINE_SEED = 20260817;

/**
 * ⚠ THE TOWER'S LED BANDS GET THEIR OWN SEED, MIXED WITH THE SESSION'S.
 *
 * The real landmark runs a programmable strip that is a different colour every
 * night, and the owner asked for it lit "as it is every night". "Every night" is
 * a wall clock, which the whole determinism chapter forbids, so it is per SEED:
 * one session is one programme, and the harness passing a fixed seed gets a
 * fixed tower. Mixing rather than replacing keeps the CITY's placement — which
 * is art, not a nightly programme — pinned to `SKYLINE_SEED` regardless of seed,
 * so a session seed cannot reshuffle the high-rises.
 */
const TOWER_BAND_SEED = 20260821;

/** How many high-rises. SCENE-ONLY. */
const BUILDINGS = 16;

/**
 * Ft per window-map tile on a facade. SCENE-ONLY.
 *
 * ⚠ THE UVs ARE DERIVED FROM WORLD POSITION, NOT FROM `BoxGeometry`'s OWN. A box
 * ships UVs that run 0…1 per FACE, so one shared `repeat` would put the same
 * number of storeys on a 110 ft building and a 440 ft one — windows that grow
 * with the tower. Mapping `u` from `x + z` and `v` from `y` instead makes an
 * opening the same PHYSICAL size on every building, which is the property that
 * makes a skyline read as a skyline with buildings at different distances in it.
 * The ±x and ±z faces disagree by a half-tile at the corners; at 950–1,850 ft
 * that is well under a pixel.
 */
const FACADE_TILE_FT = 34;

/** Texture `v` above which the facade map carries no openings. SCENE-ONLY. */
const FACADE_PLAIN_TOP = 0.1;

/** World-derived facade UVs — see `FACADE_TILE_FT`. */
function facadeUV(g: BufferGeometry, tileFt: number): BufferGeometry {
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + pos.getZ(i)) / tileFt;
    uv[i * 2 + 1] = pos.getY(i) / tileFt;
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

export interface SkylinePart extends StadiumPart {
  /**
   * Drive the tower's LED strips.
   *
   * `level` is an emissive multiplier — the resting `daylight.towerGlow`, or
   * more during a home run. `offsetV` scrolls the chase UP the tower and is a
   * texture offset, so it costs nothing and uploads nothing.
   *
   * ⚠ IT TAKES NUMBERS, NOT A BOARD STATE. The tower does not know what a home
   * run is; `stadium/board.ts` owns the chain and calls this. That is the layer
   * rule inside the scene: one module decides, several render.
   */
  setGlow(level: number, offsetV: number): void;
}

export function buildSkyline({ scene, track, park, quality, seed, daylight }: StadiumCtx): SkylinePart {
  const group = new Group();
  group.name = 'skyline';
  scene.add(group);
  let setGlow: SkylinePart['setGlow'] = () => undefined;

  // ⚠ DATA, NOT A BRANCH — the same rule `roof.ts` obeys. A downtown park has a
  // city on its horizon; `Alpine Heights` at 5200 ft does not, and the first
  // render of this file put a 790 ft communications tower on a mountain. The
  // difference is a column in `parks.ts`, never an `if (park.id === …)` here.
  if (park.surroundings !== 'city') return { group, setGlow };

  const rng = mulberry32(SKYLINE_SEED);
  const parts: BufferGeometry[] = [];

  // The tower's CONCRETE, merged into the same mesh as the city — one draw call
  // for the whole horizon. Its LIGHT is a second mesh; see `tower.ts`.
  const { tx, tz } = towerAnchor();
  parts.push(...towerShells(tx, tz));

  // The high-rises. Placed on the far side of the bowl in a band of bearings, at
  // distances that put them outside every camera's near geometry and inside the
  // 6000 ft far plane. Seeded, so the city is the same city every run.
  // ⚠ THE CITY'S TINT IS A LIGHTING ROW, NOT A CONSTANT HERE, and the two rows
  // are not two shades of the same thing. By day it is concrete, palest at the
  // top of the ramp because that is aerial perspective. At night it is the
  // colour of a LIT WINDOW, because `windows.ts`'s map multiplies and
  // `daylight.cityWallGain` is what pulls the concrete DOWN off it. See
  // `daylightSpec.ts`'s `cityLoHex` / `cityWallGain` — including the
  // measurement that says these buildings were the brightest mass in a night
  // frame, brighter than the floodlit turf.
  const lo = new Color(daylight.cityLoHex);
  const hi = new Color(daylight.cityHiHex);
  const mix = new Color();
  for (let i = 0; i < BUILDINGS; i++) {
    const bearingDeg = -118 + 236 * (i / (BUILDINGS - 1)) + (rng() * 2 - 1) * 6;
    const bearing = bearingDeg * DEG;
    // ⚠ CLOSE AND TALL, NOT A HORIZON — an owner note off a photograph taken
    // from the stands looking toward LEFT FIELD, in which a tower fills a large
    // part of the sky ABOVE the bowl's rim. The band used to be 950–1850 ft out
    // at 110–440 ft tall, which subtends 3.4°–26° and reads as a city seen from
    // a distance; a park wedged into a downtown has buildings LOOMING over the
    // back of the seating.
    //
    // ⚠ AND THE LOOM IS ON THE LEFT-FIELD SIDE, which is the same photograph and
    // is consistent with the tower being to the RIGHT. `lean` is 1 at the
    // left-field foul line and 0 at the right, so the west end of the band comes
    // in closest and stands tallest — a bearing-dependent bias, i.e. still one
    // seeded band and not a special case per building.
    const lean = Math.max(0, Math.min(1, (30 - bearingDeg) / 148));
    const dist = 760 + rng() * 820 - 180 * lean;
    const h = (150 + rng() * 380) * (1 + 0.55 * lean);
    const w = 55 + rng() * 90;
    const d = 55 + rng() * 90;
    const box: BufferGeometry = new BoxGeometry(w, h, d);
    box.translate(Math.sin(bearing) * dist, h / 2, -Math.cos(bearing) * dist);
    // Taller reads paler — aerial perspective, and it separates the cluster.
    mix.copy(lo).lerp(hi, Math.min(1, h / 440));
    parts.push(facadeUV(tintGeometry(box, mix, 0.92 + rng() * 0.16), FACADE_TILE_FT));
  }

  const geo = track(mergeGeometries(parts));
  for (const p of parts) p.dispose();
  // ⚠ ONE WINDOW MAP FOR THE WHOLE CITY, INCLUDING THE TOWER. Measured before:
  // the high-rises were untextured single-colour boxes, i.e. the same defect the
  // ground surfaces had, one layer further out. 24 % lit rather than the hotel
  // band's 42 % — an office block at the same hour is emptier than a hotel.
  const facade = buildWindowTexture({
    px: quality.grainPx,
    cols: 24,
    rows: 24,
    litFraction: 0.24,
    fillU: 0.55,
    fillV: 0.45,
    plainTopFraction: FACADE_PLAIN_TOP,
    // The wall between two openings, AND the plain lane the tower's concrete
    // shells sample — so the shaft falls with the city off one column.
    wallGain: daylight.cityWallGain,
    rng,
  });
  if (facade) track(facade);
  const mesh = new Mesh(
    geo,
    track(
      new MeshLambertMaterial({
        vertexColors: true,
        side: FrontSide,
        ...(facade ? { map: facade } : {}),
      }),
    ),
  );
  mesh.name = 'skyline';
  // ⚠ NOT A SHADOW CASTER AND NOT A RECEIVER. The sun's ortho shadow volume is
  // sized from the BOWL (±630 ft); a 790 ft tower 1250 ft out is entirely
  // outside it, so `castShadow` would buy nothing at best and, if the volume
  // were ever widened to contain it, would cost every texel of a 1024² map that
  // the infield currently spends on the only shadows anybody looks at.
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  // --- THE TOWER'S LIGHT. One extra draw call, and it is the third link of the
  // home-run chain — `stadium/board.ts` drives it. See `tower.ts` for why the
  // strips are vertical, one colour, and brighter at the pod.
  const lights = buildTowerLights(tx, tz, seed, track);
  group.add(lights.mesh);
  setGlow = lights.setGlow;

  return { group, setGlow };
}
