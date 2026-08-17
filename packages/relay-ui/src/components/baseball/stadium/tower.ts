// THE TOWER — the downtown landmark, its concrete silhouette and the LED
// lighting that runs UP it.
//
// ⚠ EXTRACTED FROM `skyline.ts` AT THE CAP, WHICH IS THE RULE. That file hit 632
// lines against a 500-line builder cap when the tower's lighting became a real
// subsystem, and the charter's answer at a cap is EXTRACTION. The seam was
// already there: `skyline.ts` is a CITY, a seeded band of high-rises; this is ONE
// BUILDING with a profile, a programme and an animation.
//
// ⚠ ARCHITECTURE IS NOT A MARK. A tapered concrete communications tower with an
// observation pod near the top is a building TYPOLOGY; no name appears anywhere,
// and every vertex is generated from a profile written here. `ip.test.ts` scans
// this file like every other.
//
// ⚠ THE CONCRETE MERGES INTO THE CITY, THE LIGHT DOES NOT. The shells go back to
// `skyline.ts` for its single Lambert mesh, so the whole horizon is one draw
// call. The lit strips are a SECOND mesh with an UNLIT material, which is not an
// oversight: an unlit surface is exactly as bright at midnight as at noon, and
// that is what carries the night mode with no extra lights.

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  Color,
  DoubleSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { mulberry32 } from '../../../lib/golf/wind';
import { DEG, mergeGeometries, tintGeometry } from './geom';
import type { Track } from './geom';

/**
 * ⚠ THE TOWER'S LEDs GET THEIR OWN SEED, MIXED WITH THE SESSION'S.
 *
 * The real landmark runs a programmable strip that is a different colour every
 * night, and the owner asked for it lit "as it is every night". "Every night" is
 * a wall clock, which the whole determinism chapter forbids, so it is per SEED:
 * one session is one programme, and the harness passing a fixed seed gets a
 * fixed tower. Mixing rather than replacing keeps the CITY's placement — which
 * is art, not a nightly programme — pinned to its own constant regardless of
 * seed, so a session seed cannot reshuffle the high-rises.
 */
const TOWER_SEED = 20260821;

/**
 * Bearing of the tower, deg, in the park's own frame. SCENE-ONLY.
 *
 * ⚠⚠ **+12, NOT −12 — AN OWNER CORRECTION, AND THE SIGN IS THE WHOLE CONTENT.**
 * This shipped at −12° with a comment claiming that was "where it sits in the
 * reference photography". It is not. The owner is a fan of the club, has been to
 * the venue, and looked at `night-homerun.png`: *"The CN tower is on the right
 * side not the left."* Their reference photographs agree — from the stands at
 * night and from field level at dusk, the tower stands to the **RIGHT** of the
 * centre-field structure with the dome roof sweeping away to the left. Scene +x
 * is the first-base side, which is the right-hand side of any frame shot toward
 * centre field (`geom.ts`), so right of the board is a POSITIVE bearing.
 *
 * ⚠ NOTHING BUT THIS NUMBER MOVED, AND THAT IS THE POINT OF IT BEING DATA. No
 * geometry is mirrored, no profile is edited, no camera is re-aimed.
 *
 * ⚠ AND THE MAGNITUDE HAD TO MOVE WITH THE SIGN — 14°, NOT 12°, AND A RENDER IS
 * WHAT SAID SO. The `flight` camera stands at x = −40 and is therefore NOT
 * symmetric about dead centre, so mirroring a bearing does not mirror what the
 * camera sees. Measured from that camera (horizontal half-FOV 16.3°, frame top
 * 20.2° of elevation):
 *
 *     bearing  dist    off-axis            mast tip
 *      −12°   1500 ft   9.9°  (61 % out)    —          ← what shipped, on the LEFT
 *      +12°   1500 ft  12.7°  (78 % out)   22.8°       ← mirrored: CROPPED
 *      +14°   1900 ft  14.5°  (89 % out)   18.5°       ← ships
 *
 * The +12° row is the trap: 12.73° is **exactly** the angle of the centre-field
 * structure's own right edge from that camera, so the mirrored tower emerged
 * from behind the building rather than standing beside it — and its mast ran
 * 2.6° off the top of the frame. Pushing it to 14° and 1900 ft clears the
 * building by 1.8° and the frame's top by 1.7°. Distance is the lever for the
 * VERTICAL crop and bearing for the horizontal, and they are nearly independent:
 * moving a landmark further away does not move it sideways.
 *
 * ⚠⚠ **OPEN, AND IT IS THE CAMERA RATHER THAN THE TOWER.** At 14° the landmark
 * sits at **89 % of the `flight` frame's half-width**, i.e. hard against the
 * right edge, and only its near flank is in the picture. That is not a bearing
 * that can be tuned away: the usable window on that side is 12.73° (the
 * building's own edge) to ~16.3° (the frame's), and the horizontal angle is set
 * almost entirely by the bearing — moving the tower nearer or further barely
 * shifts it sideways. The cause is that `CAMERAS.flight` stands at **x = −40**,
 * which was chosen to favour the PULL corner back when the landmark was on the
 * left; it makes the right-hand half of that frame ~3° narrower in usable terms.
 *
 * So: the tower is now correct in the WORLD — right of the board, clear of the
 * structure, in open sky — and it is edge-of-frame in ONE camera. Re-centring
 * `flight` is a gameplay-framing decision with its own derivation (see
 * `camera.ts` on the follow-pull / follow-oppo asymmetry) and is NOT a thing an
 * art pass should take unilaterally. Recorded here rather than fixed.
 */
