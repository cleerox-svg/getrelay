/**
 * scene3d/stats — GPU instrumentation for a Three.js render loop.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/GRAPHICS.md` §4 rule 5: "Numeric budgets are committed and enforced." That
 * is impossible without a number, and until this module landed the golf scenes —
 * the bigger, shipped ones — emitted none at all: `scripts/shoot-baseball.mjs`
 * printed draw calls and triangles per scene while `scripts/shoot-golf.mjs`
 * printed nothing numeric. Golf was the one flying blind, and every item on the
 * fidelity roadmap adds GPU cost.
 *
 * WHAT IT IS NOT. It is not a profiler and it cannot see the GPU. `renderer.info`
 * counts what the CPU SUBMITTED; a scene can be well inside every number here and
 * still fall over on a handset, which is exactly how the 2048² shadow map shipped.
 * These numbers catch the regressions that are visible from the CPU side — an
 * un-instanced crowd, a material split per section, a texture leaked on every
 * remount — and nothing else. Rule 4 still stands: "renders fine in SwiftShader"
 * is not evidence of on-device safety.
 *
 * READ IT AFTER `render()`, NOT BEFORE. three resets `info.render` at the START
 * of each `render()` call, so a sample taken before the draw reports the previous
 * frame (and, on frame 1, zero).
 */

import type { SceneQuality, SceneTier } from './quality';

/** One instrumentation sample from a render loop. */
export interface SceneStats {
  /** `renderer.info.render.calls` — the dominant mobile cost. */
  drawCalls: number;
  /** `renderer.info.render.triangles`. */
  triangles: number;
  /** Compiled shader programs. Growth here means a material variant exploded. */
  programs: number;
  /** Live geometries. Should be flat once a scene is built — growth is a leak. */
  geometries: number;
  /** Live textures. Same: flat after build, or something is uploading per frame. */
  textures: number;
  /** The resolved tier, and enough of it to explain the numbers above. */
  tier: SceneTier;
  shadows: boolean;
  shadowMapSize: number;
  pixelRatioCap: number;
  /** Why that tier was chosen — see `quality.ts`. */
  qualityReason: string;
  /**
   * Median frame time over the probe window, ms, or `null` before the window
   * fills. WALL CLOCK, deliberately: a virtual-clock step would report the step,
   * not the machine. Nothing renders from this value — it is telemetry for a
   * human holding a handset.
   */
  frameMs: number | null;
  /** Frames rendered by this scene when the sample was taken. */
  frame: number;
}

/**
 * A rolling frame-time probe.
 *
 * MEDIAN, NOT MEAN, and that is the whole design. A mean over a browser
 * animation loop is dominated by the outliers a phone produces for free — a GC
 * pause, a compositor hiccup, the OS scheduling something else — so it reports a
 * device as slow when it was merely interrupted. The median answers the question
 * actually being asked: what does a typical frame cost here.
 *
 * ⚠ IT DOES NOT FEED THE TIER, ON PURPOSE. See the header of `quality.ts` for
 * what a promotion would have to persist, and why persisting it would make the
 * screenshot harness's tier depend on a previous run.
 */
export interface FrameProbe {
  /** Call once per rendered frame, at the end of the loop body. */
  sample(): void;
  /** Median frame time over the window, or `null` until the window fills. */
  medianMs(): number | null;
}

/**
 * Build a probe over a rolling window of `size` frames.
 *
 * 30 frames is half a second at 60 fps and ~10 s under SwiftShader, which is the
 * right order for "is this device coping" and short enough that the whole thing
 * is one small preallocated array.
 */
export function makeFrameProbe(size = 30): FrameProbe {
  const win = new Float64Array(size);
  const sorted = new Float64Array(size);
  let n = 0;
  let i = 0;
  let last = 0;
  return {
    sample() {
      const t = performance.now();
      // The first sample only starts the stopwatch — there is no previous frame
      // to measure against, and treating `t - 0` as a frame time would report the
      // page's whole lifetime as one catastrophic frame.
      if (last > 0) {
        win[i] = t - last;
        i = (i + 1) % size;
        if (n < size) n++;
      }
      last = t;
    },
    medianMs() {
      if (n < size) return null;
      sorted.set(win);
      sorted.sort();
      const mid = size >> 1;
      return size % 2 ? (sorted[mid] ?? null) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
    },
  };
}

/**
 * The slice of `THREE.WebGLRenderer` a sample reads, structurally — so this
 * module needs no `three` import and can be unit-tested in a node environment.
 */
export interface SceneStatsRenderer {
  info: {
    render: { calls: number; triangles: number };
    memory: { geometries: number; textures: number };
    programs?: { length: number } | null;
  };
}

/** Snapshot the renderer's counters. Call AFTER `renderer.render()`. */
export function sampleSceneStats(
  renderer: SceneStatsRenderer,
  quality: SceneQuality,
  frame: number,
  frameMs: number | null = null,
): SceneStats {
  const info = renderer.info;
  return {
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    programs: info.programs?.length ?? 0,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    tier: quality.tier,
    shadows: quality.shadows,
    shadowMapSize: quality.shadowMapSize,
    pixelRatioCap: quality.pixelRatioCap,
    qualityReason: quality.reason,
    frameMs,
    frame,
  };
}

/**
 * Should this frame emit a sample?
 *
 * Every 30th frame, PLUS frame 3. The cadence keeps the cost of instrumentation
 * at roughly nothing in a shipped loop; the extra early sample exists for the
 * screenshot harness, which under SwiftShader renders at ~3 fps and would
 * otherwise wait ten seconds per scene for its first number.
 *
 * Frame 3 rather than frame 1 because three uploads textures and compiles
 * programs lazily on first use, so frame 1 undercounts both.
 */
export function shouldSampleStats(frame: number): boolean {
  return frame === 3 || frame % 30 === 0;
}
