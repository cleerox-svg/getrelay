import '../../styles/tune-skin.css';

// Spectrum-analyzer strip for the Tune player. It is PURELY decorative:
// a CSS animation (scaleY keyframes with staggered per-bar delays) toggled
// on/off by `active` (true while a clip is playing). There is no Web Audio
// and no real FFT — routing cross-origin Deezer previews through Web Audio
// would mute or fail to load them, so the strip never depends on analysis.
// It simply animates whenever a clip is playing, on every skin.
//
// A brief celebratory flare plays when `flash` is set (a correct guess),
// independent of playback. Colours come from the active skin's
// --tune-viz-* tokens on the enclosing .tune-skin wrapper. Decorative, so
// aria-hidden.

interface Props {
  // True while a clip is actually playing; false when paused/stopped.
  // Drives the decorative animation.
  active: boolean;
  // Brief celebratory flare, e.g. on a correct guess.
  flash?: boolean;
  bars?: number;
}

export function TuneVisualizer({ active, flash, bars = 20 }: Props) {
  const cls = ['tune-viz', active ? 'is-active' : 'is-idle', flash ? 'is-correct' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className="tune-viz-bar"
          style={{
            // Deterministic per-bar variation so the decorative strip reads
            // as a lively equalizer rather than a synchronized row. Negative
            // delays desynchronize the phases immediately.
            animationDelay: `${-((i * 97) % 60) / 100}s`,
            animationDuration: `${0.42 + ((i * 53) % 40) / 100}s`,
          }}
        />
      ))}
    </div>
  );
}