const TOWER_BEARING_DEG = 14;

/**
 * How far out the tower stands, ft. SCENE-ONLY.
 *
 * ⚠ PUSHED OUT TWICE, AND BOTH TIMES FOR A CROP RATHER THAN A LOOK. 1150 → 1500
 * because the visual gate measured the observation pod CLIPPED AT y = 0 in
 * `homerun`: the follow camera tips up to hold a ball near its apex, and a
 * 790 ft tower 1150 ft out subtends 34.5° of elevation against a 55° frame.
 * 1500 → 1900 when the tower moved to the RIGHT of the board, because the
 * `flight` camera's asymmetry put the mast 2.6° off the top of the frame on that
 * side — see `TOWER_BEARING_DEG` for the measured table.
 *
 * It is the honest fix as well as the cheap one: a downtown landmark reads as a
 * landmark by being FAR, and shortening the tower to fit a frustum would have
 * been fitting the world to the camera. 1900 ft is well inside the 6000 ft far
 * plane and outside the 3000 ft sky dome's near side.
 */
const TOWER_DIST_FT = 1900;

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


/**
 * Texture `v` the TOWER samples — inside `buildWindowTexture`'s plain lane.
 *
 * ⚠ THE TOWER IS CONCRETE, NOT GLASS. It shares the city's one material, so it
 * cannot have a different map — it points at a part of the SAME map that carries
 * no openings. Without this it came back covered in office windows and read as a
 * mesh tube, measured on `homerun.png`.
 */
const TOWER_PLAIN_V = 0.03;
const FACADE_PLAIN_TOP = 0.1;


const COLORS = { tower: 0xb0b3b0, towerPod: 0x8d9296 };

/**
 * ⚠⚠ **THE LIGHTING RUNS UP THE TOWER, NOT AROUND IT — OWNER CORRECTION.**
 *
 * This shipped as fifteen HORIZONTAL bands in six simultaneous colours. Four
 * night photographs of the real landmark say both halves are wrong:
 * *"the lights go up the tower in a long row"* — the strips are VERTICAL and
 * continuous over the shaft's whole height — and the whole tower is **ONE colour
 * at a time**, red in two of the shots, cyan in a third, magenta in a fourth. A
 * stack of yellow, blue, red and white at once reads as a fairground mast, which
 * is what the render looked like to somebody who had been there.
 *
 * Three parts light SEPARATELY and all three read in the silhouette: the shaft's
 * strips, a **pod ring** brighter than the shaft (the strongest single feature at
 * night), and the **mast** above it, tapering.
 *
 * The schemes below are SCENE-ONLY and a colour scheme rather than a mark —
 * `ip.test.ts` and `stands.ts` both already record that a palette is not trade
 * dress, and "programmable LEDs change colour" is a fact about the hardware.
 */
