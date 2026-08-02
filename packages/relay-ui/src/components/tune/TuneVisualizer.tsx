import '../../styles/tune-skin.css';

// Decorative spectrum-analyzer strip for the Tune player. The bars are a
// pure CSS animation (scaleY keyframes with staggered per-bar delays and
// durations) toggled on/off by the `active` flag — there is NO Web Audio
// / FFT here, deliberately: the design avoids the Web Audio API for the
// same CORS-taint and mobile-reliability reasons plain <audio> is used.
// When inactive the bars sit low and still. Colours come from the active
// skin's --tune-viz-* tokens on the enclosing .tune-skin wrapper.

interface Props {
  // True while a clip is actually playing; false when paused/stopped.
  active: boolean;
  bars?: number;
}

export function TuneVisualizer({ active, bars = 20 }: Props) {
  return (
    <div className={`tune-viz ${active ? 'is-active' : 'is-idle'}`} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="tune-viz-bar"
          style={{
            // Deterministic per-bar variation so the strip reads as a
            // lively equalizer rather than a synchronized row. Negative
            // delays desynchronize the phases immediately.
            animationDelay: `${-((i * 97) % 60) / 100}s`,
            animationDuration: `${0.42 + ((i * 53) % 40) / 100}s`,
          }}
        />
      ))}
    </div>
  );
}
