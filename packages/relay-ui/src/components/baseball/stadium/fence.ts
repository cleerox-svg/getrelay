// The outfield wall and the two foul poles.
//
// ⚠ THE WALL IS SAMPLED THROUGH `fenceAt`, WHICH IS THE PCHIP. Not through
// `park.fence` directly — that would draw a five-segment polygon while the sim
// resolves home runs against a monotone cubic, and BASEBALL.md measures that gap
// at up to 4.97 ft of fence distance. A 5 ft error in the drawn wall is a home
// run the player watches clear a wall the sim says it did not. So the wall you
// see is `fenceAt` evaluated every `quality.fenceStepDeg`, and the HEIGHT is
// `fenceAt(...).heightFt` too, which is what makes Alpine's 16 ft left-centre
// wall visibly taller than the 8 ft it carries elsewhere.
//
// `sample()` reads the distance and height back OUT of the built BufferGeometry
// rather than returning what was passed in. The screenshot harness prints those
// numbers against `parks.ts`, and a read-back of the caller's own input would
// have proved nothing.

import { BoxGeometry, DoubleSide, Group, Mesh, MeshLambertMaterial } from 'three';
import type { BufferGeometry } from 'three';
import { fenceAt, FOUL_LINE_DEG } from '../../../lib/baseball/parks';
import { at, bearingOf, loft, ring } from './geom';
import type { StadiumCtx, StadiumPart } from './geom';

/**
 * How far a foul pole stands above the wall beside it, ft. FEEL KNOB, and
 * labelled as one: the rule book requires a pole and requires it to be visible,
 * and puts no number on the height. Nothing in the physics reads this — a ball
 * at |bearing| > 45° is foul at any height (`resolveFence`).
 */
const POLE_ABOVE_WALL_FT = 22;

/** Foul-pole cross-section, ft. SCENE-ONLY. */
const POLE_W_FT = 0.9;

/** Wall thickness, ft. SCENE-ONLY — the sim's wall is a surface, not a solid. */
const WALL_THICK_FT = 0.75;

const COLORS = {
  wall: 0x1d3f7a, // royal blue: a colour scheme, not a mark (see ip.test.ts)
  pole: 0xf2c400,
};

export interface FencePart extends StadiumPart {
  /**
   * Distance and height of the DRAWN wall at a bearing, read back out of the
   * built geometry. Null outside the sampled span.
   */
  sample(bearingDeg: number): { distFt: number; heightFt: number } | null;
}

export function buildFence({ scene, track, park, quality }: StadiumCtx): FencePart {
  const group = new Group();
  group.name = 'fence';

  const step = quality.fenceStepDeg;
  const base = ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => ({
    r: fenceAt(park, b).distFt,
    y: 0,
  }));
  const top = ring(-FOUL_LINE_DEG, FOUL_LINE_DEG, step, (b) => {
    const f = fenceAt(park, b);
    return { r: f.distFt, y: f.heightFt };
  });

  const wallGeo = track(loft(base, top));
  const wallMat = track(new MeshLambertMaterial({ color: COLORS.wall, side: DoubleSide }));
  const wall = new Mesh(wallGeo, wallMat);
  wall.name = 'outfieldWall';
  wall.castShadow = true;
  wall.receiveShadow = true;
  group.add(wall);

  // Foul poles, one per line, standing on the wall at the line.
  const poleMat = track(new MeshLambertMaterial({ color: COLORS.pole }));
  for (const sign of [-1, 1]) {
    const b = sign * FOUL_LINE_DEG;
    const f = fenceAt(park, b);
    const h = f.heightFt + POLE_ABOVE_WALL_FT;
    const geo = track(new BoxGeometry(POLE_W_FT, h, POLE_W_FT));
    const pole = new Mesh(geo, poleMat);
    const p = at(b, f.distFt + WALL_THICK_FT, h / 2);
    pole.position.set(p[0], p[1], p[2]);
    pole.name = `foulPole${sign < 0 ? 'LF' : 'RF'}`;
    pole.castShadow = true;
    group.add(pole);
  }

  scene.add(group);
  return { group, sample: (deg) => sampleGeometry(wallGeo, deg) };
}

/**
 * Read the wall back out of its own vertex buffer.
 *
 * `loft` lays the base ring down first and the top ring second, so vertex `i`
 * and vertex `i + count` are the foot and the cap of the same post. Bearings run
 * monotonically from −45 to +45, so a linear scan with a bracket is enough and
 * needs no index structure.
 */
function sampleGeometry(
  geo: BufferGeometry,
  bearingDeg: number,
): { distFt: number; heightFt: number } | null {
  const pos = geo.getAttribute('position');
  const count = pos.count / 2;
  for (let i = 0; i + 1 < count; i++) {
    const b0 = bearingOf(pos.getX(i), pos.getZ(i));
    const b1 = bearingOf(pos.getX(i + 1), pos.getZ(i + 1));
    if (bearingDeg < Math.min(b0, b1) - 1e-9 || bearingDeg > Math.max(b0, b1) + 1e-9) continue;
    const t = b1 === b0 ? 0 : (bearingDeg - b0) / (b1 - b0);
    const r0 = Math.hypot(pos.getX(i), pos.getZ(i));
    const r1 = Math.hypot(pos.getX(i + 1), pos.getZ(i + 1));
    const h0 = pos.getY(count + i) - pos.getY(i);
    const h1 = pos.getY(count + i + 1) - pos.getY(i + 1);
    return { distFt: r0 + (r1 - r0) * t, heightFt: h0 + (h1 - h0) * t };
  }
  return null;
}
