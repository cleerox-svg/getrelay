import { useEffect, useRef } from 'react';
import '../../styles/tune-skin.css';

// Spectrum-analyzer strip for the Tune player. It runs in TWO modes:
//
//  - Decorative (default / fallback): a pure CSS animation (scaleY
//    keyframes with staggered per-bar delays) toggled on/off by `active`.
//    No Web Audio, always safe — this is what ships whenever real analysis
//    isn't available (probe blocked, setup failed, etc.).
//  - Reactive: when `levels` (0..1 per bar) is supplied by a CONFIRMED
//    Web Audio analyser, each bar's height is driven from its level. An
//    internal rAF eases the displayed height toward the target so the
//    strip is smooth even though `levels` publishes at a coarse cadence,
//    and DOM writes are imperative so they don't churn React.
//
// Either mode gets a brief celebratory flare when `flash` is set (a
// correct guess). Colours come from the active skin's --tune-viz-* tokens
// on the enclosing .tune-skin wrapper. Decorative, so aria-hidden.

interface Props {
  // True while a clip is actually playing; false when paused/stopped.
  // Drives the decorative animation only.
  active: boolean;
  // Real spectrum levels (0..1) when Web Audio analysis is live. When
  // omitted/empty the strip uses the decorative CSS animation.
  levels?: number[];
  // Brief celebratory flare, e.g. on a correct guess.
  flash?: boolean;
  bars?: number;
}

// How hard reduced-motion damps the reactive bars toward a steady mid.
const REDUCED_MOTION_STEADY = 0.5;
// Per-frame easing factor toward the target height.
const EASE = 0.35;
// Resting scale for a bar with no signal.
const FLOOR = 0.15;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function TuneVisualizer({ active, levels, flash, bars = 20 }: Props) {
  const reactive = Array.isArray(levels) && levels.length > 0;
  const count = reactive ? levels!.length : bars;

  // Per-bar element refs + the eased display heights the rAF writes.
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const displayRef = useRef<number[]>([]);
  const levelsRef = useRef<number[] | undefined>(levels);
  levelsRef.current = levels;
  const rafRef = useRef<number | null>(null);

  // Reactive mode: ease each bar toward its target level, writing scaleY
  // imperatively. Under reduced motion, hold the bars at a calm steady
  // height instead of pulsing.
  useEffect(() => {
    if (!reactive) {
      // Leaving reactive mode — clear any imperative transforms so the CSS
      // animation (decorative mode) takes over cleanly.
      barRefs.current.forEach((el) => {
        if (el) el.style.transform = '';
      });
      return;
    }

    const reduce = prefersReducedMotion();
    if (reduce) {
      barRefs.current.forEach((el) => {
        if (el) el.style.transform = `scaleY(${REDUCED_MOTION_STEADY})`;
      });
      return; // no animation loop under reduced motion
    }

    const loop = () => {
      const target = levelsRef.current ?? [];
      const disp = displayRef.current;
      for (let i = 0; i < barRefs.current.length; i++) {
        const el = barRefs.current[i];
        if (!el) continue;
        const t = Math.max(FLOOR, Math.min(1, target[i] ?? 0));
        const prev = disp[i] ?? FLOOR;
        const next = prev + (t - prev) * EASE;
        disp[i] = next;
        el.style.transform = `scaleY(${next.toFixed(3)})`;
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [reactive]);

  const cls = [
    'tune-viz',
    reactive ? 'is-reactive' : active ? 'is-active' : 'is-idle',
    flash ? 'is-correct' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className="tune-viz-bar"
          style={{
            // Deterministic per-bar variation so the decorative strip reads
            // as a lively equalizer rather than a synchronized row. Negative
            // delays desynchronize the phases immediately. (Ignored in
            // reactive mode, where the rAF drives transform directly.)
            animationDelay: `${-((i * 97) % 60) / 100}s`,
            animationDuration: `${0.42 + ((i * 53) % 40) / 100}s`,
          }}
        />
      ))}
    </div>
  );
}
