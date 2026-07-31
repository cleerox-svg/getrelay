import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { FogEngine } from '../../lib/fog/engine';
import type { BrushHardness, FogTheme } from '../../lib/fog/engine';

// The foggy window itself: a mystery image "outside" the glass with a
// condensation canvas on top. The image is a plain <img> UNDER the
// canvas — never drawn into it — so cross-origin sources (Giphy, team
// logos, avatars) can't taint the canvas and break the fog-percentage
// readback (see lib/fog/engine.ts).

export interface FogCanvasHandle {
  reset(): void;
  clearFog(): void;
  breathe(): void;
  getFogPct(): number;
}

interface Props {
  imageUrl?: string | null;
  // Plain CSS color painted behind the glass instead of an image
  // (free-play color swatches).
  background?: string | null;
  refogRate: number;
  brushSizePx: number;
  brushHardness: BrushHardness;
  fogDensity: number;
  wipeEnabled: boolean;
  onWipe?: (lenPx: number) => void;
  onFogPct?: (pct: number) => void;
}

// Same resolution logic as App.tsx / lib/theme.ts: explicit data-theme
// wins, otherwise the OS preference.
function resolveTheme(): FogTheme {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return 'dark';
  if (explicit === 'light') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const FogCanvas = forwardRef<FogCanvasHandle, Props>(function FogCanvas(
  {
    imageUrl,
    background,
    refogRate,
    brushSizePx,
    brushHardness,
    fogDensity,
    wipeEnabled,
    onWipe,
    onFogPct,
  },
  ref,
) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<FogEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const activePointer = useRef<number | null>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  // Latest callbacks/props for the rAF loop without re-registering it.
  const onFogPctRef = useRef(onFogPct);
  onFogPctRef.current = onFogPct;

  useImperativeHandle(ref, () => ({
    reset: () => engineRef.current?.refill(),
    clearFog: () => engineRef.current?.clearFog(),
    breathe: () => engineRef.current?.breathe(),
    getFogPct: () => engineRef.current?.fogPct() ?? 0,
  }));

  // Engine lifecycle: init once, run a single rAF loop (paused while
  // the document is hidden), watch for resizes and theme flips.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;

    const engine = new FogEngine();
    // clientWidth/Height = the padding box, which is what the inset-0
    // canvas actually spans (getBoundingClientRect would include the
    // frame's 1px border and disagree with the ResizeObserver's
    // contentRect by 2px).
    const initW = frame.clientWidth;
    const initH = frame.clientHeight;
    engine.init(canvas, initW, initH, {
      theme: resolveTheme(),
      fogDensity,
      refogRate,
    });
    engineRef.current = engine;

    let lastTs = performance.now();
    let lastSample = 0;
    const loop = (now: number) => {
      engine.tick(now - lastTs);
      lastTs = now;
      if (now - lastSample >= 250) {
        lastSample = now;
        onFogPctRef.current?.(engine.fogPct());
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    // Pause the loop entirely while hidden — no refog, no sampling.
    // On resume, reset lastTs so the hidden interval doesn't get
    // applied as one giant refog burst.
    const onVis = () => {
      if (document.hidden) {
        if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      } else if (rafRef.current == null) {
        lastTs = performance.now();
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    document.addEventListener('visibilitychange', onVis);

    // Resize recreates the backing store, i.e. a full refog. Fine —
    // rotating mid-round re-steams the window.
    let lastW = initW;
    let lastH = initH;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width === lastW && height === lastH) return;
      if (width <= 0 || height <= 0) return;
      lastW = width;
      lastH = height;
      engine.resize(width, height);
    });
    ro.observe(frame);

    // Theme can flip via the Profile picker (data-theme mutation) or
    // the OS (auto mode).
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => engine.setTheme(resolveTheme());
    mq.addEventListener('change', onTheme);
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      mq.removeEventListener('change', onTheme);
      mo.disconnect();
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
    // Mount-only: live prop changes are pushed via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    engineRef.current?.setRefogRate(refogRate);
  }, [refogRate]);

  useEffect(() => {
    // Density changes re-lay the whole sheet — it's a free-play
    // control, not something that changes mid-round.
    const engine = engineRef.current;
    if (!engine) return;
    engine.setFogDensity(fogDensity);
    engine.refill();
  }, [fogDensity]);

  // New subject behind the glass → fresh fog.
  useEffect(() => {
    engineRef.current?.refill();
  }, [imageUrl, background]);

  function toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!wipeEnabled || activePointer.current != null) return;
    const engine = engineRef.current;
    if (!engine) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    const p = toLocal(e);
    lastPos.current = p;
    // A tap wipes a dot. Charge it one brush-width of budget —
    // otherwise machine-gun tapping would clear the pane for free.
    engine.wipeSegment(p.x, p.y, p.x, p.y, brushSizePx, brushHardness);
    onWipe?.(brushSizePx);
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerId !== activePointer.current || !wipeEnabled) return;
    const engine = engineRef.current;
    const last = lastPos.current;
    if (!engine || !last) return;
    // Coalesced events give us the full high-frequency touch path on
    // supporting browsers instead of one sampled point per frame.
    const native = e.nativeEvent;
    const events: { clientX: number; clientY: number }[] =
      typeof native.getCoalescedEvents === 'function' && native.getCoalescedEvents().length > 0
        ? native.getCoalescedEvents()
        : [native];
    let total = 0;
    let prev = last;
    for (const ev of events) {
      const p = toLocal(ev);
      total += engine.wipeSegment(prev.x, prev.y, p.x, p.y, brushSizePx, brushHardness);
      prev = p;
    }
    lastPos.current = prev;
    if (total > 0) onWipe?.(total);
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    lastPos.current = null;
  }

  return (
    <div
      ref={frameRef}
      className="relative w-full overflow-hidden rounded-2xl mx-auto"
      style={{
        // Fixed 4:5 pane, height-capped so the choice buttons stay on
        // screen and the page never needs to scroll mid-wipe.
        aspectRatio: '4 / 5',
        maxHeight: '60vh',
        maxWidth: 'calc(60vh * 0.8)',
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.14)',
      }}
    >
      {background ? (
        <div aria-hidden className="absolute inset-0" style={{ background }} />
      ) : imageUrl ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-contain"
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        // touch-action none: the wipe gesture must not scroll the page.
        style={{ touchAction: 'none', overscrollBehavior: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endStroke}
        onPointerCancel={endStroke}
        onLostPointerCapture={endStroke}
      />
    </div>
  );
});
