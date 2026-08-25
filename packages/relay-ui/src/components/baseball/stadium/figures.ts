// THE PEOPLE — the defensive nine, the batter and the home-plate umpire.
//
// ⚠ THE DEFENCE'S POSITIONS ARE READ FROM `fielders.ALIGNMENT`, NOT RETYPED,
// and that is the whole reason this file is worth having rather than eleven
// hand-placed props. The ground-ball model races a runner against exactly those
// eight (bearing, distance) pairs; the air lookup asks which of them is nearest
// a landing point. Drawing a second copy would let the defence you SEE drift
// from the defence that FIELDS the ball, and nothing would ever catch it — the
// same class of defect `field.ts` avoids by drawing the dirt from
// `infieldDepthFt` instead of a prettier circle. `figures.test.ts` mutates
// `ALIGNMENT` and asserts the drawn figure moves with it, so the coupling is
// proved live rather than asserted by eye.
//
// ⚠ ONE MESH, ONE MATERIAL, ONE DRAW CALL. Eleven figures authored naively are
// eleven meshes and eleven materials; the charter legislates draw calls, so
// every limb of every figure is merged into a single geometry and tinted with a
// vertex-colour attribute (`geom.tintGeometry`, through `Color` — see its note
// about sRGB vs linear). That is the crowd's rule and the reed belt's rule
// applied to people. Measured: +1 draw call, +4,380 triangles at `medium`
// (2,392 at `low`, 6,896 at `high`).
//
// ⚠ THE CATCHER AND THE UMPIRE ARE OFF THE CENTRE LINE ON PURPOSE, AND THE
// MEASUREMENT IS IN `PLATE_CREW` BELOW. The `batter` camera stands 19.5 ft
// BEHIND the plate at 4 ft — so anything behind the plate is BETWEEN the player
// and the strike zone he is aiming at. A catcher's head in the zone would be
// worse than an empty field, and no crouch is low enough: the eye→zone-bottom
// sightline is only 2.2 ft off the ground where a catcher stands.
//
// ⚠ STATIC POSES, NO ANIMATION SYSTEM. A pose is DATA — a table of joint
// positions in stature units — and a figure is that table transformed by one
// yaw and one translation. Six poses, one assembler; a role that needs to look
// different is a row, never a branch.
//
// No `Math.random`, no clock: everything here is a constant or is derived from
// `ALIGNMENT`.

