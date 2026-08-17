// The FLIGHT TRACER — a preallocated polyline, and the visual gate's READ-BACK
// SEAM.
//
// ⚠ THIS IS THE ONE OBJECT THE GATE ACTUALLY MEASURES. `baseball-visual-qa`'s
// highest-value check is "the sim reports N inches of break; does the DRAWN
// curve bend the same way and the same amount?" — and it can only ask that of
// geometry it can read. `read()` returns the vertices out of the SAME
// `BufferAttribute` the GPU draws from, not a copy of the input, so a tracer
// that is written wrong, truncated, or quietly re-sampled shows up as a delta.
// Returning the caller's own input here would make the gate a tautology.
//
// ⚠ PREALLOCATED, WITH `setDrawRange`. A pitch is ~51 samples and a fly ball is
// up to ~1440; reallocating a BufferGeometry per frame would churn a GPU buffer
// 120 times a second for data that only changes when a new flight is served.
// The buffer is sized once at build time and the draw range moves.
//
// ⚠ AND THE DRAW RANGE IS NOW THE REVEAL. `set()` writes the WHOLE flight once;
// `reveal(n)` says how much of it has happened yet. The vertex data never moves
// after `set()` — which is what keeps the visual gate's drawn-vs-sim comparison
// a statement about the renderer and not about an animation — while what the GPU
// rasterises grows with the ball. Before this, the entire arc INCLUDING THE
// LANDING POINT was on screen from the instant the pitch was served: the player
// could read a home run before it happened, and could read the pitch's break
// before having to commit to a swing. That is an information leak, not a
// framerate problem, and it is fixed here rather than in the sim.
//
// It is a `Line`, i.e. ONE draw call per tracer. WebGL ignores
// `LineBasicMaterial.linewidth` on every platform that matters, so the tracer is
// 1 px wide by construction — bright colours rather than thick ones.

import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicMaterial,
} from 'three';
import type { StadiumCtx, StadiumPart } from './geom';

export interface TracerHandle extends StadiumPart {
  /**
   * Replace the polyline. `points` is flat scene-space `[x, y, z, …]`.
   *
   * Writes the WHOLE path and reveals all of it; `reveal()` is what trims it
   * back to the part that has happened. A caller that wants a progressive trail
   * calls `set()` once per flight and `reveal()` once per frame.
   */
  set(points: readonly number[]): void;
  /**
   * How many leading vertices the GPU draws. Clamped to what `set()` wrote, so
   * a caller cannot reveal geometry that is not there.
   */
  reveal(count: number): void;
  /** Vertices `set()` wrote, revealed or not. */
  written(): number;
  /** Draw nothing (draw range 0) without freeing the buffer. */
  clear(): void;
  /** The vertices AS DRAWN, read out of the attribute. The gate's seam. */
  read(): number[];
  /**
   * The WHOLE written path, revealed or not — the gate's geometry seam.
   *
   * ⚠ TWO READERS, TWO QUESTIONS, AND CONFLATING THEM WOULD HAVE HOLLOWED THE
   * GATE. `read()` answers "what is on screen right now", which is what the
   * information-leak check needs; this answers "what did the renderer build from
   * the sim", which is what the 0.002 ft drawn-vs-sim comparison needs. Point
   * the second question at `read()` and it silently becomes a check on a
   * prefix — every hidden vertex stops being compared, and a tracer that is
   * wrong past the ball passes forever.
   */
  readAll(): number[];
  /** Is the line actually being rendered? Position without this proves nothing. */
  visible(): boolean;
}

export interface TracerOptions {
  name: string;
  color: number;
  /** Upper bound on vertices. Over-length input is truncated, never grown. */
  maxPoints: number;
}

export function buildTracer({ scene, track }: StadiumCtx, opts: TracerOptions): TracerHandle {
  const group = new Group();
  group.name = opts.name;

  const positions = new Float32Array(opts.maxPoints * 3);
  const attr = new BufferAttribute(positions, 3);
  attr.setUsage(DynamicDrawUsage);
  const geom = track(new BufferGeometry());
  geom.setAttribute('position', attr);
  geom.setDrawRange(0, 0);

  const mat = track(new LineBasicMaterial({ color: opts.color }));
  const line = new Line(geom, mat);
  line.name = opts.name;
  // The bounding sphere is computed from a buffer that is all zeros at build
  // time and is never recomputed, so three would cull the tracer against a
  // point at the origin. Culling one line saves nothing; being invisible in
  // half the camera modes costs the gate everything.
  line.frustumCulled = false;
  group.add(line);
  scene.add(group);

  let written = 0;

  return {
    group,
    set(points) {
      const count = Math.min(Math.floor(points.length / 3), opts.maxPoints);
      for (let i = 0; i < count * 3; i++) positions[i] = points[i] ?? 0;
      attr.needsUpdate = true;
      written = count;
      geom.setDrawRange(0, count);
    },
    reveal(count) {
      const n = Number.isFinite(count) ? Math.floor(count) : 0;
      geom.setDrawRange(0, Math.max(0, Math.min(n, written)));
    },
    written: () => written,
    clear() {
      written = 0;
      geom.setDrawRange(0, 0);
    },
    // ⚠ READ THE DRAW RANGE, NOT A PRIVATE COUNTER. This used to close over its
    // own `count`, which agreed with `drawRange.count` only because `set()` wrote
    // both. The gate's whole claim is that it reads WHAT THE GPU DRAWS, and a
    // progressive draw range would have made that claim false silently: `read()`
    // would keep returning geometry that is no longer being rasterised and every
    // delta the harness prints would stay zero. One source of truth, and it is
    // the one three hands to `drawArrays`.
    //
    // ⚠ THE PROGRESSIVE DRAW RANGE HAS NOW LANDED, and this line is why the gate
    // did not have to be weakened for it. `read()` narrowed to the revealed
    // prefix on the day `reveal()` appeared — automatically, because it was
    // already asking three rather than a counter — so the harness's re-basing was
    // a matter of pointing the geometry checks at `readAll()` and pointing a NEW
    // check (the trail's tip must never be ahead of the ball) at `read()`.
    read() {
      return Array.from(positions.subarray(0, geom.drawRange.count * 3));
    },
    readAll() {
      return Array.from(positions.subarray(0, written * 3));
    },
    visible() {
      return line.visible && group.visible && geom.drawRange.count > 0;
    },
  };
}
