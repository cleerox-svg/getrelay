import '../../styles/tune-skin.css';

// The animated LCD "screen" for the Dolphin skin — an original, from-scratch
// homage to the leaping-dolphin idle screens on late-'90s/early-'00s car head
// units. A cyan dolphin silhouette arcs over a shimmering waterline while an
// amber "sun" hangs above and stars twinkle; everything is our own SVG plus
// the CSS keyframes in tune-skin.css. No captured bitmap, product name or
// logo is used.
//
// Colours come from the active skin's tokens on the enclosing `.tune-skin`
// wrapper (cyan = --tune-readout-text, amber = --tune-warn, dim ripples =
// --tune-readout-dim), so the screen always matches the chrome. Purely
// decorative → aria-hidden. Under prefers-reduced-motion the CSS parks the
// dolphin mid-leap and stills the water instead of looping (see the media
// query in tune-skin.css).
//
// The dolphin path is authored centred on (0,0) so the leap keyframes can
// translate its CENTRE straight along the arc without a bounding-box offset.

export function TuneDolphin() {
  return (
    <svg
      className="tune-dolphin"
      viewBox="0 0 320 140"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* Amber "sun" over the water, tucked upper-left clear of the leap arc. */}
      <circle className="tune-dolphin-sun" cx="58" cy="34" r="15" />

      {/* Twinkling stars. */}
      <circle className="tune-dolphin-star" cx="120" cy="18" r="1.5" style={{ animationDelay: '0s' }} />
      <circle className="tune-dolphin-star" cx="196" cy="30" r="1.4" style={{ animationDelay: '0.8s' }} />
      <circle className="tune-dolphin-star" cx="248" cy="20" r="1.5" style={{ animationDelay: '1.6s' }} />
      <circle className="tune-dolphin-star" cx="300" cy="30" r="1.4" style={{ animationDelay: '2.4s' }} />

      {/* Leaping dolphin. The <g> is what the leap keyframes drive; the paths
          inside are centred near (0,0) and face up-and-to-the-right — rounded
          melon and short beak, a swept-back falcate dorsal, and a notched
          fluke, so it reads as a dolphin rather than a shark. */}
      <g className="tune-dolphin-leap">
        <g className="tune-dolphin-body">
          {/* Body: tail root → arched back → rounded melon → short beak →
              belly back to the tail. */}
          <path d="M-34 18 C-20 2 0 -6 14 -14 C20 -17 26 -16 30 -12 L44 -6 C34 -2 24 2 14 4 C2 7 -14 12 -28 20 Z" />
          {/* Swept-back (falcate) dorsal fin. */}
          <path d="M-4 -6 L-6 -20 L6 -7 Z" />
          {/* Notched tail fluke. */}
          <path d="M-28 16 L-44 8 L-38 20 L-44 26 L-29 22 Z" />
          {/* Swept-back pectoral fin under the belly. */}
          <path d="M-2 6 L-6 18 L8 10 Z" />
          {/* Eye (drawn in the screen background colour so it reads as a dot). */}
          <circle className="tune-dolphin-eye" cx="26" cy="-6" r="2" />
        </g>
      </g>

      {/* Waterline: a dim base swell plus a bright crest that gently shimmers.
          Shapes overshoot the right edge so preserveAspectRatio="none" never
          reveals a gap. */}
      <path
        className="tune-dolphin-water-dim"
        d="M-10 118 Q40 110 90 118 T190 118 T290 118 T400 118 V150 H-10 Z"
      />
      <path
        className="tune-dolphin-water"
        d="M-10 122 Q40 114 90 122 T190 122 T290 122 T400 122 V150 H-10 Z"
      />
    </svg>
  );
}
