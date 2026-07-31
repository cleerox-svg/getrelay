// Canvas "condensation" engine for the Fog mini game. Framework-
// agnostic: the React wrapper (components/fog/FogCanvas.tsx) owns the
// rAF loop, pointer events and lifecycle; this class only pushes
// pixels.
//
// Design constraints (low-end Android WebView is the floor):
// - Backing store capped at devicePixelRatio 2 — 3x panels burn fill
//   rate for no visible gain under a blur-less fog layer.
// - The fog is a repeating 128x128 pattern tile, not per-frame noise.
// - Wiping stamps a pre-rendered soft brush with destination-out. No
//   shadowBlur anywhere: it forces a slow path on Android.
// - CRITICAL: the mystery image is NEVER drawn into this canvas. It
//   sits in a separate <img> element underneath. Remote pixels
//   (Giphy / ESPN logos / avatars) would taint the canvas and make
//   the getImageData call in fogPct() throw.

import { REFOG_TICK_MS } from './tuning';

export type FogTheme = 'light' | 'dark';
export type BrushHardness = 'soft' | 'hard';

export interface FogEngineOpts {
  theme: FogTheme;
  // Initial fog opacity, 0.75–1.0.
  fogDensity: number;
  // Alpha re-applied per 100ms tick; 0 disables refog.
  refogRate: number;
}

const TILE = 128;
// fogPct() samples the canvas downscaled to 64x80 (matches the 4:5
// play area) — 5120 pixels is plenty for a percentage and cheap to
// read back every 250ms.
const SAMPLE_W = 64;
const SAMPLE_H = 80;
const BREATHE_BOOST = 0.15;
const BREATHE_MS = 600;

// Condensation base colors per theme — cool gray so the glass reads
// as steamed-up rather than painted over.
const FOG_RGB: Record<FogTheme, [number, number, number]> = {
  light: [210, 216, 224],
  dark: [60, 66, 78],
};

