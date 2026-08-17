// The city beyond the park — a tapered concrete tower with an observation pod,
// and a cluster of rectangular high-rises.
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

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  FrontSide,
  Group,
  Mesh,
  MeshLambertMaterial,
} from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import { DEG, mergeGeometries } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import { buildWindowTexture } from './windows';

/** Fixed seed. Determinism is a hard gate — see the header. */
const SKYLINE_SEED = 20260817;

/**
 * Bearing of the tower, deg, in the park's own frame. SCENE-ONLY.
 *
 * ⚠ CHOSEN AGAINST A FRUSTUM, NOT BY TASTE. The `flight` camera's horizontal
 * half-FOV at 900×1600 portrait is 16.3° about a fixed axis pointing at centre
 * field, so a landmark at −38° projects 34° off-axis and is simply not in the
 * picture — measured, on the first render of this file. −12° puts it just left
 * of centre above the roof opening, which is also where it sits in the
 * reference photography.
 */
const TOWER_BEARING_DEG = -12;

/**
 * How far out the tower stands, ft. SCENE-ONLY.
 *
 * ⚠ PUSHED OUT FROM 1150, AND THE REASON IS A CROP, NOT A LOOK. The visual gate
 * measured the observation pod CLIPPED AT y = 0 in `homerun` — the follow camera
 * tips up to hold a ball near its apex, and a 790 ft tower 1150 ft out subtends
 * 34.5° of elevation, which walks straight off the top of a 55° frame. At
 * 1500 ft it subtends 27.8°, which clears. It is the honest fix as well as the
 * cheap one: a downtown landmark reads as a landmark by being FAR, and shortening
 * the tower to fit a frustum would have been fitting the world to the camera.
 */
const TOWER_DIST_FT = 1500;

/** Sides on the tower's shell. 12 reads round at this distance and costs 24 tris a band. */
const TOWER_SIDES = 12;

/**
 * The tower's silhouette, as DATA: half-width against height, ft. Original
 * geometry from a silhouette — a tapered shaft, an observation pod two thirds of
 * the way up, a short upper shaft and a mast. SCENE-ONLY, every row.
 */
const TOWER_PROFILE: Array<{ y: number; r: number }> = [
  { y: 0, r: 52 },
  { y: 120, r: 34 },
  { y: 340, r: 24 },
  { y: 560, r: 19 },
  { y: 596, r: 19 },
  { y: 604, r: 44 }, // pod, underside
  { y: 628, r: 47 },
  { y: 652, r: 44 },
  { y: 660, r: 22 }, // pod, top
  { y: 700, r: 17 },
  { y: 706, r: 6 }, // mast
  { y: 790, r: 3 },
];

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

/**
 * Texture `v` the TOWER samples — inside `buildWindowTexture`'s plain lane.
 *
 * ⚠ THE TOWER IS CONCRETE, NOT GLASS. It shares the city's one material (one
 * draw call for the whole skyline is the point of this file), so it cannot have
 * a different map — it has to point at a part of the SAME map that carries no
 * openings. Without this it came back covered in office windows and read as a
 * mesh tube; measured on `homerun.png`, where the tower is 27.8° of elevation
 * and the most-read object in the frame after the ball.
 */
const TOWER_PLAIN_V = 0.03;
const FACADE_PLAIN_TOP = 0.1;

const COLORS = {
  tower: 0xb0b3b0, // weathered concrete
  towerPod: 0x8d9296,
  cityLo: 0x6d7683,
  cityHi: 0x99a4b2,
};

/**
 * Add a flat vertex-colour attribute to a geometry so it can be merged with
 * differently-tinted parts under one material. `Color` does the sRGB → linear
 * conversion, exactly as `stands.ts` explains at length: a hex literal handed
 * straight to a vertex-colour attribute is read as linear and comes out roughly
 * twice as bright as authored.
 */
function tint(geo: BufferGeometry, c: Color, scale = 1): BufferGeometry {
  const n = geo.getAttribute('position')?.count ?? 0;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r * scale;
    arr[i * 3 + 1] = c.g * scale;
    arr[i * 3 + 2] = c.b * scale;
  }
  geo.setAttribute('color', new BufferAttribute(arr, 3));
  return geo;
}

