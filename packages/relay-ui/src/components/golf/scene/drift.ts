/**
 * The understory DRIFT — a mass of flowering shrub at the foot of a tree, drawn
 * inside the volume the sim collides with.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * It is the geometry half of a two-part contract with `lib/golf/courseSim.ts`,
 * and the part most likely to be edited by someone tuning the LOOK. Keeping it
 * here means the containment proof below sits next to every constant that could
 * break it, instead of being one paragraph in the middle of a grove builder.
 * `foliage.ts` calls `composeDrift` `BLOOM_DRIFT_BLOBS` times per flowering tree
 * and knows nothing else about drifts.
 *
 * THE CONTRACT
 * ------------
 * A drift is a HALF-ELLIPSOID standing on the ground at the trunk —
 * `CourseTree.shrubR` by `CourseTree.shrubH`, authored in `terrain.ts` and
 * brushed by `courseSim.brushShrub`. This module does not choose those numbers;
 * it FILLS them. Every blob it emits is inside that envelope, provably (see
 * `composeDrift`), and the distribution is tuned so the blobs very nearly reach
 * it — mean 0.95 of the radius and 0.92 of the height across the whole grove.
 *
 * ⚠ BOTH BOUNDS MATTER, AND THE HISTORY IS WHY. The form shipped with its own
 * hand-picked dimensions and drew a mass 5.7× wider than anything the sim
 * collided with down there: a ball rolled through eight yards of apparent
 * flowering shrub and felt nothing. The mirror-image bug is just as bad and much
 * easier to introduce — a collider the art does not fill is a ball snagging on
 * empty air. `foliage.test.ts` holds both directions; do not weaken either while
 * tuning the constants below.
 *
 * All of it is triangles only: a drift blob is the same unit icosahedron and the
 * same white instanced material as every leaf in the grove, so the whole form
 * still costs ZERO draw calls.
 */

import type * as THREE from 'three';
import { composeInstance } from '../../../lib/scene3d/instancing';

/**
 * Blobs in one drift. Enough to merge into a single mass rather than reading as
 * scattered dots (the failure of the first 5-blob pass), and no more than that:
 * 16 cover ~83% of the envelope's silhouette across the whole grove, and 18 buys
 * under half a point. 20 triangles each.
 */
export const BLOOM_DRIFT_BLOBS = 16;

/**
 * Blob size as a fraction of the ENVELOPE. Fractions, not absolute units, so a
 * blob keeps its proportion whatever the tree's scale — and so the containment
 * proof holds for every tree without a per-tree check.
 *
 * 0.24–0.34 of a 5.3–7.0 yd envelope is a bush 2.5–4.7 yd across and 1.3–2.4 yd
 * tall. That range is half the boulder fix: the first pass drew blobs of radius
 * 1.1–1.75 LOCAL units, i.e. 3.6–7.6 yd ACROSS each, which is not a shrub, it is
 * a glacial erratic. The whole mass got smaller too, but the individual blob
 * getting smaller is what stopped it reading as rock.
 */
const DRIFT_BLOB = [0.24, 0.34] as const;
/**
 * How high up the dome a blob's centre sits, as a fraction of the highest the
 * envelope allows it at that radius. Below 1 for the mound: a drift that is
 * tallest over the trunk and settles toward the ground at its rim reads as
 * planting, where a flat-topped one reads as a hedge someone cut. Not much below
 * 1, because every yard the art falls short of the envelope is a yard of
 * collider with nothing drawn in it. 0.65 crowns the mound at a mean 0.92 of the
 * collider height.
 */
const DRIFT_LIFT = [0.65, 1] as const;
/**
 * Cap on the normalised radius a blob's centre is thrown to. Purely so the rim
 * blobs stand a little proud of the turf instead of sitting exactly at ground
 * level with their bottom halves buried.
 */
const DRIFT_U_MAX = 0.96;
/**
 * Radial distribution exponent: `q ∝ u^DRIFT_RADIAL_POW`. 0.5 spreads the
 * centres uniformly over the disc, 1 piles them on the trunk. 0.65 leans just far
 * enough toward the middle to give the mound a crown — measured across the whole
 * grove it holds the drawn extent at a mean 0.95 of the collider radius while
 * lifting the drawn top from 0.87 to 0.92 of its height.
 */
