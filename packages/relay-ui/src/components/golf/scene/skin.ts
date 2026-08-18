// THE EQUIPPED SKIN, APPLIED TO A SCENE THAT IS ALREADY BUILT.
//
// A golf scene is built ONCE, in a `useEffect(..., [])` — that is deliberate
// and must stay that way: rebuilding a course to recolour a ball would dispose
// and re-create every geometry, material and texture in it and drop the round's
// mid-shot state. But the equipped ball skin and tracer colour are props that
// can change UNDER a live scene:
//
//   • the economy's cosmetics slice can resolve after the scene has mounted
//     (`three` is lazy, but a slow or retried /economy/cosmetics is slower);
//   • the player can equip a different ball between holes without leaving.
//
// Both used to be impossible to see. Each `*GL.tsx` snapshotted the prop into a
// ref and read it once inside its build effect (`makeBallMaterial(tex,
// cosmeticsRef.current?.ball)`); nothing ever wrote the material afterwards and
// `cosmetics` was in no dependency array anywhere in `components/golf`. So a
// skin applied only by luck of timing, and an equip mid-session never applied
// at all — the shipped "golf ball skins don't work".
//
// This is the ONE seam that fixes it, shared by Course / Range / Putt so the
// three cannot drift (three near-identical update effects in three files is
// exactly the drift GOLF.md §2.1 rule 2 exists to stop). A scene:
//
//     const registerSkin = useGolfSkin(cosmetics);          // top of component
//     ...
//     useEffect(() => {
//       const ballMat = track(makeBallMaterial(dimpleTex)); // STOCK ball
//       const tracerMat = track(new THREE.LineBasicMaterial({ color: 0xff4d4d }));
//       registerSkin({ ball: ballMat, trail: tracerMat });
//       ...
//     }, []);
//
// `registerSkin` applies the current skin SYNCHRONOUSLY, so the first frame the
// build effect draws is already skinned; the hook's own effect re-applies on
// every later `cosmetics` change.
//
// ⚠ The cosmetic → material MAPPING is not here. `applyBallCosmetic` lives
// beside `makeBallMaterial` in `lib/golf/ballTexture.ts` and is what that
// constructor uses, so "the colour a new ball is built with" and "the colour a
// live ball is changed to" are one function by construction.
//
// This module imports `three` and is therefore reachable ONLY from the lazy
// `*GL.tsx` scenes (GOLF.md §2.1 rule 1). The `three`-free half of the seam is
// `lib/golf/cosmetics.ts`, which the shop/hub DOM imports.

import { useCallback, useEffect, useRef } from 'react';
import type * as THREE from 'three';
import { applyBallCosmetic } from '../../../lib/golf/ballTexture';
import type { GolfCosmetics } from '../../../lib/golf/cosmetics';

// The scene-side face of the cosmetics seam: a `*GL.tsx` takes both its prop
// TYPE and the hook that applies it from here, so there is one import to follow.
export type { GolfCosmetics } from '../../../lib/golf/cosmetics';

/** The materials a scene lets the equipped cosmetics drive. All optional. */
export interface GolfSkinTargets {
  /** The ball material (Course / Range / Putt all have one). */
  ball?: THREE.MeshStandardMaterial;
  /** The shot tracer line material. Mini-golf has none. */
  trail?: THREE.LineBasicMaterial;
  /**
   * The colour an UN-equipped tracer reverts to. Defaults to the colour the
   * scene built `trail` with, snapshotted at registration — the Range's line is
   * red (0xff4d4d) and the Course's white, and neither should have to repeat
   * its own constant here for the seam to put it back.
   */
  stockTrail?: THREE.ColorRepresentation;
}

/**
 * Write `cosmetics` onto whichever of `targets` the scene registered. Safe to
 * call with an empty target set (a scene that has not built yet) and with no
 * cosmetics (an unresolved slice / the default equip), which restores the stock
 * look rather than leaving the last skin behind.
 *
 * Touches only uniform-level fields, so it is safe mid-frame and needs no
 * shader recompile.
 */
export function applyGolfSkin(targets: GolfSkinTargets, cosmetics?: GolfCosmetics): void {
  if (targets.ball) applyBallCosmetic(targets.ball, cosmetics?.ball);
  if (targets.trail) targets.trail.color.set(cosmetics?.trail?.color ?? targets.stockTrail ?? 0xffffff);
}

/**
 * Keep a scene's ball + tracer materials in sync with the equipped cosmetics,
 * for the life of the scene.
 *
 * Returns the `registerSkin` callback the build effect hands its materials to.
 * The callback is stable, so it does not perturb a `[]` build effect, and it
 * applies immediately on registration.
 */
export function useGolfSkin(
  cosmetics?: GolfCosmetics,
): (targets: GolfSkinTargets) => void {
  const targetsRef = useRef<GolfSkinTargets>({});
  // Read by `register`, which runs inside the build effect — i.e. AFTER this
  // hook's own effect on the mount pass, so it must see the newest prop.
  const latest = useRef(cosmetics);
  latest.current = cosmetics;

  const register = useCallback((targets: GolfSkinTargets) => {
    // Snapshot the scene's own stock tracer colour BEFORE the first skin is
    // written over it, so un-equipping restores that scene's line and not a
    // colour this shared seam guessed.
    const stockTrail = targets.stockTrail ?? targets.trail?.color.getHex();
    targetsRef.current = { ...targets, stockTrail };
    applyGolfSkin(targetsRef.current, latest.current);
  }, []);

  // THE LIVE HALF. `cosmetics` is the only dependency, and it deliberately is
  // NOT a dependency of the scene's build effect: this re-skins the materials
  // already on the GPU instead of tearing the scene down and rebuilding it,
  // which would cost a full dispose/rebuild and drop the round's mid-shot
  // state to change a colour. A no-op before the scene registers (empty
  // targets) and idempotent, so re-running on a new object identity is free.
  useEffect(() => {
    applyGolfSkin(targetsRef.current, cosmetics);
  }, [cosmetics]);

  return register;
}
