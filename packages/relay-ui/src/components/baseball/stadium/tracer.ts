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
  /** Replace the drawn polyline. `points` is flat scene-space `[x, y, z, …]`. */
  set(points: readonly number[]): void;
  /** Draw nothing (draw range 0) without freeing the buffer. */
  clear(): void;
  /** The vertices AS DRAWN, read out of the attribute. The gate's seam. */
  read(): number[];
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

  return {
    group,
    set(points) {
      const count = Math.min(Math.floor(points.length / 3), opts.maxPoints);
      for (let i = 0; i < count * 3; i++) positions[i] = points[i] ?? 0;
      attr.needsUpdate = true;
      geom.setDrawRange(0, count);
    },
    clear() {
      geom.setDrawRange(0, 0);
    },
    // ⚠ READ THE DRAW RANGE, NOT A PRIVATE COUNTER. This used to close over its
    // own `count`, which agreed with `drawRange.count` only because `set()` wrote
    // both. The gate's whole claim is that it reads WHAT THE GPU DRAWS, and the
    // first progressive draw range — the obvious next step, since these tracers
    // double as the ball's trail — would have made that claim false silently:
    // `read()` would keep returning geometry that is no longer being rasterised
    // and every delta the harness prints would stay zero. One source of truth,
    // and it is the one three hands to `drawArrays`.
    read() {
      return Array.from(positions.subarray(0, geom.drawRange.count * 3));
    },
    visible() {
      return line.visible && group.visible && geom.drawRange.count > 0;
    },
  };
}