import {
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { BufferGeometry } from 'three';
import { M_PER_FT } from '../../../lib/baseball/bat';
import { ALIGNMENT, infieldDepthFt } from '../../../lib/baseball/fielders';
import { RUBBER_D_FT } from '../../../lib/baseball/zone';
import { GROUND_Y } from './ground';
import { at, mergeGeometries, tintGeometry } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';
import { MOUND_HEIGHT_FT } from './mound';

type V3 = readonly [number, number, number];

/**
 * Stature, m — and THE reference height of this game.
 *
 * ⚠ `stadium/scale.ts`'s magenta measuring stick imports it FROM HERE, which
 * inverts the old dependency on purpose: the box exists to say "a person is
 * this tall", so the person is the source and the box is the instrument. They
 * cannot drift apart, and `figures.test.ts` reads the box's drawn geometry back
 * out to prove it. Converted through `bat.M_PER_FT` — there is one
 * international foot in this repo, not two.
 */
export const FIGURE_M = 1.83;

/** Stature, ft. DERIVED. 6.0039 ft — 1.83 m is 6 ft to two decimals, not to
 * twelve, and the tests assert the conversion rather than the round number. */
export const FIGURE_STATURE_FT = FIGURE_M / M_PER_FT;

/**
 * Body proportions, as fractions of STATURE. Anthropometric rules of thumb, not
 * published data, and labelled as such: a head is ~1/7.5 of stature, shoulders
 * sit at ~0.82, hips at ~0.53. The two that are pinned rather than chosen are
 * `HEAD_RISE + HEAD_R = 0.18`, because an upright pose (`shoulderY = 0.82`) must
 * then reach EXACTLY 1.000 — a figure whose crown missed its own stature would
 * make the scale check a lie.
 */
const P = {
  headRise: 0.118,
  headR: 0.062,
  shoulderHalf: 0.115,
  hipHalf: 0.075,
  torsoR: [0.085, 0.105] as const,
  armR: [0.032, 0.025] as const,
  legR: [0.05, 0.036] as const,
  neckR: 0.042,
  handR: 0.033,
  /** A mitt is a hand and a half across; it is what makes a fielder read as one. */
  gloveR: 0.072,
  /** How far a knee leads its hip→foot chord, and an elbow bows off its own. */
  kneeFwd: 0.055,
  elbowOut: 0.045,
  /** Cap band: a shallow taper sitting ON the crown, never above it. */
  capY: [0.004, 0.05] as const,
  capR: [0.064, 0.05] as const,
  /** Bat: 33 in of the published bat model, as a fraction of stature. */
  batLen: 2.75 / (FIGURE_M / M_PER_FT),
  batR: [0.012, 0.021] as const,
} as const;

/** A static pose: joint targets in stature units, body frame, `+z` = chest. */
interface Pose {
  hipY: number;
  shoulderY: number;
  /** Forward lean of the shoulders, `+z`. The hips take 30 % of it. */
  leanZ: number;
  /** `[left, right]`. `+x` is the figure's LEFT (y-up, z-forward, right-handed). */
  feet: readonly [V3, V3];
  hands: readonly [V3, V3];
  /** Which hand wears the mitt, if either. */
  glove: 0 | 1 | null;
  /** Bat tip, if this pose carries one. */
  bat?: V3;
}

/**
 * The six poses. DATA — no role branches anywhere below.
 *
 * `bat` and `pitch` are authored with the chest facing the PLATE, which is why
 * their feet spread along `±x`: a batter's stance and a pitcher's stride both
 * run along the mound-plate line, and their chests both face across it. That
 * falls out of the frame rather than needing a special case.
 */
const POSES = {
  /** A fielder's athletic ready position. Crown at 0.950 → 5.70 ft. */
  ready: {
    hipY: 0.48,
    shoulderY: 0.77,
    leanZ: 0.06,
    feet: [
      [0.13, 0, 0],
      [-0.13, 0, 0],
    ],
    hands: [
      [0.2, 0.44, 0.16],
      [-0.2, 0.44, 0.16],
    ],
    glove: 0,
  },
  /** The catcher's squat, mitt up and forward. Crown at 0.680 → 4.08 ft. */
  crouch: {
    hipY: 0.24,
    shoulderY: 0.5,
    leanZ: 0.07,
    feet: [
      [0.17, 0, 0.04],
      [-0.17, 0, 0.04],
    ],
    hands: [
      [0.22, 0.52, 0.3],
      [-0.14, 0.22, 0.06],
    ],
    glove: 0,
  },
  /** The umpire, slotted behind, hands on knees. Crown at 0.840 → 5.04 ft. */
  ump: {
    hipY: 0.4,
    shoulderY: 0.66,
    leanZ: 0.14,
    feet: [
      [0.14, 0, 0],
      [-0.14, 0, 0],
    ],
    hands: [
      [0.16, 0.3, 0.14],
      [-0.16, 0.3, 0.14],
    ],
    glove: null,
  },
  /** The stance: front side (`+x`) toward the mound, hands up and back. */
  bat: {
    hipY: 0.5,
    shoulderY: 0.8,
    leanZ: 0.03,
    feet: [
      [0.19, 0, 0.01],
      [-0.19, 0, -0.01],
    ],
    hands: [
      [-0.11, 0.72, 0.1],
      [-0.15, 0.76, 0.09],
    ],
    glove: null,
    bat: [-0.32, 1.11, 0.14],
  },
  /** The set position on the rubber: glove up front, ball hand back. */
  pitch: {
    hipY: 0.51,
    shoulderY: 0.81,
    leanZ: 0.02,
    feet: [
      [0.1, 0, 0.06],
      [-0.11, 0, -0.04],
    ],
    hands: [
      [0.1, 0.56, 0.24],
      [-0.16, 0.6, -0.06],
    ],
    glove: 0,
  },
} as const satisfies Record<string, Pose>;

export type PoseId = keyof typeof POSES;

/** Crown height of a pose, in stature units. */
export const poseCrownUnits = (id: PoseId): number =>
  POSES[id].shoulderY + P.headRise + P.headR;

/**
 * Kits. SCENE-ONLY colour, and deliberately generic — a royal/white home set, a
 * grey/red road set and a charcoal umpire. No marks, no crests, no nicknames;
 * `ip.test.ts` is the guard and a colour scheme is not a trademark.
 */
type KitId = 'home' | 'road' | 'ump';
const KITS: Record<KitId, { shirt: number; pants: number; cap: number }> = {
  home: { shirt: 0x1b3fa0, pants: 0xe8e8e2, cap: 0x14307a },
  road: { shirt: 0xb5232c, pants: 0x9aa0a6, cap: 0x2a2f36 },
  ump: { shirt: 0x23262b, pants: 0x35383d, cap: 0x15171a },
};

/** Glove leather and bat ash. SCENE-ONLY. */
const LEATHER = 0x6b4526;
const ASH = 0xcaa972;

/**
 * Four skin tones, indexed by placement order. NOT random — the determinism
 * chapter forbids a clock and a seed here would buy nothing a fixed cycle does
 * not, since the point is only that eleven people are not one person.
 */
const SKIN = [0x8d5a3b, 0xc79a72, 0x6b4530, 0xe0b08c] as const;
const skinFor = (i: number): number => SKIN[i % SKIN.length] ?? SKIN[0];

/** Where the plate crew stands, scene ft, and WHY it is where it is.
 *
 * ⚠ THESE FOUR NUMBERS ARE DERIVED FROM THE `batter` CAMERA, NOT FROM A FIELD
 * DIAGRAM, and the trade is stated rather than hidden. That camera sits at
 * (0, 4, 19.5) — see `stadium/camera.ts` — so the sightline from the eye to the
 * rule zone's edge (`x = ±0.708` at `z = 0`) has spread to only ±0.53 ft by the
 * time it reaches the catcher's depth and ±0.44 ft at the umpire's. A catcher
 * on the centre line is therefore a wall across the zone at ANY aspect ratio,
 * and lowering him does not help: the eye→zone-bottom sightline is 2.22 ft off
 * the ground at `z = 5`, against a 3.0 ft squat.
 *
 * So the crew sets up on the third-base side, behind the right-handed batter —
 * a catcher setting up inside to a RHB, with the umpire over his shoulder. The
 * clearances that buys, MEASURED off the merged mesh rather than off a torso
 * centre, are 0.93 ft (catcher) and 1.56 ft (umpire) at the nearest vertex —
 * the batter's own is 1.61 ft. `figures.test.ts` raycasts all nine sample
 * points of the zone from the real camera pose to prove it rather than trusting
 * this paragraph, and prints the three margins every run.
 *
 * ⚠ THE HONEST COST: the catcher is ~0.9 ft outside the 43 in catcher's box and
 * the umpire works the OUTSIDE shoulder rather than the slot. Both are wrong by
 * a rule book neither the sim nor the HUD reads, and both are what the one
 * camera the game is played through can afford. */
const PLATE_CREW = {
  batterX: -3.2,
  catcher: [-2.7, 5.0] as const,
  umpire: [-3.3, 7.4] as const,
};

/** Everything the composer and the gate need to know about a drawn figure. */
export interface PlacedFigure {
  /** `P`,`C`,`1B`… for the defence; `B` the batter, `UMP` the umpire. */
  id: string;
  pose: PoseId;
  /** Scene position of the point between the feet, ft. */
  pos: V3;
  /** Yaw about `+y`, radians. */
  yaw: number;
  /** Absolute scene height of the crown, ft — `pos.y` plus the pose's stature. */
  crownFt: number;
}

export interface FiguresPart extends StadiumPart {
  figures: readonly PlacedFigure[];
  /** Triangles in the one merged mesh — the gate's number. */
  triangles: number;
}

/** Yaw that turns a figure's chest from `from` toward `to`. */
const faceToward = (from: V3, to: V3): number => Math.atan2(to[0] - from[0], to[2] - from[2]);

/**
 * Which ground layer a spot stands on. `field.ts` owns the layer heights and
 * `fielders.infieldDepthFt` owns the boundary, so a fielder's feet are on the
 * same surface the roll model decelerates him on — one arc, three consumers.
 */
const groundY = (bearingDeg: number, distFt: number): number =>
  distFt <= infieldDepthFt(bearingDeg) ? GROUND_Y.dirt : GROUND_Y.grass;

const PLATE: V3 = [0, 0, 0];
const MOUND: V3 = [0, 0, -RUBBER_D_FT];

/** The eleven placements. The defensive eight come from `ALIGNMENT`. */
export function figurePlacements(): PlacedFigure[] {
  const out: PlacedFigure[] = [];
  const push = (id: string, pose: PoseId, pos: V3, look: V3) =>
    out.push({
      id,
      pose,
      pos,
      yaw: faceToward(pos, look),
      crownFt: pos[1] + poseCrownUnits(pose) * FIGURE_STATURE_FT,
    });

  for (const f of ALIGNMENT) {
    const p = at(f.bearingDeg, f.distFt, 0);
    const onMound = f.pos === 'P';
    push(
      f.pos,
      onMound ? 'pitch' : 'ready',
      [p[0], onMound ? MOUND_HEIGHT_FT : groundY(f.bearingDeg, f.distFt), p[2]],
      PLATE,
    );
  }
  push('C', 'crouch', [PLATE_CREW.catcher[0], GROUND_Y.dirt, PLATE_CREW.catcher[1]], MOUND);
  push('UMP', 'ump', [PLATE_CREW.umpire[0], GROUND_Y.dirt, PLATE_CREW.umpire[1]], MOUND);
  push('B', 'bat', [PLATE_CREW.batterX, GROUND_Y.dirt, 0], PLATE);
  return out;
}

/** Which kit a placement wears. Data, keyed by id. */
const kitOf = (id: string): KitId => (id === 'UMP' ? 'ump' : id === 'B' ? 'road' : 'home');

// --- primitives -------------------------------------------------------------

const scratch = { a: new Vector3(), b: new Vector3(), q: new Quaternion(), m: new Matrix4() };
const UP = new Vector3(0, 1, 0);
const ONE = new Vector3(1, 1, 1);

/** A tapered, capped cylinder between two scene points. Radii in scene ft. */
function limb(a: V3, b: V3, r0: number, r1: number, seg: number): BufferGeometry {
  const dir = scratch.a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = Math.max(1e-4, dir.length());
  const g = new CylinderGeometry(r1, r0, len, seg, 1, false);
  g.deleteAttribute('uv');
  scratch.q.setFromUnitVectors(UP, dir.divideScalar(len));
  g.applyMatrix4(
    scratch.m.compose(
      scratch.b.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2),
      scratch.q,
      ONE,
    ),
  );
  return g;
}