/**
 * A closed n-gon shell of revolution about a vertical axis at `(cx, cz)`.
 *
 * Written here rather than reusing `geom.ring`/`loft` because those are keyed to
 * the PLATE-CENTRED bearing frame — every radius they take is a distance from
 * home — and the tower is not at home plate. Reusing them would have meant
 * passing a fake bearing function, which is the kind of "share it anyway" that
 * makes a helper stop meaning anything.
 */
function shell(
  cx: number,
  cz: number,
  profile: Array<{ y: number; r: number }>,
  sides: number,
): BufferGeometry {
  const rings = profile.length;
  const pos = new Float32Array(rings * sides * 3);
  const idx: number[] = [];
  for (let k = 0; k < rings; k++) {
    const p = profile[k];
    if (!p) continue;
    for (let i = 0; i < sides; i++) {
      const a = (360 / sides) * i * DEG;
      const v = (k * sides + i) * 3;
      pos[v] = cx + Math.cos(a) * p.r;
      pos[v + 1] = p.y;
      pos[v + 2] = cz + Math.sin(a) * p.r;
    }
  }
  for (let k = 0; k + 1 < rings; k++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const a0 = k * sides + i;
      const a1 = k * sides + j;
      const b0 = (k + 1) * sides + i;
      const b1 = (k + 1) * sides + j;
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Point every vertex at the map's plain lane — see `TOWER_PLAIN_V`. */
function plainUV(g: BufferGeometry): BufferGeometry {
  const n = g.getAttribute('position').count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) uv[i * 2 + 1] = TOWER_PLAIN_V;
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}

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

export function buildSkyline({ scene, track, park, quality }: StadiumCtx): StadiumPart {
  const group = new Group();
  group.name = 'skyline';
  scene.add(group);

  // ⚠ DATA, NOT A BRANCH — the same rule `roof.ts` obeys. A downtown park has a
  // city on its horizon; `Alpine Heights` at 5200 ft does not, and the first
  // render of this file put a 790 ft communications tower on a mountain. The
  // difference is a column in `parks.ts`, never an `if (park.id === …)` here.
  if (park.surroundings !== 'city') return { group };

  const rng = mulberry32(SKYLINE_SEED);
  const parts: BufferGeometry[] = [];
  const towerC = new Color(COLORS.tower);
  const podC = new Color(COLORS.towerPod);

  // The tower. Split at the pod so the pod carries its own tint — the one piece
  // of the silhouette a viewer actually reads.
  const tb = TOWER_BEARING_DEG * DEG;
  const tx = Math.sin(tb) * TOWER_DIST_FT;
  const tz = -Math.cos(tb) * TOWER_DIST_FT;
  const podFrom = 4;
  const podTo = 8;
  parts.push(plainUV(tint(shell(tx, tz, TOWER_PROFILE.slice(0, podFrom + 1), TOWER_SIDES), towerC)));
  parts.push(plainUV(tint(shell(tx, tz, TOWER_PROFILE.slice(podFrom, podTo + 1), TOWER_SIDES), podC)));
  parts.push(plainUV(tint(shell(tx, tz, TOWER_PROFILE.slice(podTo), TOWER_SIDES), towerC)));

  // The high-rises. Placed on the far side of the bowl in a band of bearings, at
  // distances that put them outside every camera's near geometry and inside the
  // 6000 ft far plane. Seeded, so the city is the same city every run.
  const lo = new Color(COLORS.cityLo);
  const hi = new Color(COLORS.cityHi);
  const mix = new Color();
  for (let i = 0; i < BUILDINGS; i++) {
    const bearing = (-118 + 236 * (i / (BUILDINGS - 1)) + (rng() * 2 - 1) * 6) * DEG;
    const dist = 950 + rng() * 900;
    const h = 110 + rng() * 330;
    const w = 55 + rng() * 90;
    const d = 55 + rng() * 90;
    const box: BufferGeometry = new BoxGeometry(w, h, d);
    box.translate(Math.sin(bearing) * dist, h / 2, -Math.cos(bearing) * dist);
    // Taller reads paler — aerial perspective, and it separates the cluster.
    mix.copy(lo).lerp(hi, Math.min(1, h / 440));
    parts.push(facadeUV(tint(box, mix, 0.92 + rng() * 0.16), FACADE_TILE_FT));
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

  return { group };
}
