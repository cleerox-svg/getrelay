/**
 * scene3d/quality — the shared quality-tier POLICY.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/GRAPHICS.md` §4 rule 1: **default DOWN, promote only on measured evidence.**
 * A capability sniff answers "what does this driver ALLOW", never "what can this
 * GPU AFFORD". The reference implementation of that policy was
 * `components/baseball/stadium/quality.ts`; this module is the game-neutral
 * extraction of the same rules so golf and baseball cannot drift apart on the
 * one decision that has already killed a GPU process once.
 *
 * ⚠ THE ANTI-PATTERN, NAMED. `lib/golf/water.ts` `pickWaterQuality` promotes to
 * its most expensive tier on `cores > 4 && maxTextureSize >= 8192`, which a
 * typical mid-range Android satisfies — so the tier meant to be gated behind GPU
 * headroom is what most phones actually get. Nothing here may do that. Every
 * automatic decision below can only make a scene CHEAPER.
 *
 * POLICY IS SHARED, NUMBERS ARE NOT (contract rule 6). This module has no idea
 * how big a shadow map should be: a stadium's shadow volume is ~900 ft across
 * and a golf hole's is not. The caller passes a `SceneBudgetTable` it owns, and
 * this module only decides WHICH ROW of that table to hand back, and why.
 *
 * ⚠ A TABLE MUST NEVER RAISE A SCENE'S CURRENT COST. The tier exists to have a
 * way DOWN, not a way up. When a scene already runs at 1024², its `medium` and
 * `high` rows are 1024² — writing 1536² there because another scene uses it is a
 * 2.25× shadow-memory regression dressed up as a fix. The per-game table is
 * where that is asserted (see `components/golf/scene/quality.ts`).
 *
 * WHY `high` IS UNREACHABLE AUTOMATICALLY
 * --------------------------------------
 * There is still nothing to promote ON. `stats.ts` now ships a real frame-time
 * probe, but its median arrives *after* the scene is built — a scene cannot be
 * re-tiered mid-flight without rebuilding its shadow map — so using it would
 * mean PERSISTING a verdict across sessions, and persisted cross-run state would
 * make the screenshot harness's tier depend on a previous run. That trades a
 * determinism guarantee that took real work to win for a tier nobody has
 * measured a need for.
 *
 * When someone does wire persistence, here is the bar it has to clear, written
 * down now so it is not invented later: a median frame time **≤ 20 ms over ≥300
 * consecutive settled frames at `medium`**, recorded on that same device for
 * that same scene, in at least two separate sessions. Anything less is a
 * capability sniff with extra steps.
 *
 * Until then `high` is reachable only by an explicit `?quality=high` override —
 * which is the point: rule 3 says every tier is overridable by URL parameter so
 * it can be bisected on a real handset without a rebuild. That is the only way
 * the on-device evidence ever gets collected.
 */

/** The three tiers. Ordered cheapest → most expensive. */
export type SceneTier = 'low' | 'medium' | 'high';

/** Tiers in cost order — handy for asserting a table is monotonic. */
export const SCENE_TIERS: readonly SceneTier[] = ['low', 'medium', 'high'] as const;

/**
 * One tier's GPU dials for ONE scene. Deliberately small: a dial belongs here
 * only if it is (a) a real GPU cost and (b) meaningful for more than one game.
 * Anything game-shaped — an angular tessellation step, a grass density — belongs
 * in the game's own extension of this type.
 */
export interface SceneBudget {
  /** Shadow-casting sun on/off. `false` skips the whole shadow pass. */
  shadows: boolean;
  /**
   * Shadow map edge, px. Cost is quadratic AND it is the exact dial that killed
   * the Android WebView GPU process at 2048² (GOLF.md), so it is the one number
   * in this file that is never raised without an on-device test.
   */
  shadowMapSize: number;
  /**
   * Upper bound on `devicePixelRatio`. Fill rate scales with its square, so this
   * is the cheapest lever on a fill-bound mobile GPU — and the one most likely
   * to be noticed as "blurry", so it moves only with a visual review.
   */
  pixelRatioCap: number;
  /**
   * Scene-wide image-based lighting (`scene.environment`) on/off.
   *
   * This is a REVERSAL of a considered decision, which is why it is a tier and
   * not a switch. `lib/golf/scenery.ts` deliberately attached its PMREM to the
   * ball's `envMap` alone so "turf/trees/water pay no per-frame env cost", and
   * that reasoning still holds on the hardware it was written for. `false` keeps
   * exactly that behaviour; `true` costs a cubeUV sample per lit fragment plus
   * the prefiltered target's VRAM (see `lib/scene3d/env.ts` `skyEnvBytes`).
   *
   * ⚠ A scene that turns this on MUST cut its ambient/hemisphere fill in the
   * same change. IBL added on top of an unchanged fill double-counts the
   * ambient term and flattens everything to grey — a failure that looks exactly
   * like "the IBL did not work".
   */
  ibl: boolean;
}

