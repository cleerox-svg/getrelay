/**
 * scene3d/clock — a freezable virtual clock for 3D render loops.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every animated 3D scene we ship samples wall-clock time (`performance.now()`
 * / the rAF timestamp) to drive water, particles, camera easing and fixed-step
 * physics accumulators. That is correct for a live game and fatal for a
 * screenshot harness: the captured frame becomes a function of how fast the
 * machine happened to run, so two identical runs produce two different PNGs and
 * the visual gate can no longer prove that a change is pixel-identical.
 *
 * The fix is not "seed the RNG" (the generators are already seeded) — it is to
 * make TIME an input the harness controls. A render loop asks this module for
 * the current time instead of the platform, and the preview entry point can
 * then run the scene for an exact number of fixed steps and FREEZE it. Once
 * frozen every subsequent frame renders byte-identically, so the screenshot no
 * longer races the animation.
 *
 * DEFAULT IS A NO-OP. Until something calls `engageVirtualClock()` this module
 * hands back `performance.now()` (or, in a render loop, the rAF timestamp it was
 * given, verbatim). The shipped app never engages it, so its behaviour is
 * unchanged down to the millisecond.
 *
 * GAME-NEUTRAL BY DESIGN. This lives in `lib/scene3d/` — the shared kit for
 * anything that drives a Three.js scene (golf today, baseball next). It must
 * never import from `lib/golf/*` or `lib/baseball/*`, and no export may name a
 * game concept.
 *
 * HOW A RENDER LOOP USES IT
 * -------------------------
 *   let last = sceneNow();
 *   const frame = (rafNow: number) => {
 *     const now = tickSceneClock(rafNow);   // one fixed step when engaged
 *     const dt = (now - last) / 1000;
 *     last = now;
 *     ...
 *   };
 *
 * When frozen, `tickSceneClock()` returns the same value every frame, so
 * `dt === 0`: fixed-step accumulators take no substeps and every time-driven
 * uniform holds its value. Loops must therefore tolerate `dt === 0` — none may
 * divide by it.
 *
 * EXACTLY ONE LOOP MAY DRIVE THE CLOCK. `tickSceneClock()` advances virtual
 * time, so it belongs in the single per-frame render callback. Anything else
 * that needs "now" (an effect start timestamp, a splash ring's t0) must call
 * `sceneNow()`, which reads without advancing.
 */

/** Default virtual frame step: 60 fps, the rate a rAF loop targets. */
export const DEFAULT_SCENE_STEP_MS = 1000 / 60;

/**
 * Default virtual start time. Nonzero on purpose: real `performance.now()` is
 * well past zero by the time a scene mounts, and some loops compare `now`
 * against a zero-initialised "last event at" timestamp. Starting at zero would
 * silently change those comparisons relative to the live app.
 */
const DEFAULT_START_MS = 1000;

let engaged = false;
let nowMs = DEFAULT_START_MS;
let stepMs = DEFAULT_SCENE_STEP_MS;
/**
 * Milliseconds of virtual time still owed to the scene. `Infinity` = run freely
 * (one step per frame, forever); `0` = frozen. A finite budget lets a caller ask
 * for an exact slice of animation and have it drain over the next N frames.
 */
let budgetMs = Infinity;

/** True when time is virtual (i.e. a harness is in control). */
export function isVirtualClock(): boolean {
  return engaged;
}

/**
 * Switch the process over to virtual time. Idempotent in effect but not in
 * value: calling it again resets the clock, so call it once, before any scene
 * mounts.
 */
export function engageVirtualClock(startMs = DEFAULT_START_MS, step = DEFAULT_SCENE_STEP_MS): void {
  engaged = true;
  nowMs = startMs;
  stepMs = step > 0 ? step : DEFAULT_SCENE_STEP_MS;
  budgetMs = Infinity;
}

/** Drop back to wall-clock time. Mainly for tests. */
export function disengageVirtualClock(): void {
  engaged = false;
  nowMs = DEFAULT_START_MS;
  stepMs = DEFAULT_SCENE_STEP_MS;
  budgetMs = Infinity;
}

/**
 * The current time, WITHOUT advancing it. Use this anywhere outside the single
 * per-frame tick — seeding a loop's `last`, stamping the start of a splash or a
 * divot fade, etc.
 */
export function sceneNow(): number {
  return engaged ? nowMs : performance.now();
}

/**
 * Advance the clock by one frame and return the new time. Call this exactly
 * once per rendered frame, from the render loop.
 *
 * `realNowMs` is the timestamp the platform handed the loop (the rAF argument).
 * When the virtual clock is NOT engaged it is returned verbatim — the loop
 * behaves exactly as it did before this module existed, with no extra clock
 * read and no drift.
 */
export function tickSceneClock(realNowMs?: number): number {
  if (!engaged) return realNowMs ?? performance.now();
  if (budgetMs > 0) {
    const step = Math.min(stepMs, budgetMs);
    nowMs += step;
    budgetMs -= step;
  }
  return nowMs;
}

/**
 * Stop advancing. Every later frame then renders from the same instant, so a
 * screenshot taken any number of frames later is identical.
 */
export function freezeSceneClock(): void {
  budgetMs = 0;
}

/**
 * Hand the scene an exact slice of animation: `ms` of virtual time, consumed one
 * fixed step per frame, after which the clock freezes again. This is how a
 * harness gets a settled camera or a few frames of water motion without
 * reintroducing wall-clock dependence.
 *
 * Additive, so two calls before the first has drained queue up.
 */
export function advanceSceneClock(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  budgetMs = budgetMs === Infinity ? ms : budgetMs + ms;
}

/** Let the clock run freely again (one step per frame, no budget). */
export function resumeSceneClock(): void {
  budgetMs = Infinity;
}

/**
 * Virtual milliseconds still owed. `0` means frozen — a harness polls this to
 * know an `advanceSceneClock()` slice has fully rendered. `Infinity` means the
 * clock is running freely.
 */
export function sceneClockPending(): number {
  return budgetMs;
}
