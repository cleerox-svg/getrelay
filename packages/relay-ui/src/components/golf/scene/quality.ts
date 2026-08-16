/**
 * Golf's GPU budget table — the NUMBERS behind the shared policy.
 *
 * The policy (default DOWN, promote only on measured evidence) lives in
 * `lib/scene3d/quality.ts` and is shared with baseball. What lives HERE is
 * everything a stadium would get wrong: how big a golf hole's shadow volume is,
 * and what each of the three golf scenes can currently afford.
 *
 * ⚠ THE ONE RULE THAT SHAPED THIS TABLE: **a tier may never RAISE a scene's
 * cost.** The obvious version of this change was "default 1536² everywhere",
 * which reads as a step down because two of the three scenes were at 2048² — but
 * `PuttGL` was already at 1024², so a flat default would have made a
 * currently-safe scene 2.25× more expensive in shadow-map memory. That is a
 * regression wearing a fix's clothes. Each scene therefore has its OWN row, and
 * `quality.test.ts` asserts that no tier of any scene exceeds what that scene
 * ships today.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * Course and Range came DOWN from 2048² to 1536²; Putt STAYS at 1024².
 *
 * GOLF.md records a 2048² shadow map killing the Android WebView GPU process —
 * black screen, app restart — while rendering perfectly in desktop software GL.
 * It was reverted to 1024², then re-enabled to 2048² by request, with a standing
 * requirement to re-verify on a low-end Android before the next release AAB. That
 * verification has never happened and the requirement is still open. GOLF.md
 * itself nominates 1536² as "the first dial to turn down", so that is the dial
 * turned: 1536² is 56% of 2048²'s memory and 2.25× 1024²'s, i.e. one real notch,
 * and it keeps the crisp contact shadows the 2048² map was raised for.
 *
 * ⚠ `high` DOES NOT RAISE THE SHADOW MAP, in any scene. It buys pixel ratio only.
 * Re-testing the exact configuration that crashed is what `?shadow=2048` is for —
 * an explicit, per-load, per-handset act, not something a tier hands out.
 *
 * ⚠ `pixelRatioCap` at `medium`/`high` is 2 because that is what all three scenes
 * cap at TODAY (`Math.min(devicePixelRatio, 2)`). Fill rate scales with its
 * square so 1.5 is tempting, but it would soften every phone's render with no
 * visual review — a separate change, gated by `golf-visual-qa`, not a rider on a
 * shadow-map fix.
 *
 * `ibl` — SCENE-WIDE IMAGE-BASED LIGHTING
 * --------------------------------------
 * `scenery.ts` attached its PMREM to the ball's `envMap` alone, on the recorded
 * grounds that "turf/trees/water pay no per-frame env cost". Reversing that is
 * the single biggest lever on how materials respond to light (`/GRAPHICS.md` §1
 * names it), but the reasoning behind the original decision has not stopped
 * being true for weak hardware — so `low` keeps the ball-only path, byte for
 * byte, and `medium`/`high` get `scene.environment`.
 *
 * This is the one dial in the table that does NOT reduce to a shadow map, and it
 * is deliberately the same value for all three scenes: the cost is per lit
 * fragment, and Putt's board is the cheapest surface golf ships.
 * See `components/golf/scene/env.ts` for what gets built and what it costs.
 */

import {
  pickSceneQuality,
  withShadowMapSize,
  type SceneBudgetTable,
  type SceneQuality,
} from '../../../lib/scene3d/quality';

/** The three golf scenes that own a renderer. */
export type GolfSceneId = 'course' | 'range' | 'putt';

/**
 * What each scene shipped BEFORE tiering, px. This is the ceiling the test
 * asserts against, and the reason it is written down rather than inferred: a
 * future edit that raises a row has to change this line too, and changing this
 * line is a claim that an on-device test was run.
 */
export const SHIPPED_SHADOW_MAP_SIZE: Record<GolfSceneId, number> = {
  course: 2048,
  range: 2048,
  putt: 1024,
};

/**
 * Shadow-map sizes accepted by `?shadow=`. An allowlist, not a parse: a
 * fat-fingered `?shadow=20488` on a phone in a car park must fall back to the
 * tier, not allocate 1.6 GB and take the tab with it.
 */
export const SHADOW_OVERRIDE_SIZES = [1024, 1536, 2048] as const;

/**
 * The Course and the Range: a shadow volume 640 yd wide (Course) / 160 yd
 * (Range) with trees, flags and a ball that all need a readable contact shadow.
 */
const WIDE_SCENE: SceneBudgetTable = {
  // `low` drops the shadow pass entirely. It is reached automatically only on a
  // WebGL1 context, a sub-4096 texture limit or a non-highp fragment precision —
  // i.e. hardware where a second geometry pass is the first thing to cut.
  low: { shadows: false, shadowMapSize: 1024, pixelRatioCap: 1, ibl: false },
  medium: { shadows: true, shadowMapSize: 1536, pixelRatioCap: 2, ibl: true },
  high: { shadows: true, shadowMapSize: 1536, pixelRatioCap: 2, ibl: true },
};

/**
 * Mini-golf. A whole hole fits in ~140 virtual units and the camera is a fixed
 * overhead frame, so 1024² already resolves the rails and the ball crisply —
 * there is nothing to buy by spending more, and 1024² is what it ships.
 */
const PUTT_SCENE: SceneBudgetTable = {
  low: { shadows: false, shadowMapSize: 512, pixelRatioCap: 1, ibl: false },
  medium: { shadows: true, shadowMapSize: 1024, pixelRatioCap: 2, ibl: true },
  high: { shadows: true, shadowMapSize: 1024, pixelRatioCap: 2, ibl: true },
};

export const GOLF_SCENE_BUDGETS: Record<GolfSceneId, SceneBudgetTable> = {
  course: WIDE_SCENE,
  range: WIDE_SCENE,
  putt: PUTT_SCENE,
};

/** Read one URL parameter, tolerating a non-browser/locked-down `location`. */
function param(name: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/**
 * `?quality=low|medium|high`, or null. Validated by `pickSceneQuality`, so an
 * unknown value simply falls through to the automatic decision.
 */
export function readQualityOverride(): string | null {
  return param('quality');
}

/**
 * `?shadow=1024|1536|2048`, or null.
 *
 * This exists for exactly one job: bisecting the WebView GPU-process crash on a
 * real handset without a rebuild (`/GRAPHICS.md` §4 rule 3). It is therefore
 * allowed to go UP past the tier — reproducing the configuration that crashed is
 * half the bisect.
 */
export function readShadowSizeOverride(): number | null {
  const raw = param('shadow');
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return (SHADOW_OVERRIDE_SIZES as readonly number[]).includes(n) ? n : null;
}

/**
 * Resolve the quality for one golf scene: the shared policy against this scene's
 * row of the table, then the `?shadow=` escape hatch on top.
 *
 * Every `*GL.tsx` calls this once, immediately after creating its renderer, and
 * drives `setPixelRatio`, `shadowMap.enabled` and `sun.shadow.mapSize` off the
 * result. Nothing else in a scene may pick a shadow size.
 */
export function resolveGolfQuality(
  renderer: Parameters<typeof pickSceneQuality>[0],
  scene: GolfSceneId,
): SceneQuality {
  const q = pickSceneQuality(renderer, GOLF_SCENE_BUDGETS[scene], readQualityOverride());
  const forced = readShadowSizeOverride();
  return forced === null ? q : withShadowMapSize(q, forced);
}