const DRIFT_RADIAL_POW = 0.65;
/**
 * How close a drift blob sits to the pure blossom colour: 0.88–1.0 of the way
 * from white, i.e. barely washed at all. Unlike a crown blob there is no green to
 * blend with, and that is botanically right — forsythia flowers on bare wands,
 * before a single leaf opens.
 *
 * It started at 0.75 on the theory that lightening would keep the sun-facing
 * facets from going dark. The measurement said otherwise: value was already
 * healthy (0.73 mean) and SATURATION was the weak axis (0.58 against an authored
 * 0.93), because washing toward white is exactly a saturation cut. Chroma is the
 * scarce resource here, so spend the white sparingly.
 */
const DRIFT_PURITY_MIN = 0.88;

/**
 * Compose ONE drift blob into `m`, and return how pure its blossom colour should
 * be (0..1, a lerp weight from white toward the blossom — the caller owns the
 * palette).
 *
 * `a` and `b` are the envelope's radius and height in the TREE'S LOCAL frame
 * (`shrubR/scale`, `shrubH/scale`), because the grove's group matrix re-applies
 * the tree's own scale to everything composed here.
 *
 * `r` is the tree's blossom generator. This function draws EXACTLY FIVE rolls
 * from it, in this order — angle, size, radius, lift, colour — and that order is
 * load-bearing: it is what makes a given seed produce the same drift on every
 * load, which is what the screenshot gate's determinism rests on.
 *
 * THE CONTAINMENT PROOF, because "the art fits the collider" has to be a fact and
 * not an intention. Squash the world by (1/a, 1/b) and the envelope becomes the
 * unit half-ball. A blob of radius ρ·a and half-height ρ·b becomes a SPHERE of
 * radius ρ — that is the only reason the blob's squash is b/a rather than a
 * hand-picked constant. (It also comes out flatter than the 0.72 the first pass
 * chose by eye, which happens to help: a ground-level icosahedron turns half its
 * faces away from a high sun and an unlit yellow facet is olive, so squashing
 * points more of them up.) Its centre is placed at
 *
 *     q  = (1−ρ)·u^DRIFT_RADIAL_POW·DRIFT_U_MAX   (distance from the trunk axis)
 *     cy = √((1−ρ)² − q²)·lift                    (height, lift ≤ 1)
 *
 * so |centre|² = q² + cy² ≤ q² + ((1−ρ)² − q²) = (1−ρ)², i.e. |centre| + ρ ≤ 1:
 * the blob is inside the unit ball, tangent to it when lift = 1. Unsquash and
 * every drawn blob is inside the ellipsoid `courseSim.brushShrub` tests, touching
 * it at the crown of the mound. The bound holds for ANY `u` and `lift` in range,
 * so the distribution constants above can be tuned for looks without ever putting
 * a petal outside the collider.
 */
export function composeDrift(m: THREE.Matrix4, a: number, b: number, r: () => number): number {
  const ang = r() * Math.PI * 2;
  const rho = DRIFT_BLOB[0] + r() * (DRIFT_BLOB[1] - DRIFT_BLOB[0]);
  const u = r();
  const lift = DRIFT_LIFT[0] + r() * (DRIFT_LIFT[1] - DRIFT_LIFT[0]);
  const q = (1 - rho) * Math.pow(u, DRIFT_RADIAL_POW) * DRIFT_U_MAX;
  const cy = Math.sqrt(Math.max(0, (1 - rho) * (1 - rho) - q * q)) * lift;
  const rad = q * a;
  composeInstance(
    m,
    Math.cos(ang) * rad,
    cy * b,
    Math.sin(ang) * rad,
    0,
    ang,
    0,
    rho * a,
    rho * b,
    rho * a,
  );
  return DRIFT_PURITY_MIN + (1 - DRIFT_PURITY_MIN) * r();
}