export class FogEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private opts: FogEngineOpts = { theme: 'light', fogDensity: 1, refogRate: 0 };
  private pattern: CanvasPattern | null = null;
  private brush: HTMLCanvasElement | null = null;
  private brushSize = 0;
  private brushHardness: BrushHardness = 'soft';
  private tickAcc = 0;
  private breatheUntil = 0;
  private sampleCtx: CanvasRenderingContext2D | null = null;

  init(canvas: HTMLCanvasElement, cssW: number, cssH: number, opts: FogEngineOpts): void {
    this.canvas = canvas;
    this.opts = { ...opts };
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = cssW;
    this.cssH = cssH;
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(this.dpr, this.dpr);
    this.ctx = ctx;
    this.buildPattern();
    this.refill();
  }

  setTheme(theme: FogTheme): void {
    if (theme === this.opts.theme) return;
    this.opts.theme = theme;
    // Rebuild the tile; existing fog keeps its old tint until the next
    // refill/refog pass. Good enough — theme flips mid-wipe are rare.
    this.buildPattern();
  }

  setFogDensity(d: number): void {
    this.opts.fogDensity = d;
  }

  setRefogRate(r: number): void {
    this.opts.refogRate = r;
  }

  // 128x128 condensation tile: per-pixel alpha noise (+/-0.06) over
  // the theme base color, plus a faint diagonal light gradient so the
  // sheet doesn't look like a flat color fill.
  private buildPattern(): void {
    if (!this.ctx) return;
    const tile = document.createElement('canvas');
    tile.width = TILE;
    tile.height = TILE;
    const tctx = tile.getContext('2d');
    if (!tctx) return;
    const [r, g, b] = FOG_RGB[this.opts.theme];
    const img = tctx.createImageData(TILE, TILE);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      const noise = (Math.random() * 2 - 1) * 0.06;
      data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, 1 + noise)));
    }
    tctx.putImageData(img, 0, 0);
    // Diagonal sheen, clipped to the tile's own alpha.
    const grad = tctx.createLinearGradient(0, 0, TILE, TILE);
    grad.addColorStop(0, 'rgba(255,255,255,0.07)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.06)');
    tctx.globalCompositeOperation = 'source-atop';
    tctx.fillStyle = grad;
    tctx.fillRect(0, 0, TILE, TILE);
    this.pattern = this.ctx.createPattern(tile, 'repeat');
  }

  private fillFog(alpha: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.pattern) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
    ctx.fillStyle = this.pattern;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    ctx.restore();
  }

  // Pre-rendered radial brush, regenerated only when size or hardness
  // changes — stamping a cached canvas is far cheaper than building a
  // gradient per stamp.
  private ensureBrush(sizePx: number, hardness: BrushHardness): HTMLCanvasElement | null {
    if (this.brush && this.brushSize === sizePx && this.brushHardness === hardness) {
      return this.brush;
    }
    const px = Math.max(2, Math.ceil(sizePx * this.dpr));
    const c = document.createElement('canvas');
    c.width = px;
    c.height = px;
    const bctx = c.getContext('2d');
    if (!bctx) return null;
    const half = px / 2;
    const grad = bctx.createRadialGradient(half, half, 0, half, half, half);
    if (hardness === 'hard') {
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(0.75, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    } else {
      grad.addColorStop(0, 'rgba(0,0,0,0.9)');
      grad.addColorStop(0.55, 'rgba(0,0,0,0.45)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
    }
    bctx.fillStyle = grad;
    bctx.fillRect(0, 0, px, px);
    this.brush = c;
    this.brushSize = sizePx;
    this.brushHardness = hardness;
    return c;
  }

  // Wipe along a segment by stamping the brush every brushPx/4.
  // Returns the segment length (CSS px) so the caller can meter a
  // wipe budget.
  wipeSegment(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    brushPx: number,
    hardness: BrushHardness,
  ): number {
    const ctx = this.ctx;
    const brush = this.ensureBrush(brushPx, hardness);
    if (!ctx || !brush) return 0;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, brushPx / 4);
    const stamps = Math.max(1, Math.ceil(len / step));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i <= stamps; i++) {
      const t = stamps === 0 ? 0 : i / stamps;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      ctx.drawImage(brush, x - brushPx / 2, y - brushPx / 2, brushPx, brushPx);
    }
    ctx.restore();
    return len;
  }

  // Advance the refog clock. Called from the wrapper's rAF loop with
  // frame delta; fills only fire on 100ms boundaries.
  tick(dtMs: number): void {
    if (!this.ctx) return;
    this.tickAcc += dtMs;
    while (this.tickAcc >= REFOG_TICK_MS) {
      this.tickAcc -= REFOG_TICK_MS;
      const boosted = performance.now() < this.breatheUntil;
      const rate = this.opts.refogRate + (boosted ? BREATHE_BOOST : 0);
      if (rate > 0) this.fillFog(rate);
    }
  }

  // "Haaah" on the glass: a burst of extra refog for 600ms plus a soft
  // one-off condensation puff at the center.
  breathe(): void {
    this.breatheUntil = performance.now() + BREATHE_MS;
    const ctx = this.ctx;
    if (!ctx) return;
    const [r, g, b] = FOG_RGB[this.opts.theme];
    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const radius = Math.min(this.cssW, this.cssH) * 0.45;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.45)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = grad;
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  // Fraction of the pane still fogged (0..1), read from a 64x80
  // downsample. Safe to getImageData because this canvas only ever
  // contains our own generated fog pixels — never the remote image.
  fogPct(): number {
    if (!this.canvas) return 0;
    if (!this.sampleCtx) {
      const c = document.createElement('canvas');
      c.width = SAMPLE_W;
      c.height = SAMPLE_H;
      this.sampleCtx = c.getContext('2d', { willReadFrequently: true });
    }
    const sctx = this.sampleCtx;
    if (!sctx) return 0;
    sctx.clearRect(0, 0, SAMPLE_W, SAMPLE_H);
    sctx.drawImage(this.canvas, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let sum = 0;
    for (let i = 3; i < data.length; i += 4) sum += data[i] ?? 0;
    return sum / (255 * SAMPLE_W * SAMPLE_H);
  }

  clearFog(): void {
    this.ctx?.clearRect(0, 0, this.cssW, this.cssH);
  }

  refill(): void {
    if (!this.ctx) return;
    this.clearFog();
    this.fillFog(this.opts.fogDensity);
  }

  // Resizing recreates the backing store, which wipes the bitmap — a
  // full refog on rotate/resize is acceptable (and arguably fair).
  resize(cssW: number, cssH: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    this.cssW = cssW;
    this.cssH = cssH;
    canvas.width = Math.max(1, Math.round(cssW * this.dpr));
    canvas.height = Math.max(1, Math.round(cssH * this.dpr));
    // Setting width resets the context transform; reapply the scale.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.refill();
  }

  destroy(): void {
    this.canvas = null;
    this.ctx = null;
    this.pattern = null;
    this.brush = null;
    this.sampleCtx = null;
  }
}
