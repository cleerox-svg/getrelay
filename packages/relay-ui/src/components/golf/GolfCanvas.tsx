import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { GolfEngine } from '../../lib/golf/engine';
import type { GolfEvent, GolfMode, ModeCtx } from '../../lib/golf/engine';

// The shared hand-rolled Canvas 2D surface for the Golf game. The
// GolfEngine owns the fit transform, the fixed-timestep sim and an event
// queue; this harness owns the rAF loop, pointer input and lifecycle.
//
// Mode-agnostic (Phase 2): instead of building a PuttingMode from a hole,
// it takes a `makeMode` factory so the same harness drives both the
// top-down putting mode and the down-range driving-range mode. The caller
// bumps `modeKey` to rebuild the mode (new hole / new target), reads the
// live mode instance via the handle's getMode(), and receives raw engine
// events through onEvent.
//
// Renders EVERY frame (a live physics scene): the loop calls engine.step(dt)
// then engine.render() unconditionally.

export interface GolfCanvasHandle {
  // Rebuild the mode from the current factory (e.g. reset the hole).
  rebuild(): void;
  // The live mode instance, for mode-specific control (club/target).
  getMode(): GolfMode | null;
}

interface Props {
  // Build a fresh mode against the engine's ModeCtx. Called at mount, on
  // every modeKey change, and on an explicit rebuild().
  makeMode: (ctx: ModeCtx) => GolfMode;
  // Bump/change to rebuild the mode (new hole id, new challenge target…).
  modeKey?: string | number;
  // Freeze the scene: stops the rAF loop and ignores pointer input. Same
  // pathway the document-hidden pause uses, so resuming can't apply the
  // paused interval as one giant physics step.
  paused?: boolean;
  // Raw engine events (stroke/rest/sink for putting; launch/land/splash/
  // fence/rest for the range), drained once per frame in order.
  onEvent?: (e: GolfEvent) => void;
}

export const GolfCanvas = forwardRef<GolfCanvasHandle, Props>(function GolfCanvas(
  { makeMode, modeKey, paused = false, onEvent },
  ref,
) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GolfEngine | null>(null);
  const rafRef = useRef<number | null>(null);
  const activePointer = useRef<number | null>(null);
  // Latest callbacks/props for the rAF loop without re-registering it.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  // Latest factory so rebuild()/modeKey changes always use current props.
  const makeModeRef = useRef(makeMode);
  makeModeRef.current = makeMode;
  // start/stop handles onto the mount effect's rAF loop, so the `paused`
  // prop and the visibilitychange listener drive the same pause pathway.
  const loopCtlRef = useRef<{ start: () => void; stop: () => void } | null>(null);

  function buildMode(engine: GolfEngine) {
    engine.setMode(makeModeRef.current(engine.context()));
  }

  useImperativeHandle(ref, () => ({
    rebuild: () => {
      const engine = engineRef.current;
      if (engine) buildMode(engine);
    },
    getMode: () => engineRef.current?.getMode() ?? null,
  }));

  // Engine lifecycle: init once, run a single rAF loop (paused while the
  // document is hidden), watch for resizes.
  useEffect(() => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;

    const engine = new GolfEngine();
    const initW = frame.clientWidth;
    const initH = frame.clientHeight;
    engine.init(canvas, initW, initH);
    buildMode(engine);
    engineRef.current = engine;

    let lastTs = performance.now();
    const loop = (now: number) => {
      engine.step(now - lastTs);
      lastTs = now;
      engine.render();
      const events = engine.drainEvents();
      for (const e of events) onEventRef.current?.(e);
      rafRef.current = requestAnimationFrame(loop);
    };

    const stop = () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    const start = () => {
      if (rafRef.current != null) return;
      lastTs = performance.now();
      rafRef.current = requestAnimationFrame(loop);
    };
    loopCtlRef.current = { start, stop };
    if (!pausedRef.current) start();

    const onVis = () => {
      if (document.hidden) stop();
      else if (!pausedRef.current) start();
    };
    document.addEventListener('visibilitychange', onVis);

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

    return () => {
      stop();
      loopCtlRef.current = null;
      document.removeEventListener('visibilitychange', onVis);
      ro.disconnect();
      engine.destroy();
      engineRef.current = null;
    };
    // Mount-only: live prop changes are pushed via the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pause/resume from the prop. Runs after the mount effect has filled
  // loopCtlRef, so a canvas that mounts already paused never ticks.
  useEffect(() => {
    if (paused) {
      // Drop any in-flight aim so resuming doesn't launch a stale shot.
      activePointer.current = null;
    }
    const ctl = loopCtlRef.current;
    if (!ctl) return;
    if (paused) ctl.stop();
    else if (!document.hidden) ctl.start();
  }, [paused]);

  // New modeKey → rebuild the mode (also covers the very first mount, which
  // buildMode already handled, so the first run is a redundant-but-cheap
  // rebuild — acceptable, and keeps the reset path identical).
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    buildMode(engine);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeKey]);

  function toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  const canPlay = !paused;

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!canPlay || activePointer.current != null) return;
    const engine = engineRef.current;
    if (!engine) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    activePointer.current = e.pointerId;
    engine.onPointerDown(toLocal(e));
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerId !== activePointer.current || !canPlay) return;
    const engine = engineRef.current;
    if (!engine) return;
    const native = e.nativeEvent;
    const coalesced =
      typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : null;
    const last =
      coalesced && coalesced.length > 0 ? coalesced[coalesced.length - 1] ?? native : native;
    engine.onPointerMove(toLocal(last));
  }

  function endStroke(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.pointerId !== activePointer.current) return;
    activePointer.current = null;
    engineRef.current?.onPointerUp(toLocal(e));
  }

  return (
    <div
      ref={frameRef}
      className="relative w-full overflow-hidden rounded-2xl mx-auto"
      style={{
        // Same fixed 4:5 pane as the Fog play area, matching the virtual
        // 100x125 board so letterbox bars stay minimal.
        aspectRatio: '4 / 5',
        maxHeight: '60vh',
        maxWidth: 'calc(60vh * 0.8)',
        background: 'var(--card-bg)',
        border: '1px solid var(--separator)',
        boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.14)',
      }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        // touch-action none: the aim drag must not scroll the page.
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