/** A game's numbers for one scene, one row per tier. */
export type SceneBudgetTable = Record<SceneTier, SceneBudget>;

/** The resolved row, plus which tier it is and WHY it was chosen. */
export interface SceneQuality extends SceneBudget {
  tier: SceneTier;
  /** Human-readable justification — surfaced in the harness output. */
  reason: string;
}

/**
 * The renderer capabilities this policy reads, as a structural type.
 *
 * A `THREE.WebGLRenderer` satisfies it. Taking it structurally rather than
 * importing the class keeps this module free of `three` entirely (so it can be
 * unit-tested in the node environment, and so it can never be the reason `three`
 * lands in a chunk that did not already have it).
 */
export interface SceneQualityCaps {
  isWebGL2?: boolean;
  maxTextureSize?: number;
  precision?: string;
}

/** Anything with a `capabilities` bag — i.e. a `THREE.WebGLRenderer`. */
export interface SceneQualityRenderer {
  capabilities: SceneQualityCaps;
}

export const isSceneTier = (v: unknown): v is SceneTier =>
  v === 'low' || v === 'medium' || v === 'high';

/**
 * Choose a tier for one scene.
 *
 * `override` is the `?quality=` URL parameter, plumbed all the way through so a
 * tier can be forced on a real handset without a rebuild. An unrecognised value
 * is ignored rather than throwing — a typo in a URL on someone's phone must not
 * be a blank screen.
 *
 * The automatic decisions are the whole point of the file, so they are listed
 * exhaustively: WebGL1 context, a small `maxTextureSize`, or a fragment
 * precision below `highp`. All three step DOWN to `low`. There is no branch that
 * reads a signal as headroom, and adding one is the defect this module exists to
 * prevent.
 */
export function pickSceneQuality(
  renderer: SceneQualityRenderer,
  table: SceneBudgetTable,
  override?: string | null,
): SceneQuality {
  if (isSceneTier(override)) {
    return { ...table[override], tier: override, reason: `forced by ?quality=${override}` };
  }

  const caps = renderer.capabilities ?? {};
  const maxTex = caps.maxTextureSize ?? 0;

  if (caps.isWebGL2 === false) {
    return { ...table.low, tier: 'low', reason: 'WebGL1 context — stepped down' };
  }
  if (maxTex < 4096) {
    return {
      ...table.low,
      tier: 'low',
      reason: `maxTextureSize ${maxTex} < 4096 — stepped down`,
    };
  }
  if (caps.precision && caps.precision !== 'highp') {
    return {
      ...table.low,
      tier: 'low',
      reason: `fragment precision ${caps.precision} — stepped down`,
    };
  }
  return { ...table.medium, tier: 'medium', reason: 'default (no measured evidence to promote on)' };
}

/**
 * Clamp a resolved quality to an explicit shadow-map size (the `?shadow=` URL
 * parameter).
 *
 * ⚠ THIS IS A DEBUG ESCAPE HATCH AND IT CAN GO UP. GOLF.md carries an open
 * action to re-verify a 2048² map on a low-end Android, and the only way to
 * bisect a GPU-process crash on someone's handset is to be able to reproduce the
 * exact configuration that crashed and then step it down one notch at a time.
 * Nothing but an explicit URL parameter may call this with a size above the
 * scene's own tier value.
 */
export function withShadowMapSize(quality: SceneQuality, size: number): SceneQuality {
  if (!Number.isFinite(size) || size <= 0) return quality;
  const px = Math.round(size);
  if (px === quality.shadowMapSize) return quality;
  return { ...quality, shadowMapSize: px, reason: `${quality.reason}; ?shadow=${px}` };
}