const TOWER_SCHEMES = [0xe0344c, 0x38c6ff, 0xd44cff, 0x2f6bff];

/** How many vertical strips run the shaft, and how wide each is, deg. */
const STRIP_COUNT = 10;
const STRIP_HALF_DEG = 4.5;
/** How many heights each strip is sampled at — enough to follow the taper. */
const STRIP_ROWS = 14;
/** Bottom of the run and the top of the pod, ft. `TOWER_PROFILE`'s own numbers. */
const STRIP_Y0_FT = 128;
const POD_TOP_FT = 660;
/** How far proud of the shell the light stands, ft — enough to beat z-fighting. */
const STRIP_PROUD_FT = 0.9;

/**
 * Emissive multipliers, relative to the shaft's strips. SCENE-ONLY.
 *
 * ⚠ THE POD IS THE BRIGHTEST THING ON THE TOWER, WHICH IS AN OBSERVATION AND NOT
 * A PREFERENCE. It is the one element that reads at a glance in every night
 * photograph; a pod at the same level as the shaft loses the silhouette.
 */
const POD_GLOW = 1.75;
const MAST_GLOW = 1.25;

/** Chase map height, texels. One column; every lit surface samples one row. */
const CHASE_PX = 64;
/**
 * The chase's floor and its pulse width, as fractions.
 *
 * ⚠ THE MAP CARRIES THE PULSE AND THE MATERIAL CARRIES THE LEVEL, WHICH IS WHAT
 * MAKES THE CELEBRATION FREE. Scrolling `offset.y` is a float assignment — no
 * upload, no re-authored vertex colours — so light travelling up a 530 ft tower
 * costs nothing per frame. A texel cannot exceed 1.0, so the resting brightness
 * is the map's FLOOR and the flash is the material's colour scalar going past 1.
 *
 * ⚠ THE PULSE IS CENTRED ON `v = 0`, NOT `v = 0.5`. The strips run `v` 0 at the
 * foot to 1 at the pod and the map WRAPS, so a pulse at 0 is bright at both ends
 * — uplighting at the base, a lit pod at the top, the shaft between them at the
 * floor, which is what the photographs show. At 0.5 it would be a bright collar
 * halfway up a tower that has nothing there.
 */
const CHASE_FLOOR = 0.62;
const CHASE_WIDTH = 0.3;

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

/** Radius of the tower's own shell at a height, ft — read off `TOWER_PROFILE`. */
function towerRadiusAt(y: number): number {
  const p = TOWER_PROFILE;
  if (y <= (p[0]?.y ?? 0)) return p[0]?.r ?? 0;
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1]!;
    const b = p[i]!;
    if (y <= b.y) {
      const f = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
      return a.r + (b.r - a.r) * f;
    }
  }
  return p[p.length - 1]?.r ?? 0;
}

/**
 * The chase map: one column, `CHASE_PX` rows, a soft pulse over a floor,
 * centred on `v = 0` and wrapping — see `CHASE_FLOOR`.
 *
 * ⚠ CANVAS ROW 0 IS `v = 1`, NOT `v = 0`. A `CanvasTexture`'s first row is the
 * TOP of the image and three's `v` runs UP, so the row index has to be flipped
 * or the pulse ends up centred on the wrong end of the tower — which reads as
 * "the pod is dark and there is a glow halfway up", i.e. as a lighting choice
 * rather than as an inverted axis.
 *
 * Deterministic and unseeded — it is a shape, not a draw. Returns `null` with no
 * DOM, exactly as `buildWindowTexture` and `skyTexture` do, so the strips fall
 * back to a flat lit run rather than the mesh disappearing.
 */
function chaseTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = CHASE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  for (let i = 0; i < CHASE_PX; i++) {
    const v = 1 - (i + 0.5) / CHASE_PX;
    // Distance to v = 0 ON A WRAPPING AXIS, so the pulse is bright at both ends
    // of the run: the base and the pod.
    const d = Math.min(Math.min(v, 1 - v), CHASE_WIDTH) / CHASE_WIDTH;
    const pulse = 0.5 * (1 + Math.cos(Math.PI * d));
    const lvl = Math.round(255 * (CHASE_FLOOR + (1 - CHASE_FLOOR) * pulse));
    ctx.fillStyle = `rgb(${lvl},${lvl},${lvl})`;
    ctx.fillRect(0, i, 1, 1);
  }
  const tex = new CanvasTexture(canvas);
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = RepeatWrapping;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/**
 * A VERTICAL lit strip on the tower's shaft: a narrow ribbon at one bearing,
 * following the shell's own taper from `y0` to `y1` and standing proud of it.
 *
 * `v` runs 0 at `STRIP_Y0_FT` to 1 at `POD_TOP_FT` for EVERY lit part — shaft,
 * pod and mast — so the whole tower shares one parameterisation and a single
 * `offset.y` scroll runs light up all of it in step. The mast is above the pod,
 * so its `v` legitimately exceeds 1 and wraps back onto the pulse's tail, which
 * is why the mast reads lit at rest.
 */
