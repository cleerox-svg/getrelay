interface Props {
  size?: number;
}

// Tiny inline padlock, drawn in the same round-cap stroke idiom as the
// Receipt checkmark so the two glyphs sit together in a meta row. Inherits
// its color via currentColor, so callers set color on the wrapper (dim on
// their bubbles, white-ish on my accent bubbles).
export function LockGlyph({ size = 12 }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
