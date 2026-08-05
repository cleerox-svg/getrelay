// Shared, mode-agnostic shell for the Golf mini game. Framework-
// agnostic in the same spirit as lib/fog/engine.ts: the React wrapper
// (components/golf/GolfCanvas.tsx) owns the rAF loop, pointer events
// and lifecycle; this class only owns the 2D context, the letterbox
// fit transform, a fixed-timestep accumulator loop and an event queue.
//
// The actual simulation and drawing live in a MODE module implementing
// GolfMode (lib/golf/putting.ts for Phase 1; a driving-range module in
// Phase 2). GolfEngine never imports a mode — it delegates through the
// interface, so the shell stays reusable across modes.
//
// Design constraints (low-end Android WebView is the floor):
// - Backing store capped at devicePixelRatio 2.
// - NO shadowBlur anywhere: it forces a slow path on Android. Modes
//   fake shadows with offset semi-transparent fills.
// - NO ctx.roundRect(): unavailable on older WebViews — modes hand-roll
//   rounded-rect paths.

import { FIXED_MS } from './tuning';

// The virtual coordinate space every mode authors in: a 4:5 portrait
// board. The fit transform maps this to CSS pixels with letterboxing.
export const VW = 100;
export const VH = 125;

const FIXED_S = FIXED_MS / 1000;
// Cap substeps per frame so a long stall (backgrounded tab, GC pause)
// can't trigger a spiral-of-death of catch-up steps.
const MAX_SUBSTEPS = 4;

export interface Vec {
  x: number;
  y: number;
}

// Letterbox fit: virtual units -> CSS px is `off + v * scale`.
export interface Fit {
  scale: number;
  offX: number;
  offY: number;
}

// Shared Vec math. Pure, allocation-light helpers used by every mode.
export const V = {
  add: (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s }),
  len: (a: Vec): number => Math.hypot(a.x, a.y),
  dot: (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y,
  normalize: (a: Vec): Vec => {
    const l = Math.hypot(a.x, a.y);
    return l > 1e-9 ? { x: a.x / l, y: a.y / l } : { x: 0, y: 0 };
  },
  // Nearest point to `p` on segment a->b. Clamped to the endpoints, so
  // wall collision treats a finite segment, not an infinite line.
  closestPointOnSegment(p: Vec, a: Vec, b: Vec): Vec {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const denom = abx * abx + aby * aby;
    if (denom < 1e-9) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / denom;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return { x: a.x + abx * t, y: a.y + aby * t };
  },
};

// Convert a virtual-space point to CSS pixels (for drawing).
export function toScreen(fit: Fit, v: Vec): Vec {
  return { x: fit.offX + v.x * fit.scale, y: fit.offY + v.y * fit.scale };
}

// Convert a CSS-pixel point (a pointer position) back to virtual space.
export function toVirtual(fit: Fit, p: Vec): Vec {
  return { x: (p.x - fit.offX) / fit.scale, y: (p.y - fit.offY) / fit.scale };
}

// Phase 1 (putting) uses stroke/rest/sink. Phase 2 (driving range) adds
// launch/land/splash/fence. The union stays backward-tolerant: the shell
// never inspects the type, and each mode only emits the members it needs,
// so adding members can't break an existing mode or the wrapper's drain.
export type GolfEventType =
  | 'stroke'
  | 'rest'
  | 'sink'
  | 'launch'
  | 'land'
  | 'splash'
  | 'fence';
export interface GolfEvent {
  type: GolfEventType;
}

// What the engine hands a mode so it can push gameplay events into the
// shared queue and read the live fit transform (for pointer->virtual
// conversion) without knowing about the wrapper.
export interface ModeCtx {
  emit(e: GolfEvent): void;
  fit(): Fit;
}

// The contract every game mode implements. Pointer coords arrive in CSS
// pixels (relative to the canvas); the mode converts via ctx.fit().
export interface GolfMode {
  substep(h: number): void;
  render(ctx: CanvasRenderingContext2D, fit: Fit): void;
  onPointerDown(p: Vec): void;
  onPointerMove(p: Vec): void;
  onPointerUp(p: Vec): void;
  getState(): unknown;
}

function computeFit(cssW: number, cssH: number): Fit {
  const scale = Math.min(cssW / VW, cssH / VH);
  return {
    scale,
    offX: (cssW - VW * scale) / 2,
    offY: (cssH - VH * scale) / 2,
  };
}

export class GolfEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private fit: Fit = { scale: 1, offX: 0, offY: 0 };
  private mode: GolfMode | null = null;
  private acc = 0;
  private events: GolfEvent[] = [];
  // Stable ModeCtx handed to every mode — closes over `this`, so it
  // always reads the current fit and pushes into the live queue.
  private readonly modeCtx: ModeCtx = {
    emit: (e) => this.events.push(e),
    fit: () => this.fit,
  };

  init(canvas: HTMLCanvasElement, cssW: number, cssH: number): void {
    this.canvas = canvas;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = cssW;
    this.cssH = cssH;
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx = ctx;
    this.fit = computeFit(cssW, cssH);
  }

  // A mode owns one hole/scene. Replacing it (loadHole/resetHole) is a
  // fresh mode instance; the accumulator is reset so no stale sim time
  // carries across.
  setMode(mode: GolfMode | null): void {
    this.mode = mode;
    this.acc = 0;
  }

  // The live mode instance, so the React wrapper can expose it for
  // mode-specific control (e.g. the range's club/target selectors).
  getMode(): GolfMode | null {
    return this.mode;
  }

  // Handed to a mode's constructor so it can emit events + read the fit.
  context(): ModeCtx {
    return this.modeCtx;
  }

  // Fixed-timestep integration. Accumulate the (clamped) frame delta and
  // run whole 1/120s substeps, capped so a long pause can't spiral.
  step(dtMs: number): void {
    this.acc += Math.min(dtMs, 100);
    let n = 0;
    while (this.acc >= FIXED_MS && n < MAX_SUBSTEPS) {
      this.mode?.substep(FIXED_S);
      this.acc -= FIXED_MS;
      n++;
    }
    // Hit the cap with time to spare: drop the backlog rather than
    // carrying it into the next frame as a burst.
    if (n >= MAX_SUBSTEPS && this.acc >= FIXED_MS) this.acc = 0;
  }

  render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    this.mode?.render(ctx, this.fit);
  }

  // The wrapper drains this once per frame and surfaces events as
  // React callbacks (stroke / rest / sink).
  drainEvents(): GolfEvent[] {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  onPointerDown(p: Vec): void {
    this.mode?.onPointerDown(p);
  }
  onPointerMove(p: Vec): void {
    this.mode?.onPointerMove(p);
  }
  onPointerUp(p: Vec): void {
    this.mode?.onPointerUp(p);
  }

  resize(cssW: number, cssH: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    this.cssW = cssW;
    this.cssH = cssH;
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    // Setting width resets the transform; reapply the DPR scale.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fit = computeFit(cssW, cssH);
  }

  destroy(): void {
    this.canvas = null;
    this.ctx = null;
    this.mode = null;
    this.events = [];
  }
}