function strip(
  cx: number,
  cz: number,
  bearingRad: number,
  halfRad: number,
  y0: number,
  y1: number,
  rows: number,
): BufferGeometry {
  const pos = new Float32Array(rows * 2 * 3);
  const uv = new Float32Array(rows * 2 * 2);
  const idx: number[] = [];
  for (let k = 0; k < rows; k++) {
    const y = y0 + ((y1 - y0) * k) / (rows - 1);
    const r = towerRadiusAt(y) + STRIP_PROUD_FT;
    for (let s = 0; s < 2; s++) {
      const a = bearingRad + (s === 0 ? -halfRad : halfRad);
      const i = k * 2 + s;
      pos[i * 3] = cx + Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = cz + Math.sin(a) * r;
      uv[i * 2] = s;
      uv[i * 2 + 1] = (y - STRIP_Y0_FT) / (POD_TOP_FT - STRIP_Y0_FT);
    }
    if (k + 1 < rows) {
      const a0 = k * 2;
      idx.push(a0, a0 + 2, a0 + 1, a0 + 1, a0 + 2, a0 + 3);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A lit RING around the tower at one height — the pod's collar. */
function litRing(cx: number, cz: number, y0: number, y1: number, proud: number): BufferGeometry {
  const g = shell(
    cx,
    cz,
    [
      { y: y0, r: towerRadiusAt(y0) + proud },
      { y: y1, r: towerRadiusAt(y1) + proud },
    ],
    TOWER_SIDES,
  );
  const n = g.getAttribute('position').count;
  const uv = new Float32Array(n * 2);
  const pos = g.getAttribute('position');
  for (let i = 0; i < n; i++) {
    uv[i * 2 + 1] = (pos.getY(i) - STRIP_Y0_FT) / (POD_TOP_FT - STRIP_Y0_FT);
  }
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  return g;
}


/** Where the tower stands, scene ft. Read by the city so both agree. */
export function towerAnchor(): { tx: number; tz: number } {
  const b = TOWER_BEARING_DEG * DEG;
  return { tx: Math.sin(b) * TOWER_DIST_FT, tz: -Math.cos(b) * TOWER_DIST_FT };
}

/**
 * The tower's CONCRETE, as geometries for the city's own merge — three shells so
 * the pod carries its own tint, which is the one piece of the silhouette a
 * viewer actually reads. The caller disposes them.
 */
export function towerShells(tx: number, tz: number): BufferGeometry[] {
  const towerC = new Color(COLORS.tower);
  const podC = new Color(COLORS.towerPod);
  const podFrom = 4;
  const podTo = 8;
  return [
    plainUV(tintGeometry(shell(tx, tz, TOWER_PROFILE.slice(0, podFrom + 1), TOWER_SIDES), towerC)),
    plainUV(tintGeometry(shell(tx, tz, TOWER_PROFILE.slice(podFrom, podTo + 1), TOWER_SIDES), podC)),
    plainUV(tintGeometry(shell(tx, tz, TOWER_PROFILE.slice(podTo), TOWER_SIDES), towerC)),
  ];
}

export interface TowerLights {
  mesh: Mesh;
  /**
   * Drive the strips. `level` is an emissive multiplier — the resting
   * `daylight.towerGlow`, or more during a home run; `offsetV` scrolls the chase
   * UP the tower and is a texture offset, so it costs nothing and uploads
   * nothing.
   */
  setGlow(level: number, offsetV: number): void;
}

/**
 * The lit tower: vertical strips up the shaft, a bright pod ring, a lit mast.
 * ONE mesh, ONE unlit material, ONE colour drawn from the session's seed.
 */
export function buildTowerLights(tx: number, tz: number, seed: number, track: Track): TowerLights {
  // ⚠ ONE DRAW OF THE SESSION PRNG, ONE COLOUR. This used to be drawn fifteen
  // times for fifteen band colours; the real tower is ONE colour at a time — see
  // the lighting note above. A given seed still renders the same tower, which is
  // what the byte-identical gate needs, and a different seed still renders a
  // different one, which is what "it changes nightly" means without a clock.
  const rng = mulberry32(TOWER_SEED ^ (seed >>> 0));
  const scheme = TOWER_SCHEMES[Math.floor(rng() * TOWER_SCHEMES.length)] ?? TOWER_SCHEMES[0]!;
  const parts: BufferGeometry[] = [];
  const c = new Color();

  // --- the SHAFT: long vertical strips, base to the foot of the pod.
  const podFootY = TOWER_PROFILE[4]?.y ?? 596;
  for (let i = 0; i < STRIP_COUNT; i++) {
    const a = (2 * Math.PI * i) / STRIP_COUNT;
    parts.push(
      tintGeometry(
        strip(tx, tz, a, STRIP_HALF_DEG * DEG, STRIP_Y0_FT, podFootY, STRIP_ROWS),
        c.set(scheme),
      ),
    );
  }
  // --- the POD RING: the brightest thing on the tower, and a RING rather than
  // strips because that is what wraps the deck in every photograph.
  parts.push(
    tintGeometry(
      litRing(tx, tz, TOWER_PROFILE[6]?.y ?? 628, TOWER_PROFILE[7]?.y ?? 652, 2.0),
      c.set(scheme).multiplyScalar(POD_GLOW),
    ),
  );
  // --- the MAST. A lit sleeve rather than strips: it tapers from 22 ft of
  // radius to 3 over 130 ft, so at 1500 ft strips on it would be sub-pixel. Its
  // `v` runs past 1 and WRAPS onto the pulse's tail, which is why it reads lit
  // at rest — the same wrap that lights the base and the pod together.
  parts.push(
    tintGeometry(
      litRing(tx, tz, POD_TOP_FT, TOWER_PROFILE[TOWER_PROFILE.length - 1]?.y ?? 790, 0.6),
      c.set(scheme).multiplyScalar(MAST_GLOW),
    ),
  );

  const geo = track(mergeGeometries(parts));
  for (const p of parts) p.dispose();
  const chase = chaseTexture();
  if (chase) track(chase);
  const mat = track(
    new MeshBasicMaterial({ vertexColors: true, side: DoubleSide, ...(chase ? { map: chase } : {}) }),
  );
  const mesh = new Mesh(geo, mat);
  mesh.name = 'towerLights';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    setGlow: (level, offsetV) => {
      mat.color.setScalar(Math.max(0, level));
      if (chase) chase.offset.y = offsetV;
    },
  };
}
