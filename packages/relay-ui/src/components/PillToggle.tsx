interface Props {
  on: boolean;
  onChange: (next: boolean) => void;
  // Two labels because BBM-style buttons read better as verbs than
  // ON / OFF — "Follow" → "Following", "Enable" → "Enabled", etc.
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
  // Sub-component variant: in a destructive context (eg. Disable Push)
  // we want the on-state pill to look "armed" rather than affirmative.
  // For now this just swaps the fill colour to ping red.
  destructive?: boolean;
}

// Animated on/off pill. Off = outlined accent border with accent text.
// On  = accent fill slides in from the leading edge in ~250ms, label
// crossfades from accent to white. Reused across SportsSettings (team
// follow + notification toggles) and Profile (push, classic theme).
export function PillToggle({
  on,
  onChange,
  onLabel,
  offLabel,
  disabled = false,
  destructive = false,
}: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      data-on={on ? 'true' : 'false'}
      data-destructive={destructive ? 'true' : 'false'}
      className="pill-toggle"
    >
      <span className="pill-toggle-fill" aria-hidden="true" />
      <span className="pill-toggle-label">
        {/* Render both labels stacked so the pill's intrinsic width is
            always the longer of the two — prevents the button from
            jumping wider mid-animation when the label swaps. */}
        <span aria-hidden="true" className="pill-toggle-ghost">
          {onLabel.length >= offLabel.length ? onLabel : offLabel}
        </span>
        <span className="pill-toggle-visible">{on ? onLabel : offLabel}</span>
      </span>
    </button>
  );
}