/** A ball joint — a head, a hand, a mitt. */
function blob(c: V3, r: number, seg: number): BufferGeometry {
  const g = new SphereGeometry(r, seg, Math.max(2, seg - 2));
  g.deleteAttribute('uv');
  g.translate(c[0], c[1], c[2]);
  return g;
}

// --- assembly ---------------------------------------------------------------

const mid = (a: V3, b: V3, dx: number, dz: number): V3 => [
  (a[0] + b[0]) / 2 + dx,
  (a[1] + b[1]) / 2,
  (a[2] + b[2]) / 2 + dz,
];

/**
 * One figure's limbs, already in scene space.
 *
 * Joints are built in the body frame in stature units, scaled, then put through
 * ONE yaw + translation — which is why a pose table never mentions the scene.
 * Knees lead their hip→foot chord and elbows bow outward from their
 * shoulder→hand chord, so a straight-line pose still bends the right way and no
 * pose table has to carry a knee or an elbow of its own.
 */
function figureParts(f: PlacedFigure, seg: number, skin: number): BufferGeometry[] {
  const pose: Pose = POSES[f.pose];
  const H = FIGURE_STATURE_FT;
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const xf = (p: V3): V3 => [
    f.pos[0] + (p[0] * c + p[2] * s) * H,
    f.pos[1] + p[1] * H,
    f.pos[2] + (-p[0] * s + p[2] * c) * H,
  ];

  const hip = xf([0, pose.hipY, pose.leanZ * 0.3]);
  const sh = xf([0, pose.shoulderY, pose.leanZ]);
  const head = xf([0, pose.shoulderY + P.headRise, pose.leanZ * 0.75]);
  const side = (dx: number, base: V3): [V3, V3] => [
    [base[0] + dx * c, base[1], base[2] - dx * s],
    [base[0] - dx * c, base[1], base[2] + dx * s],
  ];
  const hips = side(P.hipHalf * H, hip);
  const shoulders = side(P.shoulderHalf * H, sh);
  const feet = pose.feet.map(xf) as [V3, V3];
  const hands = pose.hands.map(xf) as [V3, V3];

  const kit = KITS[kitOf(f.id)];
  const paint = (g: BufferGeometry, hex: number) => tintGeometry(g, new Color(hex));
  const parts: BufferGeometry[] = [
    paint(limb(hip, sh, P.torsoR[0] * H, P.torsoR[1] * H, seg), kit.shirt),
    paint(limb(shoulders[0], shoulders[1], P.neckR * H, P.neckR * H, seg), kit.shirt),
    paint(limb(sh, head, P.neckR * H, P.neckR * H, seg), skin),
    paint(blob(head, P.headR * H, seg), skin),
    paint(
      limb(
        [head[0], head[1] + P.capY[0] * H, head[2]],
        [head[0], head[1] + P.capY[1] * H, head[2]],
        P.capR[0] * H,
        P.capR[1] * H,
        seg,
      ),
      kit.cap,
    ),
  ];
  for (const i of [0, 1] as const) {
    const [shoulder, hand, hipSide, foot] = [shoulders[i], hands[i], hips[i], feet[i]];
    const out = (i === 0 ? 1 : -1) * P.elbowOut * H;
    const elbow = mid(shoulder, hand, out * c, -out * s);
    const knee = mid(hipSide, foot, P.kneeFwd * H * s, P.kneeFwd * H * c);
    parts.push(
      paint(limb(shoulder, elbow, P.armR[0] * H, P.armR[1] * H, seg), kit.shirt),
      paint(limb(elbow, hand, P.armR[1] * H, P.armR[1] * H, seg), skin),
      paint(limb(hipSide, knee, P.legR[0] * H, P.legR[1] * H, seg), kit.pants),
      paint(limb(knee, foot, P.legR[1] * H, P.legR[1] * H, seg), kit.pants),
      pose.glove === i
        ? paint(blob(hand, P.gloveR * H, seg), LEATHER)
        : paint(blob(hand, P.handR * H, seg), skin),
    );
  }
  if (pose.bat) {
    const grip = mid(hands[0], hands[1], 0, 0);
    parts.push(paint(limb(grip, xf(pose.bat), P.batR[0] * H, P.batR[1] * H, seg), ASH));
  }
  return parts;
}

/**
 * Radial segments per limb, by tier.
 *
 * ⚠ THE TIER MAY MAKE A FIGURE SIMPLER AND MAY NEVER MAKE ONE VANISH. An empty
 * field is the defect this module exists to fix, so there is no population knob
 * here at all — only a silhouette one. Four segments is a square limb, which at
 * `low` is what a phone that reported WebGL1 or non-`highp` gets.
 */
const segmentsFor = (tier: string): number => (tier === 'low' ? 4 : tier === 'high' ? 8 : 6);

export function buildFigures({ scene, track, quality }: StadiumCtx): FiguresPart {
  const group = new Group();
  group.name = 'figures';
  const figures = figurePlacements();
  const seg = segmentsFor(quality.tier);

  const parts: BufferGeometry[] = [];
  figures.forEach((f, i) => parts.push(...figureParts(f, seg, skinFor(i))));
  const geo = track(mergeGeometries(parts));
  for (const p of parts) p.dispose();

  const mesh = new Mesh(geo, track(new MeshLambertMaterial({ vertexColors: true })));
  mesh.name = 'figureCrowd';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  scene.add(group);

  return { group, figures, triangles: (geo.getIndex()?.count ?? 0) / 3 };
}
