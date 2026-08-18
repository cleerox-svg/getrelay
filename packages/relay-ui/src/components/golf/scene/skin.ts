// THE EQUIPPED SKIN, APPLIED TO A SCENE THAT IS ALREADY BUILT.
//
// A golf scene is built in ONE effect with a near-empty dependency array —
// `[]` for Range and Putt, `[sim]` for the Course, which rebuilds per HOLE. That
// is deliberate and must stay that way: rebuilding to recolour a ball would
// dispose and re-create every geometry, material and texture in the scene and
// drop the round's mid-shot state. But the equipped ball skin and tracer colour
// are props that can change UNDER a live scene:
//
//   • the economy's cosmetics slice can resolve after the scene has mounted
//     (`three` is lazy, but a slow or retried /economy/cosmetics is slower);
//   • the player can equip a different ball without leaving the round.
//
// Both used to be impossible to see. Each `*GL.tsx` snapshotted the prop into a
// ref and read it once inside its build effect (`makeBallMaterial(tex,
// cosmeticsRef.current?.ball)`); nothing ever wrote the material afterwards and
// `cosmetics` was in no dependency array anywhere in `components/golf`. So a
// skin applied only by luck of timing, and an equip mid-session never applied
// — the shipped "golf ball skins don't work". (The Course's `[sim]` softened
// that ONE case: an equip there did land at the next hole's rebuild, which is
// also the loudest hint that a rebuild is the wrong tool for a colour.)
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
// every later `cosmetics` change. Pass the PROP — `useGolfSkin(cosmetics)`. The
// parameter is optional only so an unresolved slice is expressible; calling
// `useGolfSkin()` typechecks and silently freezes that scene at the stock ball,
// which is the original bug, so `skin.test.tsx` asserts the argument is there.
//
// ⚠ REGISTER ONLY FRESHLY-BUILT MATERIALS. `register` snapshots `trail`'s
// CURRENT colour as the stock tracer to revert to, which is right only because
// every caller registers materials it has just constructed and not yet skinned.
// Re-registering a material that is already wearing a skin would capture the
// SKIN as that scene's stock, and un-equipping would then "restore" the old
// cosmetic. A scene that needs to re-register mid-life must build new materials
// (which is what a rebuild does) or pass `stockTrail` explicitly.
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
}

/**
 * Write `cosmetics` onto whichever of `targets` the scene registered.
 *
 * `stockTrail` is the colour an UN-equipped tracer reverts to — the Range's
 * line is red (0xff4d4d) and the Course's white, so a shared seam cannot pick
 * one. `useGolfSkin` fills it in from the material the scene built, and no
 * caller passes it by hand; it is a parameter rather than a field of
 * `GolfSkinTargets` so that it cannot be mistaken for something a scene has to
 * supply at registration.
 *
 * Safe to call with an empty target set (a scene that has not built yet) and
 * with no cosmetics (an unresolved slice / the default equip), which restores
 * the stock look rather than leaving the last skin behind. Touches only
 * uniform-level fields, so it is safe mid-frame and needs no shader recompile.
 */
export function applyGolfSkin(
  targets: GolfSkinTargets,
  cosmetics?: GolfCosmetics,
  stockTrail?: THREE.ColorRepresentation,
): void {
  if (targets.ball) applyBallCosmetic(targets.ball, cosmetics?.ball);
  if (targets.trail) targets.trail.color.set(cosmetics?.trail?.color ?? stockTrail ?? 0xffffff);
}

/**
 * Keep a scene's ball + tracer materials in sync with the equipped cosmetics,
 * for the life of the scene.
 *
 * Returns the `registerSkin` callback the build effect hands its materials to.
 * The callback is `useCallback([])`-STABLE — that is load-bearing, not tidiness:
 * it is called from a build effect whose deps are `[]` / `[sim]`, so an unstable
 * identity would either rebuild the whole scene on every render or (as today,
 * since relay-ui ships no eslint config to catch the missing dep) go stale.
 */
export function useGolfSkin(
  cosmetics?: GolfCosmetics,
): (targets: GolfSkinTargets) => void {
  const skinRef = useRef<{ targets: GolfSkinTargets; stockTrail?: THREE.ColorRepresentation }>({
    targets: {},
  });
  // Read by `register`, which runs inside the build effect — i.e. AFTER this
  // hook's own effect on the mount pass, so it must see the newest prop.
  const latest = useRef(cosmetics);
  latest.current = cosmetics;

  const register = useCallback((targets: GolfSkinTargets) => {
    // Snapshot the scene's own stock tracer colour BEFORE the first skin is
    // written over it — see the "register only freshly-built materials" note.
    const stockTrail = targets.trail?.color.getHex();
    skinRef.current = { targets, stockTrail };
    applyGolfSkin(targets, latest.current, stockTrail);
  }, []);

  // THE LIVE HALF. `cosmetics` is the only dependency, and it deliberately is
  // NOT a dependency of the scene's build effect: this re-skins the materials
  // already on the GPU instead of tearing the scene down and rebuilding it,
  // which would cost a full dispose/rebuild and drop the round's mid-shot state
  // to change a colour. A no-op before the scene registers (empty targets) and
  // idempotent, so re-running on a new object identity is free.
  //
  // ⚠ DO NOT "FIX" THE ORDERING. This effect is declared BEFORE the scene's
  // build effect, so on mount it runs first against empty targets and the build
  // then registers and applies — that is what makes frame 0 skinned. The one
  // oddity it buys: when a scene's build deps and `cosmetics` change in the SAME
  // commit (a Course hole change while an equip lands), this writes a colour to
  // materials the build cleanup has just disposed, moments before the rebuild
  // registers the new ones. That write is inert — `dispose()` frees GPU
  // resources, it does not poison the JS object, and the fresh materials are
  // skinned correctly immediately after. Guarding it by moving this effect after
  // the build, or by making `register` lazy, would trade a harmless no-op for an
  // unskinned first frame.
  useEffect(() => {
    applyGolfSkin(skinRef.current.targets, cosmetics, skinRef.current.stockTrail);
  }, [cosmetics]);

  return register;
}
