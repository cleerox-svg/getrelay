// The ONE way the golf hub reports a failed load.
//
// Extracted from GolfTournaments, which already had the right shape (an error
// state distinct from the loading state, plus a Retry that refetches) while the
// economy screens had none at all — they rendered a failed fetch as an empty
// catalog and a null balance, i.e. as confident, wrong facts about the player.
// Sharing the markup means a new screen gets the affordance by default instead
// of inventing a second, weaker one.

/** The inline "Retry" affordance. Text-button, accent-coloured, no chrome. */
export function RetryButton({
  onClick,
  label = 'Retry',
  className,
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`font-semibold${className ? ` ${className}` : ''}`}
      style={{ color: 'var(--golf-accent)', background: 'transparent', border: 0 }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/**
 * A whole-panel "couldn't load this" state with a Retry.
 *
 * Use when the screen has nothing to show. When the screen still has SOMETHING
 * to show (a catalog cached from an earlier fetch, say) prefer a `LoadFailureLine`
 * banner so the failure is visible without hiding usable content.
 */
export function LoadFailure({
  title,
  detail,
  onRetry,
}: {
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div className="golf-empty">
      <b>{title}</b>
      <br />
      {detail}
      <br />
      <RetryButton onClick={onRetry} className="mt-2" />
    </div>
  );
}

/** A one-line failure banner + Retry, for a screen that still has content. */
export function LoadFailureLine({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="golf-loadfail" role="status">
      <span>{text}</span>
      <RetryButton onClick={onRetry} />
    </div>
  );
}
