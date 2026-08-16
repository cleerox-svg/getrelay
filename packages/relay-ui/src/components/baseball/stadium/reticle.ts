// The aiming reticle and the strike-zone frame — DRAWN IN THE SCENE, at the
// plate, in perspective.
//
// ⚠ WHY THIS IS NOT A DOM OVERLAY. The reticle's whole job is to say "the bat
// will be HERE when the ball arrives". A CSS circle floating over the canvas is
// pinned to the screen, so it agrees with the plate only for one camera at one
// aspect ratio; rotate a phone and the aid points at a different spot than the
// one `DerbySim.setReticle` was told about. Built as geometry at REPORT
// (x, h, d = 0) it is the same object under every camera mode, and the visual
// gate can read its world position back out.
//
// ⚠ AND IT INVENTS NO GEOMETRY. The frame is `zone.RULE_ZONE` — the same four
// numbers `isStrike` calls a strike and `pitchSim` aims at — so the box the
// player sees is the box the sim uses. `derbyRules.RETICLE_REACH_FT` is what
// bounds how far outside it the reticle may be dragged, and the HUD clamps to
// the identical constant. One source, three consumers.
//
// No textures, one geometry per part, everything through `track`.

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
} from 'three';
import { RULE_ZONE } from '../../../lib/baseball/zone';
import type { StadiumCtx } from './geom';

/**
 * Reticle radius, scene ft.
 *
 * ⚠ FEEL KNOB, and a DISPLAY one — it is not the contact tolerance. The real
 * tolerance is `derbyRules.RETICLE_FULL_MISS_FT` (0.667 ft, where the aim
 * residual has faded fully in) and it is a smooth shoulder, not a rim: drawing
 * a circle at that radius would tell the player there is a hard edge where the
 * sim has a fade. This is drawn a little inside it, as a "here" mark.
 */
const RETICLE_RADIUS_FT = 0.28;
const RETICLE_THICKNESS_FT = 0.045;

const RETICLE_COLOR = 0xffe14d;
const ZONE_COLOR = 0xffffff;
// Measured on the M2c `aim` shot: at 0.5 the frame all but vanished against the
// infield dirt, which is the surface it is drawn over for most of its length.
const ZONE_OPACITY = 0.7;

/** Nudged toward the batter so it can never z-fight the plate-crossing ball. */
const RETICLE_Z_FT = 0.02;

export interface ReticleHandle {
  group: Group;
  /** Place it at REPORT (x, h), ft. Cheap: two writes to a Vector3. */
  setReticle(x: number, h: number): void;
  /** Hide both parts (during the swing's result, when aiming is over). */
  setVisible(reticle: boolean, zone: boolean): void;
  /** Where the reticle is DRAWN, scene ft — the visual gate's read-back seam. */
  reticleScene(): [number, number, number];
}

/** The rule zone's outline as a closed `LineSegments` loop, at d = 0. */
function zoneFrame(): BufferGeometry {
  const { left, right, bottom, top } = RULE_ZONE;
  const corners: Array<[number, number]> = [
    [left, bottom],
    [right, bottom],
    [right, top],
    [left, top],
  ];
  const pos = new Float32Array(corners.length * 2 * 3);
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]!;
    const b = corners[(i + 1) % corners.length]!;
    pos.set([a[0], a[1], 0, b[0], b[1], 0], i * 6);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  return g;
}

export function buildReticle(ctx: StadiumCtx): ReticleHandle {
  const { scene, track } = ctx;
  const group = new Group();
  group.name = 'reticle';

  const frame = new LineSegments(
    track(zoneFrame()),
    track(new LineBasicMaterial({ color: ZONE_COLOR, transparent: true, opacity: ZONE_OPACITY })),
  );
  frame.name = 'zoneFrame';
  frame.visible = false;
  group.add(frame);

  // A flat annulus with its normal along +z — i.e. facing the batter's camera,
  // which is the only camera that aims. One geometry, moved; never rebuilt.
  const ring = new Mesh(
    track(
      new RingGeometry(
        RETICLE_RADIUS_FT - RETICLE_THICKNESS_FT,
        RETICLE_RADIUS_FT,
        28,
      ),
    ),
    track(
      new MeshBasicMaterial({
        color: RETICLE_COLOR,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
      }),
    ),
  );
  ring.name = 'reticleRing';
  ring.visible = false;
  ring.position.z = RETICLE_Z_FT;
  group.add(ring);

  scene.add(group);

  return {
    group,
    setReticle: (x, h) => {
      ring.position.x = x;
      ring.position.y = h;
    },
    setVisible: (reticleOn, zoneOn) => {
      ring.visible = reticleOn;
      frame.visible = zoneOn;
    },
    reticleScene: () => ring.position.toArray() as [number, number, number],
  };
}
