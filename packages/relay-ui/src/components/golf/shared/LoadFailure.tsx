// The ONE way the golf hub reports a failed load.
//
// Extracted from GolfTournaments, which already had the right shape (an error
// state distinct from the loading state, plus a Retry that refetches) while the
// economy screens had none at all — they rendered a failed fetch as an empty
// catalog and a null balance, i.e. as confident, wrong facts about the player.
// Sharing the markup means a new screen gets the affordance by default instead
// of inventing a second, weaker one.

/**
 * The inline "Retry" affordance. Text-button, accent-coloured, no chrome.
 *
 * ⚠ `ariaLabel` is not decoration. Every retry in the hub reads as just "Retry"
 * to a screen reader, and a screen can render TWO of them at once (the shop's
 * wallet banner and its stale-catalog banner), so "Retry" alone names neither.
 * Pass a label that starts with the visible word — "Retry loading your wallet"
 * — so the accessible name still CONTAINS the visible text (WCAG 2.5.3).
 */
export function RetryButton({
  onClick,
  label = 'Retry',
  ariaLabel,
  className,
}: {
  onClick: () => void;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`font-semibold${className ? ` ${className}` : ''}`}
      style={{ color: 'var(--golf-accent)', background: 'transparent', border: 0 }}
      aria-label={ariaLabel}
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
  retryLabel,
  onRetry,
}: {
  title: string;
  detail: string;
  /** Accessible name for the Retry — see RetryButton. */
  retryLabel?: string;
  onRetry: () => void;
}) {
  return (
    // role="status" so the swap from a spinner to a failure is ANNOUNCED. It
    // replaces content that was already on screen, so a screen-reader user gets
    // no other signal that the panel changed under them; the line variant has
    // carried this since it was written.
    <div className="golf-empty" role="status">
      <b>{title}</b>
      <br />
      {detail}
      <br />
      <RetryButton onClick={onRetry} ariaLabel={retryLabel} className="mt-2" />
    </div>
  );
}

/** A one-line failure banner + Retry, for a screen that still has content. */
export function LoadFailureLine({
  text,
  retryLabel,
  onRetry,
}: {
  text: string;
  /** Accessible name for the Retry — see RetryButton. */
  retryLabel?: string;
  onRetry: () => void;
}) {
  return (
    <div className="golf-loadfail" role="status">
      <span>{text}</span>
      <RetryButton onClick={onRetry} ariaLabel={retryLabel} />
    </div>
  );
}
